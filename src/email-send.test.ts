import { describe, it, expect, vi, beforeEach } from "vitest";
import type { gmail_v1 } from "googleapis";
import { sendOrDraftEmail, type EmailSendArgs } from "./email-send.js";
import { _resetDefaultSenderCache } from "./sender-resolver.js";

// Build a mocked gmail client. Each method records its calls; any
// method not configured to throw returns the supplied response (or a
// minimal stub if none is supplied). The resulting object is cast to
// `gmail_v1.Gmail` so the function-under-test sees the exact shape it
// expects without us mocking every untouched property of the real type.
function mockGmail(opts: {
  threadGet?: {
    messages?: Array<{ payload?: { headers?: Array<{ name: string; value: string }> } }>;
  };
  threadGetThrows?: boolean;
  sendId?: string;
  draftId?: string;
  sendThrows?: Error;
  draftThrows?: Error;
}): {
  client: gmail_v1.Gmail;
  calls: {
    threadGet: Array<unknown>;
    messageSend: Array<unknown>;
    draftCreate: Array<unknown>;
  };
} {
  const calls = {
    threadGet: [] as Array<unknown>,
    messageSend: [] as Array<unknown>,
    draftCreate: [] as Array<unknown>,
  };

  const client = {
    users: {
      threads: {
        get: async (params: unknown) => {
          calls.threadGet.push(params);
          if (opts.threadGetThrows) throw new Error("thread fetch failed");
          return { data: { messages: opts.threadGet?.messages ?? [] } };
        },
      },
      messages: {
        send: async (params: unknown) => {
          calls.messageSend.push(params);
          if (opts.sendThrows) throw opts.sendThrows;
          return { data: { id: opts.sendId ?? "msg_default" } };
        },
      },
      drafts: {
        create: async (params: unknown) => {
          calls.draftCreate.push(params);
          if (opts.draftThrows) throw opts.draftThrows;
          return { data: { id: opts.draftId ?? "draft_default" } };
        },
      },
      // resolveDefaultSender uses these — return enough to make the
      // resolver pick a value without throwing.
      settings: {
        sendAs: {
          list: async () => ({
            data: { sendAs: [{ sendAsEmail: "me@example.com", isDefault: true }] },
          }),
        },
      },
      getProfile: async () => ({ data: { emailAddress: "me@example.com" } }),
    },
  } as unknown as gmail_v1.Gmail;

  return { client, calls };
}

const baseArgs = (overrides: Partial<EmailSendArgs> = {}): EmailSendArgs => ({
  subject: "Hello",
  to: ["bob@example.com"],
  body: "Hi Bob",
  ...overrides,
});

describe("sendOrDraftEmail — no attachments path", () => {
  beforeEach(() => {
    _resetDefaultSenderCache();
  });

  it("send action calls gmail.users.messages.send and returns the message ID", async () => {
    const { client, calls } = mockGmail({ sendId: "msg_xyz" });
    const result = await sendOrDraftEmail(client, "send", baseArgs({ from: "me@example.com" }));

    expect(calls.messageSend).toHaveLength(1);
    expect(calls.draftCreate).toHaveLength(0);
    expect(result.content[0]?.text).toContain("msg_xyz");
    expect(result.content[0]?.text).toContain("sent successfully");
  });

  it("draft action calls gmail.users.drafts.create and returns the draft ID", async () => {
    const { client, calls } = mockGmail({ draftId: "draft_abc" });
    const result = await sendOrDraftEmail(client, "draft", baseArgs({ from: "me@example.com" }));

    expect(calls.draftCreate).toHaveLength(1);
    expect(calls.messageSend).toHaveLength(0);
    expect(result.content[0]?.text).toContain("draft_abc");
    expect(result.content[0]?.text).toContain("draft created");
  });

  it("forwards threadId to gmail.users.messages.send", async () => {
    const { client, calls } = mockGmail({});
    await sendOrDraftEmail(
      client,
      "send",
      baseArgs({ from: "me@example.com", threadId: "thread_42", inReplyTo: "<id-42@x>" }),
    );
    const call = calls.messageSend[0] as { requestBody: { threadId?: string } };
    expect(call.requestBody.threadId).toBe("thread_42");
  });
});

