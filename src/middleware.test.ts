/**
 * Tests for src/middleware.ts — wrapToolHandler rate-limit + audit glue.
 *
 * Mirrors the behaviour covered inline by the current
 * `setRequestHandler` in `src/index.ts` (lines 522-533 rate-limit,
 * 539-1949 audit finally) so the extracted helper preserves the
 * observable audit trail and the rate-limited error payload shape.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetRateLimitHistory } from "./rate-limit.js";
import { wrapToolHandler, type ToolResult } from "./middleware.js";

describe("wrapToolHandler", () => {
  let stateDir: string;
  let auditPath: string;
  const originalEnv = { ...process.env };

  const readAuditEntries = (): Array<Record<string, unknown>> => {
    if (!existsSync(auditPath)) return [];
    return readFileSync(auditPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "gmail-mcp-middleware-test-"));
    auditPath = join(stateDir, "audit.jsonl");
    process.env.GMAIL_MCP_STATE_DIR = stateDir;
    process.env.GMAIL_MCP_AUDIT_LOG = auditPath;
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

  const okResult: ToolResult = {
    content: [{ type: "text", text: "ok" }],
  };

  it("returns the handler result on the happy path", async () => {
    const result = await wrapToolHandler("list_email_labels", { foo: 1 }, async () => okResult);
    expect(result).toEqual(okResult);
  });

  it("logs `ok` audit entry on a clean handler return (for an unbucketed read tool)", async () => {
    // list_email_labels is a READ tool and not bucketed → rate-limit is
    // a no-op; we still expect an audit entry because the helper logs
    // unconditionally in the `finally`.
    await wrapToolHandler("list_email_labels", { q: "test" }, async () => okResult);
    const entries = readAuditEntries();
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({ tool: "list_email_labels", result: "ok" });
  });

  it("logs `error` audit entry when the handler throws (and re-throws)", async () => {
    const boom = new Error("handler boom");
    await expect(
      wrapToolHandler("list_email_labels", {}, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    const entries = readAuditEntries();
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({ tool: "list_email_labels", result: "error" });
  });

  it("logs `error` audit entry when the handler returns isError:true (business error)", async () => {
    const result = await wrapToolHandler("list_email_labels", {}, async () => ({
      content: [{ type: "text", text: "handler-surfaced failure" }],
      isError: true,
    }));
    expect(result.isError).toBe(true);
    const entries = readAuditEntries();
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({ tool: "list_email_labels", result: "error" });
  });

  it("trips on rate-limit and returns an isError MCP payload (no handler run)", async () => {
    // Force the `send` bucket to 1/day so the second call is rejected.
    process.env.GMAIL_MCP_RATE_LIMIT_send = "1/day,1/month";
    resetRateLimitHistory();

    let handlerRuns = 0;
    const handler = async (): Promise<ToolResult> => {
      handlerRuns += 1;
      return okResult;
    };

    const first = await wrapToolHandler("send_email", { to: "a@b.c" }, handler);
    expect(first).toEqual(okResult);
    expect(handlerRuns).toBe(1);

    const second = await wrapToolHandler("send_email", { to: "a@b.c" }, handler);
    expect(second.isError).toBe(true);
    expect(handlerRuns).toBe(1); // handler NOT re-entered on rate-limit
    const parsed = JSON.parse(second.content[0].text) as { error_type: string; source: string };
    expect(parsed.source).toBe("mcp_safeguard");
    expect(parsed.error_type).toMatch(/^mcp_rate_limit_(daily|monthly)_exceeded$/);
    // The rate-limit text is JSON → auto-attached as structuredContent
    // so programmatic consumers see the shape without re-parsing.
    expect(second.structuredContent).toEqual(parsed);
  });

  it("logs `rate_limited` audit entry when the rate-limit trips", async () => {
    process.env.GMAIL_MCP_RATE_LIMIT_send = "1/day,1/month";
    resetRateLimitHistory();

    await wrapToolHandler("send_email", { to: "a@b.c" }, async () => okResult);
    await wrapToolHandler("send_email", { to: "a@b.c" }, async () => okResult);

    const entries = readAuditEntries();
    // First call succeeded → one "ok" entry. Second trip → one "rate_limited".
    expect(entries.length).toBe(2);
    expect(entries[0]).toMatchObject({ tool: "send_email", result: "ok" });
    expect(entries[1]).toMatchObject({ tool: "send_email", result: "rate_limited" });
  });

  describe("structuredContent auto-attachment", () => {
    it("lifts a JSON-object text payload into structuredContent", async () => {
      const payload = { id: "abc", labels: ["INBOX"], count: 3 };
      const result = await wrapToolHandler("list_email_labels", {}, async () => ({
        content: [{ type: "text", text: JSON.stringify(payload) }],
      }));
      expect(result.structuredContent).toEqual(payload);
    });

    it("lifts a JSON-array text payload into structuredContent", async () => {
      const payload = [{ id: "1" }, { id: "2" }];
      const result = await wrapToolHandler("list_email_labels", {}, async () => ({
        content: [{ type: "text", text: JSON.stringify(payload) }],
      }));
      expect(result.structuredContent).toEqual(payload);
    });

    it("leaves structuredContent unset for plain-text payloads (non-JSON)", async () => {
      const result = await wrapToolHandler("send_email", {}, async () => ({
        content: [{ type: "text", text: "Email sent successfully: <abc@mail.gmail.com>" }],
      }));
      expect(result.structuredContent).toBeUndefined();
    });

    it("leaves structuredContent unset for JSON primitives (number/string/boolean/null)", async () => {
      for (const raw of ["42", '"hello"', "true", "null"]) {
        const result = await wrapToolHandler("list_email_labels", {}, async () => ({
          content: [{ type: "text", text: raw }],
        }));
        expect(result.structuredContent).toBeUndefined();
      }
    });

    it("does not overwrite a structuredContent that the handler already set", async () => {
      const handlerPayload = { explicit: true };
      const result = await wrapToolHandler("send_email", {}, async () => ({
        content: [{ type: "text", text: JSON.stringify({ ignored: true }) }],
        structuredContent: handlerPayload,
      }));
      expect(result.structuredContent).toEqual(handlerPayload);
    });

    it("leaves structuredContent unset when the content array is empty or non-text", async () => {
      const emptyResult = await wrapToolHandler("list_email_labels", {}, async () => ({
        content: [],
      }));
      expect(emptyResult.structuredContent).toBeUndefined();

      const imageResult = await wrapToolHandler("list_email_labels", {}, async () => ({
        content: [{ type: "image", text: JSON.stringify({ looks: "json" }) }],
      }));
      expect(imageResult.structuredContent).toBeUndefined();
    });

    it("leaves isError flag intact on the auto-attached result", async () => {
      const result = await wrapToolHandler("send_email", {}, async () => ({
        content: [{ type: "text", text: JSON.stringify({ error: "nope" }) }],
        isError: true,
      }));
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({ error: "nope" });
    });
  });

  it("passes args through to the audit log (after redaction in audit-log.ts)", async () => {
    await wrapToolHandler(
      "list_email_labels",
      { harmless: "visible", access_token: "SECRET" },
      async () => okResult,
    );
    const entries = readAuditEntries();
    const argsEntry = entries[0].args as Record<string, unknown>;
    expect(argsEntry.harmless).toBe("visible");
    expect(argsEntry.access_token).toBe("[REDACTED]");
  });
});
