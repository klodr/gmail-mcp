/**
 * Tool registrar barrel. Wires every per-domain registrar
 * (`messages`, `labels`, `filters`, `threads`, `downloads`,
 * `messaging`) into the supplied `McpServer`. Called by `createServer`
 * in `src/server.ts`.
 *
 * Once invoked, the SDK's `tools/list` auto-emit returns every
 * scope-eligible tool from the 26-tool surface. PR #7 of the v1.0.0
 * migration switched the entry point in `src/index.ts` to call
 * `createServer` directly, replacing the legacy `Server` +
 * `CallToolRequestSchema` switch dispatcher.
 */

import type { gmail_v1 } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMessageTools } from "./messages.js";
import { registerLabelTools } from "./labels.js";
import { registerFilterTools } from "./filters.js";
import { registerThreadTools } from "./threads.js";
import { registerDownloadTools } from "./downloads.js";
import { registerMessagingTools } from "./messaging.js";

export function registerAllTools(
  server: McpServer,
  gmail: gmail_v1.Gmail,
  authorizedScopes: readonly string[],
): void {
  registerMessageTools(server, gmail, authorizedScopes);
  registerLabelTools(server, gmail, authorizedScopes);
  registerFilterTools(server, gmail, authorizedScopes);
  registerThreadTools(server, gmail, authorizedScopes);
  registerDownloadTools(server, gmail, authorizedScopes);
  registerMessagingTools(server, gmail, authorizedScopes);
}
