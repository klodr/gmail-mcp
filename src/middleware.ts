/**
 * Tool-handler middleware for the MCP `CallToolRequestSchema` dispatcher.
 *
 * This module exists to extract the rate-limit + audit-log wiring that
 * currently lives inline inside the 1300-line switch in `src/index.ts`,
 * mirroring the design of the sibling repos:
 *   - `mercury-invoicing-mcp/src/middleware.ts:359`
 *   - `faxdrop-mcp/src/middleware.ts:203`
 *
 * Extraction unblocks the v0.10.0 parity layers (`AbortSignal.timeout`,
 * `sanitizeForLlm` fence, dry-run, `structuredContent`) without having
 * to duplicate glue code in every switch case.
 *
 * NOTE: this first release ships the module as an importable helper
 * with unit tests; the switch in `src/index.ts` is migrated in a
 * follow-up PR so the wire-up can be reviewed as a separate, contained
 * change on top of an already-merged, tested helper.
 */
import { type AuditResult, logAudit, redactSensitive } from "./audit-log.js";
import { enforceRateLimit, formatRateLimitError, RateLimitError } from "./rate-limit.js";

/**
 * Tool names that mutate Gmail state (outbound mail, label / filter /
 * thread writes). Dry-run short-circuits these before any Gmail API
 * call is made; read-only tools (`list_*`, `get_*`, `read_*`,
 * `search_*`, `download_*`) bypass dry-run entirely — there is nothing
 * to preview, and `download_*` only writes to a local jail inside
 * `GMAIL_MCP_DOWNLOAD_DIR`, which is an LLM-visible side effect that
 * the download-path hardening (see `src/index.ts`) owns rather than
 * the dry-run gate (CR #52).
 *
 * Keep in sync with the rate-limit buckets in `src/rate-limit.ts` —
 * every tool listed here should have a rate-limit entry, and vice
 * versa. The two lists are the canonical "this is a write operation"
 * signal used across the stack.
 */
const WRITE_TOOLS = new Set<string>([
  "send_email",
  "reply_all",
  "draft_email",
  "delete_email",
  "modify_email",
  "batch_modify_emails",
  "batch_delete_emails",
  "create_label",
  "update_label",
  "delete_label",
  "get_or_create_label",
  "create_filter",
  "delete_filter",
  "create_filter_from_template",
  "modify_thread",
]);

/**
 * Dry-run gate. Set `GMAIL_MCP_DRY_RUN=true` to make every write tool
 * short-circuit before calling Gmail and return the payload it would
 * have sent (sensitive args redacted via `redactSensitive`). Matches
 * `MERCURY_MCP_DRY_RUN` and `FAXDROP_MCP_DRY_RUN` in the sibling
 * servers. Useful for CI smoke tests, agent debugging, and
 * human-in-the-loop approval flows that need a preview before
 * authorising the real call.
 *
 * Only the exact string `"true"` flips the gate — an empty string or
 * any other value (including `"1"`, `"TRUE"`) counts as off. Strict
 * matching avoids accidentally enabling dry-run when an operator
 * copies a value from a different env convention.
 */
export function isDryRun(): boolean {
  return process.env.GMAIL_MCP_DRY_RUN === "true";
}

/**
 * Tool-handler response shape — local subset of the SDK's `CallToolResult`
 * (see `@modelcontextprotocol/sdk/types.js`).
 *
 * Intentionally looser than the SDK's full discriminated-union content
 * shape (`text` | `image` | `resource` | `resource_link`): the
 * 1300-line `CallToolRequestSchema` switch emits `{ type: "text",
 * text: "…" }` object literals inline, and TypeScript widens `type` to
 * `string` without an `as const` or a per-case return-type annotation.
 * Aligning with the SDK union here would force ~17 `as const` cascades
 * across the dispatcher for no observable behaviour change — the
 * handlers only emit the `text` variant today.
 *
 * When handler extraction lands (ROADMAP near-term item) each case
 * body becomes its own explicitly-annotated function and aligning
 * with `CallToolResult` becomes a one-line change.
 */
export type ToolResult = {
  content: { type: string; text: string }[];
  // Permit both record and array payloads: the attached-structured-content
  // helper lifts any JSON object OR array, matching the MCP spec's
  // tolerance for top-level arrays on tools that return lists. Clients
  // narrow via `Array.isArray(…)` or a shape guard (CR finding on #53).
  structuredContent?: Record<string, unknown> | unknown[];
  isError?: boolean;
};

/**
 * `logAudit` that never throws — wraps the call in a try/catch and
 * routes any audit failure to stderr. Used on every code path in
 * `wrapToolHandler` where a throw from the audit log would override a
 * more-important exception: the `finally` (whose throw overrides the
 * handler's throw per JS/TS semantics), the rate-limit branch (whose
 * return would be replaced by the audit throw), and the non-
 * `RateLimitError` re-throw (where the audit event itself must not
 * mask the underlying bug).
 *
 * `logAudit` already swallows its own `appendFileSync` failures
 * (`src/audit-log.ts` wraps the syscall), so this is defence in depth
 * against the two remaining failure paths inside `logAudit`:
 * `JSON.stringify` on a circular `args` shape and the date formatter.
 */
