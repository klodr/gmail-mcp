import { describe, it, expect } from "vitest";
import { OAuth2Client } from "google-auth-library";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, VERSION } from "./server.js";
import { defineTool } from "./tools/_shared.js";
import { z } from "zod";

describe("createServer", () => {
  it("returns an McpServer instance", () => {
    const server = createServer({
      oauth2Client: new OAuth2Client(),
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
      oauth2Client: new OAuth2Client(),
      authorizedScopes: ["gmail.readonly"],
    });
    expect(server).toBeInstanceOf(McpServer);
  });

  it("does not throw when authorizedScopes is empty (lazy-boot mode)", () => {
    // Mirrors the lazy-boot path in src/index.ts:loadCredentials —
    // when no OAuth keys are mounted, authorizedScopes is `[]` and
    // tools/list returns the empty surface. createServer must accept
    // this without complaint.
    expect(() =>
      createServer({ oauth2Client: new OAuth2Client(), authorizedScopes: [] }),
    ).not.toThrow();
  });
});

describe("defineTool", () => {
  function noopHandler(): Promise<{ content: { type: string; text: string }[] }> {
    return Promise.resolve({ content: [{ type: "text", text: "ok" }] });
  }

  it("registers the tool when the OAuth scopes match", () => {
    const server = createServer({
      oauth2Client: new OAuth2Client(),
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
      oauth2Client: new OAuth2Client(),
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
      oauth2Client: new OAuth2Client(),
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
      oauth2Client: new OAuth2Client(),
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
      oauth2Client: new OAuth2Client(),
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
      oauth2Client: new OAuth2Client(),
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
});
