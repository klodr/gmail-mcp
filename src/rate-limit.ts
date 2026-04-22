/**
 * Per-bucket dual-window rate limit for write tools.
 *
 * Each write tool is mapped to a bucket; buckets enforce two rolling
 * windows simultaneously:
 *   - daily   (24h)
 *   - monthly (30-day rolling)
 * A call is rejected as soon as either cap is reached. The daily window
 * is checked first, so an explicit "Daily Limit Exceeded" is surfaced
 * when both caps are hit at the same instant.
 *
 * Read tools (get/list/search/download/*) are intentionally NOT in
 * TOOL_BUCKET: they do not forge state, and Google's Gmail API quota is
 * measured per-user/second at the platform level. The goal of this
 * limiter is to cap irreversible, destructive, or spam-shaped actions
 * that a prompt-injected agent could fire in a loop.
 *
 * Persistence: `<stateDir>/ratelimit.json`, mode 0o600, atomic rename.
 * `stateDir` defaults to `~/.gmail-mcp/` (override with
 * `GMAIL_MCP_STATE_DIR`). State is keyed by bucket; entries are arrays
 * of Unix-ms timestamps pruned to the monthly window on every access.
 *
 * Env overrides:
 *   GMAIL_MCP_RATE_LIMIT_<BUCKET>=D/day,M/month   # e.g. "50/day,500/month"
 *   GMAIL_MCP_RATE_LIMIT_DISABLE=true             # disable all limits
 *   GMAIL_MCP_STATE_DIR=/abs/path                 # state directory
 *
 * Design inspired by mercury-invoicing-mcp's middleware.ts.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DAY_MS = 86_400_000;
const MONTH_MS = 30 * DAY_MS; // 30-day rolling window

/**
 * Tool → bucket. Tools that share a bucket share the same history
 * array. Tools absent from this map (read/list/search/download/get_*)
 * are unlimited — Gmail's server-side quota is the authoritative cap
 * for those; the MCP limiter only exists to prevent burn-through on
 * irreversible write operations.
 */
const TOOL_BUCKET: Record<string, string> = {
  // Outbound mail (irreversible, spammable → the primary risk we cap)
  send_email: "send",
  reply_all: "send",

  // Deletion (irreversible; Gmail trashes first but batch deletes bypass trash)
  delete_email: "delete",
  batch_delete_emails: "delete",

  // Non-destructive label / thread mutations
  modify_email: "modify",
  batch_modify_emails: "modify",
  modify_thread: "modify",

  // Drafts (reversible, higher allowance)
  draft_email: "drafts",

  // Label management
  create_label: "labels",
  update_label: "labels",
  delete_label: "labels",
  get_or_create_label: "labels",

  // Filter rules (low-volume admin operations)
  create_filter: "filters",
  delete_filter: "filters",
  create_filter_from_template: "filters",
};

interface BucketLimit {
  daily: number;
  monthly: number;
}

/**
 * Defaults sized for "personal assistant" workloads, not bulk-mail, and
 * always well below the upstream Google Workspace caps so the MCP
 * safeguard surfaces BEFORE Google's own quota error.
 *
 * Upstream reference
 * (https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace):
 *   - Daily send: 2000/day (standard), 1500/day (mail merge), 500/day (trial)
 *   - Unique recipients: 3000/day (500 external on trial)
 *
 * `send` is deliberately capped at 400/day so that even on a trial
 * Google Workspace account (500/day upstream) the MCP limiter is the
 * one that trips first, with a clean "mcp_rate_limit_daily_exceeded"
 * error, rather than a less actionable 429 from Google.
 *
 * Override any bucket with `GMAIL_MCP_RATE_LIMIT_<BUCKET>=D/day,M/month`.
 */
const DEFAULT_BUCKET_LIMITS: Record<string, BucketLimit> = {
  send: { daily: 400, monthly: 6000 },
  delete: { daily: 200, monthly: 2000 },
  modify: { daily: 500, monthly: 5000 },
  drafts: { daily: 300, monthly: 3000 },
  labels: { daily: 50, monthly: 500 },
  filters: { daily: 20, monthly: 200 },
};

