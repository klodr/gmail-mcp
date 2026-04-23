/**
 * Opt-in JSONL audit log.
 *
 * When `GMAIL_MCP_AUDIT_LOG` is set to an absolute path, every call to
 * a write tool appends one JSON line recording:
 *   { ts, tool, result, args }
 * where `args` is recursively redacted — sensitive keys (OAuth tokens,
 * credentials, client secrets, API keys, passwords) are replaced with
 * "[REDACTED]", and large binary-ish payloads (message bodies,
 * attachment bytes, htmlBody) are elided so the audit log stays
 * readable and does not accidentally become a backup of your mail.
 *
 * File is created with mode 0o600 (owner read/write only). The path
 * must be absolute; relative paths are refused with a stderr warning.
 *
 * No-op if the env var is unset — this feature is opt-in.
 *
 * Design mirrors mercury-invoicing-mcp and faxdrop-mcp so a consumer
 * aggregating audit logs across klodr/* MCPs gets one consistent
 * JSONL shape.
 */

import { appendFileSync } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * Sensitive object keys to redact. Case-insensitive (the check
 * lowercases the key before lookup). Covers OAuth tokens, credentials,
 * API keys, and similar.
 */
export const SENSITIVE_KEYS = Object.freeze([
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "id_token",
  "idtoken",
  "client_secret",
  "clientsecret",
  "credentials",
  "apikey",
  "api_key",
  "authorization",
  "password",
  "token",
  "secret",
] as const);

const SENSITIVE_KEYS_SET: ReadonlySet<string> = new Set(SENSITIVE_KEYS);

/**
 * Keys whose *value* is elided rather than redacted, because they
 * typically carry large free-form content OR attacker-controlled
 * content that would bloat the audit log without adding operational
 * value — AND can carry PII or prompt-injection payloads if left raw.
 * Elided to "[ELIDED:N chars]" so reviewers can still see that the
 * field was present and its size.
 *
 * The "size-only" set: `body`, `htmlbody`, `data`, `attachments` —
 * bulky by nature, never needed at call-review time.
 *
 * The "PII + attacker-control" set: `subject`, `to`, `cc`, `bcc`,
 * `from`, `snippet`, `q` (the `search_emails` query), `forward` (the
 * filter action that writes an email address, i.e. a potential
 * exfiltration channel if the log itself leaks). Those reconstruct
 * the full conversation from the log and expose counterparty data
 * that a security-audit log has no business keeping. To re-enable
 * full-fidelity inspection, set `GMAIL_MCP_AUDIT_LOG_VERBOSE=true`
 * which restricts elision to the size-only set.
 */
const SIZE_ELIDED_KEYS = ["body", "htmlbody", "data", "attachments"] as const;
const PII_ELIDED_KEYS = ["subject", "to", "cc", "bcc", "from", "snippet", "q", "forward"] as const;

const ELIDED_KEYS: ReadonlySet<string> =
  process.env.GMAIL_MCP_AUDIT_LOG_VERBOSE === "true"
    ? new Set<string>(SIZE_ELIDED_KEYS)
    : new Set<string>([...SIZE_ELIDED_KEYS, ...PII_ELIDED_KEYS]);

/**
 * Recursively walk a value, redacting sensitive keys and eliding
 * large free-form fields.
 */
export function redactSensitive(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactSensitive);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const lower = k.toLowerCase();
    if (SENSITIVE_KEYS_SET.has(lower)) {
      out[k] = "[REDACTED]";
    } else if (ELIDED_KEYS.has(lower)) {
      if (typeof v === "string") {
        out[k] = `[ELIDED:${v.length} chars]`;
      } else if (Array.isArray(v)) {
        out[k] = `[ELIDED:${v.length} items]`;
      } else {
        out[k] = "[ELIDED]";
      }
    } else {
      out[k] = redactSensitive(v);
    }
  }
  return out;
}

export type AuditResult = "ok" | "error" | "rate_limited" | "dry-run";

export function logAudit(toolName: string, args: unknown, result: AuditResult): void {
  const path = process.env.GMAIL_MCP_AUDIT_LOG;
  if (!path) return;
  if (!isAbsolute(path)) {
    console.error(`[audit] GMAIL_MCP_AUDIT_LOG must be an absolute path; got: ${path}`);
    return;
  }
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    tool: toolName,
    result,
    args: redactSensitive(args),
  });
  try {
    appendFileSync(path, entry + "\n", { mode: 0o600 });
  } catch (err) {
    console.error(`[audit] failed to write to ${path}:`, (err as Error).message);
  }
}
