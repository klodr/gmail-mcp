/**
 * `pair_recipient add` with the pairing gate ON: the model cannot widen
 * the allowlist on its own. The human confirms through MCP elicitation
 * when the client supports it; otherwise the call is refused and points
 * to the CLI. `list` / `remove` stay available, and with the gate OFF
 * `add` behaves as before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { gmail_v1 } from "googleapis";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/server.js";
import { PAIRING_CONFIRM_TIMEOUT_MS_DEFAULT } from "../src/tools/messaging.js";
import { resetRateLimitHistory } from "../src/rate-limit.js";
import { addPairedAddress, readPairedList } from "../src/recipient-pairing.js";

type ToolOut = { content: Array<{ type: string; text: string }>; isError?: boolean };

// Built at runtime so no literal address sits in the diff (leak-detect).
const mail = (user: string): string => `${user}@example.com`;

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "gmail-mcp-pairing-confirm-"));
  process.env.GMAIL_MCP_PAIRED_PATH = join(stateDir, "paired.json");
  process.env.GMAIL_MCP_STATE_DIR = stateDir;
  process.env.GMAIL_MCP_RECIPIENT_PAIRING = "true";
  resetRateLimitHistory();
});

afterEach(() => {
  delete process.env.GMAIL_MCP_PAIRED_PATH;
  delete process.env.GMAIL_MCP_STATE_DIR;
  delete process.env.GMAIL_MCP_RECIPIENT_PAIRING;
  delete process.env.GMAIL_MCP_PAIRING_CONFIRM_TIMEOUT_MS;
  rmSync(stateDir, { recursive: true, force: true });
});

/**
 * Connect a client. `answer` set → the client declares form
 * elicitation and replies with it (or throws, for the error path);
 * `answer` undefined → a client without elicitation support.
 */
async function connect(
  answer?: () => ElicitResult | Promise<ElicitResult>,
  capabilities?: Record<string, unknown>,
): Promise<{
  client: Client;
  server: ReturnType<typeof createServer>;
  asked: string[];
  close: () => Promise<void>;
}> {
  const server = createServer({
    gmail: {} as gmail_v1.Gmail,
    authorizedScopes: ["gmail.modify"],
  });
  const asked: string[] = [];
  const client = new Client(
    { name: "pairing-confirm-test", version: "0.0.0" },
    { capabilities: capabilities ?? (answer ? { elicitation: { form: {} } } : {}) },
  );
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, (request) => {
      asked.push(request.params.message);
      return answer();
    });
  }
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    server,
    asked,
    close: async () => {
      await Promise.all([client.close(), server.close()]);
    },
  };
}

async function add(client: Client, email: string): Promise<ToolOut> {
  return (await client.callTool({
    name: "pair_recipient",
    arguments: { action: "add", email },
  })) as ToolOut;
}

