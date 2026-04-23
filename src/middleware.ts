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
import { type AuditResult, logAudit } from "./audit-log.js";
import { enforceRateLimit, formatRateLimitError, RateLimitError } from "./rate-limit.js";

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
  structuredContent?: Record<string, unknown>;
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
function safeLogAudit(name: string, args: unknown, result: AuditResult): void {
  try {
    logAudit(name, args, result);
  } catch (auditErr) {
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
export function wrapToolHandler(
  name: string,
  args: unknown,
  handler: () => Promise<ToolResult>,
): Promise<ToolResult> {
  return (async () => {
    try {
      enforceRateLimit(name);
    } catch (err) {
      if (err instanceof RateLimitError) {
        safeLogAudit(name, args, "rate_limited");
        return {
          content: [{ type: "text", text: formatRateLimitError(err) }],
          isError: true,
        };
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
      return result;
    } catch (err) {
      auditResult = "error";
      throw err;
    } finally {
      safeLogAudit(name, args, auditResult);
    }
  })();
}
