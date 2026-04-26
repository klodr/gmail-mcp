/**
 * Send-or-draft pipeline for `send_email`, `draft_email`, and `reply_all`.
 *
 * Extracted from the legacy `CallToolRequestSchema` switch in
 * `src/index.ts` so the same code path can be exercised by unit tests
 * without spinning the whole MCP dispatcher (which calls main() on
 * module load and depends on environment-driven OAuth state).
 *
 * Three call sites consume `sendOrDraftEmail`:
 *   - `send_email` tool    → action: "send"
 *   - `draft_email` tool   → action: "draft"
 *   - `reply_all` tool     → action: "send" (after rebuilding To/Cc and
 *                            attaching In-Reply-To / References)
 *
 * The `gmail` client is passed in (rather than closed over) so the
 * function is reusable across multiple OAuth identities and trivially
 * mockable in tests.
 */

import type { gmail_v1 } from "googleapis";
import { ValidatedEmailArgs, createEmailMessage, createEmailWithNodemailer } from "./utl.js";
import { resolveDefaultSender } from "./sender-resolver.js";
import { requirePairedRecipients } from "./recipient-pairing.js";
import { asGmailApiError } from "./gmail-errors.js";

export type EmailAction = "send" | "draft";

export interface EmailSendArgs extends ValidatedEmailArgs {
  threadId?: string;
  inReplyTo?: string;
}

export interface EmailSendResult {
  content: Array<{ type: "text"; text: string }>;
}

/**
 * Assemble + base64url-encode the RFC 822 representation of a
 * message. Picks the Nodemailer pipeline when the message carries
 * attachments (multipart MIME assembly is non-trivial) and the
 * lighter `createEmailMessage` path otherwise. Extracted so the
 * `update_draft` handler can produce the exact same encoded payload
 * `sendOrDraftEmail` would have produced — Gmail's
 * `users.drafts.update` takes the same `{ raw, threadId? }` shape as
 * `users.messages.send` / `users.drafts.create`.
 */
export async function buildEncodedRawMessage(args: EmailSendArgs): Promise<string> {
  const message =
    args.attachments && args.attachments.length > 0
      ? await createEmailWithNodemailer(args)
      : createEmailMessage(args);
  return Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Send a Gmail message or save it as a draft.
 *
 * Mutates `validatedArgs` in place when:
 *   - `from` is empty/missing → resolved via `resolveDefaultSender(gmail)`
 *   - `threadId` is set but `inReplyTo` is not → both `inReplyTo` and
 *     `references` are populated from the thread's existing messages
 *
 * Throws on:
 *   - recipient-pairing gate violation (when `GMAIL_MCP_RECIPIENT_PAIRING=true`
 *     and any To/Cc/Bcc address is not in `~/.gmail-mcp/paired.json`)
 *   - any Gmail API error from `messages.send` / `drafts.create`
 *
 * Thread-header resolution failures are logged to stderr and the send
 * continues without `In-Reply-To` / `References` (degraded but not broken).
 */
export async function sendOrDraftEmail(
  gmail: gmail_v1.Gmail,
  action: EmailAction,
  validatedArgs: EmailSendArgs,
): Promise<EmailSendResult> {
  let message: string;

  try {
    // Recipient pairing gate — no-op unless
    // GMAIL_MCP_RECIPIENT_PAIRING=true. When enabled, every
    // To/Cc/Bcc address must appear in ~/.gmail-mcp/paired.json
    // (manage via the `pair_recipient` tool). Caps the blast
    // radius of a prompt-injection-driven send.
    requirePairedRecipients([
      ...(validatedArgs.to ?? []),
      ...(validatedArgs.cc ?? []),
      ...(validatedArgs.bcc ?? []),
    ]);

    // Resolve `from` from the user's default send-as alias (with
    // displayName) when the caller didn't specify one. Using the
    // literal "me" works for the envelope but renders a bare
    // email address in the recipient's `From:` header — see
    // GongRzhe/Gmail-MCP-Server#77. Scope-degraded: on
    // `gmail.send`-only tokens the sendAs/getProfile calls fail
    // and we fall back to "me" (original behaviour).
    if (!validatedArgs.from || validatedArgs.from.trim() === "") {
      validatedArgs.from = await resolveDefaultSender(gmail);
    }

    // Auto-resolve threading headers when threadId is provided but inReplyTo is missing
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
          // Collect all Message-ID values for the References chain
          const allMessageIds: string[] = [];
          for (const msg of threadMessages) {
            const msgHeaders = msg.payload?.headers || [];
            const messageIdHeader = msgHeaders.find((h) => h.name?.toLowerCase() === "message-id");
            if (messageIdHeader?.value) {
              allMessageIds.push(messageIdHeader.value);
            }
          }

          // Last message's Message-ID becomes In-Reply-To.
          // threadMessages.length > 0 is guaranteed by the outer if;
          // the `?.` keeps the compiler happy under noUncheckedIndexedAccess.
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
        // Continue without threading headers - degraded but not broken
      }
    }

    // Check if we have attachments
    if (validatedArgs.attachments && validatedArgs.attachments.length > 0) {
      // Use Nodemailer to create properly formatted RFC822 message
      message = await createEmailWithNodemailer(validatedArgs);

      const encodedMessage = Buffer.from(message)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      if (action === "send") {
        const result = await gmail.users.messages.send({
          userId: "me",
          requestBody: {
            raw: encodedMessage,
            ...(validatedArgs.threadId && { threadId: validatedArgs.threadId }),
          },
        });

        return {
          content: [
            {
              type: "text",
              text: `Email sent successfully with ID: ${result.data.id}`,
            },
          ],
        };
      } else {
        const messageRequest = {
          raw: encodedMessage,
          ...(validatedArgs.threadId && { threadId: validatedArgs.threadId }),
        };

        const response = await gmail.users.drafts.create({
          userId: "me",
          requestBody: {
            message: messageRequest,
          },
        });
        return {
          content: [
            {
              type: "text",
              text: `Email draft created successfully with ID: ${response.data.id}`,
            },
          ],
        };
      }
    } else {
      // For emails without attachments, use the existing simple method
      message = createEmailMessage(validatedArgs);

      const encodedMessage = Buffer.from(message)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      interface GmailMessageRequest {
        raw: string;
        threadId?: string;
      }

      const messageRequest: GmailMessageRequest = {
        raw: encodedMessage,
      };

      if (validatedArgs.threadId) {
        messageRequest.threadId = validatedArgs.threadId;
      }

      if (action === "send") {
        const response = await gmail.users.messages.send({
          userId: "me",
          requestBody: messageRequest,
        });
        return {
          content: [
            {
              type: "text",
              text: `Email sent successfully with ID: ${response.data.id}`,
            },
          ],
        };
      } else {
        const response = await gmail.users.drafts.create({
          userId: "me",
          requestBody: {
            message: messageRequest,
          },
        });
        return {
          content: [
            {
              type: "text",
              text: `Email draft created successfully with ID: ${response.data.id}`,
            },
          ],
        };
      }
    }
  } catch (error: unknown) {
    // Log attachment-related errors for debugging
    if (validatedArgs.attachments && validatedArgs.attachments.length > 0) {
      const { code, message } = asGmailApiError(error);
      const codeTag = code !== undefined ? ` (HTTP ${code})` : "";
      console.error(
        `Failed to send email with ${validatedArgs.attachments.length} attachments${codeTag}:`,
        message,
      );
    }
    throw error;
  }
}
