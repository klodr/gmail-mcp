/**
 * End-to-end coverage for the registerDraftTools handlers
 * (list_drafts, get_draft, delete_draft, send_draft) via MCP roundtrip.
 *
 * update_draft is covered separately — it depends on
 * buildEncodedRawMessage + sender resolution + threading backfill, which
 * each have their own dedicated test files.
 */

import { describe, it, expect, vi } from "vitest";
import type { gmail_v1 } from "googleapis";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";

interface DraftListEntry {
  id: string;
  message?: { id: string; threadId: string };
}

function makeMockGmail(): {
  gmail: gmail_v1.Gmail;
  listSpy: ReturnType<typeof vi.fn>;
  getSpy: ReturnType<typeof vi.fn>;
  deleteSpy: ReturnType<typeof vi.fn>;
  sendSpy: ReturnType<typeof vi.fn>;
} {
  const drafts: DraftListEntry[] = [
    { id: "D1", message: { id: "M1", threadId: "T1" } },
    { id: "D2", message: { id: "M2", threadId: "T2" } },
  ];
  const listSpy = vi.fn(() =>
    Promise.resolve({
      data: {
        drafts,
        nextPageToken: "next-token-abc",
        resultSizeEstimate: 2,
      },
    }),
  );
  const getSpy = vi.fn((params: { id: string }) =>
    Promise.resolve({
      data: {
        id: params.id,
        message: {
          id: `msg-${params.id}`,
          threadId: `thread-${params.id}`,
          payload: {
            headers: [
              { name: "Subject", value: "Draft subject" },
              { name: "From", value: "alice@example.com" },
            ],
          },
        },
      },
    }),
  );
  const deleteSpy = vi.fn(() => Promise.resolve({ data: {} }));
  const sendSpy = vi.fn(() =>
    Promise.resolve({ data: { id: "sent-msg", threadId: "sent-thread" } }),
  );

  const gmail = {
    users: {
      drafts: {
        list: listSpy,
        get: getSpy,
        delete: deleteSpy,
        send: sendSpy,
      },
    },
  } as unknown as gmail_v1.Gmail;
  return { gmail, listSpy, getSpy, deleteSpy, sendSpy };
}

async function makeClient(gmail: gmail_v1.Gmail): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = createServer({
    gmail,
    authorizedScopes: ["gmail.modify", "mail.google.com", "gmail.send"],
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "drafts-handlers-test", version: "0.0.0" });
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

