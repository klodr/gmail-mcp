import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveDefaultSender,
  resolveSender,
  pickConversationAlias,
  _resetDefaultSenderCache,
  type ConversationHeaders,
  type ConversationSenderGmailClient,
  type SenderResolverGmailClient,
} from "../src/sender-resolver.js";

// Build a mocked gmail client from a minimal recipe. Any method not
// supplied throws to surface misuse (better than returning an empty
// response that would pass a check by accident).
function mockGmail(opts: {
  sendAs?: unknown[];
  sendAsThrows?: boolean;
  emailAddress?: string | null;
  getProfileThrows?: boolean;
}): SenderResolverGmailClient {
  return {
    users: {
      settings: {
        sendAs: {
          list: async () => {
            if (opts.sendAsThrows) {
              const e = new Error("insufficient scope") as Error & { code?: number };
              e.code = 403;
              throw e;
            }
            // Cast through `unknown` to the googleapis return type. The
            // clever `T extends infer _ ? never : never` hack was more
            // obscure than useful — a plain double-cast with a short
            // comment is easier to maintain.
            return { data: { sendAs: opts.sendAs ?? null } } as unknown as Awaited<
              ReturnType<SenderResolverGmailClient["users"]["settings"]["sendAs"]["list"]>
            >;
          },
        },
      },
      getProfile: async () => {
        if (opts.getProfileThrows) throw new Error("profile fetch failed");
        return { data: { emailAddress: opts.emailAddress ?? null } };
      },
    },
  };
}

