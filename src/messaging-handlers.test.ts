/**
 * End-to-end coverage for the messaging.ts handlers that the existing
 * registrars.test.ts doesn't exercise:
 *
 *   - reply_to_email recipient-resolver branches (Reply-To / Sender /
 *     From precedence + multi-mailbox bail).
 *   - forward_email basic + cc/bcc paths.
 *
 * send_email / draft_email / reply_all are already covered in
 * src/tools/registrars.test.ts and src/email-send.test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import type { gmail_v1 } from "googleapis";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";

interface Header {
  name: string;
  value: string;
}

function makeMockGmail(headers: Header[]): {
  gmail: gmail_v1.Gmail;
  getSpy: ReturnType<typeof vi.fn>;
  sendSpy: ReturnType<typeof vi.fn>;
} {
  const getSpy = vi.fn((params: { id: string }) =>
    Promise.resolve({
      data: {
        id: params.id,
        threadId: "T1",
        payload: {
          mimeType: "text/plain",
          headers,
          body: { data: Buffer.from("Original body text").toString("base64url") },
        },
      },
    }),
  );
  // sendOrDraftEmail eventually calls gmail.users.messages.send with
  // a base64-encoded raw RFC 822 message. Stub it to a benign success.
  const sendSpy = vi.fn(() => Promise.resolve({ data: { id: "S1", threadId: "T1" } }));
  const gmail = {
    users: {
      messages: {
        get: getSpy,
        send: sendSpy,
      },
      getProfile: vi.fn(() => Promise.resolve({ data: { emailAddress: "me@example.com" } })),
    },
  } as unknown as gmail_v1.Gmail;
  return { gmail, getSpy, sendSpy };
}

async function makeClient(gmail: gmail_v1.Gmail): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  // gmail.send covers send_email/draft_email/reply_all/reply_to_email/forward_email.
  const server = createServer({
    gmail,
    authorizedScopes: ["gmail.send", "gmail.modify"],
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "messaging-handlers-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await Promise.all([client.close(), server.close()]);
    },
  };
}

function textOf(out: { content: Array<{ type: string; text?: string }> }): string {
  return out.content.find((c) => c.type === "text")?.text ?? "";
}

describe("registerMessagingTools — reply_to_email recipient resolver", () => {
  it("picks the From address when there is no Reply-To and no Sender (single From)", async () => {
    const { gmail, sendSpy } = makeMockGmail([
      { name: "From", value: "alice@example.com" },
      { name: "Subject", value: "Original subject" },
      { name: "Message-ID", value: "<orig@example.com>" },
    ]);
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "reply_to_email",
        arguments: { messageId: "M1", body: "thanks" },
      });
      expect(sendSpy).toHaveBeenCalledOnce();
      const text = textOf(out as { content: Array<{ type: string; text?: string }> });
      expect(text).toContain("Reply sent successfully!");
      expect(text).toContain("To: alice@example.com");
      expect(text).toContain("Subject: Re: Original subject");
    } finally {
      await close();
    }
  });

  it("picks the Sender address when From has multiple mailboxes and Reply-To is absent", async () => {
    const { gmail, sendSpy } = makeMockGmail([
      { name: "From", value: "alice@example.com, bob@example.com" },
      { name: "Sender", value: "shared@example.com" },
      { name: "Subject", value: "Co-authored" },
      { name: "Message-ID", value: "<co@example.com>" },
    ]);
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "reply_to_email",
        arguments: { messageId: "M2", body: "noted" },
      });
      expect(sendSpy).toHaveBeenCalledOnce();
      expect(textOf(out as { content: Array<{ type: string; text?: string }> })).toContain(
        "To: shared@example.com",
      );
    } finally {
      await close();
    }
  });

  it("fails with the multi-Reply-To error when there are 2+ Reply-To mailboxes", async () => {
    const { gmail } = makeMockGmail([
      { name: "From", value: "alice@example.com" },
      { name: "Reply-To", value: "list-a@example.com, list-b@example.com" },
      { name: "Subject", value: "Ambiguous" },
      { name: "Message-ID", value: "<amb@example.com>" },
    ]);
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "reply_to_email",
        arguments: { messageId: "M3", body: "ignored" },
      });
      expect(out.isError).toBe(true);
      // The 273-275 reason branch — multiple Reply-To header values.
      expect(textOf(out as { content: Array<{ type: string; text?: string }> })).toMatch(
        /multiple Reply-To: mailboxes/,
      );
    } finally {
      await close();
    }
  });

  it("fails with the no-headers error when From / Sender / Reply-To are all empty", async () => {
    const { gmail } = makeMockGmail([
      { name: "Subject", value: "Headerless" },
      { name: "Message-ID", value: "<noh@example.com>" },
    ]);
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "reply_to_email",
        arguments: { messageId: "M4", body: "ignored" },
      });
      expect(out.isError).toBe(true);
      // The 277-278 reason branch — nothing to reply to.
      expect(textOf(out as { content: Array<{ type: string; text?: string }> })).toMatch(
        /no From: \/ Sender: \/ Reply-To: header/,
      );
    } finally {
      await close();
    }
  });

  it("fails with the multi-Sender error when Sender has 2+ mailboxes (no Reply-To)", async () => {
    const { gmail } = makeMockGmail([
      { name: "From", value: "alice@example.com" },
      { name: "Sender", value: "shared-a@example.com, shared-b@example.com" },
      { name: "Subject", value: "Ambiguous Sender" },
      { name: "Message-ID", value: "<as@example.com>" },
    ]);
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "reply_to_email",
        arguments: { messageId: "M-ms", body: "ignored" },
      });
      expect(out.isError).toBe(true);
      // The 275-276 reason branch — multi-mailbox Sender header.
      expect(textOf(out as { content: Array<{ type: string; text?: string }> })).toMatch(
        /multiple Sender: mailboxes/,
      );
    } finally {
      await close();
    }
  });

  it("fails with the multi-From error when From has 2+ mailboxes and no Reply-To/Sender disambiguator", async () => {
    const { gmail } = makeMockGmail([
      { name: "From", value: "alice@example.com, bob@example.com" },
      { name: "Subject", value: "Co-authored no Sender" },
      { name: "Message-ID", value: "<mf@example.com>" },
    ]);
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "reply_to_email",
        arguments: { messageId: "M-mf", body: "ignored" },
      });
      expect(out.isError).toBe(true);
      // The 279 reason branch — multi-From with no Reply-To / Sender disambiguator.
      expect(textOf(out as { content: Array<{ type: string; text?: string }> })).toMatch(
        /multiple From: mailboxes/,
      );
    } finally {
      await close();
    }
  });
});

describe("registerMessagingTools — forward_email", () => {
  it("forwards a message with To only and reports success text", async () => {
    const { gmail, sendSpy } = makeMockGmail([
      { name: "From", value: "alice@example.com" },
      { name: "To", value: "me@example.com" },
      { name: "Subject", value: "Heads up" },
      { name: "Date", value: "Wed, 01 Jan 2025 00:00:00 +0000" },
    ]);
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "forward_email",
        arguments: { messageId: "M5", to: ["downstream@example.com"], body: "FYI" },
      });
      expect(sendSpy).toHaveBeenCalledOnce();
      const text = textOf(out as { content: Array<{ type: string; text?: string }> });
      expect(text).toContain("Forward sent successfully!");
      expect(text).toContain("To: downstream@example.com");
      expect(text).toContain("Subject: Fwd: Heads up");
      // No CC/BCC echoed when the caller didn't supply them.
      expect(text).not.toContain("CC: ");
      expect(text).not.toContain("BCC: ");
    } finally {
      await close();
    }
  });

  it("forwards with CC + BCC and echoes them in the success text", async () => {
    const { gmail } = makeMockGmail([
      { name: "From", value: "alice@example.com" },
      { name: "To", value: "me@example.com" },
      { name: "Subject", value: "Group fwd" },
      { name: "Date", value: "Wed, 01 Jan 2025 00:00:00 +0000" },
    ]);
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "forward_email",
        arguments: {
          messageId: "M6",
          to: ["t1@example.com"],
          cc: ["c1@example.com"],
          bcc: ["b1@example.com"],
        },
      });
      const text = textOf(out as { content: Array<{ type: string; text?: string }> });
      expect(text).toContain("CC: c1@example.com");
      expect(text).toContain("BCC: b1@example.com");
    } finally {
      await close();
    }
  });
});
