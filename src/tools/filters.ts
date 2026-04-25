/**
 * Filter-domain tool registrars. PR #3 introduced the file with
 * `delete_filter` (trivial wrapper). PR #4 extends with the four
 * remaining filter tools (`create_filter` with the recipient-pairing
 * forward gate, `list_filters`, `get_filter`,
 * `create_filter_from_template`). Once every filter tool lives here,
 * PR #7 deletes the corresponding switch arms from the legacy
 * dispatcher in `src/index.ts`.
 */

import type { gmail_v1 } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool } from "./_shared.js";
import {
  getToolByName,
  CreateFilterSchema,
  ListFiltersSchema,
  GetFilterSchema,
  DeleteFilterSchema,
  CreateFilterFromTemplateSchema,
} from "../tools.js";
import {
  createFilter,
  deleteFilter,
  listFilters,
  getFilter,
  filterTemplates,
} from "../filter-manager.js";
import { requirePairedRecipients } from "../recipient-pairing.js";

function pull(name: string) {
  const def = getToolByName(name);
  if (!def) {
    throw new Error(`Tool definition missing: ${name}`);
  }
  return { description: def.description, scopes: def.scopes, annotations: def.annotations };
}

// Format a record as `key: value, key2: value2` — used for both the
// criteria block and the action block in the create/list/get filter
// renderings. Skips undefined values and empty arrays so the printed
// output stays terse instead of "addLabelIds: []".
function formatRecord(rec: Record<string, unknown>): string {
  return Object.entries(rec)
    .filter(([_, value]) => {
      if (value === undefined) return false;
      if (Array.isArray(value) && value.length === 0) return false;
      return true;
    })
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`)
    .join(", ");
}

export function registerFilterTools(
  server: McpServer,
  gmail: gmail_v1.Gmail,
  authorizedScopes: readonly string[],
): void {
  // delete_filter — PR #3
  const deleteFilterDef = pull("delete_filter");
  defineTool(
    server,
    "delete_filter",
    deleteFilterDef.description,
    DeleteFilterSchema.shape,
    async (args) => {
      const result = await deleteFilter(gmail, args.filterId);
      return { content: [{ type: "text", text: result.message }] };
    },
    deleteFilterDef.annotations,
    deleteFilterDef.scopes,
    authorizedScopes,
  );

  // create_filter — PR #4 (with recipient-pairing forward gate)
  const createFilterDef = pull("create_filter");
  defineTool(
    server,
    "create_filter",
    createFilterDef.description,
    CreateFilterSchema.shape,
    async (args) => {
      // Forward action gate: when GMAIL_MCP_RECIPIENT_PAIRING=true,
      // installing a server-side forwarding rule requires the
      // destination to be paired (mirrors send_email / reply_all /
      // draft_email). Closes the prompt-injection-driven exfil
      // channel on the create_filter surface.
      if (args.action.forward) {
        requirePairedRecipients([args.action.forward]);
      }
      const result = await createFilter(gmail, args.criteria, args.action);
      const criteriaText = formatRecord(args.criteria);
      const actionText = formatRecord(args.action);
      return {
        content: [
          {
            type: "text",
            text: `Filter created successfully:\nID: ${result.id}\nCriteria: ${criteriaText}\nActions: ${actionText}`,
          },
        ],
      };
    },
    createFilterDef.annotations,
    createFilterDef.scopes,
    authorizedScopes,
  );

  // list_filters — PR #4
  const listFiltersDef = pull("list_filters");
  defineTool(
    server,
    "list_filters",
    listFiltersDef.description,
    ListFiltersSchema.shape,
    async () => {
      const result = await listFilters(gmail);
      const filters = result.filters;
      if (filters.length === 0) {
        return { content: [{ type: "text", text: "No filters found." }] };
      }
      const filtersText = filters
        .map((filter) => {
          const criteriaEntries = formatRecord((filter.criteria || {}) as Record<string, unknown>);
          const actionEntries = formatRecord((filter.action || {}) as Record<string, unknown>);
          return `ID: ${filter.id}\nCriteria: ${criteriaEntries}\nActions: ${actionEntries}\n`;
        })
        .join("\n");
      return {
        content: [{ type: "text", text: `Found ${result.count} filters:\n\n${filtersText}` }],
      };
    },
    listFiltersDef.annotations,
    listFiltersDef.scopes,
    authorizedScopes,
  );

  // get_filter — PR #4
  const getFilterDef = pull("get_filter");
  defineTool(
    server,
    "get_filter",
    getFilterDef.description,
    GetFilterSchema.shape,
    async (args) => {
      const result = await getFilter(gmail, args.filterId);
      const criteriaText = formatRecord((result.criteria || {}) as Record<string, unknown>);
      const actionText = formatRecord((result.action || {}) as Record<string, unknown>);
      return {
        content: [
          {
            type: "text",
            text: `Filter details:\nID: ${result.id}\nCriteria: ${criteriaText}\nActions: ${actionText}`,
          },
        ],
      };
    },
    getFilterDef.annotations,
    getFilterDef.scopes,
    authorizedScopes,
  );

  // create_filter_from_template — PR #4
  const fromTemplateDef = pull("create_filter_from_template");
  defineTool(
    server,
    "create_filter_from_template",
    fromTemplateDef.description,
    CreateFilterFromTemplateSchema.shape,
    async (args) => {
      const template = args.template;
      const params = args.parameters;
      let filterConfig;
      switch (template) {
        case "fromSender":
          if (!params.senderEmail) {
            throw new Error("senderEmail is required for fromSender template");
          }
          filterConfig = filterTemplates.fromSender(
            params.senderEmail,
            params.labelIds,
            params.archive,
          );
          break;
        case "withSubject":
          if (!params.subjectText) {
            throw new Error("subjectText is required for withSubject template");
          }
          filterConfig = filterTemplates.withSubject(
            params.subjectText,
            params.labelIds,
            params.markAsRead,
          );
          break;
        case "withAttachments":
          filterConfig = filterTemplates.withAttachments(params.labelIds);
          break;
        case "largeEmails":
          if (!params.sizeInBytes) {
            throw new Error("sizeInBytes is required for largeEmails template");
          }
          filterConfig = filterTemplates.largeEmails(params.sizeInBytes, params.labelIds);
          break;
        case "containingText":
          if (!params.searchText) {
            throw new Error("searchText is required for containingText template");
          }
          filterConfig = filterTemplates.containingText(
            params.searchText,
            params.labelIds,
            params.markImportant,
          );
          break;
        case "mailingList":
          if (!params.listIdentifier) {
            throw new Error("listIdentifier is required for mailingList template");
          }
          filterConfig = filterTemplates.mailingList(
            params.listIdentifier,
            params.labelIds,
            params.archive,
          );
          break;
        default:
          throw new Error(`Unknown template: ${String(template)}`);
      }
      const result = await createFilter(gmail, filterConfig.criteria, filterConfig.action);
      return {
        content: [
          {
            type: "text",
            text: `Filter created from template '${template}':\nID: ${result.id}\nTemplate used: ${template}`,
          },
        ],
      };
    },
    fromTemplateDef.annotations,
    fromTemplateDef.scopes,
    authorizedScopes,
  );
}
