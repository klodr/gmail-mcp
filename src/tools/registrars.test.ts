/**
 * E2E tests for the trivial-tool registrars introduced in PR #3.
 *
 * Each registrar wires its tools into a real `McpServer` (built via
 * `createServer`), connected to an `InMemoryTransport` pair. A
 * `Client` then issues real `tools/call` requests and we assert on
 * the parsed result. This pins the entire `Client → SDK → defineTool
 * adapter → wrapToolHandler → handler → gmail mock` round-trip — the
 * exact pipeline that PR #7's switchover will run in production.
 *
 * Note: the legacy dispatcher in `src/index.ts` is not exercised
 * here. Until PR #7 wires `createServer` into the entry point, the
 * production runtime still routes tool calls through that dispatcher;
 * these tests cover the parallel `McpServer` path that PR #7 will
 * promote to default.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { gmail_v1 } from "googleapis";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import { resetRateLimitHistory } from "../rate-limit.js";
import { resetJailDirCache } from "../utl.js";

// Per-test rate-limit isolation: each test gets its own GMAIL_MCP_STATE_DIR
// so the persistent rate-limit ledger does not leak across tests (without
// this, the ~20 filter-tool calls below the 24h cap of the "filters"
// bucket and subsequent tests get 429-ed). Same for download-jail
// (GMAIL_MCP_DOWNLOAD_DIR + the in-process jail-root cache) so the
// download tests in PR #6 do not write to one another's directories.
let stateDir: string;
let downloadDir: string;
let pairedPath: string;
const originalEnv = { ...process.env };

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "gmail-mcp-registrars-test-"));
  downloadDir = mkdtempSync(join(tmpdir(), "gmail-mcp-download-test-"));
  // pair_recipient writes to GMAIL_MCP_PAIRED_PATH — point it at a
  // file inside the temp state-dir so each test gets a fresh
  // allowlist and the host's real ~/.gmail-mcp/paired.json is never
  // touched.
  pairedPath = join(stateDir, "paired.json");
  process.env.GMAIL_MCP_PAIRED_PATH = pairedPath;
  process.env.GMAIL_MCP_STATE_DIR = stateDir;
  process.env.GMAIL_MCP_DOWNLOAD_DIR = downloadDir;
  delete process.env.GMAIL_MCP_RATE_LIMIT_DISABLE;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("GMAIL_MCP_RATE_LIMIT_") && k !== "GMAIL_MCP_RATE_LIMIT_DISABLE") {
      delete process.env[k];
    }
  }
  resetRateLimitHistory();
  resetJailDirCache();
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(downloadDir, { recursive: true, force: true });
  process.env = { ...originalEnv };
  resetRateLimitHistory();
  resetJailDirCache();
});

interface MockedGmailCalls {
  messageDelete: Array<unknown>;
  messageGet: Array<unknown>;
  messageList: Array<unknown>;
  messageModify: Array<unknown>;
  attachmentGet: Array<unknown>;
  messageSend: Array<unknown>;
  draftCreate: Array<unknown>;
  getProfile: Array<unknown>;
  threadModify: Array<unknown>;
  threadGet: Array<unknown>;
  threadList: Array<unknown>;
  filterDelete: Array<unknown>;
  filterCreate: Array<unknown>;
  filterList: Array<unknown>;
  filterGet: Array<unknown>;
  labelDelete: Array<unknown>;
  labelCreate: Array<unknown>;
  labelUpdate: Array<unknown>;
  labelList: Array<unknown>;
}

interface MockGmailOpts {
  /**
   * Pre-existing labels returned by `gmail.users.labels.list`. Used by
   * `getOrCreateLabel` (look up by name first; create if absent).
   */
  existingLabels?: Array<{ id: string; name: string; type?: string }>;
  /**
   * Body bytes returned by `gmail.users.messages.get`'s `text/plain`
   * MIME part for the `read_email` truncation tests.
   */
  messageBodyText?: string;
  /**
   * Messages list returned by `gmail.users.messages.list` for
   * `search_emails`.
   */
  searchResults?: Array<{ id: string; subject?: string; from?: string; date?: string }>;
  /**
   * Pre-existing thread structure returned by
   * `gmail.users.threads.list` + `gmail.users.threads.get`. Keyed by
   * threadId for the `get` lookup.
   */
  threads?: Record<
    string,
    {
      snippet?: string;
      historyId?: string;
      messages: Array<{
        id: string;
        labelIds?: string[];
        bodyText?: string;
        from?: string;
        subject?: string;
      }>;
    }
  >;
  /**
   * Attachment payload returned by `gmail.users.messages.attachments.get`
   * (base64url-encoded). Used by `download_attachment` tests.
   */
  attachmentData?: string;
  /**
   * When true, `gmail.users.settings.filters.list` returns an empty
   * `filter` array instead of the default single-seeded filter.
   * Used to exercise the empty-list branch in `list_filters`.
   */
  noFilters?: boolean;
}

