/**
 * Drafts-domain tool registrars: `list_drafts`, `get_draft`,
 * `update_draft`, `delete_draft`, `send_draft`. Extends the existing
 * `draft_email` (create) registered in `messaging.ts` so the full
 * surface is now covered.
 *
 * Each tool maps 1:1 to a `gmail.users.drafts.*` endpoint.
 * `update_draft` reuses `buildEncodedRawMessage` from `email-send.ts`
 * to assemble the same RFC 822 payload the create path produces, then
 * routes the recipient-pairing gate through `requirePairedRecipients`
 * so the same allowlist guards both create and update.
 */

import type { gmail_v1 } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, pullToolMeta as pull } from "./_shared.js";
import {
  ListDraftsSchema,
  GetDraftSchema,
  UpdateDraftSchema,
  DeleteDraftSchema,
  SendDraftSchema,
} from "../tools.js";
import { buildEncodedRawMessage, type EmailSendArgs } from "../email-send.js";
import { isPairingEnabled, requirePairedRecipients } from "../recipient-pairing.js";
import { resolveDefaultSender } from "../sender-resolver.js";
import { asGmailApiError } from "../gmail-errors.js";
import { parseEmailAddresses } from "../reply-all-helpers.js";

export function registerDraftTools(
  server: McpServer,
  gmail: gmail_v1.Gmail,
  authorizedScopes: readonly string[],
): void {
  // list_drafts
  const listDrafts = pull("list_drafts");
  defineTool(
    server,
    "list_drafts",
    listDrafts.description,
    ListDraftsSchema.shape,
    async (args) => {
      try {
        const response = await gmail.users.drafts.list({
          userId: "me",
          maxResults: args.maxResults,
          ...(args.pageToken !== undefined && { pageToken: args.pageToken }),
          ...(args.q !== undefined && { q: args.q }),
          includeSpamTrash: args.includeSpamTrash,
        });
        const drafts = (response.data.drafts ?? []).map((d) => ({
          id: d.id ?? "",
          messageId: d.message?.id ?? "",
          threadId: d.message?.threadId ?? "",
        }));
        const result = {
          drafts,
          count: drafts.length,
          nextPageToken: response.data.nextPageToken ?? undefined,
          resultSizeEstimate: response.data.resultSizeEstimate ?? 0,
        };
        const lines = [
          `Drafts (${drafts.length}${result.nextPageToken ? "+" : ""}):`,
          ...drafts.map((d) => `  - ${d.id} (messageId=${d.messageId}, threadId=${d.threadId})`),
          ...(result.nextPageToken ? [`\nNext page token: ${result.nextPageToken}`] : []),
        ];
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: result,
        };
      } catch (error: unknown) {
        const { code, message } = asGmailApiError(error);
        const prefix =
          code !== undefined ? `Failed to list drafts (HTTP ${code})` : "Failed to list drafts";
        return {
          content: [{ type: "text", text: `${prefix}: ${message}` }],
          isError: true,
        };
      }
    },
    listDrafts.annotations,
    listDrafts.scopes,
    authorizedScopes,
  );

  // get_draft
  const getDraft = pull("get_draft");
  defineTool(
    server,
    "get_draft",
    getDraft.description,
    GetDraftSchema.shape,
    async (args) => {
      try {
        const response = await gmail.users.drafts.get({
          userId: "me",
          id: args.id,
          format: args.format,
        });
        const draft = response.data;
        const message = draft.message;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  id: draft.id,
                  message,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error: unknown) {
        const { code, message } = asGmailApiError(error);
        const prefix =
          code !== undefined ? `Failed to get draft (HTTP ${code})` : "Failed to get draft";
        return {
          content: [{ type: "text", text: `${prefix}: ${message}` }],
          isError: true,
        };
      }
    },
    getDraft.annotations,
    getDraft.scopes,
    authorizedScopes,
  );

  // update_draft
  const updateDraft = pull("update_draft");
  defineTool(
    server,
    "update_draft",
    updateDraft.description,
    UpdateDraftSchema.shape,
    async (args) => {
      try {
        // Recipient-pairing gate, same as `send_email` / `draft_email`
        // / `reply_all`. Update is a write surface and an attacker
        // who escapes the create gate could otherwise launder a send
        // through update + send_draft. Pin the gate at update time.
        requirePairedRecipients([...(args.to ?? []), ...(args.cc ?? []), ...(args.bcc ?? [])]);

        // Mirror sendOrDraftEmail's `from` resolution path so an agent
        // that already calls draft_email without `from` keeps the
        // exact same outbound display name when it later updates.
        const validatedArgs: EmailSendArgs = { ...args };
        if (!validatedArgs.from || validatedArgs.from.trim() === "") {
          validatedArgs.from = await resolveDefaultSender(gmail);
        }

        // CR finding (PR #100): if the caller supplies `threadId`
        // without explicit `inReplyTo` / `references`, mirror the
        // sendOrDraftEmail behaviour and backfill those headers
        // from the thread's existing messages BEFORE encoding.
        // Without this, updating a threaded draft strips the
        // `In-Reply-To` / `References` headers from the regenerated
        // raw message — when the draft is later sent, the recipient
        // sees an orphaned reply detached from its conversation. The
        // try/catch + console.warn pattern matches sendOrDraftEmail
        // so a thread-fetch failure is logged and the encode
        // continues degraded (no threading) rather than failing the
        // whole update.
        if (validatedArgs.threadId && !validatedArgs.inReplyTo) {
          try {
            const threadResponse = await gmail.users.threads.get({
              userId: "me",
              id: validatedArgs.threadId,
              format: "metadata",
              metadataHeaders: ["Message-ID"],
            });
            const threadMessages = threadResponse.data.messages || [];
            if (threadMessages.length > 0) {
              const allMessageIds: string[] = [];
              for (const msg of threadMessages) {
                const msgHeaders = msg.payload?.headers || [];
                const messageIdHeader = msgHeaders.find(
                  (h) => h.name?.toLowerCase() === "message-id",
                );
                if (messageIdHeader?.value) {
                  allMessageIds.push(messageIdHeader.value);
                }
              }
              const lastMessage = threadMessages[threadMessages.length - 1];
              const lastHeaders = lastMessage?.payload?.headers || [];
              const lastMessageId = lastHeaders.find(
                (h) => h.name?.toLowerCase() === "message-id",
              )?.value;
              if (lastMessageId) {
                validatedArgs.inReplyTo = lastMessageId;
              }
              if (allMessageIds.length > 0) {
                validatedArgs.references = allMessageIds.join(" ");
              }
            }
          } catch (threadError: unknown) {
            const msg = threadError instanceof Error ? threadError.message : String(threadError);
            console.warn(
              `Warning: Could not fetch thread ${validatedArgs.threadId} for header resolution: ${msg}`,
            );
            // Degraded: encode without threading headers.
          }
        }

        const encodedMessage = await buildEncodedRawMessage(validatedArgs);

        const response = await gmail.users.drafts.update({
          userId: "me",
          id: args.id,
          requestBody: {
            id: args.id,
            message: {
              raw: encodedMessage,
              ...(validatedArgs.threadId && { threadId: validatedArgs.threadId }),
            },
          },
        });

        return {
          content: [
            {
              type: "text",
              text: `Draft ${response.data.id ?? args.id} updated successfully (new messageId: ${response.data.message?.id ?? "unknown"}).`,
            },
          ],
        };
      } catch (error: unknown) {
        const { code, message } = asGmailApiError(error);
        const prefix =
          code !== undefined ? `Failed to update draft (HTTP ${code})` : "Failed to update draft";
        return {
          content: [{ type: "text", text: `${prefix}: ${message}` }],
          isError: true,
        };
      }
    },
    updateDraft.annotations,
    updateDraft.scopes,
    authorizedScopes,
  );

  // delete_draft
  const deleteDraft = pull("delete_draft");
  defineTool(
    server,
    "delete_draft",
    deleteDraft.description,
    DeleteDraftSchema.shape,
    async (args) => {
      try {
        await gmail.users.drafts.delete({
          userId: "me",
          id: args.id,
        });
        return {
          content: [
            {
              type: "text",
              text: `Draft ${args.id} deleted permanently.`,
            },
          ],
        };
      } catch (error: unknown) {
        const { code, message } = asGmailApiError(error);
        const prefix =
          code !== undefined ? `Failed to delete draft (HTTP ${code})` : "Failed to delete draft";
        return {
          content: [{ type: "text", text: `${prefix}: ${message}` }],
          isError: true,
        };
      }
    },
    deleteDraft.annotations,
    deleteDraft.scopes,
    authorizedScopes,
  );

  // send_draft
  const sendDraft = pull("send_draft");
  defineTool(
    server,
    "send_draft",
    sendDraft.description,
    SendDraftSchema.shape,
    async (args) => {
      try {
        // Recipient-pairing gate at send time. CR finding (PR #100):
        // without this, an attacker who has the create or update
        // capability can stage a draft addressed to an unpaired
        // recipient, then call `send_draft` to bypass the allowlist
        // entirely (the create / update gate runs against
        // attacker-supplied args; send_draft consumes a
        // server-resident draft that may have been addressed
        // off-allowlist via the Gmail UI or a separate session).
        //
        // CR follow-up (PR #100): the gate ONLY runs when
        // `GMAIL_MCP_RECIPIENT_PAIRING=true`. Skipping the
        // pre-flight `drafts.get` when pairing is disabled saves
        // an unconditional API round-trip per send_draft call —
        // the dominant cost on every send for the 99 % of
        // operators who don't enable the gate.
        //
        // CR security follow-up (PR #100): use `format: "full"`
        // rather than `metadata`. Gmail's `metadata` projection
        // can omit the `Bcc` header — that field is normally
        // stripped from sent messages (it's the whole point of
        // Bcc), and the Gmail API documentation does not
        // guarantee its presence on a draft's metadata response
        // either. Without `Bcc`, an attacker who stages a draft
        // with an unpaired `Bcc` recipient (via the Gmail UI, a
        // different agent session, or a prior `update_draft`
        // call) would slip through this gate and reach the actual
        // `drafts.send`. `format: "full"` includes the entire
        // payload tree, so all original headers — including the
        // load-bearing `Bcc` — round-trip to the client. The
        // extra body bytes are negligible vs the safety floor.
        if (isPairingEnabled()) {
          const draftResponse = await gmail.users.drafts.get({
            userId: "me",
            id: args.id,
            format: "full",
          });
          const headers = draftResponse.data.message?.payload?.headers ?? [];
          const headerValue = (name: string): string =>
            headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
          const recipients = [
            ...parseEmailAddresses(headerValue("to")),
            ...parseEmailAddresses(headerValue("cc")),
            ...parseEmailAddresses(headerValue("bcc")),
          ];
          requirePairedRecipients(recipients);
        }

        const response = await gmail.users.drafts.send({
          userId: "me",
          requestBody: { id: args.id },
        });
        return {
          content: [
            {
              type: "text",
              text: `Draft ${args.id} sent successfully (messageId: ${response.data.id ?? "unknown"}, threadId: ${response.data.threadId ?? "unknown"}).`,
            },
          ],
        };
      } catch (error: unknown) {
        const { code, message } = asGmailApiError(error);
        const prefix =
          code !== undefined ? `Failed to send draft (HTTP ${code})` : "Failed to send draft";
        return {
          content: [{ type: "text", text: `${prefix}: ${message}` }],
          isError: true,
        };
      }
    },
    sendDraft.annotations,
    sendDraft.scopes,
    authorizedScopes,
  );
}
