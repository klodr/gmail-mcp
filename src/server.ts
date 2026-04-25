/**
 * Build a fully-wired `McpServer` instance: gmail client + middleware-
 * wrapped tools + scope-aware tool registration. Does NOT connect to
 * any transport — the caller (`src/index.ts` for production, an
 * `InMemoryTransport`-pair smoke test for fixtures) decides.
 *
 * This is the foundation step of the v1.0.0 migration toward
 * `McpServer` + `defineTool()`. The legacy `Server` +
 * `CallToolRequestSchema` switch dispatcher in `src/index.ts` keeps
 * running unchanged for now; subsequent PRs replace tool cases one
 * group at a time, removing the corresponding switch arms as they
 * land. PR #7 deletes the legacy dispatcher entirely.
 *
 * No `register*Tools()` registrar is invoked from `createServer`
 * itself yet — that wiring lives in `src/tools/index.ts` (a barrel
 * that PR #3 introduces) once the first batch of tools is extracted.
 * Calling `createServer` in this PR returns an empty-toolset
 * `McpServer` suitable for the smoke test in `src/server.test.ts`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OAuth2Client } from "google-auth-library";

// Kept in sync with package.json by scripts/sync-version.mjs (called by
// the `npm version` lifecycle hook). Do not edit manually — bump via
// `npm version patch|minor|major`. Mirrors the same convention used in
// klodr/mercury-invoicing-mcp/src/server.ts:VERSION and
// klodr/faxdrop-mcp/src/server.ts:VERSION.
export const VERSION = "0.21.1";

export interface ServerOptions {
  /**
   * Authenticated Google OAuth2 client. Built once at boot from the
   * stored credentials (`src/index.ts:loadCredentials`); injected here
   * rather than re-derived so the factory is trivially mockable in
   * tests and so a future multi-account refactor can pass a different
   * client per workspace.
   */
  oauth2Client: OAuth2Client;
  /**
   * The OAuth scopes the stored token actually carries. Tools whose
   * required scopes are not all satisfied by this set are skipped at
   * registration time — the equivalent of the manual
   * `ListToolsRequestSchema` filter in the legacy dispatcher, but
   * applied at registration so `tools/list` is auto-emitted by the
   * SDK without a custom handler.
   */
  authorizedScopes: readonly string[];
}

/**
 * Build the MCP server. Currently registers **no tools** — the
 * register*Tools modules land in PR #3 onwards as each batch is
 * extracted from the legacy dispatcher.
 */
export function createServer(opts: ServerOptions): McpServer {
  // `oauth2Client` and `authorizedScopes` are not yet consumed inside
  // this function — they will be passed into `registerAllTools(server,
  // gmail, authorizedScopes)` once the first registrar lands. Reading
  // them here pins the contract so downstream PRs do not need to
  // change the public signature.
  void opts.oauth2Client;
  void opts.authorizedScopes;

  return new McpServer({
    name: "gmail",
    version: VERSION,
  });
}