describe("resolveDefaultSender — upstream GongRzhe#77", () => {
  beforeEach(() => {
    _resetDefaultSenderCache();
  });

  it("returns 'Display Name <email>' from the default sendAs entry", async () => {
    const gmail = mockGmail({
      sendAs: [
        { sendAsEmail: "alt@example.com", displayName: "Alt Account" },
        { sendAsEmail: "bob@example.com", displayName: "Bob Smith", isDefault: true },
      ],
    });
    expect(await resolveDefaultSender(gmail)).toBe("Bob Smith <bob@example.com>");
  });

  it("returns the bare email when the default sendAs has no displayName", async () => {
    const gmail = mockGmail({
      sendAs: [{ sendAsEmail: "bob@example.com", isDefault: true }],
    });
    expect(await resolveDefaultSender(gmail)).toBe("bob@example.com");
  });

  it("falls back to isPrimary when no isDefault is set", async () => {
    const gmail = mockGmail({
      sendAs: [
        { sendAsEmail: "alt@example.com", displayName: "Alt" },
        { sendAsEmail: "bob@example.com", displayName: "Bob", isPrimary: true },
      ],
    });
    expect(await resolveDefaultSender(gmail)).toBe("Bob <bob@example.com>");
  });

  it("falls back to the first sendAs when neither isDefault nor isPrimary is set", async () => {
    const gmail = mockGmail({
      sendAs: [
        { sendAsEmail: "first@example.com", displayName: "First" },
        { sendAsEmail: "second@example.com", displayName: "Second" },
      ],
    });
    expect(await resolveDefaultSender(gmail)).toBe("First <first@example.com>");
  });

  it("falls back to getProfile when sendAs throws (gmail.send-only scope)", async () => {
    const gmail = mockGmail({
      sendAsThrows: true,
      emailAddress: "bob@example.com",
    });
    expect(await resolveDefaultSender(gmail)).toBe("bob@example.com");
  });

  it("falls back to getProfile when sendAs returns an empty list", async () => {
    const gmail = mockGmail({
      sendAs: [],
      emailAddress: "bob@example.com",
    });
    expect(await resolveDefaultSender(gmail)).toBe("bob@example.com");
  });

  it("returns 'me' sentinel when both sendAs and getProfile fail", async () => {
    const gmail = mockGmail({
      sendAsThrows: true,
      getProfileThrows: true,
    });
    expect(await resolveDefaultSender(gmail)).toBe("me");
  });

  it("caches the resolved sender across calls", async () => {
    let sendAsCalls = 0;
    const gmail: SenderResolverGmailClient = {
      users: {
        settings: {
          sendAs: {
            list: async () => {
              sendAsCalls++;
              return {
                data: {
                  sendAs: [{ sendAsEmail: "bob@example.com", displayName: "Bob", isDefault: true }],
                } as unknown as Awaited<
                  ReturnType<SenderResolverGmailClient["users"]["settings"]["sendAs"]["list"]>
                >["data"],
              };
            },
          },
        },
        getProfile: async () => ({ data: {} }),
      },
    };

    await resolveDefaultSender(gmail);
    await resolveDefaultSender(gmail);
    await resolveDefaultSender(gmail);
    expect(sendAsCalls).toBe(1);
  });

  it("does NOT cache the 'me' sentinel so a re-auth on broader scope picks up the display name", async () => {
    let sendAsCalls = 0;
    let failing = true;
    const gmail: SenderResolverGmailClient = {
      users: {
        settings: {
          sendAs: {
            list: async () => {
              sendAsCalls++;
              if (failing) throw new Error("insufficient scope");
              return {
                data: {
                  sendAs: [{ sendAsEmail: "bob@example.com", displayName: "Bob", isDefault: true }],
                } as unknown as Awaited<
                  ReturnType<SenderResolverGmailClient["users"]["settings"]["sendAs"]["list"]>
                >["data"],
              };
            },
          },
        },
        getProfile: async () => {
          throw new Error("profile unavailable");
        },
      },
    };

    expect(await resolveDefaultSender(gmail)).toBe("me");
    // Broaden scope scenario: next call should retry, not be served from cache.
    failing = false;
    expect(await resolveDefaultSender(gmail)).toBe("Bob <bob@example.com>");
    expect(sendAsCalls).toBe(2);
  });

  it("caches per-client, not globally (Qodo #42 multi-account safety)", async () => {
    // Two distinct gmail clients in the same process — think alice's
    // session and bob's session. The pre-fix module-level cache would
    // return alice's resolved sender for bob's second call because the
    // cache was keyed on nothing. The WeakMap keyed by client keeps
    // each identity isolated.
    const alice = mockGmail({
      sendAs: [{ sendAsEmail: "alice@example.com", displayName: "Alice", isDefault: true }],
    });
    const bob = mockGmail({
      sendAs: [{ sendAsEmail: "bob@example.com", displayName: "Bob", isDefault: true }],
    });

    expect(await resolveDefaultSender(alice)).toBe("Alice <alice@example.com>");
    expect(await resolveDefaultSender(bob)).toBe("Bob <bob@example.com>");
    // Both cache hits round-trip cleanly to the SAME respective value.
    expect(await resolveDefaultSender(alice)).toBe("Alice <alice@example.com>");
    expect(await resolveDefaultSender(bob)).toBe("Bob <bob@example.com>");
  });

  it("dedups concurrent cold-cache calls into a single round-trip (Qodo #42)", async () => {
    // On cold cache, two simultaneous callers must share the same
    // in-flight promise rather than each firing their own sendAs.list.
    let sendAsCalls = 0;
    const gmail: SenderResolverGmailClient = {
      users: {
        settings: {
          sendAs: {
            list: async () => {
              sendAsCalls++;
              await new Promise((r) => setTimeout(r, 20));
              return {
                data: { sendAs: [{ sendAsEmail: "x@example.com", isDefault: true }] },
              } as unknown as Awaited<
                ReturnType<SenderResolverGmailClient["users"]["settings"]["sendAs"]["list"]>
              >;
            },
          },
        },
        getProfile: async () => ({ data: {} }),
      },
    };

    const [a, b, c] = await Promise.all([
      resolveDefaultSender(gmail),
      resolveDefaultSender(gmail),
      resolveDefaultSender(gmail),
    ]);
    expect(a).toBe("x@example.com");
    expect(b).toBe("x@example.com");
    expect(c).toBe("x@example.com");
    expect(sendAsCalls).toBe(1);
  });
});

