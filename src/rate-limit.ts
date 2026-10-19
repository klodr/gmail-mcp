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
 * Read tools (get/list/search/*) and the local-only `download_*` tools
 * are intentionally NOT in TOOL_BUCKET: they do not forge Gmail state, and Google's Gmail API quota is
 * measured per-user/second at the platform level. The goal of this
 * limiter is to cap irreversible, destructive, or spam-shaped actions
 * that a prompt-injected agent could fire in a loop.
 *
 * Batch tools (`batch_modify_emails`, `batch_delete_emails`,
 * `move_to_spam_batch`) are weighted by the number of message IDs they
 * carry: a call touching 1 000 messages consumes 1 000 units of the
 * bucket, not 1. Without the weight a single call could act on the
 * whole cap's worth of messages a thousand times over.
 *
 * Persistence: `<stateDir>/ratelimit.json`, mode 0o600, atomic rename.
 * `stateDir` defaults to `~/.gmail-mcp/` (override with
 * `GMAIL_MCP_STATE_DIR`). State is keyed by bucket; each entry is a
 * Unix-ms timestamp (weight 1) or a `[timestamp, weight]` pair, pruned
 * to the monthly window on every access.
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
  reply_to_email: "send",
  forward_email: "send",

  // Deletion (irreversible; Gmail trashes first but batch deletes bypass trash)
  delete_email: "delete",
  batch_delete_emails: "delete",

  // Non-destructive label / thread mutations
  modify_email: "modify",
  batch_modify_emails: "modify",
  modify_thread: "modify",
  // Spam reports are label moves (reversible from the Spam folder)
  move_to_spam: "modify",
  move_to_spam_batch: "modify",

  // Drafts (reversible, higher allowance)
  draft_email: "drafts",
  update_draft: "drafts",
  delete_draft: "drafts",
  // `send_draft` is an irreversible outbound send: it consumes the draft
  // and delivers the staged message to recipients. Route it through the
  // stricter `send` bucket alongside `send_email` / `reply_all` so a
  // pre-staged draft cannot bypass the anti-spam ceiling that gates
  // freshly-composed sends.
  send_draft: "send",

  // Label management
  create_label: "labels",
  update_label: "labels",
  delete_label: "labels",
  get_or_create_label: "labels",

  // Filter rules (low-volume admin operations)
  create_filter: "filters",
  delete_filter: "filters",
  create_filter_from_template: "filters",

  // Recipient allowlist edits (`pair_recipient` add/remove/list)
  pair_recipient: "pairing",
};

/**
 * The canonical "this tool mutates Gmail-side state" set, derived from
 * TOOL_BUCKET so the dry-run gate (`src/middleware.ts`) and the rate
 * limiter can never drift apart: a write tool is dry-run'd if and only
 * if it is rate-limited. `test/write-tools-coherence.test.ts` checks it
 * against every registered tool definition.
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(Object.keys(TOOL_BUCKET));

/**
 * Tools that write ONLY to the local filesystem, inside the download
 * jail (`GMAIL_MCP_DOWNLOAD_DIR`), and never mutate the mailbox. They
 * carry `readOnlyHint: false` (they do change the environment) but are
 * deliberately neither rate-limited nor dry-run'd: there is no Gmail
 * write to preview or to cap, and the jail owns their hardening.
 */
/**
 * Tools whose rate-limit weight is the number of message IDs they act
 * on (see `callWeight`). Every other tool weighs 1 per call.
 */
const PER_MESSAGE_TOOLS: ReadonlySet<string> = new Set([
  "batch_modify_emails",
  "batch_delete_emails",
  "move_to_spam_batch",
]);

/**
 * Rate-limit weight of one call: the length of `messageIds` for the
 * batch tools, 1 for everything else (and never less than 1, so an
 * empty or malformed batch still counts as one call).
 */
export function callWeight(toolName: string, args: unknown): number {
  if (!PER_MESSAGE_TOOLS.has(toolName)) return 1;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const ids = (args as Record<string, unknown>)["messageIds"];
    if (Array.isArray(ids) && ids.length > 0) return ids.length;
  }
  return 1;
}

