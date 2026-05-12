/**
 * End-to-end coverage for the four registerThreadTools handlers
 * (modify_thread, get_thread, list_inbox_threads, get_inbox_with_threads).
 * Drives them through the full MCP roundtrip via InMemoryTransport so
 * every branch in src/tools/threads.ts gets exercised — particularly the
 * ones the schema-only thread-tools.test.ts file misses (54.54% branches
 * before this suite).
 */

import { describe, it, expect, vi } from "vitest";
import type { gmail_v1 } from "googleapis";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

interface ParsedToolPayload {
  threadId?: string;
  messageCount?: number;
  resultCount?: number;
  threads?: Array<{ messageCount?: number; threadId?: string }>;
  messages?: Array<{ messageId: string; subject: string; body: string }>;
}

function makeMessage(id: string, threadId: string, format: string | undefined): unknown {
  if (format === "minimal") {
    return { id, threadId, labelIds: ["INBOX"] };
  }
  return {
    id,
    threadId,
    labelIds: ["INBOX"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "Subject", value: `Subject for ${id}` },
        { name: "From", value: "alice@example.com" },
        { name: "To", value: "bob@example.com" },
        { name: "Date", value: "Wed, 01 Jan 2025 00:00:00 +0000" },
      ],
      body: { data: Buffer.from("hello world").toString("base64url") },
    },
  };
}

function makeMockGmail(): {
  gmail: gmail_v1.Gmail;
  modifySpy: ReturnType<typeof vi.fn>;
  getSpy: ReturnType<typeof vi.fn>;
  listSpy: ReturnType<typeof vi.fn>;
} {
  const modifySpy = vi.fn(() => Promise.resolve({ data: {} }));
  const getSpy = vi.fn((params: { id: string; format?: string }) =>
    Promise.resolve({
      data: { messages: [makeMessage("m1", params.id, params.format)] },
    }),
  );
  const listSpy = vi.fn(() =>
    Promise.resolve({
      data: { threads: [{ id: "t1", snippet: "snippet", historyId: "h1" }] },
    }),
  );

  const gmail = {
    users: {
      threads: {
        modify: modifySpy,
        get: getSpy,
        list: listSpy,
      },
    },
  } as unknown as gmail_v1.Gmail;
  return { gmail, modifySpy, getSpy, listSpy };
}

async function makeClient(gmail: gmail_v1.Gmail): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  // Modify scope covers the read scopes too (Google's hierarchy). All
  // four thread tools register under this combined surface.
  const server = createServer({
    gmail,
    authorizedScopes: ["gmail.modify"],
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "threads-handlers-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await Promise.all([client.close(), server.close()]);
    },
  };
}

function parseTextPayload(out: {
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
}): ParsedToolPayload {
  // Prefer structuredContent — the MCP middleware wraps the text channel
  // in `<untrusted-tool-output>…</untrusted-tool-output>` fences so a
  // bare JSON.parse on .content[0].text would always reject. The
  // structuredContent channel carries the same payload, already typed.
  if (out.structuredContent) return out.structuredContent as ParsedToolPayload;
  const text = out.content.find((c) => c.type === "text")?.text;
  if (!text) return {};
  try {
    return JSON.parse(text) as ParsedToolPayload;
  } catch {
    return {};
  }
}

