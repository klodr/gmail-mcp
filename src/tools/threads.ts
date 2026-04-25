/**
 * Thread-domain tool registrars. PR #3 starts with `modify_thread`
 * (trivial wrapper over `gmail.users.threads.modify`); PR #6 extends
 * with `get_thread`, `list_inbox_threads`, and
 * `get_inbox_with_threads`. Once every thread-domain tool lives here,
 * PR #7 deletes the corresponding switch arms from the legacy
 * dispatcher in `src/index.ts`.
 */

import type { gmail_v1 } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool } from "./_shared.js";
import { getToolByName, ModifyThreadSchema } from "../tools.js";

function pull(name: string) {
  const def = getToolByName(name);
  if (!def) {
    throw new Error(`Tool definition missing: ${name}`);
  }
  return { description: def.description, scopes: def.scopes, annotations: def.annotations };
}

export function registerThreadTools(
  server: McpServer,
  gmail: gmail_v1.Gmail,
  authorizedScopes: readonly string[],
): void {
  const modifyThread = pull("modify_thread");
  defineTool(
    server,
    "modify_thread",
    modifyThread.description,
    ModifyThreadSchema.shape,
    async (args) => {
      const requestBody: Record<string, unknown> = {};
      if (args.addLabelIds) {
        requestBody.addLabelIds = args.addLabelIds;
      }
      if (args.removeLabelIds) {
        requestBody.removeLabelIds = args.removeLabelIds;
      }
      await gmail.users.threads.modify({
        userId: "me",
        id: args.threadId,
        requestBody,
      });
      return {
        content: [
          {
            type: "text",
            text: `Thread ${args.threadId} labels updated successfully (all messages in thread modified)`,
          },
        ],
      };
    },
    modifyThread.annotations,
    modifyThread.scopes,
    authorizedScopes,
  );
}
