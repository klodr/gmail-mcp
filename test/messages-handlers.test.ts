/**
 * End-to-end coverage for the six registerMessageTools handlers
 * (delete_email, read_email, search_emails, modify_email,
 * batch_modify_emails, batch_delete_emails). Drives them through the
 * full MCP roundtrip via InMemoryTransport so every branch in
 * src/tools/messages.ts gets exercised — particularly read_email's
 * format / truncation / attachments matrix and modify_email's
 * labelIds + addLabelIds dedup merge (CR finding history).
 */

import { describe, it, expect, vi } from "vitest";
import type { gmail_v1 } from "googleapis";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

interface MockOpts {
  bodyText?: string;
  attachments?: Array<{ filename: string; mimeType: string; size: number; id: string }>;
  threadId?: string;
}

function makeMockGmail(opts: MockOpts = {}): {
  gmail: gmail_v1.Gmail;
  deleteSpy: ReturnType<typeof vi.fn>;
  getSpy: ReturnType<typeof vi.fn>;
  listSpy: ReturnType<typeof vi.fn>;
  modifySpy: ReturnType<typeof vi.fn>;
} {
  const bodyText = opts.bodyText ?? "Hello from the test suite.";
  const threadId = opts.threadId ?? "T1";
  const attachmentParts =
    opts.attachments?.map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      body: { attachmentId: a.id, size: a.size },
    })) ?? [];

  const deleteSpy = vi.fn(() => Promise.resolve({ data: {} }));
  const modifySpy = vi.fn(() => Promise.resolve({ data: {} }));
  const listSpy = vi.fn(() =>
    Promise.resolve({ data: { messages: [{ id: "M1" }, { id: "M2" }] } }),
  );
  const getSpy = vi.fn((params: { id: string; format?: string }) => {
    if (params.format === "metadata") {
      return Promise.resolve({
        data: {
          id: params.id,
          threadId,
          payload: {
            headers: [
              { name: "Subject", value: `Subject ${params.id}` },
              { name: "From", value: "alice@example.com" },
              { name: "Date", value: "Wed, 01 Jan 2025 00:00:00 +0000" },
            ],
          },
        },
      });
    }
    return Promise.resolve({
      data: {
        id: params.id,
        threadId,
        payload: {
          mimeType: attachmentParts.length > 0 ? "multipart/mixed" : "text/plain",
          headers: [
            { name: "Subject", value: `Subject ${params.id}` },
            { name: "From", value: "alice@example.com" },
            { name: "To", value: "bob@example.com" },
            { name: "Date", value: "Wed, 01 Jan 2025 00:00:00 +0000" },
            { name: "Message-ID", value: `<${params.id}@example.com>` },
          ],
          ...(attachmentParts.length > 0
            ? {
                parts: [
                  {
                    mimeType: "text/plain",
                    body: { data: Buffer.from(bodyText).toString("base64url") },
                  },
                  ...attachmentParts,
                ],
              }
            : {
                body: { data: Buffer.from(bodyText).toString("base64url") },
              }),
        },
      },
    });
  });

  const gmail = {
    users: {
      messages: {
        delete: deleteSpy,
        get: getSpy,
        list: listSpy,
        modify: modifySpy,
      },
    },
  } as unknown as gmail_v1.Gmail;
  return { gmail, deleteSpy, getSpy, listSpy, modifySpy };
}

async function makeClient(gmail: gmail_v1.Gmail): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  // delete_email and batch_delete_emails require the full mail.google.com
  // scope (the API rejects gmail.modify with 403). Authorize both so the
  // entire registerMessageTools surface is reachable from the test client.
  const server = createServer({
    gmail,
    authorizedScopes: ["gmail.modify", "mail.google.com"],
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "messages-handlers-test", version: "0.0.0" });
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

