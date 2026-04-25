/**
 * Thread-domain tool registrars. PR #3 introduced the file with
 * `modify_thread`. PR #6 extends with `get_thread`,
 * `list_inbox_threads`, and `get_inbox_with_threads`. PR #7 deletes
 * the corresponding switch arms from the legacy dispatcher in
 * `src/index.ts`.
 */

import type { gmail_v1 } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, pullToolMeta as pull } from "./_shared.js";
import {
  ModifyThreadSchema,
  GetThreadSchema,
  ListInboxThreadsSchema,
  GetInboxWithThreadsSchema,
} from "../tools.js";
import { pickBodyAnnotated } from "../utl.js";
import { extractEmailContent, collectAttachmentsForThread } from "../mime-walkers.js";

type GmailMessagePart = gmail_v1.Schema$MessagePart;

function getH(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

export function registerThreadTools(
  server: McpServer,
  gmail: gmail_v1.Gmail,
  authorizedScopes: readonly string[],
): void {
  // modify_thread — PR #3
  const modifyThread = pull("modify_thread");
  defineTool(
    server,
    "modify_thread",
    modifyThread.description,
    ModifyThreadSchema.shape,
    async (args) => {
      const requestBody: Record<string, unknown> = {};
      if (args.addLabelIds) requestBody.addLabelIds = args.addLabelIds;
      if (args.removeLabelIds) requestBody.removeLabelIds = args.removeLabelIds;
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

  // get_thread — PR #6
  const getThread = pull("get_thread");
  defineTool(
    server,
    "get_thread",
    getThread.description,
    GetThreadSchema.shape,
    async (args) => {
      const threadResponse = await gmail.users.threads.get({
        userId: "me",
        id: args.threadId,
        format: args.format || "full",
      });
      const threadMessages = threadResponse.data.messages || [];

      const messagesOutput = threadMessages.map((msg) => {
        const headers = msg.payload?.headers;
        const subject = getH(headers, "subject");
        const from = getH(headers, "from");
        const to = getH(headers, "to");
        const cc = getH(headers, "cc");
        const bcc = getH(headers, "bcc");
        const date = getH(headers, "date");

        let body = "";
        if (args.format !== "minimal") {
          const { text, html } = extractEmailContent((msg.payload as GmailMessagePart) || {});
          body = pickBodyAnnotated(text, html).body;
        }

        const attachments = msg.payload
          ? collectAttachmentsForThread(msg.payload, "get_thread.processAttachmentParts")
          : [];

        return {
          messageId: msg.id || "",
          threadId: msg.threadId || "",
          from,
          to,
          cc,
          bcc,
          subject,
          date,
          body,
          labelIds: msg.labelIds || [],
          attachments: attachments.map((a) => ({
            filename: a.filename,
            mimeType: a.mimeType,
            size: a.size,
          })),
        };
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                threadId: args.threadId,
                messageCount: messagesOutput.length,
                messages: messagesOutput,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
    getThread.annotations,
    getThread.scopes,
    authorizedScopes,
  );

  // list_inbox_threads — PR #6
  const listInboxThreads = pull("list_inbox_threads");
  defineTool(
    server,
    "list_inbox_threads",
    listInboxThreads.description,
    ListInboxThreadsSchema.shape,
    async (args) => {
      const threadsResponse = await gmail.users.threads.list({
        userId: "me",
        q: args.query || "in:inbox",
        maxResults: args.maxResults || 50,
      });
      const threads = threadsResponse.data.threads || [];

      const threadDetails = await Promise.all(
        threads.map(async (thread) => {
          const detail = await gmail.users.threads.get({
            userId: "me",
            id: thread.id!,
            format: "metadata",
            metadataHeaders: ["Subject", "From", "Date"],
          });
          const messages = detail.data.messages || [];
          const latestMessage = messages[messages.length - 1];
          const latestHeaders = latestMessage?.payload?.headers;

          return {
            threadId: thread.id || "",
            snippet: thread.snippet || "",
            historyId: thread.historyId || "",
            messageCount: messages.length,
            latestMessage: {
              from: getH(latestHeaders, "From"),
              subject: getH(latestHeaders, "Subject"),
              date: getH(latestHeaders, "Date"),
            },
          };
        }),
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { resultCount: threadDetails.length, threads: threadDetails },
              null,
              2,
            ),
          },
        ],
      };
    },
    listInboxThreads.annotations,
    listInboxThreads.scopes,
    authorizedScopes,
  );

  // get_inbox_with_threads — PR #6
  const getInboxWithThreads = pull("get_inbox_with_threads");
  defineTool(
    server,
    "get_inbox_with_threads",
    getInboxWithThreads.description,
    GetInboxWithThreadsSchema.shape,
    async (args) => {
      const threadsResponse = await gmail.users.threads.list({
        userId: "me",
        q: args.query || "in:inbox",
        maxResults: args.maxResults || 50,
      });
      const threads = threadsResponse.data.threads || [];

      if (!args.expandThreads) {
        const threadSummaries = await Promise.all(
          threads.map(async (thread) => {
            const detail = await gmail.users.threads.get({
              userId: "me",
              id: thread.id!,
              format: "metadata",
              metadataHeaders: ["Subject", "From", "Date"],
            });
            const messages = detail.data.messages || [];
            const latestMessage = messages[messages.length - 1];
            const latestHeaders = latestMessage?.payload?.headers;
            return {
              threadId: thread.id || "",
              snippet: thread.snippet || "",
              historyId: thread.historyId || "",
              messageCount: messages.length,
              latestMessage: {
                from: getH(latestHeaders, "From"),
                subject: getH(latestHeaders, "Subject"),
                date: getH(latestHeaders, "Date"),
              },
            };
          }),
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { resultCount: threadSummaries.length, threads: threadSummaries },
                null,
                2,
              ),
            },
          ],
        };
      }

      // Expand each thread with full message content (parallel fetch)
      const expandedThreads = await Promise.all(
        threads.map(async (thread) => {
          const threadDetail = await gmail.users.threads.get({
            userId: "me",
            id: thread.id!,
            format: "full",
          });
          const threadMessages = threadDetail.data.messages || [];
          const messages = threadMessages.map((msg) => {
            const headers = msg.payload?.headers;
            const subject = getH(headers, "subject");
            const from = getH(headers, "from");
            const to = getH(headers, "to");
            const cc = getH(headers, "cc");
            const bcc = getH(headers, "bcc");
            const date = getH(headers, "date");

            const { text, html } = extractEmailContent((msg.payload as GmailMessagePart) || {});
            const body = pickBodyAnnotated(text, html).body;

            const attachments = msg.payload
              ? collectAttachmentsForThread(
                  msg.payload,
                  "get_inbox_with_threads.processAttachmentParts",
                )
              : [];

            return {
              messageId: msg.id || "",
              threadId: msg.threadId || "",
              from,
              to,
              cc,
              bcc,
              subject,
              date,
              body,
              labelIds: msg.labelIds || [],
              attachments: attachments.map((a) => ({
                filename: a.filename,
                mimeType: a.mimeType,
                size: a.size,
              })),
            };
          });
          return {
            threadId: thread.id || "",
            messageCount: messages.length,
            messages,
          };
        }),
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { resultCount: expandedThreads.length, threads: expandedThreads },
              null,
              2,
            ),
          },
        ],
      };
    },
    getInboxWithThreads.annotations,
    getInboxWithThreads.scopes,
    authorizedScopes,
  );
}
