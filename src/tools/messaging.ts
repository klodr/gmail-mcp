/**
 * Messaging-domain tool registrars: `send_email`, `draft_email`,
 * `pair_recipient`, `reply_all`. Lands in PR #7 — the final
 * extraction batch before the legacy dispatcher in `src/index.ts`
 * goes away.
 *
 * `send_email` / `draft_email` / `reply_all` all route through
 * `sendOrDraftEmail` (PR #1's `src/email-send.ts`); `reply_all`
 * additionally walks the original message's headers to build the
 * To/Cc/References chain before calling into `sendOrDraftEmail`.
 *
 * `pair_recipient` is a thin wrapper over the
 * `addPairedAddress` / `removePairedAddress` / `readPairedList`
 * functions in `src/recipient-pairing.ts`.
 */

import type { gmail_v1 } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, pullToolMeta as pull } from "./_shared.js";
import {
  SendEmailSchema,
  PairRecipientSchema,
  ReplyAllSchema,
  ReplyToEmailSchema,
  ForwardEmailSchema,
} from "../tools.js";
import { sendOrDraftEmail, type EmailSendArgs } from "../email-send.js";
import { addPairedAddress, readPairedList, removePairedAddress } from "../recipient-pairing.js";
import {
  addFwdPrefix,
  addRePrefix,
  buildForwardQuotedBody,
  buildReferencesHeader,
  buildReplyAllRecipients,
  parseEmailAddresses,
} from "../reply-all-helpers.js";
import { extractEmailContent } from "../mime-walkers.js";