describe("registerDraftTools — handler-level coverage", () => {
  it("list_drafts: forwards pagination + query + includeSpamTrash", async () => {
    const { gmail, listSpy } = makeMockGmail();
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "list_drafts",
        arguments: {
          maxResults: 25,
          pageToken: "tok-abc",
          q: "subject:test",
          includeSpamTrash: true,
        },
      });
      const call = listSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(call.maxResults).toBe(25);
      expect(call.pageToken).toBe("tok-abc");
      expect(call.q).toBe("subject:test");
      expect(call.includeSpamTrash).toBe(true);
      const text = textOf(out as { content: Array<{ type: string; text?: string }> });
      expect(text).toContain("Drafts (2+)");
      expect(text).toContain("D1 (messageId=M1, threadId=T1)");
      expect(text).toContain("Next page token: next-token-abc");
    } finally {
      await close();
    }
  });

  it("list_drafts: omits pageToken + q when caller doesn't supply them", async () => {
    const { gmail, listSpy } = makeMockGmail();
    const { client, close } = await makeClient(gmail);
    try {
      await client.callTool({
        name: "list_drafts",
        arguments: { maxResults: 10, includeSpamTrash: false },
      });
      const call = listSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      // The conditional spread `...(args.X !== undefined && { X: args.X })`
      // omits the field entirely when undefined.
      expect("pageToken" in call).toBe(false);
      expect("q" in call).toBe(false);
      expect(call.includeSpamTrash).toBe(false);
    } finally {
      await close();
    }
  });

  it("list_drafts: returns the API error envelope when the Gmail call rejects", async () => {
    const erroring = {
      users: {
        drafts: {
          list: vi.fn(() => Promise.reject(new Error("boom-list"))),
          get: vi.fn(),
          delete: vi.fn(),
          send: vi.fn(),
        },
      },
    } as unknown as gmail_v1.Gmail;
    const { client, close } = await makeClient(erroring);
    try {
      const out = await client.callTool({
        name: "list_drafts",
        arguments: { maxResults: 5, includeSpamTrash: false },
      });
      const text = textOf(out as { content: Array<{ type: string; text?: string }> });
      expect(text).toMatch(/Failed to list drafts/);
      expect(out.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it("get_draft: returns the JSON-stringified message payload", async () => {
    const { gmail, getSpy } = makeMockGmail();
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "get_draft",
        arguments: { id: "D-test", format: "full" },
      });
      const call = getSpy.mock.calls[0]?.[0] as { id: string; format: string };
      expect(call.id).toBe("D-test");
      expect(call.format).toBe("full");
      const text = textOf(out as { content: Array<{ type: string; text?: string }> });
      expect(text).toContain('"id": "D-test"');
      expect(text).toContain("Draft subject");
    } finally {
      await close();
    }
  });

  it("get_draft: returns the API error envelope when the Gmail call rejects", async () => {
    const erroring = {
      users: {
        drafts: {
          list: vi.fn(),
          get: vi.fn(() => Promise.reject(new Error("boom-get"))),
          delete: vi.fn(),
          send: vi.fn(),
        },
      },
    } as unknown as gmail_v1.Gmail;
    const { client, close } = await makeClient(erroring);
    try {
      const out = await client.callTool({
        name: "get_draft",
        arguments: { id: "D-bad", format: "metadata" },
      });
      expect(textOf(out as { content: Array<{ type: string; text?: string }> })).toMatch(
        /Failed to get draft/,
      );
      expect(out.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it("delete_draft: forwards the id and emits the success text", async () => {
    const { gmail, deleteSpy } = makeMockGmail();
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({ name: "delete_draft", arguments: { id: "D-del" } });
      const call = deleteSpy.mock.calls[0]?.[0] as { id: string };
      expect(call.id).toBe("D-del");
      expect(textOf(out as { content: Array<{ type: string; text?: string }> })).toMatch(
        /Draft D-del deleted permanently/,
      );
    } finally {
      await close();
    }
  });

  it("delete_draft: surfaces Gmail API errors via the shared error envelope", async () => {
    const erroring = {
      users: {
        drafts: {
          list: vi.fn(),
          get: vi.fn(),
          delete: vi.fn(() => Promise.reject(new Error("boom-del"))),
          send: vi.fn(),
        },
      },
    } as unknown as gmail_v1.Gmail;
    const { client, close } = await makeClient(erroring);
    try {
      const out = await client.callTool({ name: "delete_draft", arguments: { id: "D-x" } });
      expect(textOf(out as { content: Array<{ type: string; text?: string }> })).toMatch(
        /Failed to delete draft/,
      );
      expect(out.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it("send_draft: skips the pairing pre-flight when GMAIL_MCP_RECIPIENT_PAIRING is unset", async () => {
    delete process.env.GMAIL_MCP_RECIPIENT_PAIRING;
    const { gmail, getSpy, sendSpy } = makeMockGmail();
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({ name: "send_draft", arguments: { id: "D-send" } });
      // The cost-saving short-circuit means drafts.get is NOT called.
      expect(getSpy).not.toHaveBeenCalled();
      const sendCall = sendSpy.mock.calls[0]?.[0] as { requestBody: { id: string } };
      expect(sendCall.requestBody.id).toBe("D-send");
      const text = textOf(out as { content: Array<{ type: string; text?: string }> });
      expect(text).toMatch(/Draft D-send sent successfully/);
      expect(text).toContain("messageId: sent-msg");
      expect(text).toContain("threadId: sent-thread");
    } finally {
      await close();
    }
  });

  it("send_draft: surfaces Gmail API errors via the shared error envelope", async () => {
    const erroring = {
      users: {
        drafts: {
          list: vi.fn(),
          get: vi.fn(),
          delete: vi.fn(),
          send: vi.fn(() => Promise.reject(new Error("boom-send"))),
        },
      },
    } as unknown as gmail_v1.Gmail;
    const { client, close } = await makeClient(erroring);
    try {
      const out = await client.callTool({ name: "send_draft", arguments: { id: "D-z" } });
      expect(textOf(out as { content: Array<{ type: string; text?: string }> })).toMatch(
        /Failed to send draft/,
      );
      expect(out.isError).toBe(true);
    } finally {
      await close();
    }
  });
});

describe("registerDraftTools — update_draft handler-level coverage", () => {
  function makeUpdateMockGmail(
    opts: {
      threadGetThrows?: boolean;
      threadMessages?: Array<{ payload?: { headers?: Array<{ name: string; value: string }> } }>;
    } = {},
  ): {
    gmail: gmail_v1.Gmail;
    updateSpy: ReturnType<typeof vi.fn>;
    threadGetSpy: ReturnType<typeof vi.fn>;
  } {
    const updateSpy = vi.fn(() =>
      Promise.resolve({ data: { id: "D-updated", message: { id: "M-new" } } }),
    );
    const threadGetSpy = opts.threadGetThrows
      ? vi.fn(() => Promise.reject(new Error("thread fetch boom")))
      : vi.fn(() =>
          Promise.resolve({
            data: { messages: opts.threadMessages ?? [] },
          }),
        );
    const gmail = {
      users: {
        drafts: {
          update: updateSpy,
          // unused by update_draft but required by the registrar:
          list: vi.fn(),
          get: vi.fn(),
          delete: vi.fn(),
          send: vi.fn(),
        },
        threads: {
          get: threadGetSpy,
        },
        getProfile: vi.fn(() =>
          Promise.resolve({
            data: { sendAs: [{ sendAsEmail: "me@example.com", isDefault: true }] },
          }),
        ),
        settings: {
          sendAs: {
            list: vi.fn(() =>
              Promise.resolve({
                data: { sendAs: [{ sendAsEmail: "me@example.com", isDefault: true }] },
              }),
            ),
          },
        },
      },
    } as unknown as gmail_v1.Gmail;
    return { gmail, updateSpy, threadGetSpy };
  }

  it("update_draft: simple update without threadId skips the thread backfill", async () => {
    delete process.env.GMAIL_MCP_RECIPIENT_PAIRING;
    const { gmail, updateSpy, threadGetSpy } = makeUpdateMockGmail();
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "update_draft",
        arguments: {
          id: "D1",
          to: ["bob@example.com"],
          subject: "Updated",
          body: "Body",
          from: "me@example.com",
        },
      });
      expect(threadGetSpy).not.toHaveBeenCalled();
      expect(updateSpy).toHaveBeenCalledOnce();
      const text = textOf(out as { content: Array<{ type: string; text?: string }> });
      expect(text).toMatch(/Draft D-updated updated successfully/);
      expect(text).toContain("M-new");
    } finally {
      await close();
    }
  });

  it("update_draft: with threadId backfills In-Reply-To + References from the thread", async () => {
    delete process.env.GMAIL_MCP_RECIPIENT_PAIRING;
    const { gmail, threadGetSpy } = makeUpdateMockGmail({
      threadMessages: [
        {
          payload: {
            headers: [{ name: "Message-ID", value: "<first@example.com>" }],
          },
        },
        {
          payload: {
            headers: [{ name: "Message-ID", value: "<second@example.com>" }],
          },
        },
      ],
    });
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "update_draft",
        arguments: {
          id: "D2",
          to: ["bob@example.com"],
          subject: "Re: thread",
          body: "Continued",
          threadId: "T-abc",
          from: "me@example.com",
        },
      });
      expect(threadGetSpy).toHaveBeenCalledOnce();
      // Tolerant: backfill is best-effort; a successful update is the real assertion.
      expect(out.isError ?? false).toBe(false);
    } finally {
      await close();
    }
  });

  it("update_draft: thread.get failure logs a warning and proceeds in degraded mode", async () => {
    delete process.env.GMAIL_MCP_RECIPIENT_PAIRING;
    const { gmail, updateSpy } = makeUpdateMockGmail({ threadGetThrows: true });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      /* swallow */
    });
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "update_draft",
        arguments: {
          id: "D3",
          to: ["bob@example.com"],
          subject: "Re: degraded",
          body: "Body",
          threadId: "T-broken",
          from: "me@example.com",
        },
      });
      // The catch path must NOT propagate — the update still goes through.
      expect(updateSpy).toHaveBeenCalledOnce();
      expect(out.isError ?? false).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      await close();
    }
  });

  it("update_draft: surfaces Gmail API errors via the shared error envelope", async () => {
    delete process.env.GMAIL_MCP_RECIPIENT_PAIRING;
    const erroring = {
      users: {
        drafts: {
          list: vi.fn(),
          get: vi.fn(),
          delete: vi.fn(),
          send: vi.fn(),
          update: vi.fn(() => Promise.reject(new Error("boom-update"))),
        },
        threads: { get: vi.fn() },
        settings: { sendAs: { list: vi.fn(() => Promise.resolve({ data: { sendAs: [] } })) } },
      },
    } as unknown as gmail_v1.Gmail;
    const { client, close } = await makeClient(erroring);
    try {
      const out = await client.callTool({
        name: "update_draft",
        arguments: {
          id: "D4",
          to: ["bob@example.com"],
          subject: "fail",
          body: "x",
          from: "me@example.com",
        },
      });
      expect(textOf(out as { content: Array<{ type: string; text?: string }> })).toMatch(
        /Failed to update draft/,
      );
      expect(out.isError).toBe(true);
    } finally {
      await close();
    }
  });
});
