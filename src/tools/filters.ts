/**
 * Filter-domain tool registrars. PR #3 starts with `delete_filter`
 * (trivial wrapper over `deleteFilter` from `src/filter-manager.ts`);
 * PR #4 extends with `create_filter` (with the recipient-pairing
 * forward-action gate), `list_filters`, `get_filter`, and
 * `create_filter_from_template`. Once every filter-domain tool lives
 * here, PR #7 deletes the corresponding switch arms from the legacy
 * dispatcher in `src/index.ts`.
 */

import type { gmail_v1 } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool } from "./_shared.js";
import { getToolByName, DeleteFilterSchema } from "../tools.js";
import { deleteFilter } from "../filter-manager.js";

function pull(name: string) {
  const def = getToolByName(name);
  if (!def) {
    throw new Error(`Tool definition missing: ${name}`);
  }
  return { description: def.description, scopes: def.scopes, annotations: def.annotations };
}

export function registerFilterTools(
  server: McpServer,
  gmail: gmail_v1.Gmail,
  authorizedScopes: readonly string[],
): void {
  const deleteFilterDef = pull("delete_filter");
  defineTool(
    server,
    "delete_filter",
    deleteFilterDef.description,
    DeleteFilterSchema.shape,
    async (args) => {
      const result = await deleteFilter(gmail, args.filterId);
      return {
        content: [{ type: "text", text: result.message }],
      };
    },
    deleteFilterDef.annotations,
    deleteFilterDef.scopes,
    authorizedScopes,
  );
}