/**
 * Auto-attach `structuredContent` when a handler emits a JSON-stringified
 * text block but did not explicitly set `structuredContent` itself.
 * The MCP 2025-06-18 spec marks `structuredContent` as the channel
 * programmatic consumers (registries, test harnesses, other MCPs) read
 * for typed access to the tool result; the text block remains the
 * human-readable surface.
 *
 * Only object / array JSON payloads are lifted — primitives (strings,
 * numbers, booleans) are rejected because Dynaconf-style record typing
 * would not round-trip them meaningfully, and a bare number in
 * structuredContent conveys no more than the text block already does.
 *
 * Handlers that want full control (dry-run, rate-limit error, custom
 * typed payload) pass `structuredContent` themselves; this function
 * never overwrites an already-set value.
 */
function attachStructuredContent(result: ToolResult): ToolResult {
  if (result.structuredContent !== undefined) return result;
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") return result;
  try {
    const parsed: unknown = JSON.parse(first.text);
    // `typeof null === "object"` in JS — exclude nulls explicitly so a
    // JSON `"null"` payload stays on the text channel only (matches the
    // "primitives skipped" test contract). Both records and arrays are
    // lifted since structuredContent tolerates either.
    if (parsed !== null && typeof parsed === "object") {
      return {
        ...result,
        structuredContent: parsed as Record<string, unknown> | unknown[],
      };
    }
  } catch {
    // text is not JSON — leave the ToolResult untouched.
  }
  return result;
}

function safeLogAudit(name: string, args: unknown, result: AuditResult): void {
  try {
    logAudit(name, args, result);
  } catch (auditErr) {
    /* v8 ignore next -- defensive catch: logAudit already swallows
       appendFileSync failures internally, so this branch only fires on
       a JSON.stringify / Date format throw — not exercisable from a
       unit test without mocking the import (which would over-couple
       the test to implementation detail). The guarantee is the
       `try/catch` presence itself. */
    console.error(`[middleware] audit log failed for ${name}:`, (auditErr as Error).message);
  }
}

/**
 * Wrap a tool handler with rate-limit + audit-log middleware.
 *
 * Order of operations:
 *   1. `enforceRateLimit(name)` trips before the handler runs. Read
 *      tools (`list_*`, `get_*`, `read_*`, `search_*`, `download_*`) are
 *      unbucketed and the call is a cheap no-op; write tools (`send_*`,
 *      `delete_*`, `modify_*`, `batch_*`, label/filter writes) throw
 *      `RateLimitError` if either the daily or monthly window is
 *      exhausted. The error is caught here and mapped to an `isError`
 *      MCP payload with the `mcp_rate_limit_*` error-type so a client
 *      can distinguish a local MCP safeguard from a Gmail-side 429.
 *   2. `handler()` runs. Any throw is re-thrown — the caller owns the
 *      error-mapping surface (today: the outer try/catch in
 *      `setRequestHandler`; tomorrow: a Gmail-error-to-ToolResult
 *      mapper layered on top).
 *   3. `logAudit(name, args, result)` fires in the `finally`, with
 *      `result` = `"ok"` on a clean return, `"error"` on a throw, or
 *      `"rate_limited"` if the rate-limit branch returned early.
 *
 * This matches the three terminal audit-log states already emitted
 * inline by `src/index.ts` at lines 526 (`rate_limited`), 1948 (`ok` /
 * `error` from the finally), so the observable audit trail is
 * unchanged once the wire-up PR lands.
 */
export async function wrapToolHandler(
  name: string,
  args: unknown,
  handler: () => Promise<ToolResult>,
): Promise<ToolResult> {
  // Dry-run short-circuit — run BEFORE rate-limit so that previewing a
  // write call never consumes the daily/monthly quota. Read tools
  // bypass dry-run because they have nothing to preview (no side
  // effect to describe); they still hit the real handler.
  if (isDryRun() && WRITE_TOOLS.has(name)) {
    const dryPayload = {
      dryRun: true,
      tool: name,
      wouldCallWith: redactSensitive(args),
      note: "GMAIL_MCP_DRY_RUN=true; no Gmail API call was made. Sensitive fields are redacted.",
    };
    safeLogAudit(name, args, "dry-run");
    return {
      content: [{ type: "text", text: JSON.stringify(dryPayload, null, 2) }],
      structuredContent: dryPayload,
    };
  }

  try {
    enforceRateLimit(name);
  } catch (err) {
    if (err instanceof RateLimitError) {
      safeLogAudit(name, args, "rate_limited");
      return attachStructuredContent({
        content: [{ type: "text", text: formatRateLimitError(err) }],
        isError: true,
      });
    }
    // Non-RateLimitError: defensive path (enforceRateLimit only
    // throws RateLimitError today, but if a future regression
    // surfaces a different error here we still want the audit
    // trail to show it before the re-throw propagates).
    /* v8 ignore next 2 -- defensive: enforceRateLimit only throws
       RateLimitError today; this path guards against a future
       regression, not a runtime path we can exercise from a unit
       test. */
    safeLogAudit(name, args, "error");
    /* v8 ignore next */
    throw err;
  }

  let auditResult: AuditResult = "ok";
  try {
    const result = await handler();
    // Business errors returned via `isError: true` (vs thrown) are
    // also audited as "error" so the audit log distinguishes a
    // successful call from one that surfaced a handler-side failure
    // through the MCP protocol's isError channel (Qodo finding on
    // #48 — the prior inline audit at src/index.ts:1948 only saw
    // "error" on throws, missing the isError:true returns).
    if (result.isError) auditResult = "error";
    return attachStructuredContent(result);
  } catch (err) {
    auditResult = "error";
    throw err;
  } finally {
    safeLogAudit(name, args, auditResult);
  }
}
