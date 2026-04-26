/**
 * Shared infrastructure for the modular `defineTool()` registration
 * pattern. Mirrors `klodr/mercury-invoicing-mcp/src/tools/_shared.ts`
 * and `klodr/faxdrop-mcp/src/tools/_shared.ts` so the three repos
 * stay aligned on tool-registration semantics.
 *
 * `defineTool()` here adds one gmail-specific concern on top of the
 * mercury/faxdrop pattern: scope-based registration. Gmail tokens
 * carry an OAuth scope set (e.g. `gmail.readonly`); a tool whose
 * required scopes are NOT covered by the token (ANY-of-required
 * match — see the long-form rationale at the call site) must not be
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
import { getToolByName } from "../tools.js";

export type { ToolResult };
export type { ToolAnnotations };

/**
 * Look up a tool's `description`, `scopes`, and `annotations` from the
 * `toolDefinitions` registry in `src/tools.ts`. Throws if the name is
 * unknown — that is a programming error (the registrar typo'd a tool
 * name) and should fail loud at module load, not silently skip.
 *
 * Centralised here so the per-domain registrars
 * (`src/tools/{messages,labels,filters,threads}.ts`) do not each
 * inline the same 4-line helper. Once PR #7 deletes the legacy
 * dispatcher, the description / scopes / annotations live in the
 * registrar modules directly and this helper goes away.
 */
export function pullToolMeta(name: string): {
  description: string;
  scopes: string[];
  annotations: ToolAnnotations;
} {
  const def = getToolByName(name);
  if (!def) {
    throw new Error(`Tool definition missing: ${name}`);
  }
  return { description: def.description, scopes: def.scopes, annotations: def.annotations };
}

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
export function defineTool<S extends ZodRawShape, O extends ZodRawShape = ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>,
  annotations: ToolAnnotations,
  requiredScopes: readonly string[],
  authorizedScopes: readonly string[],
  outputSchema?: O,
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
  // Pin the optional `outputSchema` onto the SDK's registerTool
  // config when supplied. Two consumer sides:
  //   1. `tools/list` advertises the schema in its `outputSchema`
  //      field, so an MCP client / agent can introspect the
  //      structured contract without parsing the textual `RETURNS:`
  //      block in `description`.
  //   2. The SDK validates each `structuredContent` payload against
  //      the schema before emitting — a regression that drops a
  //      field or returns the wrong type fails at the MCP boundary
  //      instead of silently producing a malformed agent input.
  // Schemas are intentionally `ZodRawShape` (not `z.object(...)`),
  // matching the inputSchema convention; the SDK wraps them with
  // `z.object(...).passthrough()` internally.
  //
  // The SDK's registerTool config type is over-loaded with an
  // unwieldy generic discriminator that confuses TS's structural
  // inference here — we hand-roll the config object as `unknown`
  // and let the SDK accept it. The runtime shape is exactly what
  // the SDK expects; the type-side gymnastics are purely about
  // working around the deprecated overload disambiguation.
  const config: Record<string, unknown> = {
    description,
    inputSchema: strictSchema,
    annotations,
  };
  if (outputSchema) {
    config.outputSchema = outputSchema;
  }
  server.registerTool(name, config, sdkCallback);

  return true;
}
