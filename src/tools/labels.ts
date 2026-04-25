/**
 * Label-domain tool registrars. PR #3 starts with `delete_label`
 * (trivial wrapper over `deleteLabel` from `src/label-manager.ts`);
 * PR #4 extends with `create_label`, `update_label`,
 * `get_or_create_label`, and `list_email_labels`. Once every
 * label-domain tool lives here, PR #7 deletes the corresponding
 * switch arms from the legacy dispatcher in `src/index.ts`.
 */

import type { gmail_v1 } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool } from "./_shared.js";
import { getToolByName, DeleteLabelSchema } from "../tools.js";
import { deleteLabel } from "../label-manager.js";

function pull(name: string) {
  const def = getToolByName(name);
  if (!def) {
    throw new Error(`Tool definition missing: ${name}`);
  }
  return { description: def.description, scopes: def.scopes, annotations: def.annotations };
}

export function registerLabelTools(
  server: McpServer,
  gmail: gmail_v1.Gmail,
  authorizedScopes: readonly string[],
): void {
  const deleteLabelDef = pull("delete_label");
  defineTool(
    server,
    "delete_label",
    deleteLabelDef.description,
    DeleteLabelSchema.shape,
    async (args) => {
      const result = await deleteLabel(gmail, args.id);
      return {
        content: [{ type: "text", text: result.message }],
      };
    },
    deleteLabelDef.annotations,
    deleteLabelDef.scopes,
    authorizedScopes,
  );
}