function parseOverride(raw: string): BucketLimit | null {
  const parts = raw.split(",").map((s) => s.trim());
  const [dailyPart, monthlyPart] = parts;
  if (parts.length !== 2 || !dailyPart || !monthlyPart) return null;
  const dailyM = dailyPart.match(/^(\d+)\s*\/\s*day$/i);
  const monthlyM = monthlyPart.match(/^(\d+)\s*\/\s*month$/i);
  if (!dailyM || !monthlyM || !dailyM[1] || !monthlyM[1]) return null;
  const daily = Number(dailyM[1]);
  const monthly = Number(monthlyM[1]);
  if (daily < 1 || monthly < 1) return null;
  return { daily, monthly };
}

function getBucketLimit(bucket: string): BucketLimit | null {
  const envKey = `GMAIL_MCP_RATE_LIMIT_${bucket}`;
  const raw = process.env[envKey];
  if (raw) {
    const parsed = parseOverride(raw);
    if (parsed) return parsed;
    console.error(
      `[ratelimit] invalid format for ${envKey}: "${raw}" — expected like "50/day,500/month". Using default.`,
    );
  }
  return DEFAULT_BUCKET_LIMITS[bucket] ?? null;
}

const callHistory = new Map<string, number[]>();
// `readOk` is set once the state file has been successfully read (or the
// file is confirmed absent). It gates `persistCallHistory`: if a prior
// read failed with a hard error (EACCES, EIO…) we must NOT clobber the
// unreadable-but-present file with an empty counter. Unlike the earlier
// `stateLoaded` flag, this does NOT cache the in-memory state — every
// enforce call re-reads the file (see the Critical CR comment on
// cross-process stale reads).
let readOk = false;

function getStateFile(): string {
  const dir = process.env.GMAIL_MCP_STATE_DIR || join(homedir(), ".gmail-mcp");
  return join(dir, "ratelimit.json");
}

function loadCallHistory(): void {
  // Always re-read the state file from disk. In-memory caching allowed
  // two MCP processes sharing the same ratelimit.json to each enforce
  // against stale state — effectively doubling the documented cap. The
  // atomic rename in persistCallHistory still avoids torn files, so a
  // reader either sees the complete old file or the complete new file,
  // never a mid-write concatenation. A race between a reader and a
  // writer in the same bucket can still let one extra call slip through
  // (read → other process appends → we append); the cap is therefore
  // ENFORCE_CAP + (N_processes - 1) worst case, not the per-process
  // bypass the stale-cache version allowed.
  const path = getStateFile();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Cold start: no prior state. readOk so the first persist succeeds.
      callHistory.clear();
      readOk = true;
      return;
    }
    // Any other read error: do NOT mark readOk. Persisting with an
    // empty counter would clobber a present-but-unreadable state file
    // and silently reset the limit. Keep readOk=false so
    // persistCallHistory stays a no-op until a successful read.
    console.error(`[ratelimit] failed to read state from ${path}: ${(err as Error).message}`);
    return;
  }
  // Successfully read the file → replace in-memory snapshot.
  callHistory.clear();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (Array.isArray(v) && v.every((n) => typeof n === "number")) {
          callHistory.set(k, v);
        }
      }
    }
  } catch (err) {
    // Corrupted JSON: we *did* read the file, so a fresh start is the
    // documented recovery. Overwriting the corrupt file is intentional.
    console.error(
      `[ratelimit] corrupted state at ${path}, starting fresh: ${(err as Error).message}`,
    );
  }
  readOk = true;
}

function persistCallHistory(): void {
  if (!readOk) return;
  const path = getStateFile();
  // Per-write unique tmp filename so two MCP processes that both call
  // persistCallHistory at the same instant cannot clobber each other's
  // tmp file before either rename completes. The rename itself is atomic.
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const obj: Record<string, number[]> = {};
    for (const [k, v] of callHistory) obj[k] = v;
    writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    console.error(`[ratelimit] failed to persist state to ${path}: ${(err as Error).message}`);
  }
}