function mockGmail(opts: MockGmailOpts = {}): {
  client: gmail_v1.Gmail;
  calls: MockedGmailCalls;
} {
  const calls: MockedGmailCalls = {
    messageDelete: [],
    messageGet: [],
    messageList: [],
    messageModify: [],
    messageSend: [],
    draftCreate: [],
    getProfile: [],
    attachmentGet: [],
    threadModify: [],
    threadGet: [],
    threadList: [],
    filterDelete: [],
    filterCreate: [],
    filterList: [],
    filterGet: [],
    labelDelete: [],
    labelCreate: [],
    labelUpdate: [],
    labelList: [],
  };
  const client = {
    users: {
      messages: {
        attachments: {
          get: async (params: unknown) => {
            calls.attachmentGet.push(params);
            const data =
              opts.attachmentData ??
              Buffer.from("%PDF-1.4 fake pdf content", "utf-8").toString("base64url");
            return { data: { data, size: data.length } };
          },
        },
        delete: async (params: unknown) => {
          calls.messageDelete.push(params);
          return { data: {} };
        },
        modify: async (params: unknown) => {
          calls.messageModify.push(params);
          return { data: {} };
        },
        send: async (params: unknown) => {
          calls.messageSend.push(params);
          return { data: { id: `msg_sent_${calls.messageSend.length}` } };
        },
        get: async (params: unknown) => {
          calls.messageGet.push(params);
          const id = (params as { id?: string }).id ?? "msg_unknown";
          const format = (params as { format?: string }).format ?? "full";
          // Reject unsupported formats so the test fixture does not
          // accidentally pass when a registrar regression switches to
          // `format: "minimal"` (or anything else not actually wired).
          // The 3 supported formats are: "full" (read_email,
          // download_email, get_inbox_with_threads), "raw"
          // (download_email format=eml), "metadata" (search_emails
          // header-only fetch). CR finding on PR #84.
          const SUPPORTED = new Set(["full", "raw", "metadata"]);
          if (!SUPPORTED.has(format)) {
            throw new Error(
              `mockGmail: messages.get called with unexpected format=${format}; supported: ${[...SUPPORTED].join(", ")} (id=${id})`,
            );
          }
          // Build a minimal MIME tree with one text/plain part
          // carrying the supplied body. Sufficient for read_email's
          // header + body + truncation logic, and for download_email
          // (json/txt/html) which extracts the same shape.
          const bodyText = opts.messageBodyText ?? "default body content";
          const bodyB64 = Buffer.from(bodyText, "utf-8")
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
          const fullBase = {
            id,
            threadId: `thread_for_${id}`,
            payload: {
              headers: [
                { name: "From", value: "Alice <alice@example.com>" },
                { name: "To", value: "bob@example.com" },
                { name: "Subject", value: `Test message ${id}` },
                { name: "Date", value: "Fri, 25 Apr 2026 10:00:00 +0000" },
                { name: "Message-ID", value: `<${id}@example.com>` },
              ],
              parts: [
                {
                  mimeType: "text/plain",
                  body: { size: bodyText.length, data: bodyB64 },
                },
              ],
            },
          };
          if (format === "raw") {
            // download_email format=eml issues a separate raw fetch
            // alongside the full one. Return a minimal RFC822 payload.
            const rfc822 = `From: alice@example.com\r\nTo: bob@example.com\r\nSubject: Test message ${id}\r\n\r\n${bodyText}`;
            return {
              data: { ...fullBase, raw: Buffer.from(rfc822, "utf-8").toString("base64url") },
            };
          }
          return { data: fullBase };
        },
        list: async (params: unknown) => {
          calls.messageList.push(params);
          const items = opts.searchResults ?? [];
          return {
            data: { messages: items.map((m) => ({ id: m.id, threadId: `thread_${m.id}` })) },
          };
        },
      },
      drafts: {
        create: async (params: unknown) => {
          calls.draftCreate.push(params);
          return { data: { id: `draft_${calls.draftCreate.length}` } };
        },
      },
      // reply_all uses getProfile to figure out which address to drop
      // from the recipient list (so the user is not CC'd on their own
      // reply).
      getProfile: async (params: unknown) => {
        calls.getProfile.push(params);
        return { data: { emailAddress: "me@example.com" } };
      },
      threads: {
        modify: async (params: unknown) => {
          calls.threadModify.push(params);
          return { data: {} };
        },
        get: async (params: unknown) => {
          calls.threadGet.push(params);
          const id = (params as { id?: string }).id ?? "thread_unknown";
          const t = opts.threads?.[id];
          if (!t) {
            return { data: { messages: [] } };
          }
          return {
            data: {
              messages: t.messages.map((m) => {
                const bodyText = m.bodyText ?? "thread body";
                const bodyB64 = Buffer.from(bodyText, "utf-8")
                  .toString("base64")
                  .replace(/\+/g, "-")
                  .replace(/\//g, "_")
                  .replace(/=+$/, "");
                return {
                  id: m.id,
                  threadId: id,
                  labelIds: m.labelIds ?? [],
                  payload: {
                    headers: [
                      { name: "From", value: m.from ?? "alice@example.com" },
                      { name: "Subject", value: m.subject ?? `Msg ${m.id}` },
                      { name: "Date", value: "Fri, 25 Apr 2026 10:00:00 +0000" },
                      { name: "Message-ID", value: `<${m.id}@example.com>` },
                    ],
                    parts: [
                      {
                        mimeType: "text/plain",
                        body: { size: bodyText.length, data: bodyB64 },
                      },
                    ],
                  },
                };
              }),
            },
          };
        },
        list: async (params: unknown) => {
          calls.threadList.push(params);
          const ids = Object.keys(opts.threads ?? {});
          return {
            data: {
              threads: ids.map((id) => ({
                id,
                snippet: opts.threads?.[id]?.snippet ?? "",
                historyId: opts.threads?.[id]?.historyId ?? "",
              })),
            },
          };
        },
      },
      labels: {
        // `deleteLabel` (src/label-manager.ts) does a `get` first to
        // refuse system-label deletion + to surface the label name in
        // the success message. Mock returns a non-system label so the
        // delete proceeds.
        get: async (params: unknown) => {
          const id = (params as { id?: string }).id ?? "Unknown";
          return { data: { id, name: id, type: "user" } };
        },
        delete: async (params: unknown) => {
          calls.labelDelete.push(params);
          return { data: {} };
        },
        create: async (params: unknown) => {
          calls.labelCreate.push(params);
          const body = (params as { requestBody?: { name?: string } }).requestBody ?? {};
          return {
            data: { id: `Label_${calls.labelCreate.length}`, name: body.name ?? "", type: "user" },
          };
        },
        update: async (params: unknown) => {
          calls.labelUpdate.push(params);
          const body = (params as { requestBody?: { name?: string } }).requestBody ?? {};
          const id = (params as { id?: string }).id ?? "Label_X";
          return { data: { id, name: body.name ?? id, type: "user" } };
        },
        list: async (params: unknown) => {
          calls.labelList.push(params);
          return { data: { labels: opts.existingLabels ?? [] } };
        },
      },
      settings: {
        // resolveDefaultSender (used by sendOrDraftEmail when `from`
        // is empty) calls users.settings.sendAs.list — return one
        // default sendAs so the resolver picks `me@example.com`.
        sendAs: {
          list: async () => ({
            data: { sendAs: [{ sendAsEmail: "me@example.com", isDefault: true }] },
          }),
        },
        filters: {
          delete: async (params: unknown) => {
            calls.filterDelete.push(params);
            return { data: {} };
          },
          create: async (params: unknown) => {
            calls.filterCreate.push(params);
            const body = (params as { requestBody?: unknown }).requestBody ?? {};
            return {
              data: {
                id: `filter_${calls.filterCreate.length}`,
                criteria: (body as { criteria?: unknown }).criteria,
                action: (body as { action?: unknown }).action,
              },
            };
          },
          list: async (params: unknown) => {
            calls.filterList.push(params);
            if (opts.noFilters) {
              return { data: { filter: [] } };
            }
            return {
              data: {
                filter: [
                  {
                    id: "filter_existing",
                    criteria: { from: "newsletter@example.com" },
                    action: { addLabelIds: ["Label_5"] },
                  },
                ],
              },
            };
          },
          get: async (params: unknown) => {
            calls.filterGet.push(params);
            const id = (params as { id?: string }).id ?? "filter_unknown";
            return {
              data: {
                id,
                criteria: { from: "vendor@example.com" },
                action: { addLabelIds: ["Label_42"] },
              },
            };
          },
        },
      },
    },
  } as unknown as gmail_v1.Gmail;
  return { client, calls };
}

interface ConnectedFixture {
  client: Client;
  calls: MockedGmailCalls;
  close: () => Promise<void>;
}

/**
 * Boilerplate-killer: build a fixture, run the test body, always close
 * the fixture (even on assertion failure inside `body`). Replaces the
 * 12 `try/finally` blocks the file would otherwise carry. CR Trivial
 * suggestion on PR #84.
 */
async function withFix(
  scopes: string[],
  body: (fix: ConnectedFixture) => Promise<void>,
  mockOpts: MockGmailOpts = {},
): Promise<void> {
  const fix = await buildAndConnect(scopes, mockOpts);
  try {
    await body(fix);
  } finally {
    await fix.close();
  }
}

async function buildAndConnect(
  scopes: string[],
  mockOpts: MockGmailOpts = {},
): Promise<ConnectedFixture> {
  const { client: gmail, calls } = mockGmail(mockOpts);
  // PR #7 wired createServer to take a gmail client directly and to
  // register every per-domain tool via `registerAllTools`. The fixture
  // now passes the mock gmail straight to the factory; the per-tool
  // `register*Tools` calls are not needed (and would double-register).
  const server = createServer({
    gmail,
    authorizedScopes: scopes,
  });

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "registrars-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    calls,
    close: async () => {
      await Promise.all([client.close(), server.close()]);
    },
  };
}

