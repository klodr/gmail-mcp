/**
 * Shared infrastructure for the modular `defineTool()` registration
 * pattern. Mirrors `klodr/mercury-invoicing-mcp/src/tools/_shared.ts`
 * and `klodr/faxdrop-mcp/src/tools/_shared.ts` so the three repos
 * stay aligned on tool-registration semantics.
 *
 * `defineTool()` here adds one gmail-specific concern on top of the
 * mercury/faxdrop pattern: scope-based registration. Gmail tokens
 * carry an OAuth scope set (e.g. `gmail.readonly`); a tool whose
 * required scopes are not all satisfied by the token must not be
 * advertised on `tools/list`. The dispatcher in `src/index.ts` does
 * this filter at the `ListToolsRequestSchema` handler today; here
 * we apply it at registration time so the SDK auto-emits the right
 * `tools/list` without a custom handler.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z, ZodRawShape } from "zod";
import { wrapToolHandler, type ToolResult } from "../middleware.js";
import { hasScope } from "../scopes.js";

export type { ToolResult };
export type { ToolAnnotations };

/**
 * Register a tool against the supplied `McpServer`, with the standard
 * gmail middleware (rate-limit, audit log, sanitize-fence,
 * structuredContent) wired via `wrapToolHandler`. The Zod input schema
 * is `.strict()`-wrapped so unknown keys in an LLM-generated tool call
 * are rejected at parse time instead of silently dropped (mirrors
 * mercury / faxdrop).
 *
 * Scope filter: tools whose `requiredScopes` are not all satisfied by
 * `authorizedScopes` are silently skipped — equivalent to the manual
 * `ListToolsRequestSchema` filter in the legacy dispatcher. Returns
 * `true` when the tool was actually registered, `false` when skipped.
 */
export function defineTool<S extends ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>,
  annotations: ToolAnnotations,
  requiredScopes: readonly string[],
  authorizedScopes: readonly string[],
): boolean {
  // ANY-of-required semantics — INTENTIONAL, mirrors the legacy
  // dispatcher's `hasScope` filter at `src/index.ts:516-521`. Each
  // entry in `tools.ts:toolDefinitions[].scopes` lists the scopes
  // that ALTERNATIVELY grant access (e.g. `read_email` declares
  // `["gmail.readonly", "gmail.modify"]` — either one is enough,
  // since `modify` is a strict superset of `readonly`). All-of-
  // required would silently de-list every read tool for tokens that
  // have only `gmail.modify`, breaking the production behaviour the
  // legacy dispatcher ships today.
  //
  // Special case: an empty `requiredScopes` (no scope needed at all)
  // always registers — `hasScope([], [])` returns false because of
  // its `.some()` implementation, which would otherwise drop a
  // hypothetical no-auth tool. None of the 26 gmail tools currently
  // hit this branch, but pinning the behaviour now avoids a sharp
  // edge for any future MCP-spec utility tool that needs no OAuth.
  if (requiredScopes.length === 0) {
    // proceed — no auth needed, register unconditionally
  } else if (!hasScope([...authorizedScopes], [...requiredScopes])) {
    return false;
  }

  const strictSchema = z.object(inputSchema).strict();

  // The SDK infers its `InputArgs` generic from BOTH `inputSchema` and
  // the callback signature. `strictSchema` is a `ZodObject<…>` (not the
  // raw `S` shape itself), so explicitly typing the callback as
  // `(args: z.infer<z.ZodObject<S>>) => …` would force TS to infer
  // `InputArgs = S` from the callback while `inputSchema = strictSchema`
  // implies `InputArgs = ZodObject<…>` — a conflict. Mirror mercury's
  // approach: hand the SDK a thin adapter whose signature is
  // intentionally untyped on the callback side, then re-type `args`
  // with a single cast before forwarding to the user's handler. The
  // runtime parse is still strict (the SDK validates against
  // `strictSchema` BEFORE invoking the callback).
  const adapter = async (args: unknown) => {
    const typed = args as z.infer<z.ZodObject<S>>;
    return wrapToolHandler(name, typed, () => handler(typed));
  };

  // Cast through `unknown` to the SDK's expected callback shape. The
  // SDK types `content[].type` as the literal `"text"` (and friends);
  // gmail's `ToolResult` widens it to `string` intentionally so the
  // 1300-line legacy dispatcher does not need an `as const` cascade
  // on every case body. The adapter's runtime shape is identical to
  // what the SDK expects (every emit is `{ type: "text", text: … }`),
  // so the cast is sound. Documented in `src/middleware.ts:91`.
  const sdkCallback = adapter as unknown as Parameters<McpServer["registerTool"]>[2];
  server.registerTool(name, { description, inputSchema: strictSchema, annotations }, sdkCallback);

  return true;
}