/** Reset in-memory call history + readOk gate. Used by tests. */
export function resetRateLimitHistory(): void {
  readOk = false;
  callHistory.clear();
}

export type LimitType = "daily" | "monthly";

export class RateLimitError extends Error {
  constructor(
    public toolName: string,
    public bucket: string,
    public limitType: LimitType,
    public limit: number,
    public retryAfterMs: number,
  ) {
    const retryMinutes = Math.ceil(retryAfterMs / 60_000);
    const windowLabel = limitType === "daily" ? "24h" : "30-day rolling";
    const title = limitType === "daily" ? "Daily Limit Exceeded" : "Monthly Limit Exceeded";
    super(
      `${title}: ${toolName} (bucket: ${bucket}) capped at ${limit} per ${windowLabel}. ` +
        `Retry in ~${retryMinutes} min. ` +
        `Override with GMAIL_MCP_RATE_LIMIT_${bucket}=D/day,M/month if this is a legitimate batch.`,
    );
    this.name = "RateLimitError";
  }
}

/**
 * Enforce both rate-limit windows for a tool call.
 *
 * - No-op for read tools and tools absent from TOOL_BUCKET
 * - Prunes records older than the monthly window before counting
 * - Daily window checked first
 * - On allow: appends a timestamp and persists state
 * - On deny: throws RateLimitError with the limit type that failed
 */
export function enforceRateLimit(toolName: string): void {
  if (process.env.GMAIL_MCP_RATE_LIMIT_DISABLE === "true") return;

  const bucket = TOOL_BUCKET[toolName];
  if (!bucket) return; // read tool or untracked → no limit

  const limits = getBucketLimit(bucket);
  if (!limits) return;

  loadCallHistory();

  const now = Date.now();
  const records = (callHistory.get(bucket) ?? []).filter((ts) => now - ts < MONTH_MS);

  // retryAfterMs must be computed from the *oldest* timestamp still in the
  // window. Append order is normally chronological, but a concurrent
  // second process, a manually edited state file, or a clock skew could
  // leave entries out of order — relying on `records[0]` would then
  // advertise a wrong retry delay. Math.min is O(n) on a window that's
  // already filtered to ≤ `limits.monthly` entries (≤ 6000 worst case).
  const dailyRecords = records.filter((ts) => now - ts < DAY_MS);
  if (dailyRecords.length >= limits.daily) {
    const oldestDaily = Math.min(...dailyRecords);
    const retryAfterMs = DAY_MS - (now - oldestDaily);
    throw new RateLimitError(toolName, bucket, "daily", limits.daily, retryAfterMs);
  }

  if (records.length >= limits.monthly) {
    const oldestMonthly = Math.min(...records);
    const retryAfterMs = MONTH_MS - (now - oldestMonthly);
    throw new RateLimitError(toolName, bucket, "monthly", limits.monthly, retryAfterMs);
  }

  records.push(now);
  callHistory.set(bucket, records);
  persistCallHistory();
}

/**
 * Format a RateLimitError into the MCP ToolResult content payload.
 * Mirrors mercury-invoicing-mcp's format so MCP clients that already
 * surface one can surface the other.
 */
export function formatRateLimitError(err: RateLimitError): string {
  const retryAt = new Date(Date.now() + err.retryAfterMs).toISOString();
  return JSON.stringify(
    {
      source: "mcp_safeguard",
      error_type:
        err.limitType === "daily"
          ? "mcp_rate_limit_daily_exceeded"
          : "mcp_rate_limit_monthly_exceeded",
      message: err.message,
      hint: `Bucket "${err.bucket}" is at ${err.limit} calls per ${err.limitType === "daily" ? "24h" : "30 days"}. Override with GMAIL_MCP_RATE_LIMIT_${err.bucket}=D/day,M/month if this is a legitimate batch.`,
      retry_after: retryAt,
    },
    null,
    2,
  );
}

/** Test helper: export the tool → bucket map for property-based tests. */
export const _TOOL_BUCKET = TOOL_BUCKET;
export const _DEFAULT_BUCKET_LIMITS = DEFAULT_BUCKET_LIMITS;