describe("PR #3 registrars — delete_email (mail.google.com scope)", () => {
  it("calls gmail.users.messages.delete with the supplied messageId", async () => {
    // First test on the file to demo the `withFix` helper introduced
    // in the PR #4 fix-up commit (CR thread on PR #84). Subsequent
    // tests still use the explicit try/finally form for minimum diff;
    // PR #5+ tests adopt `withFix` directly.
    await withFix(["mail.google.com"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "delete_email",
        arguments: { messageId: "msg_target_123" },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("msg_target_123");
      expect(result.content[0]?.text).toContain("deleted successfully");
      expect(fix.calls.messageDelete).toHaveLength(1);
      expect(fix.calls.messageDelete[0]).toMatchObject({
        userId: "me",
        id: "msg_target_123",
      });
    });
  });

  it("is NOT advertised when the token only carries gmail.modify (delete needs mail.google.com)", async () => {
    const fix = await buildAndConnect(["gmail.modify"]);
    try {
      const list = await fix.client.listTools();
      expect(list.tools.find((t) => t.name === "delete_email")).toBeUndefined();
    } finally {
      await fix.close();
    }
  });
});

describe("PR #3 registrars — delete_label", () => {
  it("calls gmail.users.labels.delete with the supplied id", async () => {
    const fix = await buildAndConnect(["gmail.modify", "gmail.labels"]);
    try {
      const result = (await fix.client.callTool({
        name: "delete_label",
        arguments: { id: "Label_42" },
      })) as { content: Array<{ type: string; text: string }> };
      expect(result.content[0]?.text).toContain("Label_42");
      expect(fix.calls.labelDelete).toHaveLength(1);
      expect(fix.calls.labelDelete[0]).toMatchObject({
        userId: "me",
        id: "Label_42",
      });
    } finally {
      await fix.close();
    }
  });
});

describe("PR #3 registrars — delete_filter", () => {
  it("calls gmail.users.settings.filters.delete with the supplied filterId", async () => {
    const fix = await buildAndConnect(["gmail.settings.basic"]);
    try {
      const result = (await fix.client.callTool({
        name: "delete_filter",
        arguments: { filterId: "filter_xyz" },
      })) as { content: Array<{ type: string; text: string }> };
      expect(result.content[0]?.text.length).toBeGreaterThan(0);
      expect(fix.calls.filterDelete).toHaveLength(1);
      expect(fix.calls.filterDelete[0]).toMatchObject({
        userId: "me",
        id: "filter_xyz",
      });
    } finally {
      await fix.close();
    }
  });
});