describe("registerThreadTools — handler-level coverage", () => {
  it("modify_thread: forwards addLabelIds + removeLabelIds in the request body", async () => {
    const { gmail, modifySpy } = makeMockGmail();
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "modify_thread",
        arguments: { threadId: "t-123", addLabelIds: ["INBOX"], removeLabelIds: ["SPAM"] },
      });
      expect(modifySpy).toHaveBeenCalledOnce();
      const call = modifySpy.mock.calls[0]?.[0] as {
        userId: string;
        id: string;
        requestBody: Record<string, unknown>;
      };
      expect(call.userId).toBe("me");
      expect(call.id).toBe("t-123");
      expect(call.requestBody).toEqual({ addLabelIds: ["INBOX"], removeLabelIds: ["SPAM"] });
      // Response carries the success text. Find the text content by
      // type rather than index — order is incidental, type isn't.
      const text =
        (out.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")
          ?.text ?? "";
      expect(text).toMatch(/Thread t-123 labels updated successfully/);
    } finally {
      await close();
    }
  });

  it("modify_thread: omits unset label arrays from the request body", async () => {
    const { gmail, modifySpy } = makeMockGmail();
    const { client, close } = await makeClient(gmail);
    try {
      await client.callTool({
        name: "modify_thread",
        arguments: { threadId: "t-456" },
      });
      const call = modifySpy.mock.calls[0]?.[0] as { requestBody: Record<string, unknown> };
      // Both branches of the `if (args.X)` guards take the false path.
      expect(call.requestBody).toEqual({});
    } finally {
      await close();
    }
  });

  it("get_thread: defaults to 'full' format and returns body + headers", async () => {
    const { gmail, getSpy } = makeMockGmail();
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "get_thread",
        arguments: { threadId: "t-789" },
      });
      const call = getSpy.mock.calls[0]?.[0] as { format: string };
      // The `args.format || "full"` fallback fires when format is omitted.
      expect(call.format).toBe("full");
      const payload = parseTextPayload(out as { content: Array<{ type: string; text?: string }> });
      expect(payload.threadId).toBe("t-789");
      expect(payload.messageCount).toBe(1);
      expect(payload.messages?.[0]?.subject).toBe("Subject for m1");
      // Body is filled because format !== "minimal".
      expect(payload.messages?.[0]?.body.length ?? 0).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  it("get_thread: with format=minimal skips body extraction and attachments scan", async () => {
    const { gmail, getSpy } = makeMockGmail();
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "get_thread",
        arguments: { threadId: "t-999", format: "minimal" },
      });
      const call = getSpy.mock.calls[0]?.[0] as { format: string };
      expect(call.format).toBe("minimal");
      const payload = parseTextPayload(out as { content: Array<{ type: string; text?: string }> });
      // Body is empty because the `if (args.format !== "minimal")`
      // branch is skipped.
      expect(payload.messages?.[0]?.body).toBe("");
    } finally {
      await close();
    }
  });

  it("list_inbox_threads: uses default query 'in:inbox' and maxResults=50", async () => {
    const { gmail, listSpy } = makeMockGmail();
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "list_inbox_threads",
        arguments: {},
      });
      const call = listSpy.mock.calls[0]?.[0] as { q: string; maxResults: number };
      // Both `args.X || default` branches exercise the false (undefined) path.
      expect(call.q).toBe("in:inbox");
      expect(call.maxResults).toBe(50);
      const payload = parseTextPayload(out as { content: Array<{ type: string; text?: string }> });
      expect(payload.resultCount).toBe(1);
    } finally {
      await close();
    }
  });

  it("list_inbox_threads: forwards custom query + maxResults through to the API", async () => {
    const { gmail, listSpy } = makeMockGmail();
    const { client, close } = await makeClient(gmail);
    try {
      await client.callTool({
        name: "list_inbox_threads",
        arguments: { query: "from:alice@example.com", maxResults: 5 },
      });
      const call = listSpy.mock.calls[0]?.[0] as { q: string; maxResults: number };
      expect(call.q).toBe("from:alice@example.com");
      expect(call.maxResults).toBe(5);
    } finally {
      await close();
    }
  });

  it("get_inbox_with_threads: expandThreads=false returns metadata-only summaries", async () => {
    const { gmail, listSpy, getSpy } = makeMockGmail();
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "get_inbox_with_threads",
        arguments: { expandThreads: false },
      });
      // The list happens once for the index, then `format: "metadata"`
      // get for each thread summary.
      expect(listSpy).toHaveBeenCalledOnce();
      const getCall = getSpy.mock.calls[0]?.[0] as { format: string };
      expect(getCall.format).toBe("metadata");
      const payload = parseTextPayload(out as { content: Array<{ type: string; text?: string }> });
      expect(payload.resultCount).toBe(1);
      // No messages array on a summary.
      expect(payload.threads?.[0]?.messageCount).toBe(1);
    } finally {
      await close();
    }
  });

  it("get_inbox_with_threads: expandThreads=true returns full message content", async () => {
    const { gmail, getSpy } = makeMockGmail();
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "get_inbox_with_threads",
        arguments: { expandThreads: true },
      });
      const getCall = getSpy.mock.calls[0]?.[0] as { format: string };
      // Expand path uses `format: "full"` for each thread fetch.
      expect(getCall.format).toBe("full");
      const payload = parseTextPayload(out as { content: Array<{ type: string; text?: string }> });
      expect(payload.threads?.[0]?.messageCount).toBe(1);
    } finally {
      await close();
    }
  });

  it("get_thread: handles a message with a missing payload (optional-chain branches)", async () => {
    // Force the `msg.payload?.headers` and `(msg.payload as ...) || {}`
    // and `msg.payload ? collectAttachmentsForThread(...) : []` branches
    // to all take the false / fallback path simultaneously.
    const gmail = {
      users: {
        threads: {
          modify: vi.fn(),
          get: vi.fn(() =>
            Promise.resolve({
              data: {
                messages: [
                  {
                    id: "m-bare",
                    threadId: "t-bare",
                    labelIds: ["INBOX"],
                    // payload deliberately omitted.
                  },
                ],
              },
            }),
          ),
          list: vi.fn(),
        },
      },
    } as unknown as gmail_v1.Gmail;
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "get_thread",
        arguments: { threadId: "t-bare" },
      });
      const payload = parseTextPayload(out as { content: Array<{ type: string; text?: string }> });
      expect(payload.threadId).toBe("t-bare");
      expect(payload.messageCount).toBe(1);
      // Empty headers map to "" via getH; body falls back to "" via the
      // pickBodyAnnotated of an empty extractEmailContent result.
      expect(payload.messages?.[0]?.subject).toBe("");
    } finally {
      await close();
    }
  });

  it("list_inbox_threads: handles a thread whose detail.data.messages is empty (latestMessage undefined)", async () => {
    // Force the `latestMessage?.payload?.headers` optional chain to take
    // the undefined path. The summary still emits "" for from/subject/date.
    const gmail = {
      users: {
        threads: {
          modify: vi.fn(),
          get: vi.fn(() =>
            Promise.resolve({
              // No messages -> latestMessage = undefined -> headers branch
              // hits the optional-chain fallback.
              data: { messages: [] },
            }),
          ),
          list: vi.fn(() =>
            Promise.resolve({
              data: { threads: [{ id: "t-empty", snippet: "snip", historyId: "h0" }] },
            }),
          ),
        },
      },
    } as unknown as gmail_v1.Gmail;
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "list_inbox_threads",
        arguments: {},
      });
      const payload = parseTextPayload(out as { content: Array<{ type: string; text?: string }> });
      expect(payload.resultCount).toBe(1);
      expect(payload.threads?.[0]?.messageCount).toBe(0);
    } finally {
      await close();
    }
  });

  it("get_inbox_with_threads expandThreads=false: handles empty messages list (latestMessage undefined)", async () => {
    // Same shape as above but for the no-expand summary path so the
    // 230-258 branch family also gets the empty-thread treatment.
    const gmail = {
      users: {
        threads: {
          modify: vi.fn(),
          get: vi.fn(() => Promise.resolve({ data: { messages: [] } })),
          list: vi.fn(() =>
            Promise.resolve({
              data: { threads: [{ id: "t-x", snippet: "x", historyId: "hx" }] },
            }),
          ),
        },
      },
    } as unknown as gmail_v1.Gmail;
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "get_inbox_with_threads",
        arguments: { expandThreads: false },
      });
      const payload = parseTextPayload(out as { content: Array<{ type: string; text?: string }> });
      expect(payload.threads?.[0]?.messageCount).toBe(0);
    } finally {
      await close();
    }
  });

  it("get_inbox_with_threads expandThreads=true: handles a message with no payload (every fallback fires)", async () => {
    // Expand path with a payload-less message — exercises the optional
    // chain on payload?.headers AND the `msg.payload ? ... : []`
    // attachments branch in the false direction.
    const gmail = {
      users: {
        threads: {
          modify: vi.fn(),
          get: vi.fn(() =>
            Promise.resolve({
              data: {
                messages: [{ id: "m-bare", threadId: "t-bare", labelIds: [] }],
              },
            }),
          ),
          list: vi.fn(() =>
            Promise.resolve({ data: { threads: [{ id: "t-bare", snippet: "" }] } }),
          ),
        },
      },
    } as unknown as gmail_v1.Gmail;
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "get_inbox_with_threads",
        arguments: { expandThreads: true },
      });
      const payload = parseTextPayload(out as { content: Array<{ type: string; text?: string }> });
      expect(payload.threads?.[0]?.messageCount).toBe(1);
    } finally {
      await close();
    }
  });

  it("get_inbox_with_threads: forwards custom query + maxResults (lines 213-215 truthy branches)", async () => {
    const { gmail, listSpy } = makeMockGmail();
    const { client, close } = await makeClient(gmail);
    try {
      await client.callTool({
        name: "get_inbox_with_threads",
        arguments: {
          query: "from:bob@example.com",
          maxResults: 7,
          expandThreads: false,
        },
      });
      const call = listSpy.mock.calls[0]?.[0] as { q: string; maxResults: number };
      expect(call.q).toBe("from:bob@example.com");
      expect(call.maxResults).toBe(7);
    } finally {
      await close();
    }
  });

  it("get_inbox_with_threads: handles empty threads array (data.threads || [] line 217)", async () => {
    const gmail = {
      users: {
        threads: {
          modify: vi.fn(),
          get: vi.fn(),
          // data.threads omitted -> `|| []` fires.
          list: vi.fn(() => Promise.resolve({ data: {} })),
        },
      },
    } as unknown as gmail_v1.Gmail;
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "get_inbox_with_threads",
        arguments: {},
      });
      const payload = parseTextPayload(out as { content: Array<{ type: string; text?: string }> });
      expect(payload.resultCount).toBe(0);
    } finally {
      await close();
    }
  });

  it("get_inbox_with_threads expandThreads=false: thread.snippet/historyId fall back to '' (236-238)", async () => {
    const gmail = {
      users: {
        threads: {
          modify: vi.fn(),
          get: vi.fn(() => Promise.resolve({ data: { messages: [] } })),
          list: vi.fn(() =>
            // snippet + historyId omitted from the thread entry -> the
            // `thread.snippet || ""` and `thread.historyId || ""` defaults fire.
            Promise.resolve({ data: { threads: [{ id: "t-bare" }] } }),
          ),
        },
      },
    } as unknown as gmail_v1.Gmail;
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "get_inbox_with_threads",
        arguments: { expandThreads: false },
      });
      const payload = parseTextPayload(out as { content: Array<{ type: string; text?: string }> });
      expect(payload.threads?.[0]?.threadId).toBe("t-bare");
    } finally {
      await close();
    }
  });

  it("get_inbox_with_threads expandThreads=false: aggregates 3+ threads with mixed message counts", async () => {
    // Multiple threads, each with a different number of messages — exercises
    // the Promise.all map branches across more than one element so the
    // `messages[messages.length - 1]` index walking + the per-thread
    // `latestMessage?.payload?.headers` chain run on real data, not just
    // the single-thread default.
    const buildMsg = (id: string): unknown => ({
      id,
      threadId: id.split("-")[0],
      payload: {
        headers: [
          { name: "Subject", value: `S-${id}` },
          { name: "From", value: `from-${id}@example.com` },
          { name: "Date", value: "Wed, 01 Jan 2025 00:00:00 +0000" },
        ],
      },
    });
    const threadFixtures: Record<string, unknown[]> = {
      t1: [buildMsg("t1-a")],
      t2: [buildMsg("t2-a"), buildMsg("t2-b")],
      t3: [buildMsg("t3-a"), buildMsg("t3-b"), buildMsg("t3-c")],
    };
    const gmail = {
      users: {
        threads: {
          modify: vi.fn(),
          get: vi.fn((p: { id: string }) =>
            Promise.resolve({ data: { messages: threadFixtures[p.id] ?? [] } }),
          ),
          list: vi.fn(() =>
            Promise.resolve({
              data: {
                threads: [
                  { id: "t1", snippet: "snip-1", historyId: "h1" },
                  { id: "t2", snippet: "snip-2", historyId: "h2" },
                  { id: "t3", snippet: "snip-3", historyId: "h3" },
                ],
              },
            }),
          ),
        },
      },
    } as unknown as gmail_v1.Gmail;
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "get_inbox_with_threads",
        arguments: { expandThreads: false },
      });
      const payload = parseTextPayload(out as { content: Array<{ type: string; text?: string }> });
      expect(payload.resultCount).toBe(3);
      expect(payload.threads?.[0]?.messageCount).toBe(1);
      expect(payload.threads?.[1]?.messageCount).toBe(2);
      expect(payload.threads?.[2]?.messageCount).toBe(3);
    } finally {
      await close();
    }
  });

  it("get_inbox_with_threads expandThreads=true: aggregates messages with attachments + decoded body", async () => {
    // Single thread with two messages, one bearing an attachment in a
    // multipart payload. Exercises the messages.map(msg => ...)
    // walker + the collectAttachmentsForThread branch that finds an
    // attachment + the attachments.map projection at the end.
    const gmail = {
      users: {
        threads: {
          modify: vi.fn(),
          get: vi.fn(() =>
            Promise.resolve({
              data: {
                messages: [
                  {
                    id: "m1",
                    threadId: "T-rich",
                    payload: {
                      mimeType: "text/plain",
                      headers: [
                        { name: "Subject", value: "First" },
                        { name: "Date", value: "Wed, 01 Jan 2025 00:00:00 +0000" },
                      ],
                      body: { data: Buffer.from("text body").toString("base64url") },
                    },
                  },
                  {
                    id: "m2",
                    threadId: "T-rich",
                    payload: {
                      mimeType: "multipart/mixed",
                      headers: [{ name: "Subject", value: "Second w/ attachment" }],
                      parts: [
                        {
                          mimeType: "text/plain",
                          body: { data: Buffer.from("body").toString("base64url") },
                        },
                        {
                          filename: "doc.pdf",
                          mimeType: "application/pdf",
                          body: { attachmentId: "ATT-99", size: 2048 },
                        },
                      ],
                    },
                  },
                ],
              },
            }),
          ),
          list: vi.fn(() =>
            Promise.resolve({ data: { threads: [{ id: "T-rich", snippet: "rich" }] } }),
          ),
        },
      },
    } as unknown as gmail_v1.Gmail;
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "get_inbox_with_threads",
        arguments: { expandThreads: true },
      });
      const payload = parseTextPayload(out as { content: Array<{ type: string; text?: string }> });
      expect(payload.threads?.[0]?.messageCount).toBe(2);
    } finally {
      await close();
    }
  });

  it("get_inbox_with_threads expandThreads=true: aggregates messages with attachments + body decoding", async () => {
    // Hits the messages.map branch where each message carries an
    // attachment (attachments.map projection runs), and one message has
    // explicit cc/bcc + html body for full header coverage.
    const gmail = {
      users: {
        threads: {
          modify: vi.fn(),
          get: vi.fn(() =>
            Promise.resolve({
              data: {
                messages: [
                  {
                    id: "m1",
                    threadId: "T-att",
                    payload: {
                      mimeType: "multipart/mixed",
                      headers: [
                        { name: "Subject", value: "S1" },
                        { name: "From", value: "from@example.com" },
                        { name: "To", value: "to@example.com" },
                        { name: "Cc", value: "cc@example.com" },
                        { name: "Bcc", value: "bcc@example.com" },
                        { name: "Date", value: "Wed, 01 Jan 2025 00:00:00 +0000" },
                      ],
                      parts: [
                        {
                          mimeType: "text/plain",
                          body: { data: Buffer.from("body").toString("base64url") },
                        },
                        {
                          filename: "att.pdf",
                          mimeType: "application/pdf",
                          body: { attachmentId: "ATT-1", size: 1024 },
                        },
                      ],
                    },
                  },
                ],
              },
            }),
          ),
          list: vi.fn(() =>
            Promise.resolve({ data: { threads: [{ id: "T-att", snippet: "att" }] } }),
          ),
        },
      },
    } as unknown as gmail_v1.Gmail;
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "get_inbox_with_threads",
        arguments: { expandThreads: true },
      });
      const payload = parseTextPayload(out as { content: Array<{ type: string; text?: string }> });
      expect(payload.threads?.[0]?.messageCount).toBe(1);
    } finally {
      await close();
    }
  });

  it("get_inbox_with_threads expandThreads=true: thread.id/msg.id/msg.threadId fall back to '' when missing", async () => {
    // Force the `thread.id || ""` (line 311), `msg.id || ""` and
    // `msg.threadId || ""` (293-294) defaults to fire by responding
    // with parts that don't include those fields.
    const gmail = {
      users: {
        threads: {
          modify: vi.fn(),
          get: vi.fn(() =>
            Promise.resolve({
              data: {
                messages: [
                  {
                    // id + threadId deliberately omitted -> the `|| ""`
                    // defaults fire.
                    payload: {
                      headers: [{ name: "Subject", value: "S-bare" }],
                    },
                  },
                ],
              },
            }),
          ),
          list: vi.fn(() =>
            Promise.resolve({
              // thread.id is "" — falsy enough to trip `thread.id || ""`
              // but defined so the `thread.id!` assertion in get() doesn't crash.
              data: { threads: [{ id: "", snippet: "" }] },
            }),
          ),
        },
      },
    } as unknown as gmail_v1.Gmail;
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "get_inbox_with_threads",
        arguments: { expandThreads: true },
      });
      const payload = parseTextPayload(out as { content: Array<{ type: string; text?: string }> });
      expect(payload.threads?.[0]?.messageCount).toBe(1);
      expect(payload.threads?.[0]?.threadId).toBe("");
    } finally {
      await close();
    }
  });

  it("get_inbox_with_threads expandThreads=true: threadDetail without messages array falls back to [] (line 271)", async () => {
    const gmail = {
      users: {
        threads: {
          modify: vi.fn(),
          // No messages property in threadDetail.data -> `|| []` fires.
          get: vi.fn(() => Promise.resolve({ data: {} })),
          list: vi.fn(() =>
            Promise.resolve({ data: { threads: [{ id: "t-no-msg", snippet: "no msgs" }] } }),
          ),
        },
      },
    } as unknown as gmail_v1.Gmail;
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "get_inbox_with_threads",
        arguments: { expandThreads: true },
      });
      const payload = parseTextPayload(out as { content: Array<{ type: string; text?: string }> });
      expect(payload.threads?.[0]?.messageCount).toBe(0);
    } finally {
      await close();
    }
  });

  it("list_inbox_threads: aggregates 3 threads with their latestMessage headers", async () => {
    const buildMsg = (id: string): unknown => ({
      id,
      payload: {
        headers: [
          { name: "Subject", value: `S-${id}` },
          { name: "From", value: `from-${id}@example.com` },
          { name: "Date", value: "Wed, 01 Jan 2025 00:00:00 +0000" },
        ],
      },
    });
    const threadFixtures: Record<string, unknown[]> = {
      t1: [buildMsg("t1-a")],
      t2: [buildMsg("t2-a"), buildMsg("t2-b")],
    };
    const gmail = {
      users: {
        threads: {
          modify: vi.fn(),
          get: vi.fn((p: { id: string }) =>
            Promise.resolve({ data: { messages: threadFixtures[p.id] ?? [] } }),
          ),
          list: vi.fn(() =>
            Promise.resolve({
              data: {
                threads: [
                  { id: "t1", snippet: "s1", historyId: "h1" },
                  { id: "t2", snippet: "s2", historyId: "h2" },
                ],
              },
            }),
          ),
        },
      },
    } as unknown as gmail_v1.Gmail;
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({ name: "list_inbox_threads", arguments: {} });
      const payload = parseTextPayload(out as { content: Array<{ type: string; text?: string }> });
      expect(payload.resultCount).toBe(2);
      expect(payload.threads?.[0]?.messageCount).toBe(1);
      expect(payload.threads?.[1]?.messageCount).toBe(2);
    } finally {
      await close();
    }
  });
});