describe("pair_recipient add with the pairing gate on", () => {
  it("pairs the address once the human ticks the confirmation", async () => {
    const fix = await connect(() => ({ action: "accept", content: { confirm: true } }));
    try {
      const out = await add(fix.client, `Partner <${mail("Partner")}>`);
      expect(out.isError).toBeFalsy();
      expect(out.content[0]?.text).toContain(`Added "${mail("partner")}"`);
      expect(readPairedList()).toEqual([mail("partner")]);
      // The human was shown the bare address that will be paired.
      expect(fix.asked[0]).toContain(`"${mail("partner")}"`);
    } finally {
      await fix.close();
    }
  });

  it.each([
    [
      "left unticked",
      (): ElicitResult => ({ action: "accept", content: { confirm: false } }),
      "left unticked",
    ],
    ["declined", (): ElicitResult => ({ action: "decline" }), "declined"],
    ["cancelled", (): ElicitResult => ({ action: "cancel" }), "cancelled"],
  ])("does not pair when the confirmation is %s", async (_label, answer, reason) => {
    const fix = await connect(answer);
    try {
      const out = await add(fix.client, mail("x"));
      expect(out.isError).toBe(true);
      expect(out.content[0]?.text).toContain(reason);
      expect(readPairedList()).toEqual([]);
    } finally {
      await fix.close();
    }
  });

  it("does not pair, and points to the CLI, when the confirmation request fails", async () => {
    const fix = await connect(() => {
      throw new Error("client UI unavailable");
    });
    try {
      const out = await add(fix.client, mail("x"));
      expect(out.isError).toBe(true);
      expect(out.content[0]?.text).toContain("the confirmation request failed");
      expect(out.content[0]?.text).toContain(`npx @klodr/gmail-mcp pair add ${mail("x")}`);
      expect(readPairedList()).toEqual([]);
    } finally {
      await fix.close();
    }
  });

  it("refuses and points to the CLI when the client cannot ask the human", async () => {
    const fix = await connect();
    try {
      const out = await add(fix.client, mail("x"));
      expect(out.isError).toBe(true);
      expect(out.content[0]?.text).toContain("no elicitation support");
      expect(out.content[0]?.text).toContain(`npx @klodr/gmail-mcp pair add ${mail("x")}`);
      expect(existsSync(join(stateDir, "paired.json"))).toBe(false);
    } finally {
      await fix.close();
    }
  });

  it("refuses with the clear message when the client only declares URL elicitation", async () => {
    const fix = await connect(undefined, { elicitation: { url: {} } });
    try {
      const out = await add(fix.client, mail("x"));
      expect(out.isError).toBe(true);
      expect(out.content[0]?.text).toContain("no elicitation support for forms");
      expect(out.content[0]?.text).not.toContain("confirmation request failed");
      expect(out.content[0]?.text).toContain(`npx @klodr/gmail-mcp pair add ${mail("x")}`);
      expect(fix.asked).toEqual([]);
      expect(readPairedList()).toEqual([]);
    } finally {
      await fix.close();
    }
  });

  it.each([
    ["unset", undefined, PAIRING_CONFIRM_TIMEOUT_MS_DEFAULT],
    ["set", "120000", 120_000],
    ["not a number", "soon", PAIRING_CONFIRM_TIMEOUT_MS_DEFAULT],
    ["zero", "0", PAIRING_CONFIRM_TIMEOUT_MS_DEFAULT],
    ["negative", "-5", PAIRING_CONFIRM_TIMEOUT_MS_DEFAULT],
  ])(
    "passes an explicit timeout to the confirmation request (env %s)",
    async (_label, raw, expected) => {
      if (raw !== undefined) process.env.GMAIL_MCP_PAIRING_CONFIRM_TIMEOUT_MS = raw;
      const fix = await connect(() => ({ action: "accept", content: { confirm: true } }));
      const spy = vi.spyOn(fix.server.server, "elicitInput");
      try {
        await add(fix.client, mail("x"));
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]?.[1]).toEqual({ timeout: expected });
      } finally {
        spy.mockRestore();
        await fix.close();
      }
    },
  );

  it("does not pair when the human does not answer before the timeout", async () => {
    process.env.GMAIL_MCP_PAIRING_CONFIRM_TIMEOUT_MS = "50";
    const fix = await connect(
      () =>
        new Promise<ElicitResult>((resolve) => {
          setTimeout(() => resolve({ action: "accept", content: { confirm: true } }), 500);
        }),
    );
    try {
      const out = await add(fix.client, mail("x"));
      expect(out.isError).toBe(true);
      expect(out.content[0]?.text).toContain("the confirmation request failed");
      expect(readPairedList()).toEqual([]);
    } finally {
      await fix.close();
    }
  });

  it("still lets the model list and remove without asking", async () => {
    addPairedAddress(mail("old"));
    const fix = await connect();
    try {
      const list = (await fix.client.callTool({
        name: "pair_recipient",
        arguments: { action: "list" },
      })) as ToolOut;
      expect(list.content[0]?.text).toContain(mail("old"));
      const removed = (await fix.client.callTool({
        name: "pair_recipient",
        arguments: { action: "remove", email: mail("old") },
      })) as ToolOut;
      expect(removed.isError).toBeFalsy();
      expect(readPairedList()).toEqual([]);
    } finally {
      await fix.close();
    }
  });
});

describe("pair_recipient add with the pairing gate off", () => {
  it("pairs directly, without asking, as before", async () => {
    delete process.env.GMAIL_MCP_RECIPIENT_PAIRING;
    const fix = await connect(() => {
      throw new Error("must not be asked");
    });
    try {
      const out = await add(fix.client, mail("trusted"));
      expect(out.isError).toBeFalsy();
      expect(fix.asked).toEqual([]);
      expect(readPairedList()).toEqual([mail("trusted")]);
    } finally {
      await fix.close();
    }
  });
});