export const LOCAL_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "download_attachment",
  "download_all_attachments",
  "download_email",
]);

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
 * `send` is capped at 100/day to mirror the upper end of human
 * professional workload (~40 emails/day per knowledge worker, with
 * a 2.5× cushion for busy days). The previous 400/day default was
 * sized to trip BEFORE the 500/day Workspace trial cap, but that
 * left an order-of-magnitude headroom for a prompt-injected agent
 * to spam before the limiter fired. The new default trips much
 * earlier in the abuse curve and still covers every legitimate
 * personal-assistant workload — heavy users override via
 * `GMAIL_MCP_RATE_LIMIT_send=400/day,6000/month` to opt back in.
 *
 * `modify` and `delete` count MESSAGES for the batch tools (see
 * `callWeight`), so their caps are sized in messages: 5 000 label /
 * read-state / archive changes a day covers five full 1 000-message
 * batches — a large inbox clean-up — and still stops a runaway loop.
 * Permanent deletion stays an order of magnitude lower (1 000 a day).
 *
 * Override any bucket with `GMAIL_MCP_RATE_LIMIT_<BUCKET>=D/day,M/month`.
 */
const DEFAULT_BUCKET_LIMITS: Record<string, BucketLimit> = {
  send: { daily: 100, monthly: 2000 },
  delete: { daily: 1000, monthly: 10_000 },
  modify: { daily: 5000, monthly: 50_000 },
  drafts: { daily: 300, monthly: 3000 },
  labels: { daily: 50, monthly: 500 },
  filters: { daily: 20, monthly: 200 },
  pairing: { daily: 50, monthly: 500 },
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

/** A recorded call: a timestamp (weight 1) or `[timestamp, weight]`. */
type CallEntry = number | [number, number];

function entryTime(entry: CallEntry): number {
  return typeof entry === "number" ? entry : entry[0];
}

function entryWeight(entry: CallEntry): number {
  return typeof entry === "number" ? 1 : entry[1];
}

function isCallEntry(value: unknown): value is CallEntry {
  if (typeof value === "number") return true;
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    Number.isInteger(value[1]) &&
    value[1] >= 1
  );
}

function totalWeight(entries: readonly CallEntry[]): number {
  let total = 0;
  for (const entry of entries) total += entryWeight(entry);
  return total;
}

/**
 * Milliseconds until `needed` units fit under `limit` in a window of
 * `windowMs`: walk the entries oldest first and find the one whose
 * expiry frees enough room. `entries` must all be inside the window.
 */
function retryAfter(
  entries: readonly CallEntry[],
  limit: number,
  needed: number,
  windowMs: number,
  now: number,
): number {
  const sorted = entries.toSorted((a, b) => entryTime(a) - entryTime(b));
  let remaining = totalWeight(sorted);
  for (const entry of sorted) {
    remaining -= entryWeight(entry);
    if (remaining + needed <= limit) return windowMs - (now - entryTime(entry));
  }
  /* v8 ignore next -- unreachable: callers only ask when needed <= limit,
     and an empty window always has room for it. */
  return windowMs;
}

const callHistory = new Map<string, CallEntry[]>();
// `readOk` is set once the state file has been successfully read (or the
// file is confirmed absent). It gates `persistCallHistory`: if a prior
// read failed with a hard error (EACCES, EIO…) we must NOT clobber the
// unreadable-but-present file with an empty counter. Unlike the earlier
// `stateLoaded` flag, this does NOT cache the in-memory state — every
// enforce call re-reads the file (see the Critical CR comment on
// cross-process stale reads).
let readOk = false;

