/**
 * Message-domain tool registrars. PR #3 introduced the file with
 * `delete_email`. PR #5 extends with `read_email`, `search_emails`,
 * `modify_email`, `batch_modify_emails`, `batch_delete_emails`. Once
 * every message-domain tool lives here, PR #7 deletes the
 * corresponding switch arms from the legacy dispatcher in
 * `src/index.ts`.
 */

import type { gmail_v1 } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, pullToolMeta as pull } from "./_shared.js";
import {
  DeleteEmailSchema,
  ReadEmailSchema,
  SearchEmailsSchema,
  ModifyEmailSchema,
  BatchModifyEmailsSchema,
  BatchDeleteEmailsSchema,
} from "../tools.js";
import { extractHeaders } from "../gmail-headers.js";
import { pickBody, HTML_FALLBACK_NOTE } from "../utl.js";
import { extractEmailContent, extractAttachments } from "../mime-walkers.js";
import { processBatches } from "../batch.js";

type GmailMessagePart = gmail_v1.Schema$MessagePart;

export function registerMessageTools(
  server: McpServer,
  gmail: gmail_v1.Gmail,
  authorizedScopes: readonly string[],
): void {
  // delete_email — PR #3
  const deleteEmail = pull("delete_email");
  defineTool(
    server,
    "delete_email",
    deleteEmail.description,
    DeleteEmailSchema.shape,
    async (args) => {
      await gmail.users.messages.delete({ userId: "me", id: args.messageId });
      return {
        content: [{ type: "text", text: `Email ${args.messageId} deleted successfully` }],
      };
    },
    deleteEmail.annotations,
    deleteEmail.scopes,
    authorizedScopes,
  );

  // read_email — PR #5 (the complex one, multi-byte-safe truncation)
  const readEmail = pull("read_email");
  defineTool(
    server,
    "read_email",
    readEmail.description,
    ReadEmailSchema.shape,
    async (args) => {
      const response = await gmail.users.messages.get({
        userId: "me",
        id: args.messageId,
        format: "full",
      });
      const { subject, from, to, date, rfcMessageId } = extractHeaders(response.data.payload);
      const threadId = response.data.threadId || "";
      const headerBlock = `Thread ID: ${threadId}\nMessage-ID: ${rfcMessageId}\nSubject: ${subject}\nFrom: ${from}\nTo: ${to}\nDate: ${date}`;

      if (args.format === "headers_only") {
        return { content: [{ type: "text", text: headerBlock }] };
      }

      const { text, html } = extractEmailContent((response.data.payload as GmailMessagePart) || {});
      const { body, source } = pickBody(text, html);
      const contentTypeNote = source === "html" ? HTML_FALLBACK_NOTE : "";

      // Byte-based cap so the threshold lines up with Gmail's own
      // "[Message clipped]" rule (which is byte-based on raw text+HTML)
      // and so multi-byte characters do not quietly balloon the
      // char-count past the MCP response cap.
      const bodyBytes = Buffer.byteLength(body, "utf-8");
      const hardCap = args.format === "summary" ? 500 : args.maxBodyLength;
      let displayBody = body;
      let truncationNote = "";
      if (hardCap > 0 && bodyBytes > hardCap) {
        // Slice on a byte boundary, then let TextDecoder drop any
        // trailing incomplete multi-byte sequence — that way a
        // truncated emoji or accent does not produce an invisible
        // U+FFFD replacement character in the output.
        const buf = Buffer.from(body, "utf-8").subarray(0, hardCap);
        displayBody = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(buf);
        if (displayBody.endsWith("�")) {
          displayBody = displayBody.slice(0, -1);
        }
        const remainingBytes = bodyBytes - hardCap;
        const remainingKB = Math.round((remainingBytes / 1024) * 10) / 10;
        const marker =
          args.format === "summary"
            ? `\n\n[Summary truncated at 500 bytes — ${remainingKB.toLocaleString("en-US")} KB more.]`
            : `\n\n[Message clipped — ${remainingKB.toLocaleString("en-US")} KB more. Gmail clips at 102 KB in its own UI. Call download_email(messageId: "${args.messageId}") to save the full payload to disk, or re-call read_email with maxBodyLength: 0 to disable truncation.]`;
        truncationNote = marker;
      }

      const attachments =
        args.includeAttachments && args.format !== "summary"
          ? extractAttachments(response.data.payload as GmailMessagePart)
          : [];
      const attachmentInfo =
        attachments.length > 0
          ? `\n\nAttachments (${attachments.length}):\n` +
            attachments
              .map(
                (a) =>
                  `- ${a.filename} (${a.mimeType}, ${Math.round(a.size / 1024)} KB, ID: ${a.id})`,
              )
              .join("\n")
          : "";

      return {
        content: [
          {
            type: "text",
            text: `${headerBlock}\n\n${contentTypeNote}${displayBody}${truncationNote}${attachmentInfo}`,
          },
        ],
      };
    },
    readEmail.annotations,
    readEmail.scopes,
    authorizedScopes,
  );

  // search_emails — PR #5
  const searchEmails = pull("search_emails");
  defineTool(
    server,
    "search_emails",
    searchEmails.description,
    SearchEmailsSchema.shape,
    async (args) => {
      const response = await gmail.users.messages.list({
        userId: "me",
        q: args.query,
        maxResults: args.maxResults || 10,
      });
      const messages = response.data.messages || [];
      const results = await Promise.all(
        messages.map(async (msg) => {
          const detail = await gmail.users.messages.get({
            userId: "me",
            id: msg.id!,
            format: "metadata",
            metadataHeaders: ["Subject", "From", "Date"],
          });
          const headers = detail.data.payload?.headers || [];
          return {
            id: msg.id,
            subject: headers.find((h) => h.name === "Subject")?.value || "",
            from: headers.find((h) => h.name === "From")?.value || "",
            date: headers.find((h) => h.name === "Date")?.value || "",
          };
        }),
      );
      return {
        content: [
          {
            type: "text",
            text: results
              .map((r) => `ID: ${r.id}\nSubject: ${r.subject}\nFrom: ${r.from}\nDate: ${r.date}\n`)
              .join("\n"),
          },
        ],
      };
    },
    searchEmails.annotations,
    searchEmails.scopes,
    authorizedScopes,
  );

  // modify_email — PR #5
  const modifyEmail = pull("modify_email");
  defineTool(
    server,
    "modify_email",
    modifyEmail.description,
    ModifyEmailSchema.shape,
    async (args) => {
      // ModifyEmailSchema exposes BOTH `labelIds` (legacy "apply
      // these labels" naming inherited from the GongRzhe fork chain)
      // AND `addLabelIds` (Gmail-API-aligned "add these labels"
      // naming). The Gmail API only accepts `addLabelIds`, so both
      // schema fields map onto the same request payload key. When a
      // caller supplies both, merge into a deduplicated set rather
      // than letting the second overwrite the first — the caller
      // clearly meant "all of these", and silently dropping half the
      // request would be a foot-gun. Mirrors the underlying Gmail
      // API's union-of-labels semantics. CR finding on PR #84.
      const requestBody: Record<string, unknown> = {};
      const additions: string[] = [];
      if (args.labelIds) additions.push(...args.labelIds);
      if (args.addLabelIds) additions.push(...args.addLabelIds);
      if (additions.length > 0) {
        requestBody.addLabelIds = Array.from(new Set(additions));
      }
      if (args.removeLabelIds) requestBody.removeLabelIds = args.removeLabelIds;
      await gmail.users.messages.modify({ userId: "me", id: args.messageId, requestBody });
      return {
        content: [{ type: "text", text: `Email ${args.messageId} labels updated successfully` }],
      };
    },
    modifyEmail.annotations,
    modifyEmail.scopes,
    authorizedScopes,
  );

  // batch_modify_emails — PR #5
  const batchModify = pull("batch_modify_emails");
  defineTool(
    server,
    "batch_modify_emails",
    batchModify.description,
    BatchModifyEmailsSchema.shape,
    async (args) => {
      const requestBody: Record<string, unknown> = {};
      if (args.addLabelIds) requestBody.addLabelIds = args.addLabelIds;
      if (args.removeLabelIds) requestBody.removeLabelIds = args.removeLabelIds;
      const { successes, failures } = await processBatches(
        args.messageIds,
        args.batchSize ?? 50,
        async (batch) =>
          Promise.all(
            batch.map(async (messageId) => {
              await gmail.users.messages.modify({ userId: "me", id: messageId, requestBody });
              return { messageId, success: true };
            }),
          ),
      );
      let resultText = `Batch label modification complete.\n`;
      resultText += `Successfully processed: ${successes.length} messages\n`;
      if (failures.length > 0) {
        resultText += `Failed to process: ${failures.length} messages\n\n`;
        resultText += `Failed message IDs:\n`;
        resultText += failures
          .map((f) => `- ${f.item.substring(0, 16)}... (${f.error.message})`)
          .join("\n");
      }
      return { content: [{ type: "text", text: resultText }] };
    },
    batchModify.annotations,
    batchModify.scopes,
    authorizedScopes,
  );

  // batch_delete_emails — PR #5
  const batchDelete = pull("batch_delete_emails");
  defineTool(
    server,
    "batch_delete_emails",
    batchDelete.description,
    BatchDeleteEmailsSchema.shape,
    async (args) => {
      const { successes, failures } = await processBatches(
        args.messageIds,
        args.batchSize ?? 50,
        async (batch) =>
          Promise.all(
            batch.map(async (messageId) => {
              await gmail.users.messages.delete({ userId: "me", id: messageId });
              return { messageId, success: true };
            }),
          ),
      );
      let resultText = `Batch delete operation complete.\n`;
      resultText += `Successfully deleted: ${successes.length} messages\n`;
      if (failures.length > 0) {
        resultText += `Failed to delete: ${failures.length} messages\n\n`;
        resultText += `Failed message IDs:\n`;
        resultText += failures
          .map((f) => `- ${f.item.substring(0, 16)}... (${f.error.message})`)
          .join("\n");
      }
      return { content: [{ type: "text", text: resultText }] };
    },
    batchDelete.annotations,
    batchDelete.scopes,
    authorizedScopes,
  );
}