// Conversation-aware sender: a reply leaves from the alias the thread
// already uses (personal thread → personal alias), never silently from
// the account default. Addresses are built at runtime, the leak scan
// rejects literal addresses added in a diff.
describe("resolveSender — reply from the alias the conversation uses", () => {
  const mail = (user: string): string => `${user}@example.com`;
  const twoAliases = [
    { sendAsEmail: mail("company"), displayName: "Company", isDefault: true },
    { sendAsEmail: mail("perso"), displayName: "Perso" },
  ];
  const headers = (h: Partial<ConversationHeaders>): ConversationHeaders => ({
    from: "",
    to: "",
    cc: "",
    deliveredTo: "",
    ...h,
  });

  function conversationGmail(opts: {
    sendAs?: unknown[];
    sendAsThrows?: boolean;
    thread?: { from?: string; to?: string; labelIds?: string[] }[];
  }): { gmail: ConversationSenderGmailClient; counts: { sendAs: number; thread: number } } {
    const counts = { sendAs: 0, thread: 0 };
    const gmail = {
      users: {
        settings: {
          sendAs: {
            list: async () => {
              counts.sendAs++;
              if (opts.sendAsThrows) throw new Error("insufficient scope");
              return { data: { sendAs: opts.sendAs ?? twoAliases } };
            },
          },
        },
        getProfile: async () => ({ data: { emailAddress: mail("company") } }),
        threads: {
          get: async () => {
            counts.thread++;
            return {
              data: {
                messages: (opts.thread ?? []).map((m) => ({
                  labelIds: m.labelIds ?? [],
                  payload: {
                    headers: [
                      { name: "From", value: m.from ?? "" },
                      { name: "To", value: m.to ?? "" },
                    ],
                  },
                })),
              },
            };
          },
        },
      },
    } as unknown as ConversationSenderGmailClient;
    return { gmail, counts };
  }

  beforeEach(() => {
    _resetDefaultSenderCache();
  });

  it("replies from the alias the source message was sent to", async () => {
    const { gmail, counts } = conversationGmail({});
    const source = headers({ from: mail("bank"), to: mail("perso"), deliveredTo: mail("company") });
    expect(await resolveSender(gmail, { source, threadId: "T1" })).toBe(`Perso <${mail("perso")}>`);
    expect(counts.thread).toBe(0);
  });

  it("reuses the alias of our own source message", async () => {
    const { gmail } = conversationGmail({});
    const source = headers({ from: mail("perso"), to: mail("bank") });
    expect(await resolveSender(gmail, { source })).toBe(`Perso <${mail("perso")}>`);
  });

  it("falls back to the alias we last wrote from in the thread, drafts ignored", async () => {
    const { gmail, counts } = conversationGmail({
      thread: [
        { from: mail("perso"), to: mail("bank") },
        { from: mail("bank"), to: mail("list") },
        { from: mail("company"), to: mail("bank"), labelIds: ["DRAFT"] },
      ],
    });
    const source = headers({ from: mail("bank"), to: mail("list") });
    expect(await resolveSender(gmail, { source, threadId: "T1" })).toBe(`Perso <${mail("perso")}>`);
    expect(counts.thread).toBe(1);
  });

  it("prefers the alias used in the thread over a default Delivered-To", async () => {
    const { gmail, counts } = conversationGmail({
      thread: [{ from: mail("perso"), to: mail("bank") }],
    });
    const source = headers({ from: mail("bank"), to: mail("list"), deliveredTo: mail("company") });
    expect(await resolveSender(gmail, { source, threadId: "T1" })).toBe(`Perso <${mail("perso")}>`);
    expect(counts.thread).toBe(1);
  });

  it("uses Delivered-To when the thread names no alias", async () => {
    const { gmail } = conversationGmail({ thread: [{ from: mail("bank"), to: mail("list") }] });
    const source = headers({ from: mail("bank"), to: mail("list"), deliveredTo: mail("perso") });
    expect(await resolveSender(gmail, { source, threadId: "T1" })).toBe(`Perso <${mail("perso")}>`);
  });

  it("reads the newest thread message when only a threadId is known", async () => {
    const { gmail } = conversationGmail({ thread: [{ from: mail("bank"), to: mail("perso") }] });
    expect(await resolveSender(gmail, { threadId: "T1" })).toBe(`Perso <${mail("perso")}>`);
  });

  it("falls back to the default alias when the conversation names none", async () => {
    const { gmail } = conversationGmail({ thread: [{ from: mail("bank"), to: mail("list") }] });
    const source = headers({ from: mail("bank"), to: mail("list") });
    expect(await resolveSender(gmail, { source, threadId: "T1" })).toBe(
      `Company <${mail("company")}>`,
    );
  });

  it("does not fetch the thread when the account has a single alias", async () => {
    const { gmail, counts } = conversationGmail({
      sendAs: [{ sendAsEmail: mail("company"), isDefault: true }],
    });
    expect(await resolveSender(gmail, { threadId: "T1" })).toBe(mail("company"));
    expect(counts.thread).toBe(0);
  });

  it("keeps an explicit alias, adding its display name to a bare address", async () => {
    const { gmail } = conversationGmail({});
    expect(await resolveSender(gmail, { from: mail("perso") })).toBe(`Perso <${mail("perso")}>`);
    expect(await resolveSender(gmail, { from: `Me <${mail("perso")}>` })).toBe(
      `Me <${mail("perso")}>`,
    );
  });

  it("rejects an explicit address that is not a usable alias", async () => {
    const { gmail } = conversationGmail({
      sendAs: [...twoAliases, { sendAsEmail: mail("pending"), verificationStatus: "pending" }],
    });
    await expect(resolveSender(gmail, { from: mail("stranger") })).rejects.toThrow(
      /not a send-as address/,
    );
    await expect(resolveSender(gmail, { from: mail("pending") })).rejects.toThrow(
      /not a send-as address/,
    );
  });

  it("passes an explicit from through unchecked when the alias list is unreadable", async () => {
    const { gmail } = conversationGmail({ sendAsThrows: true });
    expect(await resolveSender(gmail, { from: mail("anyone") })).toBe(mail("anyone"));
  });

  it("lists the aliases once per client", async () => {
    const { gmail, counts } = conversationGmail({});
    await resolveSender(gmail, { from: mail("perso") });
    await resolveSender(gmail, { source: headers({ to: mail("perso") }) });
    expect(counts.sendAs).toBe(1);
  });

  it("pickConversationAlias checks From, To, Cc, the thread, then Delivered-To", () => {
    const aliases = [
      { email: mail("a"), displayName: "" },
      { email: mail("b"), displayName: "" },
    ];
    const pick = (h: Partial<ConversationHeaders>): string | undefined =>
      pickConversationAlias(aliases, headers(h))?.email;
    expect(pick({ from: mail("b"), to: mail("a") })).toBe(mail("b"));
    expect(pick({ to: `x <${mail("x")}>, ${mail("b")}`, cc: mail("a") })).toBe(mail("b"));
    expect(pick({ cc: mail("a"), deliveredTo: mail("b") })).toBe(mail("a"));
    expect(pick({ deliveredTo: mail("B").toUpperCase() })).toBe(mail("b"));
    expect(pick({ to: mail("x") })).toBeUndefined();
    const thread = [headers({ from: mail("x") }), headers({ from: mail("a") })];
    expect(pickConversationAlias(aliases, headers({ deliveredTo: mail("b") }), thread)?.email).toBe(
      mail("a"),
    );
  });
});