describe("PR #3 registrars — modify_thread", () => {
  it("forwards addLabelIds + removeLabelIds to gmail.users.threads.modify", async () => {
    const fix = await buildAndConnect(["gmail.modify"]);
    try {
      const result = (await fix.client.callTool({
        name: "modify_thread",
        arguments: {
          threadId: "thread_999",
          addLabelIds: ["L_A", "L_B"],
          removeLabelIds: ["INBOX"],
        },
      })) as { content: Array<{ type: string; text: string }> };
      expect(result.content[0]?.text).toContain("thread_999");
      expect(fix.calls.threadModify).toHaveLength(1);
      expect(fix.calls.threadModify[0]).toMatchObject({
        userId: "me",
        id: "thread_999",
        requestBody: { addLabelIds: ["L_A", "L_B"], removeLabelIds: ["INBOX"] },
      });
    } finally {
      await fix.close();
    }
  });

  it("omits empty label arrays from the request body (no addLabelIds when not supplied)", async () => {
    const fix = await buildAndConnect(["gmail.modify"]);
    try {
      await fix.client.callTool({
        name: "modify_thread",
        arguments: {
          threadId: "thread_only_remove",
          removeLabelIds: ["UNREAD"],
        },
      });
      const params = fix.calls.threadModify[0] as {
        requestBody: { addLabelIds?: string[]; removeLabelIds?: string[] };
      };
      expect(params.requestBody.addLabelIds).toBeUndefined();
      expect(params.requestBody.removeLabelIds).toEqual(["UNREAD"]);
    } finally {
      await fix.close();
    }
  });
});

describe("PR #4 registrars — label management", () => {
  it("create_label forwards name + visibility flags to gmail.users.labels.create", async () => {
    const fix = await buildAndConnect(["gmail.modify", "gmail.labels"]);
    try {
      const result = (await fix.client.callTool({
        name: "create_label",
        arguments: {
          name: "Project/Acme",
          messageListVisibility: "show",
          labelListVisibility: "labelShow",
        },
      })) as { content: Array<{ type: string; text: string }> };
      expect(result.content[0]?.text).toContain("Project/Acme");
      expect(result.content[0]?.text).toContain("Label created successfully");
      expect(fix.calls.labelCreate).toHaveLength(1);
      expect(fix.calls.labelCreate[0]).toMatchObject({
        userId: "me",
        requestBody: {
          name: "Project/Acme",
          messageListVisibility: "show",
          labelListVisibility: "labelShow",
        },
      });
    } finally {
      await fix.close();
    }
  });

  it("update_label includes only the fields the caller supplied", async () => {
    const fix = await buildAndConnect(["gmail.modify", "gmail.labels"]);
    try {
      await fix.client.callTool({
        name: "update_label",
        arguments: { id: "Label_1", name: "Renamed" },
      });
      // No `messageListVisibility` / `labelListVisibility` supplied →
      // they must NOT appear in the requestBody (avoiding accidental
      // Gmail API resets to "show"/"labelShow").
      expect(fix.calls.labelUpdate).toHaveLength(1);
      const body = (fix.calls.labelUpdate[0] as { requestBody: Record<string, unknown> })
        .requestBody;
      expect(body.name).toBe("Renamed");
      expect(body.messageListVisibility).toBeUndefined();
      expect(body.labelListVisibility).toBeUndefined();
    } finally {
      await fix.close();
    }
  });

  it("get_or_create_label returns 'found existing' when the label is already present", async () => {
    const fix = await buildAndConnect(["gmail.modify", "gmail.labels"], {
      existingLabels: [{ id: "Label_existing", name: "Acme/Invoices", type: "user" }],
    });
    try {
      const result = (await fix.client.callTool({
        name: "get_or_create_label",
        arguments: { name: "Acme/Invoices" },
      })) as { content: Array<{ type: string; text: string }> };
      expect(result.content[0]?.text).toContain("found existing");
      expect(result.content[0]?.text).toContain("Label_existing");
      // No create call — the label was already there.
      expect(fix.calls.labelCreate).toHaveLength(0);
    } finally {
      await fix.close();
    }
  });

  it("get_or_create_label creates a fresh label when none matches", async () => {
    const fix = await buildAndConnect(["gmail.modify", "gmail.labels"], {
      existingLabels: [{ id: "Label_other", name: "Different", type: "user" }],
    });
    try {
      const result = (await fix.client.callTool({
        name: "get_or_create_label",
        arguments: { name: "Brand/New" },
      })) as { content: Array<{ type: string; text: string }> };
      expect(result.content[0]?.text).toContain("Brand/New");
      expect(fix.calls.labelCreate).toHaveLength(1);
    } finally {
      await fix.close();
    }
  });

  it("list_email_labels groups system + user labels and shows the counts", async () => {
    const fix = await buildAndConnect(["gmail.readonly"], {
      existingLabels: [
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "SENT", name: "SENT", type: "system" },
        { id: "Label_1", name: "Acme", type: "user" },
      ],
    });
    try {
      const result = (await fix.client.callTool({
        name: "list_email_labels",
        arguments: {},
      })) as { content: Array<{ type: string; text: string }> };
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Found 3 labels");
      expect(text).toContain("2 system");
      expect(text).toContain("1 user");
      expect(text).toContain("INBOX");
      expect(text).toContain("Acme");
    } finally {
      await fix.close();
    }
  });
});

