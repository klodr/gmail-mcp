import { describe, it, expect } from "vitest";
import type { gmail_v1 } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, VERSION } from "./server.js";
import { defineTool } from "./tools/_shared.js";
import { z } from "zod";

// PR #7 changed `createServer` to take a `gmail` client directly
// (instead of an `OAuth2Client` from which gmail is derived). For the
// smoke tests in this file the gmail object is never actually invoked
// (we register `defineTool` calls with custom handlers that bypass it),
// so the simplest stub is `{} as gmail_v1.Gmail`.
function mockGmail(): gmail_v1.Gmail {
  return {} as gmail_v1.Gmail;
}

describe("createServer", () => {
  it("returns an McpServer instance", () => {
    const server = createServer({
      gmail: mockGmail(),
      authorizedScopes: [],
    });
    expect(server).toBeInstanceOf(McpServer);
  });

  it("uses the VERSION constant declared in server.ts", () => {
    // VERSION is hand-synced with package.json by scripts/sync-version.mjs.
    // Pinning the shape here so a manual edit that drops the export
    // (or a sync-version.mjs regression) is caught at test time.
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("accepts an authorizedScopes list and returns a usable server", () => {
    const server = createServer({
      gmail: mockGmail(),
      authorizedScopes: ["gmail.readonly"],
    });
    expect(server).toBeInstanceOf(McpServer);
  });

  it("does not throw when authorizedScopes is empty (lazy-boot mode)", () => {
    // Mirrors the lazy-boot path in src/index.ts:loadCredentials —
    // when no OAuth keys are mounted, authorizedScopes is `[]` and
    // tools/list returns the empty surface. createServer must accept
    // this without complaint.
    expect(() => createServer({ gmail: mockGmail(), authorizedScopes: [] })).not.toThrow();
  });
});

describe("createServer — prompts surface", () => {
  it("emits the prompts/list capability and returns the slash-command catalogue", async () => {
    const server = createServer({
      gmail: mockGmail(),
      authorizedScopes: ["gmail.readonly"],
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "prompts-test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const list = await client.listPrompts();
      // src/prompts.ts ships at least one slash command — pin that
      // the surface is non-empty and that each entry has the full
      // PromptInfo contract (name + title + description + arguments
      // array). A regression that drops any of those would silently
      // shrink the public surface that LLM hosts use to render the
      // slash-command picker.
      expect(list.prompts.length).toBeGreaterThan(0);
      for (const p of list.prompts) {
        expect(typeof p.name).toBe("string");
        expect(p.name.length).toBeGreaterThan(0);
        expect(typeof p.title).toBe("string");
        expect(p.title.length).toBeGreaterThan(0);
        expect(typeof p.description).toBe("string");
        expect(Array.isArray(p.arguments)).toBe(true);
      }
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("getPrompt returns the rendered template for a known prompt name", async () => {
    const server = createServer({
      gmail: mockGmail(),
      authorizedScopes: ["gmail.readonly"],
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "getprompt-test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const list = await client.listPrompts();
      // Pick a prompt that has no required arguments so the test stays
      // deterministic across catalogue reorders. Falls back to the
      // first prompt only if every prompt has required args (which
      // would itself be a regression worth flagging).
      const noArgPrompt =
        list.prompts.find((p) =>
          (p.arguments ?? []).every((a: { required?: boolean }) => !a.required),
        ) ?? list.prompts[0];
      expect(noArgPrompt).toBeDefined();
      const result = await client.getPrompt({ name: noArgPrompt!.name });
      // Pin both the array shape AND the per-message contract
      // (role + content.type + non-empty text) — without these, a
      // regression that returns an empty messages array OR drops the
      // role/type fields would still pass the length check.
      expect(Array.isArray(result.messages)).toBe(true);
      expect(result.messages.length).toBeGreaterThan(0);
      const first = result.messages[0]!;
      expect(first.role).toBe("user");
      const content = first.content as { type: string; text: string };
      expect(content.type).toBe("text");
      expect(content.text.length).toBeGreaterThan(0);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("getPrompt rejects an unknown prompt name with a JSON-RPC error", async () => {
    const server = createServer({
      gmail: mockGmail(),
      authorizedScopes: ["gmail.readonly"],
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "unknown-prompt-test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      await expect(
        client.getPrompt({ name: "definitely-not-a-real-prompt-name" }),
      ).rejects.toThrow();
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});

describe("defineTool", () => {
  function noopHandler(): Promise<{ content: { type: string; text: string }[] }> {
    return Promise.resolve({ content: [{ type: "text", text: "ok" }] });
  }

  it("registers the tool when the OAuth scopes match", () => {
    const server = createServer({
      gmail: mockGmail(),
      authorizedScopes: ["gmail.readonly"],
    });
    const registered = defineTool(
      server,
      "test_read_tool",
      "A read-only test tool.",
      { foo: z.string() },
      noopHandler,
      { readOnlyHint: true },
      ["gmail.readonly"],
      ["gmail.readonly"],
    );
    expect(registered).toBe(true);
  });

  it("skips registration when the OAuth scopes do not cover the requirement", () => {
    const server = createServer({
      gmail: mockGmail(),
      authorizedScopes: ["gmail.readonly"],
    });
    // Tool needs gmail.modify but the token only has gmail.readonly →
    // skip silently. This is the auto-emitted equivalent of the
    // dispatcher's manual ListToolsRequestSchema scope filter.
    const registered = defineTool(
      server,
      "test_modify_tool",
      "A write test tool.",
      { foo: z.string() },
      noopHandler,
      { destructiveHint: false, idempotentHint: true },
      ["gmail.modify"],
      ["gmail.readonly"],
    );
    expect(registered).toBe(false);
  });

  it("registers when the OAuth set is a strict superset of the requirement", () => {
    const server = createServer({
      gmail: mockGmail(),
      authorizedScopes: ["gmail.modify", "gmail.send"],
    });
    const registered = defineTool(
      server,
      "test_send",
      "Sends test mail.",
      { to: z.array(z.string()) },
      noopHandler,
      { destructiveHint: false },
      ["gmail.send"],
      ["gmail.modify", "gmail.send"],
    );
    expect(registered).toBe(true);
  });

  it("invokes the registered handler end-to-end via an InMemoryTransport client", async () => {
    // Pin the actual SDK round-trip: a Client invokes the tool, the
    // adapter validates args via the strict Zod schema, the handler
    // runs, and the result reaches the client unchanged.
    const server = createServer({
      gmail: mockGmail(),
      authorizedScopes: ["gmail.readonly"],
    });
    defineTool(
      server,
      "echo_tool",
      "Echoes the supplied message back as a tool result.",
      { msg: z.string() },
      async (args) =>
        Promise.resolve({
          content: [{ type: "text", text: `echo: ${args.msg}` }],
        }),
      { readOnlyHint: true },
      ["gmail.readonly"],
      ["gmail.readonly"],
    );

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = (await client.callTool({
        name: "echo_tool",
        arguments: { msg: "hello world" },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      // The text travels through `wrapToolHandler` which wraps every tool
      // response in the `<untrusted-tool-output>` sanitize fence — pin
      // both the fence wrapping AND the inner echoed payload so a future
      // change that drops the fence (or that double-fences it) is caught.
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("<untrusted-tool-output>");
      expect(result.content[0]?.text).toContain("echo: hello world");
      expect(result.content[0]?.text).toContain("</untrusted-tool-output>");
    } finally {
      // Always close — without this, an assertion failure inside the
      // `try` would leak the InMemoryTransport pair into subsequent
      // tests. CR finding on PR #84.
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("rejects unknown keys in the argument object (Zod strict mode)", async () => {
    // The SDK validates against `inputSchema = z.object(shape).strict()`
    // BEFORE the adapter runs; a smuggled key fails parse instead of
    // silently dropping. Pinning this is the whole point of `.strict()`
    // — defence against prompt-injection payloads that try to slip
    // extra fields past the validator.
    const server = createServer({
      gmail: mockGmail(),
      authorizedScopes: ["gmail.readonly"],
    });
    defineTool(
      server,
      "strict_tool",
      "Tool that should reject unknown keys.",
      { foo: z.string() },
      async () => Promise.resolve({ content: [{ type: "text", text: "ok" }] }),
      { readOnlyHint: true },
      ["gmail.readonly"],
      ["gmail.readonly"],
    );

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      // The SDK surfaces parse failure as `{ isError: true }` rather than
      // a thrown rejection — the equivalent of an MCP `-32602` shape
      // wrapped through the tool-result envelope. Pin the contract on
      // the `isError` channel + the text containing a Zod-shaped clue.
      const result = (await client.callTool({
        name: "strict_tool",
        arguments: { foo: "ok", smuggled: "extra" },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text.toLowerCase()).toMatch(/unrecognized|smuggled|strict/);
    } finally {
      // Always close — see the echo test above.
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("accepts the URL form of an authorized scope (matches the shorthand requirement)", () => {
    // `hasScope` normalises URL-form scopes (e.g.
    // "https://www.googleapis.com/auth/gmail.readonly") to the
    // shorthand the tool definitions use ("gmail.readonly"). Pin
    // that the URL form coming back from a real OAuth token does
    // not silently break registration for the matching tool.
    const server = createServer({
      gmail: mockGmail(),
      authorizedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    });
    const registered = defineTool(
      server,
      "test_url_scope",
      "Test of URL-form scope normalisation.",
      { foo: z.string() },
      noopHandler,
      { readOnlyHint: true },
      ["gmail.readonly"],
      ["https://www.googleapis.com/auth/gmail.readonly"],
    );
    expect(registered).toBe(true);
  });

  it("exposes the optional outputSchema via tools/list when supplied", async () => {
    // Pin the new MCP `outputSchema` contract: when defineTool is
    // called with the optional 9th argument, the schema must be
    // exposed verbatim on `tools/list` (so an agent can introspect
    // the structured-content shape without parsing the textual
    // RETURNS: block in `description`). Verifies the wiring on
    // `_shared.ts:127-138` — the `outputSchema` arg threads
    // through to the SDK's `registerTool` config.
    const server = createServer({
      gmail: mockGmail(),
      authorizedScopes: ["gmail.readonly"],
    });
    defineTool(
      server,
      "test_with_output",
      "Tool that emits a typed structuredContent payload.",
      { foo: z.string() },
      async () =>
        Promise.resolve({
          content: [{ type: "text", text: '{"id":"x","count":1}' }],
          structuredContent: { id: "x", count: 1 },
        }),
      { readOnlyHint: true },
      ["gmail.readonly"],
      ["gmail.readonly"],
      { id: z.string(), count: z.number().int() },
    );

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const list = await client.listTools();
      const t = list.tools.find((tool) => tool.name === "test_with_output");
      expect(t).toBeDefined();
      // `outputSchema` is a JSON Schema with `type: "object"` + the
      // shape's properties. Pin both that it exists and that the
      // properties match the Zod shape we supplied.
      expect(t?.outputSchema).toBeDefined();
      expect(t?.outputSchema?.type).toBe("object");
      const props = (t?.outputSchema as { properties?: Record<string, unknown> }).properties;
      expect(props?.id).toBeDefined();
      expect(props?.count).toBeDefined();
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("omits outputSchema from tools/list when none is supplied (back-compat)", async () => {
    // Tools registered WITHOUT the new optional 9th arg keep the
    // pre-PR behaviour: `tools/list` does not advertise an
    // `outputSchema` field. Pin this so the migration is safe to
    // roll out tool-by-tool without breaking existing clients
    // that ignore `outputSchema`.
    const server = createServer({
      gmail: mockGmail(),
      authorizedScopes: ["gmail.readonly"],
    });
    defineTool(
      server,
      "test_without_output",
      "Tool with no outputSchema (back-compat).",
      { foo: z.string() },
      noopHandler,
      { readOnlyHint: true },
      ["gmail.readonly"],
      ["gmail.readonly"],
    );

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const list = await client.listTools();
      const t = list.tools.find((tool) => tool.name === "test_without_output");
      expect(t).toBeDefined();
      expect(t?.outputSchema).toBeUndefined();
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
