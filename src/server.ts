/**
 * Build a fully-wired `McpServer` instance: gmail client + middleware-
 * wrapped tools + scope-aware tool registration. Does NOT connect to
 * any transport — the caller (`src/index.ts` for production, an
 * `InMemoryTransport`-pair smoke test for fixtures) decides.
 *
 * PR #7 of the v1.0.0 migration deleted the legacy `Server` +
 * `CallToolRequestSchema` switch dispatcher in `src/index.ts` and
 * promoted this factory to be the sole production entry point. Every
 * tool now flows through `defineTool()` → `wrapToolHandler` →
 * handler, and `tools/list` is auto-emitted by the SDK from the
 * registrations in `src/tools/*.ts`.
 */

import type { gmail_v1 } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "./tools/index.js";
import { listPrompts, getPrompt } from "./prompts.js";
import {
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Kept in sync with package.json by scripts/sync-version.mjs (called by
// the `npm version` lifecycle hook). Do not edit manually — bump via
// `npm version patch|minor|major`. Mirrors the same convention used in
// klodr/mercury-invoicing-mcp/src/server.ts:VERSION and
// klodr/faxdrop-mcp/src/server.ts:VERSION.
export const VERSION = "0.30.1";

export interface ServerOptions {
  /**
   * The Gmail API client. Built from an authenticated OAuth2Client at
   * the entry point (`src/index.ts`); injected here rather than
   * re-derived so the factory is trivially mockable in tests (the test
   * fixture passes a hand-built mock gmail object) and so a future
   * multi-account refactor can pass a different client per workspace.
   */
  gmail: gmail_v1.Gmail;
  /**
   * The OAuth scopes the stored token actually carries. Tools whose
   * required scopes are NOT covered by this set (ANY-of-required
   * match) are skipped at registration time — the equivalent of the
   * manual `ListToolsRequestSchema` filter in the legacy dispatcher,
   * but applied at registration so `tools/list` is auto-emitted by
   * the SDK without a custom handler.
   */
  authorizedScopes: readonly string[];
}

/**
 * Build the MCP server: instantiate the gmail client from the OAuth2
 * client, register every per-domain tool (filtered by scope), and
 * wire the prompts surface.
 */
export function createServer(opts: ServerOptions): McpServer {
  const server = new McpServer(
    {
      name: "gmail",
      version: VERSION,
    },
    {
      // Declare the prompts capability up-front so the SDK accepts the
      // ListPrompts / GetPrompt request handlers we register below.
      // McpServer.registerPrompt() does not match gmail's existing
      // (name, args) → text contract, so we wire the underlying Server
      // directly via the back-door `server.server` reference.
      capabilities: { prompts: {} },
    },
  );

  registerAllTools(server, opts.gmail, opts.authorizedScopes);

  // Prompts surface — slash commands. Same handlers as the legacy
  // dispatcher, registered against the underlying low-level Server
  // because McpServer.registerPrompt does not yet expose a "raw" mode
  // matching the (name, arguments) → text contract gmail's prompts use.
  server.server.setRequestHandler(ListPromptsRequestSchema, () =>
    Promise.resolve({ prompts: listPrompts() }),
  );
  server.server.setRequestHandler(GetPromptRequestSchema, (request) => {
    const { name, arguments: args } = request.params;
    try {
      return Promise.resolve(getPrompt(name, args) as unknown as Record<string, unknown>);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unexpected error generating prompt body";
      throw new Error(`Prompt "${name}": ${message}`, { cause: err });
    }
  });

  return server;
}