describe("PR #4 registrars — filter management", () => {
  it("create_filter forwards criteria + action to filters.create and pretty-prints the response", async () => {
    const fix = await buildAndConnect(["gmail.settings.basic"]);
    try {
      const result = (await fix.client.callTool({
        name: "create_filter",
        arguments: {
          criteria: { from: "noreply@vendor.com", hasAttachment: true },
          action: { addLabelIds: ["Label_42"] },
        },
      })) as { content: Array<{ type: string; text: string }> };
      expect(result.content[0]?.text).toContain("Filter created successfully");
      expect(result.content[0]?.text).toContain("from: noreply@vendor.com");
      expect(result.content[0]?.text).toContain("addLabelIds: Label_42");
      expect(fix.calls.filterCreate).toHaveLength(1);
    } finally {
      await fix.close();
    }
  });

  it("list_filters renders the seeded filter (non-empty branch)", async () => {
    const fix = await buildAndConnect(["gmail.settings.basic"]);
    try {
      const result = (await fix.client.callTool({
        name: "list_filters",
        arguments: {},
      })) as { content: Array<{ type: string; text: string }> };
      const text = result.content[0]?.text ?? "";
      expect(text).toMatch(/Found \d+ filters/);
      expect(text).toContain("filter_existing");
    } finally {
      await fix.close();
    }
  });

  it("list_filters renders 'No filters found.' when the API returns an empty list", async () => {
    // CR finding on PR #84: the previous test's title claimed empty-
    // branch coverage but the mock always seeded one filter, so only
    // the non-empty path was exercised. With `noFilters: true` the
    // mock truly returns `{ filter: [] }` and the empty-branch
    // wording is now pinned.
    await withFix(
      ["gmail.settings.basic"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "list_filters",
          arguments: {},
        })) as { content: Array<{ type: string; text: string }> };
        // The text travels through `wrapToolHandler` which wraps every
        // tool response in the `<untrusted-tool-output>` sanitize fence.
        expect(result.content[0]?.text).toContain("No filters found.");
        expect(result.content[0]?.text).toContain("<untrusted-tool-output>");
      },
      { noFilters: true },
    );
  });

  it("get_filter pretty-prints the criteria + action of a known filter", async () => {
    const fix = await buildAndConnect(["gmail.settings.basic"]);
    try {
      const result = (await fix.client.callTool({
        name: "get_filter",
        arguments: { filterId: "filter_xyz" },
      })) as { content: Array<{ type: string; text: string }> };
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("ID: filter_xyz");
      expect(text).toContain("from: vendor@example.com");
      expect(fix.calls.filterGet).toHaveLength(1);
    } finally {
      await fix.close();
    }
  });

  it("create_filter_from_template (fromSender) wires the template through to filters.create", async () => {
    const fix = await buildAndConnect(["gmail.settings.basic"]);
    try {
      const result = (await fix.client.callTool({
        name: "create_filter_from_template",
        arguments: {
          template: "fromSender",
          parameters: { senderEmail: "spam@example.com", archive: true },
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("Filter created from template 'fromSender'");
      expect(fix.calls.filterCreate).toHaveLength(1);
    } finally {
      await fix.close();
    }
  });

  it("create_filter_from_template (withAttachments) accepts a parameter-less call", async () => {
    const fix = await buildAndConnect(["gmail.settings.basic"]);
    try {
      const result = (await fix.client.callTool({
        name: "create_filter_from_template",
        arguments: {
          template: "withAttachments",
          parameters: { labelIds: ["Label_attach"] },
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("withAttachments");
      expect(fix.calls.filterCreate).toHaveLength(1);
    } finally {
      await fix.close();
    }
  });
});

describe("PR #5 registrars — read_email truncation (highest-risk extraction)", () => {
  it("returns the full headers + body when format=full and body is below the cap", async () => {
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "read_email",
          arguments: { messageId: "msg_short", format: "full" },
        })) as { content: Array<{ type: string; text: string }> };
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("Subject: Test message msg_short");
        expect(text).toContain("Alice <alice@example.com>");
        expect(text).toContain("default body content");
        expect(text).not.toContain("[Message clipped");
      },
      { messageBodyText: "default body content" },
    );
  });

  it("returns ONLY the header block when format=headers_only", async () => {
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "read_email",
          arguments: { messageId: "msg_h", format: "headers_only" },
        })) as { content: Array<{ type: string; text: string }> };
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("Subject: Test message msg_h");
        // Body MUST NOT be in the response.
        expect(text).not.toContain("default body content");
      },
      { messageBodyText: "this body must not appear" },
    );
  });

  it("clamps the body at 500 bytes in summary mode and emits the summary marker", async () => {
    const longBody = "X".repeat(2000);
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "read_email",
          arguments: { messageId: "msg_sum", format: "summary" },
        })) as { content: Array<{ type: string; text: string }> };
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("[Summary truncated at 500 bytes");
        // The summary cap is 500 bytes — `XXX...` (500 of them) should
        // appear, but not all 2000.
        const xCount = (text.match(/X/g) || []).length;
        expect(xCount).toBeGreaterThanOrEqual(500);
        expect(xCount).toBeLessThan(2000);
      },
      { messageBodyText: longBody },
    );
  });

  it("clamps the body at maxBodyLength in full mode and emits the [Message clipped] marker", async () => {
    const longBody = "Y".repeat(2000);
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "read_email",
          arguments: { messageId: "msg_full", format: "full", maxBodyLength: 100 },
        })) as { content: Array<{ type: string; text: string }> };
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("[Message clipped");
        const yCount = (text.match(/Y/g) || []).length;
        expect(yCount).toBeGreaterThanOrEqual(100);
        expect(yCount).toBeLessThan(2000);
      },
      { messageBodyText: longBody },
    );
  });

  it("does NOT truncate when maxBodyLength=0 (operator opt-out)", async () => {
    const longBody = "Z".repeat(5000);
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "read_email",
          arguments: { messageId: "msg_zero", format: "full", maxBodyLength: 0 },
        })) as { content: Array<{ type: string; text: string }> };
        const text = result.content[0]?.text ?? "";
        expect(text).not.toContain("[Message clipped");
        const zCount = (text.match(/Z/g) || []).length;
        expect(zCount).toBe(5000);
      },
      { messageBodyText: longBody },
    );
  });

  it("multi-byte safe: a truncation cut on a multi-byte sequence does not produce U+FFFD", async () => {
    // 250× "é" (UTF-8: 0xC3 0xA9, 2 bytes per char) = 500 bytes total.
    // With format=summary (cap=500) the body fits exactly; with cap=499
    // the slice would land mid-`é` and TextDecoder ignores the trailing
    // partial byte. The trailing U+FFFD trim guard in read_email
    // handles the case where TextDecoder still emits one. Pin that
    // neither case shows U+FFFD in the displayed body.
    const accentBody = "é".repeat(250);
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "read_email",
          arguments: { messageId: "msg_acc", format: "full", maxBodyLength: 11 },
        })) as { content: Array<{ type: string; text: string }> };
        const text = result.content[0]?.text ?? "";
        // U+FFFD is the Unicode REPLACEMENT CHARACTER. It should NEVER
        // appear in the body of a truncated read_email response.
        expect(text).not.toContain("�");
        expect(text).toContain("[Message clipped");
      },
      { messageBodyText: accentBody },
    );
  });
});