export function registerMessagingTools(
  server: McpServer,
  gmail: gmail_v1.Gmail,
  authorizedScopes: readonly string[],
): void {
  // send_email — PR #7
  const sendEmail = pull("send_email");
  defineTool(
    server,
    "send_email",
    sendEmail.description,
    SendEmailSchema.shape,
    (args) => sendOrDraftEmail(gmail, "send", args as EmailSendArgs),
    sendEmail.annotations,
    sendEmail.scopes,
    authorizedScopes,
  );

  // draft_email — PR #7 (same schema as send_email, action=draft)
  const draftEmail = pull("draft_email");
  defineTool(
    server,
    "draft_email",
    draftEmail.description,
    SendEmailSchema.shape,
    (args) => sendOrDraftEmail(gmail, "draft", args as EmailSendArgs),
    draftEmail.annotations,
    draftEmail.scopes,
    authorizedScopes,
  );

  // pair_recipient — PR #7. The handler is sync (every dependency in
  // src/recipient-pairing.ts returns synchronously); wrap the return
  // in Promise.resolve so the defineTool signature
  // (args) => Promise<ToolResult> is satisfied without an empty
  // `async` keyword that ESLint would flag as no-await.
  const pairRecipient = pull("pair_recipient");
  function handlePairRecipient(
    args: import("zod").infer<typeof PairRecipientSchema>,
  ): import("./_shared.js").ToolResult {
    const { action, email } = args;
    if (action === "list") {
      const addresses = readPairedList();
      return {
        content: [
          {
            type: "text",
            text: `Paired recipients (${addresses.length}):\n${
              addresses.length > 0 ? addresses.map((a) => `  - ${a}`).join("\n") : "  (none)"
            }`,
          },
        ],
        structuredContent: { addresses, count: addresses.length },
      };
    }
    if (!email || email.trim() === "") {
      return {
        content: [
          {
            type: "text",
            text: `pair_recipient action "${action}" requires an \`email\` argument.`,
          },
        ],
        isError: true,
      };
    }
    if (action === "add") {
      const res = addPairedAddress(email);
      return {
        content: [
          {
            type: "text",
            text: res.added
              ? `Added "${res.address}" to the paired allowlist.`
              : `"${res.address}" was already paired; no change.`,
          },
        ],
        structuredContent: res,
      };
    }
    // action === "remove"
    const res = removePairedAddress(email);
    return {
      content: [
        {
          type: "text",
          text: res.removed
            ? `Removed "${res.address}" from the paired allowlist.`
            : `"${res.address}" was not in the paired allowlist; no change.`,
        },
      ],
      structuredContent: res,
    };
  }
  defineTool(
    server,
    "pair_recipient",
    pairRecipient.description,
    PairRecipientSchema.shape,
    (args) => Promise.resolve(handlePairRecipient(args)),
    pairRecipient.annotations,
    pairRecipient.scopes,
    authorizedScopes,
  );

  // reply_all — PR #7
  const replyAll = pull("reply_all");
  defineTool(
    server,
    "reply_all",
    replyAll.description,
    ReplyAllSchema.shape,
    async (args) => {
      // Fetch the original email to get headers
      const originalEmail = await gmail.users.messages.get({
        userId: "me",
        id: args.messageId,
        format: "full",
      });
      const headers = originalEmail.data.payload?.headers || [];
      const threadId = originalEmail.data.threadId || "";

      const get = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
      const originalFrom = get("from");
      const originalTo = get("to");
      const originalCc = get("cc");
      const originalSubject = get("subject");
      const originalMessageId = get("message-id");
      const originalReferences = get("references");

      const profile = await gmail.users.getProfile({ userId: "me" });
      const myEmail = profile.data.emailAddress?.toLowerCase() || "";

      const { to: replyTo, cc: replyCc } = buildReplyAllRecipients(
        originalFrom,
        originalTo,
        originalCc,
        myEmail,
      );

      if (replyTo.length === 0) {
        throw new Error("Could not determine recipient for reply");
      }

      const replySubject = addRePrefix(originalSubject);
      const references = buildReferencesHeader(originalReferences, originalMessageId);

      const emailArgs: EmailSendArgs = {
        to: replyTo,
        cc: replyCc.length > 0 ? replyCc : undefined,
        subject: replySubject,
        body: args.body,
        htmlBody: args.htmlBody,
        mimeType: args.mimeType,
        threadId,
        inReplyTo: originalMessageId,
        references,
        attachments: args.attachments,
      };

      await sendOrDraftEmail(gmail, "send", emailArgs);

      return {
        content: [
          {
            type: "text",
            text: `Reply-all sent successfully!\nTo: ${replyTo.join(", ")}${
              replyCc.length > 0 ? `\nCC: ${replyCc.join(", ")}` : ""
            }\nSubject: ${replySubject}\nThread ID: ${threadId}`,
          },
        ],
      };
    },
    replyAll.annotations,
    replyAll.scopes,
    authorizedScopes,
  );

  // reply_to_email — sender-only reply (no Cc broadcast). Mirrors
  // reply_all but skips the To+Cc rebuild — just picks the first
  // address out of the source `From:` header. The threading-headers
  // wiring (In-Reply-To / References / Subject Re: prefix) is the
  // same.
  const replyToEmail = pull("reply_to_email");
  defineTool(
    server,
    "reply_to_email",
    replyToEmail.description,
    ReplyToEmailSchema.shape,
    async (args) => {
      const originalEmail = await gmail.users.messages.get({
        userId: "me",
        id: args.messageId,
        format: "full",
      });
      const headers = originalEmail.data.payload?.headers || [];
      const threadId = originalEmail.data.threadId || "";

      const get = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
      const originalFrom = get("from");
      const originalSubject = get("subject");
      const originalMessageId = get("message-id");
      const originalReferences = get("references");

      // First mailbox out of the source `From:` — RFC 5322 allows a
      // multi-address From (rare but legal). Pick the first; an
      // operator who wants every original sender should reach for
      // reply_all. Empty `From:` (synthetic message) → bail with
      // isError so the agent does not silently send to nothing.
      const fromAddresses = parseEmailAddresses(originalFrom);
      if (fromAddresses.length === 0) {
        throw new Error(
          "Could not determine recipient for reply (source message has no From: header)",
        );
      }
      const replyTo = [fromAddresses[0]!];

      const replySubject = addRePrefix(originalSubject);
      const references = buildReferencesHeader(originalReferences, originalMessageId);

      const emailArgs: EmailSendArgs = {
        to: replyTo,
        subject: replySubject,
        body: args.body,
        htmlBody: args.htmlBody,
        mimeType: args.mimeType,
        threadId,
        inReplyTo: originalMessageId,
        references,
        attachments: args.attachments,
      };

      await sendOrDraftEmail(gmail, "send", emailArgs);

      return {
        content: [
          {
            type: "text",
            text: `Reply sent successfully!\nTo: ${replyTo.join(", ")}\nSubject: ${replySubject}\nThread ID: ${threadId}`,
          },
        ],
      };
    },
    replyToEmail.annotations,
    replyToEmail.scopes,
    authorizedScopes,
  );

  // forward_email — relay an existing message to a new recipient
  // list. Builds a Gmail-style quoted body (`---------- Forwarded
  // message ---------` separator + From/Date/Subject/To headers +
  // original text) and prepends the optional `body` preface. New
  // thread (no threadId carry-over). Attachments from the source
  // are NOT re-attached — the caller chains download_attachment +
  // passes paths via `attachments` if carry-over is wanted.
  const forwardEmail = pull("forward_email");
  defineTool(
    server,
    "forward_email",
    forwardEmail.description,
    ForwardEmailSchema.shape,
    async (args) => {
      const originalEmail = await gmail.users.messages.get({
        userId: "me",
        id: args.messageId,
        format: "full",
      });
      const headers = originalEmail.data.payload?.headers || [];
      const get = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
      const originalFrom = get("from");
      const originalDate = get("date");
      const originalSubject = get("subject");
      const originalTo = get("to");

      const emailContent = extractEmailContent(originalEmail.data.payload || {});
      const originalText = emailContent.text || "";

      const forwardSubject = addFwdPrefix(originalSubject);
      const forwardBody = buildForwardQuotedBody(
        {
          from: originalFrom,
          date: originalDate,
          subject: originalSubject,
          to: originalTo,
        },
        originalText,
        args.body,
      );

      const emailArgs: EmailSendArgs = {
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: forwardSubject,
        body: forwardBody,
        attachments: args.attachments,
      };

      await sendOrDraftEmail(gmail, "send", emailArgs);

      return {
        content: [
          {
            type: "text",
            text: `Forward sent successfully!\nTo: ${args.to.join(", ")}${
              args.cc && args.cc.length > 0 ? `\nCC: ${args.cc.join(", ")}` : ""
            }${
              args.bcc && args.bcc.length > 0 ? `\nBCC: ${args.bcc.join(", ")}` : ""
            }\nSubject: ${forwardSubject}`,
          },
        ],
      };
    },
    forwardEmail.annotations,
    forwardEmail.scopes,
    authorizedScopes,
  );
}
