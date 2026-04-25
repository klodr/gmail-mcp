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

import { describe, it, expect } from "vitest";
import type { gmail_v1 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import { registerMessageTools } from "./messages.js";
import { registerLabelTools } from "./labels.js";
import { registerFilterTools } from "./filters.js";
import { registerThreadTools } from "./threads.js";

interface MockedGmailCalls {
  messageDelete: Array<unknown>;
  threadModify: Array<unknown>;
  filterDelete: Array<unknown>;
  labelDelete: Array<unknown>;
}

function mockGmail(): { client: gmail_v1.Gmail; calls: MockedGmailCalls } {
  const calls: MockedGmailCalls = {
    messageDelete: [],
    threadModify: [],
    filterDelete: [],
    labelDelete: [],
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
      },
      settings: {
        filters: {
          delete: async (params: unknown) => {
            calls.filterDelete.push(params);
            return { data: {} };
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

async function buildAndConnect(scopes: string[]): Promise<ConnectedFixture> {
  const server = createServer({
    oauth2Client: new OAuth2Client(),
    authorizedScopes: scopes,
  });
  const { client: gmail, calls } = mockGmail();
  registerMessageTools(server, gmail, scopes);
  registerLabelTools(server, gmail, scopes);
  registerFilterTools(server, gmail, scopes);
  registerThreadTools(server, gmail, scopes);

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "pr3-test", version: "0.0.0" });
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

describe("PR #3 registrars — combined tools/list shape", () => {
  it("advertises all four tools when the token covers every required scope", async () => {
    const fix = await buildAndConnect([
      "mail.google.com",
      "gmail.modify",
      "gmail.labels",
      "gmail.settings.basic",
    ]);
    try {
      const list = await fix.client.listTools();
      const names = list.tools.map((t) => t.name).sort();
      expect(names).toEqual(["delete_email", "delete_filter", "delete_label", "modify_thread"]);
    } finally {
      await fix.close();
    }
  });

  it("filters out tools whose required scopes are missing from the token", async () => {
    // Only gmail.modify + gmail.labels — covers `delete_label` and
    // `modify_thread`, but NOT `delete_email` (needs mail.google.com)
    // and NOT `delete_filter` (needs gmail.settings.basic). Pinning
    // scope-aware filtering on a populated set instead of an empty
    // one avoids the SDK quirk where `tools/list` becomes
    // `Method not found` when 0 tools are registered.
    const fix = await buildAndConnect(["gmail.modify", "gmail.labels"]);
    try {
      const list = await fix.client.listTools();
      const names = list.tools.map((t) => t.name).sort();
      expect(names).toEqual(["delete_label", "modify_thread"]);
    } finally {
      await fix.close();
    }
  });
});