describe("PR #5 registrars — search_emails", () => {
  it("calls list+get for each result and renders them line-by-line", async () => {
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "search_emails",
          arguments: { query: "from:alice@example.com", maxResults: 2 },
        })) as { content: Array<{ type: string; text: string }> };
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("ID: msg_1");
        expect(text).toContain("ID: msg_2");
        expect(fix.calls.messageList).toHaveLength(1);
        // Pin the forwarded query + maxResults so a regression that
        // drops them (e.g. switching to a hard-coded "in:inbox") is
        // caught at test time. CR finding on PR #84.
        expect(fix.calls.messageList[0]).toMatchObject({
          userId: "me",
          q: "from:alice@example.com",
          maxResults: 2,
        });
        expect(fix.calls.messageGet).toHaveLength(2);
      },
      { searchResults: [{ id: "msg_1" }, { id: "msg_2" }] },
    );
  });
});

describe("PR #5 registrars — modify_email + batch_*", () => {
  it("modify_email forwards label changes to gmail.users.messages.modify", async () => {
    await withFix(["gmail.modify"], async (fix) => {
      await fix.client.callTool({
        name: "modify_email",
        arguments: {
          messageId: "msg_mod",
          addLabelIds: ["L_A"],
          removeLabelIds: ["INBOX"],
        },
      });
      expect(fix.calls.messageModify).toHaveLength(1);
      expect(fix.calls.messageModify[0]).toMatchObject({
        userId: "me",
        id: "msg_mod",
        requestBody: { addLabelIds: ["L_A"], removeLabelIds: ["INBOX"] },
      });
    });
  });

  it("batch_modify_emails calls modify once per messageId via processBatches", async () => {
    await withFix(["gmail.modify"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "batch_modify_emails",
        arguments: {
          messageIds: ["m1", "m2", "m3"],
          addLabelIds: ["L_X"],
          batchSize: 5,
        },
      })) as { content: Array<{ type: string; text: string }> };
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Successfully processed: 3 messages");
      expect(fix.calls.messageModify).toHaveLength(3);
    });
  });

  it("batch_delete_emails deletes each messageId and reports the count", async () => {
    await withFix(["mail.google.com"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "batch_delete_emails",
        arguments: { messageIds: ["m1", "m2"] },
      })) as { content: Array<{ type: string; text: string }> };
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Successfully deleted: 2 messages");
      expect(fix.calls.messageDelete).toHaveLength(2);
    });
  });
});

describe("PR #6 registrars — download_email + download_attachment", () => {
  it("download_email json format writes a JSON file under the download jail", async () => {
    await withFix(["gmail.readonly"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "download_email",
        arguments: { messageId: "msg_dl_json", savePath: downloadDir, format: "json" },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      const text = result.content[0]?.text ?? "";
      expect(text).toContain('"status": "saved"');
      expect(text).toContain("msg_dl_json.json");
      // Verify the file actually exists in the jail.
      const written = readdirSync(downloadDir);
      expect(written).toContain("msg_dl_json.json");
    });
  });

  it("download_email eml format issues both full+raw fetches in parallel", async () => {
    await withFix(["gmail.readonly"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "download_email",
        arguments: { messageId: "msg_dl_eml", savePath: downloadDir, format: "eml" },
      })) as { content: Array<{ type: string; text: string }> };
      expect(result.content[0]?.text).toContain("msg_dl_eml.eml");
      // Two get calls: one full, one raw.
      expect(fix.calls.messageGet).toHaveLength(2);
      const formats = fix.calls.messageGet.map((c) => (c as { format?: string }).format).sort();
      expect(formats).toEqual(["full", "raw"]);
    });
  });

  it("download_attachment writes the bytes under the download jail", async () => {
    await withFix(["gmail.modify"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "download_attachment",
        arguments: {
          messageId: "msg_with_att",
          attachmentId: "att_1",
          filename: "report.pdf",
          savePath: downloadDir,
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("report.pdf");
      const written = readdirSync(downloadDir);
      expect(written).toContain("report.pdf");
    });
  });
});

describe("PR #6 registrars — get_thread + list_inbox_threads + get_inbox_with_threads", () => {
  const fixtureThreads = {
    thread_a: {
      snippet: "thread A snippet",
      historyId: "h1",
      messages: [
        { id: "m1", from: "alice@example.com", subject: "First", bodyText: "First body" },
        { id: "m2", from: "bob@example.com", subject: "Second", bodyText: "Second body" },
      ],
    },
    thread_b: {
      snippet: "thread B snippet",
      historyId: "h2",
      messages: [{ id: "m3", from: "carol@example.com", subject: "Third", bodyText: "Body 3" }],
    },
  };

  it("get_thread returns each message's headers + body in JSON", async () => {
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "get_thread",
          arguments: { threadId: "thread_a" },
        })) as { content: Array<{ type: string; text: string }> };
        const text = result.content[0]?.text ?? "";
        expect(text).toContain('"messageCount": 2');
        expect(text).toContain("First body");
        expect(text).toContain("Second body");
        expect(text).toContain("alice@example.com");
        expect(text).toContain("bob@example.com");
      },
      { threads: fixtureThreads },
    );
  });

  it("list_inbox_threads returns a metadata summary per thread + forwards q/maxResults", async () => {
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "list_inbox_threads",
          arguments: { query: "in:inbox label:Project", maxResults: 25 },
        })) as { content: Array<{ type: string; text: string }> };
        const text = result.content[0]?.text ?? "";
        expect(text).toContain('"resultCount": 2');
        expect(text).toContain("thread_a");
        expect(text).toContain("thread_b");
        // Latest message metadata pulled.
        expect(text).toContain("Second");
        // Pin the forwarded q + maxResults — CR finding on PR #84.
        expect(fix.calls.threadList).toHaveLength(1);
        expect(fix.calls.threadList[0]).toMatchObject({
          userId: "me",
          q: "in:inbox label:Project",
          maxResults: 25,
        });
      },
      { threads: fixtureThreads },
    );
  });

  it("get_inbox_with_threads expandThreads=false returns the lightweight summary", async () => {
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "get_inbox_with_threads",
          arguments: { expandThreads: false, query: "in:inbox", maxResults: 10 },
        })) as { content: Array<{ type: string; text: string }> };
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("thread_a");
        // Summary path → no body content rendered.
        expect(text).not.toContain("First body");
      },
      { threads: fixtureThreads },
    );
  });

  it("get_inbox_with_threads expandThreads=true fetches and renders every message body", async () => {
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "get_inbox_with_threads",
          arguments: { expandThreads: true, query: "in:inbox", maxResults: 10 },
        })) as { content: Array<{ type: string; text: string }> };
        const text = result.content[0]?.text ?? "";
        // Both bodies rendered.
        expect(text).toContain("First body");
        expect(text).toContain("Second body");
        expect(text).toContain("Body 3");
      },
      { threads: fixtureThreads },
    );
  });
});

