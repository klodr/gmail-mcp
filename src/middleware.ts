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
 * Shape of a single MCP tool handler response.
 *
 * `structuredContent` is the MCP 2025-06-18+ parseable JSON form; it is
 * not populated by the current Gmail handlers (`content[0].text` still
 * carries the JSON-or-plaintext payload) but the type is declared up
 * front so the later sanitizeForLlm / structuredContent layer can
 * start returning it without changing the callsite signature.
 */
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
        logAudit(name, args, "rate_limited");
        return {
          content: [{ type: "text", text: formatRateLimitError(err) }],
          isError: true,
        };
      }
      /* v8 ignore next -- defensive: enforceRateLimit only throws
         RateLimitError today; this re-throw guards against a future
         regression that would surface as a programming bug, not a
         runtime path we can exercise from a unit test. */
      throw err;
    }

    let auditResult: AuditResult = "ok";
    try {
      return await handler();
    } catch (err) {
      auditResult = "error";
      throw err;
    } finally {
      logAudit(name, args, auditResult);
    }
  })();
}