// The attachments branch (`attachments.length > 0`, routes through
// Nodemailer + messages.send/drafts.create with `raw: base64`) is not
// covered here — it would require a temp file fixture for Nodemailer
// to attach, and the mime-construction logic on that path is already
// exercised through `utl.test.ts`'s `createEmailWithNodemailer`
// coverage. The dispatcher-level integration is best validated end-to-end
// once the McpServer factory lands (PR #2 in the v1.0.0 plan).

describe("sendOrDraftEmail — thread-header auto-resolve", () => {
  beforeEach(() => {
    _resetDefaultSenderCache();
  });

  it("populates inReplyTo and references from the thread when threadId is set without inReplyTo", async () => {
    const { client, calls } = mockGmail({
      threadGet: {
        messages: [
          { payload: { headers: [{ name: "Message-ID", value: "<a@x>" }] } },
          { payload: { headers: [{ name: "Message-ID", value: "<b@x>" }] } },
        ],
      },
    });
    const args = baseArgs({ from: "me@example.com", threadId: "T1" });
    await sendOrDraftEmail(client, "send", args);

    expect(calls.threadGet).toHaveLength(1);
    expect(args.inReplyTo).toBe("<b@x>");
    expect(args.references).toBe("<a@x> <b@x>");
  });

  it("continues without throwing when the thread fetch fails", async () => {
    const { client, calls } = mockGmail({ threadGetThrows: true });
    const args = baseArgs({ from: "me@example.com", threadId: "T_broken" });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await sendOrDraftEmail(client, "send", args);
    warnSpy.mockRestore();

    expect(args.inReplyTo).toBeUndefined();
    expect(args.references).toBeUndefined();
    expect(calls.messageSend).toHaveLength(1);
    expect(result.content[0]?.text).toContain("sent successfully");
  });

  it("does NOT re-fetch the thread when inReplyTo is already supplied by the caller", async () => {
    const { client, calls } = mockGmail({});
    await sendOrDraftEmail(
      client,
      "send",
      baseArgs({ from: "me@example.com", threadId: "T1", inReplyTo: "<existing@x>" }),
    );
    expect(calls.threadGet).toHaveLength(0);
  });
});

describe("sendOrDraftEmail — from auto-resolution", () => {
  beforeEach(() => {
    _resetDefaultSenderCache();
  });

  it("resolves an empty `from` via resolveDefaultSender", async () => {
    const { client, calls } = mockGmail({});
    const args = baseArgs({ from: "" });
    await sendOrDraftEmail(client, "send", args);
    // resolveDefaultSender returns "me@example.com" via the mocked
    // sendAs.list — the mutation is the contract we want to pin.
    expect(args.from).toBe("me@example.com");
    expect(calls.messageSend).toHaveLength(1);
  });

  it("does NOT call resolveDefaultSender when the caller supplies `from`", async () => {
    const { client, calls } = mockGmail({});
    const args = baseArgs({ from: "explicit@example.com" });
    await sendOrDraftEmail(client, "send", args);
    expect(args.from).toBe("explicit@example.com");
    expect(calls.messageSend).toHaveLength(1);
  });
});

describe("sendOrDraftEmail — error propagation", () => {
  beforeEach(() => {
    _resetDefaultSenderCache();
  });

  it("propagates a gmail.users.messages.send failure", async () => {
    const boom = new Error("upstream 500");
    const { client } = mockGmail({ sendThrows: boom });
    await expect(
      sendOrDraftEmail(client, "send", baseArgs({ from: "me@example.com" })),
    ).rejects.toThrow(/upstream 500/);
  });
});
