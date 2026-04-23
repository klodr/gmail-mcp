import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveDefaultSender,
  _resetDefaultSenderCache,
  type SenderResolverGmailClient,
} from "./sender-resolver.js";

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
            return {
              data: {
                sendAs: (opts.sendAs ?? null) as SenderResolverGmailClient extends infer _
                  ? never
                  : never,
              },
            } as unknown as Awaited<
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
});
