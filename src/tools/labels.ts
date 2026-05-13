/**
 * Label-domain tool registrars. PR #3 introduced the file with
 * `delete_label` (trivial wrapper). PR #4 extends with the four
 * remaining label tools (`create_label`, `update_label`,
 * `get_or_create_label`, `list_email_labels`). Once every label tool
 * lives here, PR #7 deletes the corresponding switch arms from the
 * legacy dispatcher in `src/index.ts`.
 */

import type { gmail_v1 } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, pullToolMeta as pull } from "./_shared.js";
import {
  CreateLabelSchema,
  UpdateLabelSchema,
  DeleteLabelSchema,
  GetOrCreateLabelSchema,
  ListEmailLabelsSchema,
} from "../tools.js";
import {
  createLabel,
  updateLabel,
  deleteLabel,
  listLabels,
  getOrCreateLabel,
  type GmailLabel,
} from "../label-manager.js";

export function registerLabelTools(
  server: McpServer,
  gmail: gmail_v1.Gmail,
  authorizedScopes: readonly string[],
): void {
  // delete_label — PR #3
  const deleteLabelDefinition = pull("delete_label");
  defineTool(
    server,
    "delete_label",
    deleteLabelDefinition.description,
    DeleteLabelSchema.shape,
    async (args) => {
      const result = await deleteLabel(gmail, args.id);
      return { content: [{ type: "text", text: result.message }] };
    },
    deleteLabelDefinition.annotations,
    deleteLabelDefinition.scopes,
    authorizedScopes,
  );

  // create_label — PR #4
  const createLabelDefinition = pull("create_label");
  defineTool(
    server,
    "create_label",
    createLabelDefinition.description,
    CreateLabelSchema.shape,
    async (args) => {
      const result = await createLabel(gmail, args.name, {
        messageListVisibility: args.messageListVisibility,
        labelListVisibility: args.labelListVisibility,
      });
      return {
        content: [
          {
            type: "text",
            text: `Label created successfully:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`,
          },
        ],
      };
    },
    createLabelDefinition.annotations,
    createLabelDefinition.scopes,
    authorizedScopes,
  );

  // update_label — PR #4
  const updateLabelDefinition = pull("update_label");
  defineTool(
    server,
    "update_label",
    updateLabelDefinition.description,
    UpdateLabelSchema.shape,
    async (args) => {
      const updates: Record<string, unknown> = {};
      if (args.name) updates.name = args.name;
      if (args.messageListVisibility) {
        updates.messageListVisibility = args.messageListVisibility;
      }
      if (args.labelListVisibility) {
        updates.labelListVisibility = args.labelListVisibility;
      }
      const result = await updateLabel(gmail, args.id, updates);
      return {
        content: [
          {
            type: "text",
            text: `Label updated successfully:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`,
          },
        ],
      };
    },
    updateLabelDefinition.annotations,
    updateLabelDefinition.scopes,
    authorizedScopes,
  );

  // get_or_create_label — PR #4
  const getOrCreateDefinition = pull("get_or_create_label");
  defineTool(
    server,
    "get_or_create_label",
    getOrCreateDefinition.description,
    GetOrCreateLabelSchema.shape,
    async (args) => {
      const { label, found } = await getOrCreateLabel(gmail, args.name, {
        messageListVisibility: args.messageListVisibility,
        labelListVisibility: args.labelListVisibility,
      });
      const action = found ? "found existing" : "created new";
      return {
        content: [
          {
            type: "text",
            text: `Successfully ${action} label:\nID: ${label.id}\nName: ${label.name}\nType: ${label.type}`,
          },
        ],
      };
    },
    getOrCreateDefinition.annotations,
    getOrCreateDefinition.scopes,
    authorizedScopes,
  );

  // list_email_labels — PR #4
  const listLabelsDefinition = pull("list_email_labels");
  defineTool(
    server,
    "list_email_labels",
    listLabelsDefinition.description,
    ListEmailLabelsSchema.shape,
    async () => {
      const labelResults = await listLabels(gmail);
      const systemLabels = labelResults.system;
      const userLabels = labelResults.user;
      return {
        content: [
          {
            type: "text",
            text:
              `Found ${labelResults.count.total} labels (${labelResults.count.system} system, ${labelResults.count.user} user):\n\n` +
              "System Labels:\n" +
              systemLabels.map((l: GmailLabel) => `ID: ${l.id}\nName: ${l.name}\n`).join("\n") +
              "\nUser Labels:\n" +
              userLabels.map((l: GmailLabel) => `ID: ${l.id}\nName: ${l.name}\n`).join("\n"),
          },
        ],
      };
    },
    listLabelsDefinition.annotations,
    listLabelsDefinition.scopes,
    authorizedScopes,
  );
}
