/**
 * Message-domain tool registrars. PR #3 starts with `delete_email`
 * (the single trivial wrapper); subsequent PRs (`#4` for label/filter
 * management, `#5` for `read_email`/`search_emails`/`modify_email`/
 * `batch_modify_emails`/`batch_delete_emails`, `#6` for `download_email`)
 * extend this file. Once every message-domain tool lives here, PR #7
 * deletes the corresponding switch arms from the legacy dispatcher in
 * `src/index.ts` and wires `createServer` to call this registrar.
 */

import type { gmail_v1 } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool } from "./_shared.js";
import { getToolByName, DeleteEmailSchema } from "../tools.js";

function pull(name: string) {
  const def = getToolByName(name);
  if (!def) {
    throw new Error(`Tool definition missing: ${name}`);
  }
  return { description: def.description, scopes: def.scopes, annotations: def.annotations };
}

export function registerMessageTools(
  server: McpServer,
  gmail: gmail_v1.Gmail,
  authorizedScopes: readonly string[],
): void {
  const deleteEmail = pull("delete_email");
  defineTool(
    server,
    "delete_email",
    deleteEmail.description,
    DeleteEmailSchema.shape,
    async (args) => {
      await gmail.users.messages.delete({
        userId: "me",
        id: args.messageId,
      });
      return {
        content: [
          {
            type: "text",
            text: `Email ${args.messageId} deleted successfully`,
          },
        ],
      };
    },
    deleteEmail.annotations,
    deleteEmail.scopes,
    authorizedScopes,
  );
}
