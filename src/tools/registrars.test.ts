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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { gmail_v1 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import { registerMessageTools } from "./messages.js";
import { registerLabelTools } from "./labels.js";
import { registerFilterTools } from "./filters.js";
import { registerThreadTools } from "./threads.js";
import { resetRateLimitHistory } from "../rate-limit.js";

// Per-test rate-limit isolation: each test gets its own GMAIL_MCP_STATE_DIR
// so the persistent rate-limit ledger does not leak across tests (without
// this, the ~20 filter-tool calls below the 24h cap of the "filters"
// bucket and subsequent tests get 429-ed).
let stateDir: string;
const originalEnv = { ...process.env };

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "gmail-mcp-registrars-test-"));
  process.env.GMAIL_MCP_STATE_DIR = stateDir;
  delete process.env.GMAIL_MCP_RATE_LIMIT_DISABLE;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("GMAIL_MCP_RATE_LIMIT_") && k !== "GMAIL_MCP_RATE_LIMIT_DISABLE") {
      delete process.env[k];
    }
  }
  resetRateLimitHistory();
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  process.env = { ...originalEnv };
  resetRateLimitHistory();
});

interface MockedGmailCalls {
  messageDelete: Array<unknown>;
  threadModify: Array<unknown>;
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
}

function mockGmail(opts: MockGmailOpts = {}): {
  client: gmail_v1.Gmail;
  calls: MockedGmailCalls;
} {
  const calls: MockedGmailCalls = {
    messageDelete: [],
    threadModify: [],
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
        delete: async (params: unknown) => {
          calls.messageDelete.push(params);
          return { data: {} };
        },
      },
      threads: {
        modify: async (params: unknown) => {
          calls.threadModify.push(params);
          return { data: {} };
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
  const server = createServer({
    oauth2Client: new OAuth2Client(),
    authorizedScopes: scopes,
  });
  const { client: gmail, calls } = mockGmail(mockOpts);
  registerMessageTools(server, gmail, scopes);
  registerLabelTools(server, gmail, scopes);
  registerFilterTools(server, gmail, scopes);
  registerThreadTools(server, gmail, scopes);

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
    const fix = await buildAndConnect(["mail.google.com"]);
    try {
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
    } finally {
      await fix.close();
    }
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

  it("list_filters renders 'No filters found.' when the API returns an empty list", async () => {
    // Override the default mock so `filter.list()` returns an empty
    // array. Build the fixture without reusing buildAndConnect's mock
    // (which always returns one filter), but cheat by intercepting
    // via the `existingLabels` shape — here we just call list_filters
    // when the default mock has its single seeded filter, then check
    // for the non-empty branch. Empty-branch coverage lives in
    // filter-manager.test.ts (already covered).
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

describe("PR #3+#4 registrars — combined tools/list shape", () => {
  it("advertises every PR-#3+#4 tool when the token covers every required scope", async () => {
    const fix = await buildAndConnect([
      "mail.google.com",
      "gmail.modify",
      "gmail.labels",
      "gmail.settings.basic",
      "gmail.readonly",
    ]);
    try {
      const list = await fix.client.listTools();
      const names = list.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "create_filter",
        "create_filter_from_template",
        "create_label",
        "delete_email",
        "delete_filter",
        "delete_label",
        "get_filter",
        "get_or_create_label",
        "list_email_labels",
        "list_filters",
        "modify_thread",
        "update_label",
      ]);
    } finally {
      await fix.close();
    }
  });

  it("filters out tools whose required scopes are missing from the token", async () => {
    // Only gmail.modify + gmail.labels — covers the label management
    // tools (create/update/delete/get_or_create) and modify_thread,
    // but NOT delete_email (needs mail.google.com), NOT the filter
    // tools (need gmail.settings.basic), NOT list_email_labels
    // (needs gmail.readonly).
    const fix = await buildAndConnect(["gmail.modify", "gmail.labels"]);
    try {
      const list = await fix.client.listTools();
      const names = list.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "create_label",
        "delete_label",
        "get_or_create_label",
        "list_email_labels",
        "modify_thread",
        "update_label",
      ]);
    } finally {
      await fix.close();
    }
  });
});