describe("registerMessageTools — handler-level coverage", () => {
  it("delete_email: forwards id and emits success text", async () => {
    const { gmail, deleteSpy } = makeMockGmail();
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({ name: "delete_email", arguments: { messageId: "M9" } });
      const call = deleteSpy.mock.calls[0]?.[0] as { id: string; userId: string };
      expect(call.id).toBe("M9");
      expect(call.userId).toBe("me");
      expect(textOf(out as { content: Array<{ type: string; text?: string }> })).toMatch(
        /Email M9 deleted successfully/,
      );
    } finally {
      await close();
    }
  });

  it("read_email: format='headers_only' returns just the header block (no body fetch downstream)", async () => {
    const { gmail, getSpy } = makeMockGmail();
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "read_email",
        arguments: { messageId: "M1", format: "headers_only" },
      });
      const call = getSpy.mock.calls[0]?.[0] as { format: string };
      expect(call.format).toBe("full");
      const text = textOf(out as { content: Array<{ type: string; text?: string }> });
      expect(text).toContain("Subject: Subject M1");
      expect(text).toContain("From: alice@example.com");
      // Body is not appended in headers_only mode.
      expect(text).not.toContain("Hello from the test suite");
    } finally {
      await close();
    }
  });

  it("read_email: format='full' includes the decoded body", async () => {
    const { gmail } = makeMockGmail({ bodyText: "Body content here." });
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "read_email",
        arguments: { messageId: "M2", format: "full", maxBodyLength: 10000 },
      });
      const text = textOf(out as { content: Array<{ type: string; text?: string }> });
      expect(text).toContain("Body content here.");
    } finally {
      await close();
    }
  });

  it("read_email: format='summary' truncates body at 500 bytes with a marker", async () => {
    const { gmail } = makeMockGmail({ bodyText: "X".repeat(1200) });
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "read_email",
        arguments: { messageId: "M3", format: "summary" },
      });
      const text = textOf(out as { content: Array<{ type: string; text?: string }> });
      expect(text).toContain("Summary truncated at 500 bytes");
    } finally {
      await close();
    }
  });

  it("read_email: includeAttachments=true surfaces the attachment list", async () => {
    const { gmail } = makeMockGmail({
      attachments: [{ filename: "doc.pdf", mimeType: "application/pdf", size: 4096, id: "A1" }],
    });
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "read_email",
        arguments: { messageId: "M4", format: "full", includeAttachments: true },
      });
      const text = textOf(out as { content: Array<{ type: string; text?: string }> });
      expect(text).toContain("Attachments (1)");
      expect(text).toContain("doc.pdf");
    } finally {
      await close();
    }
  });

  it("search_emails: defaults maxResults to 10 and returns ID/subject/from per hit", async () => {
    const { gmail, listSpy } = makeMockGmail();
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "search_emails",
        arguments: { query: "from:alice" },
      });
      const call = listSpy.mock.calls[0]?.[0] as { q: string; maxResults: number };
      expect(call.q).toBe("from:alice");
      expect(call.maxResults).toBe(10);
      const text = textOf(out as { content: Array<{ type: string; text?: string }> });
      expect(text).toContain("ID: M1");
      expect(text).toContain("ID: M2");
    } finally {
      await close();
    }
  });

  it("modify_email: dedupes labelIds + addLabelIds into a single addLabelIds set", async () => {
    const { gmail, modifySpy } = makeMockGmail();
    const { client, close } = await makeClient(gmail);
    try {
      await client.callTool({
        name: "modify_email",
        arguments: {
          messageId: "M5",
          labelIds: ["INBOX", "STARRED"],
          addLabelIds: ["STARRED", "Label_42"],
          removeLabelIds: ["UNREAD"],
        },
      });
      const call = modifySpy.mock.calls[0]?.[0] as {
        id: string;
        requestBody: { addLabelIds?: string[]; removeLabelIds?: string[] };
      };
      expect(call.id).toBe("M5");
      // STARRED appears twice in input; the union must dedupe it.
      expect(call.requestBody.addLabelIds?.sort()).toEqual(["INBOX", "Label_42", "STARRED"]);
      expect(call.requestBody.removeLabelIds).toEqual(["UNREAD"]);
    } finally {
      await close();
    }
  });

  it("modify_email: with no labels supplied sends an empty body and still returns success", async () => {
    const { gmail, modifySpy } = makeMockGmail();
    const { client, close } = await makeClient(gmail);
    try {
      await client.callTool({
        name: "modify_email",
        arguments: { messageId: "M6" },
      });
      const call = modifySpy.mock.calls[0]?.[0] as {
        requestBody: Record<string, unknown>;
      };
      expect(call.requestBody).toEqual({});
    } finally {
      await close();
    }
  });

  it("batch_modify_emails: processes every id and reports success count", async () => {
    const { gmail, modifySpy } = makeMockGmail();
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "batch_modify_emails",
        arguments: {
          messageIds: ["A", "B", "C"],
          addLabelIds: ["INBOX"],
          batchSize: 2,
        },
      });
      expect(modifySpy).toHaveBeenCalledTimes(3);
      const text = textOf(out as { content: Array<{ type: string; text?: string }> });
      expect(text).toMatch(/Successfully processed: 3/);
    } finally {
      await close();
    }
  });

  it("batch_delete_emails: deletes every id and reports success count", async () => {
    const { gmail, deleteSpy } = makeMockGmail();
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "batch_delete_emails",
        arguments: { messageIds: ["X", "Y"] },
      });
      expect(deleteSpy).toHaveBeenCalledTimes(2);
      const text = textOf(out as { content: Array<{ type: string; text?: string }> });
      // batch_delete uses different wording from batch_modify
      // ("deleted" vs "processed").
      expect(text).toMatch(/Successfully deleted: 2 messages/);
    } finally {
      await close();
    }
  });

  it("batch_modify_emails: surfaces per-id failures with the truncated-id list", async () => {
    // Reject every modify call to force the failure-rendering branch.
    const modifySpy = vi.fn(() => Promise.reject(new Error("simulated modify failure")));
    const gmail = {
      users: {
        messages: {
          delete: vi.fn(),
          get: vi.fn(),
          list: vi.fn(),
          modify: modifySpy,
        },
      },
    } as unknown as gmail_v1.Gmail;
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "batch_modify_emails",
        arguments: {
          messageIds: ["aaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbb"],
          addLabelIds: ["X"],
        },
      });
      const text = textOf(out as { content: Array<{ type: string; text?: string }> });
      // The 230-238 failure branch must render: "Failed to process: N"
      // + "Failed message IDs:" + the truncated id list.
      expect(text).toMatch(/Failed to process: 2/);
      expect(text).toContain("Failed message IDs");
      expect(text).toContain("simulated modify failure");
      // 16-char truncation prefix should appear with the "..." suffix.
      expect(text).toMatch(/aaaaaaaaaaaaaaaa\.\.\./);
    } finally {
      await close();
    }
  });
});