function getStateFile(): string {
  const directory = process.env.GMAIL_MCP_STATE_DIR || join(homedir(), ".gmail-mcp");
  return join(directory, "ratelimit.json");
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
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
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
    console.error(`[ratelimit] failed to read state from ${path}: ${(error as Error).message}`);
    return;
  }
  // Successfully read the file → replace in-memory snapshot.
  callHistory.clear();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (Array.isArray(v) && v.every((entry) => isCallEntry(entry))) {
          callHistory.set(k, v);
        }
      }
    }
  } catch (error) {
    // Corrupted JSON: we *did* read the file, so a fresh start is the
    // documented recovery. Overwriting the corrupt file is intentional.
    console.error(
      `[ratelimit] corrupted state at ${path}, starting fresh: ${(error as Error).message}`,
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
    const obj: Record<string, CallEntry[]> = {};
    for (const [k, v] of callHistory) obj[k] = v;
    writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    console.error(`[ratelimit] failed to persist state to ${path}: ${(error as Error).message}`);
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
    public requested = 1,
  ) {
    const windowLabel = limitType === "daily" ? "24h" : "30-day rolling";
    const title = limitType === "daily" ? "Daily Limit Exceeded" : "Monthly Limit Exceeded";
    const timing =
      requested > limit
        ? `This call alone needs ${requested} units — more than the whole cap; split the batch. `
        : `Retry in ~${Math.ceil(retryAfterMs / 60_000)} min. `;
    super(
      `${title}: ${toolName} (bucket: ${bucket}) capped at ${limit} per ${windowLabel}. ` +
        timing +
        `Override with GMAIL_MCP_RATE_LIMIT_${bucket}=D/day,M/month if this is a legitimate batch.`,
    );
    this.name = "RateLimitError";
  }
}

/**
 * Enforce both rate-limit windows for a tool call.
 *
 * - No-op for read tools and tools absent from TOOL_BUCKET
 * - `weight` is the number of units the call consumes (see
 *   `callWeight`): 1 for a normal call, the message count for a batch
 * - Prunes records older than the monthly window before counting
 * - Daily window checked first
 * - On allow: records the call with its weight and persists state
 * - On deny: throws RateLimitError with the limit type that failed
 */
export function enforceRateLimit(toolName: string, weight = 1): void {
  if (process.env.GMAIL_MCP_RATE_LIMIT_DISABLE === "true") return;

  const bucket = TOOL_BUCKET[toolName];
  if (!bucket) return; // read tool or untracked → no limit

  const limits = getBucketLimit(bucket);
  if (!limits) return;

  const units = Math.max(1, Math.floor(weight));

  loadCallHistory();

  const now = Date.now();
  const records = (callHistory.get(bucket) ?? []).filter(
    (entry) => now - entryTime(entry) < MONTH_MS,
  );

  // The retry delay is derived from the entries that must expire before
  // `units` fit again, walked oldest first by timestamp — append order
  // is normally chronological, but a second process, a hand-edited
  // state file or clock skew can leave entries out of order.
  const dailyRecords = records.filter((entry) => now - entryTime(entry) < DAY_MS);
  if (totalWeight(dailyRecords) + units > limits.daily) {
    const retryAfterMs =
      units > limits.daily ? 0 : retryAfter(dailyRecords, limits.daily, units, DAY_MS, now);
    throw new RateLimitError(toolName, bucket, "daily", limits.daily, retryAfterMs, units);
  }

  if (totalWeight(records) + units > limits.monthly) {
    const retryAfterMs =
      units > limits.monthly ? 0 : retryAfter(records, limits.monthly, units, MONTH_MS, now);
    throw new RateLimitError(toolName, bucket, "monthly", limits.monthly, retryAfterMs, units);
  }

  records.push(units === 1 ? now : [now, units]);
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
      hint: `Bucket "${err.bucket}" is at ${err.limit} units per ${err.limitType === "daily" ? "24h" : "30 days"} (one unit per call, one per message for batch tools). Override with GMAIL_MCP_RATE_LIMIT_${err.bucket}=D/day,M/month if this is a legitimate batch.`,
      retry_after: retryAt,
    },
    null,
    2,
  );
}

/** Test helper: export the tool → bucket map for property-based tests. */
export const _TOOL_BUCKET = TOOL_BUCKET;
export const _DEFAULT_BUCKET_LIMITS = DEFAULT_BUCKET_LIMITS;