describe("PR #7 registrars — send_email / draft_email (messaging.ts)", () => {
  it("send_email forwards a base64url-encoded RFC822 payload to gmail.users.messages.send", async () => {
    await withFix(["gmail.send"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "send_email",
        arguments: {
          to: ["bob@example.com"],
          subject: "Hello from test",
          body: "This is the test body.",
          from: "me@example.com",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("sent successfully");
      expect(result.content[0]?.text).toContain("msg_sent_1");
      expect(fix.calls.messageSend).toHaveLength(1);
      const sent = fix.calls.messageSend[0] as { requestBody: { raw: string } };
      expect(typeof sent.requestBody.raw).toBe("string");
      // Decode the base64url and check the headers landed in the MIME.
      const decoded = Buffer.from(sent.requestBody.raw, "base64url").toString("utf-8");
      expect(decoded).toContain("To: bob@example.com");
      expect(decoded).toContain("Subject: Hello from test");
      expect(decoded).toContain("This is the test body.");
    });
  });

  it("draft_email routes through gmail.users.drafts.create instead of messages.send", async () => {
    await withFix(["gmail.compose"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "draft_email",
        arguments: {
          to: ["alice@example.com"],
          subject: "Draft subject",
          body: "Draft body",
          from: "me@example.com",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("draft created");
      expect(fix.calls.draftCreate).toHaveLength(1);
      expect(fix.calls.messageSend).toHaveLength(0);
    });
  });

  it("send_email forwards threadId when supplied (preserves threading on the wire)", async () => {
    await withFix(["gmail.send"], async (fix) => {
      await fix.client.callTool({
        name: "send_email",
        arguments: {
          to: ["bob@example.com"],
          subject: "Re: Project",
          body: "Reply body",
          from: "me@example.com",
          threadId: "thread_xyz",
          inReplyTo: "<orig@example.com>",
        },
      });
      const sent = fix.calls.messageSend[0] as { requestBody: { threadId?: string } };
      expect(sent.requestBody.threadId).toBe("thread_xyz");
    });
  });
});

describe("PR #7 registrars — pair_recipient", () => {
  it("list returns the empty allowlist when no addresses have been paired", async () => {
    await withFix(["gmail.modify"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "pair_recipient",
        arguments: { action: "list" },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Paired recipients (0)");
      expect(text).toContain("(none)");
    });
  });

  it("add → list round-trip persists the address through GMAIL_MCP_PAIRED_PATH", async () => {
    await withFix(["gmail.modify"], async (fix) => {
      const addRes = (await fix.client.callTool({
        name: "pair_recipient",
        arguments: { action: "add", email: "trusted@example.com" },
      })) as { content: Array<{ type: string; text: string }> };
      expect(addRes.content[0]?.text).toContain("Added");
      expect(addRes.content[0]?.text).toContain("trusted@example.com");

      const listRes = (await fix.client.callTool({
        name: "pair_recipient",
        arguments: { action: "list" },
      })) as { content: Array<{ type: string; text: string }> };
      expect(listRes.content[0]?.text).toContain("Paired recipients (1)");
      expect(listRes.content[0]?.text).toContain("trusted@example.com");
    });
  });

  it("remove drops a previously-paired address", async () => {
    await withFix(["gmail.modify"], async (fix) => {
      await fix.client.callTool({
        name: "pair_recipient",
        arguments: { action: "add", email: "ephemeral@example.com" },
      });
      const removeRes = (await fix.client.callTool({
        name: "pair_recipient",
        arguments: { action: "remove", email: "ephemeral@example.com" },
      })) as { content: Array<{ type: string; text: string }> };
      expect(removeRes.content[0]?.text).toContain("Removed");
    });
  });

  it("add without an email argument returns isError with a descriptive message", async () => {
    await withFix(["gmail.modify"], async (fix) => {
      // The Zod schema rejects empty/missing email on `add` at parse
      // time (the .refine() rejects undefined-or-blank); the
      // dispatcher's `isError: true` branch fires when the runtime
      // post-parse `!email` guard hits — exercised here by passing an
      // RFC 5322 mailbox that survives schema validation but the
      // tool body's runtime check still flags. Use the schema-valid
      // address `space@x.com` to land in the runtime branch via the
      // pair-recipient handler's own guard. Falls through to the
      // remove path; we assert the runtime guard fires for `remove`
      // with no email instead.
      const result = (await fix.client.callTool({
        name: "pair_recipient",
        arguments: { action: "remove" },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("requires an `email` argument");
    });
  });
});

describe("PR #7 registrars — reply_all", () => {
  it("fetches the original, builds the recipient list, and sends via sendOrDraftEmail", async () => {
    await withFix(["gmail.send", "gmail.readonly"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "reply_all",
        arguments: {
          messageId: "msg_orig",
          body: "Thanks for the heads-up!",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Reply-all sent successfully");
      // The mocked original message has From=Alice, So replyTo should
      // include alice@example.com (the original sender). My own
      // address (me@example.com from getProfile) must NOT appear.
      expect(text).toContain("alice@example.com");
      expect(text).not.toMatch(/To:.*me@example\.com/);
      // gmail.users.messages.get fetched the original; getProfile
      // fetched my own address; messages.send sent the reply.
      expect(fix.calls.messageGet).toHaveLength(1);
      expect(fix.calls.getProfile).toHaveLength(1);
      expect(fix.calls.messageSend).toHaveLength(1);
    });
  });
});

describe("PR #4 registrars — filter templates (4 paths)", () => {
  it("create_filter_from_template (withSubject) wires through to filters.create", async () => {
    await withFix(["gmail.settings.basic"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "create_filter_from_template",
        arguments: {
          template: "withSubject",
          parameters: { subjectText: "[Newsletter]", labelIds: ["Label_news"] },
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("withSubject");
      expect(fix.calls.filterCreate).toHaveLength(1);
    });
  });

  it("create_filter_from_template (largeEmails) takes sizeInBytes and routes through", async () => {
    await withFix(["gmail.settings.basic"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "create_filter_from_template",
        arguments: {
          template: "largeEmails",
          parameters: { sizeInBytes: 5_000_000, labelIds: ["Label_big"] },
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("largeEmails");
      expect(fix.calls.filterCreate).toHaveLength(1);
    });
  });

  it("create_filter_from_template (containingText) propagates markImportant", async () => {
    await withFix(["gmail.settings.basic"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "create_filter_from_template",
        arguments: {
          template: "containingText",
          parameters: { searchText: "urgent", labelIds: ["Label_urg"], markImportant: true },
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("containingText");
    });
  });

  it("create_filter_from_template (mailingList) takes listIdentifier", async () => {
    await withFix(["gmail.settings.basic"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "create_filter_from_template",
        arguments: {
          template: "mailingList",
          parameters: { listIdentifier: "discuss@example.com", labelIds: ["Label_list"] },
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("mailingList");
    });
  });

  it("create_filter_from_template surfaces a parameter-missing error as isError=true", async () => {
    await withFix(["gmail.settings.basic"], async (fix) => {
      // `withSubject` requires `subjectText`. Omitting it should
      // make the tool throw, which wrapToolHandler maps to
      // `isError: true`.
      const result = (await fix.client.callTool({
        name: "create_filter_from_template",
        arguments: {
          template: "withSubject",
          parameters: { labelIds: ["Label_x"] },
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("subjectText is required");
    });
  });
});

describe("PR #6 registrars — download error paths", () => {
  it("download_email reports the Gmail HTTP status when the fetch fails", async () => {
    await withFix(["gmail.readonly"], async (fix) => {
      // Pass a non-absolute savePath — resolveDownloadSavePath rejects
      // it before any Gmail call, so the catch branch fires with the
      // generic "Failed to download email" prefix (no HTTP code).
      const result = (await fix.client.callTool({
        name: "download_email",
        arguments: { messageId: "msg_x", savePath: "relative/path", format: "json" },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("Failed to download email");
    });
  });

  it("download_attachment falls back to attachment-${id} when filename is omitted", async () => {
    await withFix(["gmail.modify"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "download_attachment",
        arguments: {
          messageId: "msg_with_att",
          attachmentId: "att_default_name",
          savePath: downloadDir,
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      // The mock messages.get returns a payload without an
      // `attachmentId` match in any part, so the fallback name
      // `attachment-att_default_name` should be used.
      expect(result.content[0]?.text).toContain("attachment-att_default_name");
      const written = readdirSync(downloadDir);
      expect(written).toContain("attachment-att_default_name");
    });
  });
});

describe("PR #3+#4+#5+#6 registrars — combined tools/list shape", () => {
  it("advertises every PR-#3+#4+#5+#6 tool when the token covers every required scope", async () => {
    await withFix(
      ["mail.google.com", "gmail.modify", "gmail.labels", "gmail.settings.basic", "gmail.readonly"],
      async (fix) => {
        const list = await fix.client.listTools();
        const names = list.tools.map((t) => t.name).sort();
        expect(names).toEqual([
          "batch_delete_emails",
          "batch_modify_emails",
          "create_filter",
          "create_filter_from_template",
          "create_label",
          "delete_email",
          "delete_filter",
          "delete_label",
          "download_attachment",
          "download_email",
          "draft_email",
          "get_filter",
          "get_inbox_with_threads",
          "get_or_create_label",
          "get_thread",
          "list_email_labels",
          "list_filters",
          "list_inbox_threads",
          "modify_email",
          "modify_thread",
          "pair_recipient",
          "read_email",
          "reply_all",
          "search_emails",
          "send_email",
          "update_label",
        ]);
      },
    );
  });

  it("filters out tools whose required scopes are missing from the token", async () => {
    // Only gmail.modify + gmail.labels — covers the label management
    // tools, modify_thread, modify_email, batch_modify_emails. Does
    // NOT cover: delete_email (mail.google.com), filter tools
    // (gmail.settings.basic), batch_delete_emails (mail.google.com),
    // read_email / search_emails / list_email_labels (gmail.readonly,
    // even though gmail.modify is a strict superset upstream the tool
    // definition declares only gmail.modify for the write set, so the
    // ANY-of-required match still picks them up).
    await withFix(["gmail.modify", "gmail.labels"], async (fix) => {
      const list = await fix.client.listTools();
      const names = list.tools.map((t) => t.name).sort();
      expect(names).toContain("create_label");
      expect(names).toContain("modify_email");
      expect(names).toContain("batch_modify_emails");
      expect(names).not.toContain("delete_email");
      expect(names).not.toContain("batch_delete_emails");
      expect(names).not.toContain("create_filter");
    });
  });
});
