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
import { wrapToolHandler, isDryRun, type ToolResult } from "./middleware.js";

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
    delete process.env.GMAIL_MCP_DRY_RUN;
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

  describe("dry-run mode (GMAIL_MCP_DRY_RUN=true)", () => {
    it("flips on when the env var equals the exact string 'true'", () => {
      delete process.env.GMAIL_MCP_DRY_RUN;
      expect(isDryRun()).toBe(false);
      process.env.GMAIL_MCP_DRY_RUN = "true";
      expect(isDryRun()).toBe(true);
    });

    it("does not flip on for truthy-but-not-'true' values (strict match)", () => {
      for (const v of ["1", "TRUE", "True", "yes", "on", ""]) {
        process.env.GMAIL_MCP_DRY_RUN = v;
        expect(isDryRun()).toBe(false);
      }
    });

    it("short-circuits write tools with a dry-run payload and skips the handler", async () => {
      process.env.GMAIL_MCP_DRY_RUN = "true";
      let handlerRuns = 0;
      const handler = async (): Promise<ToolResult> => {
        handlerRuns += 1;
        return { content: [{ type: "text", text: "handler was called" }] };
      };

      const result = await wrapToolHandler(
        "send_email",
        { to: "a@b.c", subject: "hi", body: "plain" },
        handler,
      );

      expect(handlerRuns).toBe(0);
      expect(result.structuredContent).toMatchObject({
        dryRun: true,
        tool: "send_email",
        // body is in the audit-log ELIDED_KEYS list (attacker-controlled
        // free-form field) so it is elided here the same way the audit
        // log records it — sanitized view, same everywhere.
        wouldCallWith: { to: "a@b.c", subject: "hi", body: "[ELIDED:5 chars]" },
      });
      const parsed = JSON.parse(result.content[0].text) as { dryRun: boolean; tool: string };
      expect(parsed.dryRun).toBe(true);
      expect(parsed.tool).toBe("send_email");
    });

    it("redacts sensitive arg fields in the dry-run payload", async () => {
      process.env.GMAIL_MCP_DRY_RUN = "true";
      const result = await wrapToolHandler(
        "send_email",
        { to: "a@b.c", access_token: "SECRET", authorization: "Bearer X" },
        async () => ({ content: [{ type: "text", text: "unreached" }] }),
      );
      const payload = result.structuredContent as {
        wouldCallWith: Record<string, unknown>;
      };
      expect(payload.wouldCallWith.to).toBe("a@b.c");
      expect(payload.wouldCallWith.access_token).toBe("[REDACTED]");
      expect(payload.wouldCallWith.authorization).toBe("[REDACTED]");
    });

    it("logs a 'dry-run' audit entry and never enters the rate-limit bucket", async () => {
      process.env.GMAIL_MCP_DRY_RUN = "true";
      // Force a 1/day bucket — a real call would trip on the second
      // invocation, but dry-run runs BEFORE rate-limit so the bucket
      // stays untouched.
      process.env.GMAIL_MCP_RATE_LIMIT_send = "1/day,1/month";
      resetRateLimitHistory();

      await wrapToolHandler("send_email", { to: "a@b.c" }, async () => okResult);
      await wrapToolHandler("send_email", { to: "a@b.c" }, async () => okResult);
      await wrapToolHandler("send_email", { to: "a@b.c" }, async () => okResult);

      const entries = readAuditEntries();
      expect(entries.length).toBe(3);
      for (const e of entries) expect(e).toMatchObject({ result: "dry-run" });
    });

    it("does not short-circuit read tools (they bypass dry-run)", async () => {
      process.env.GMAIL_MCP_DRY_RUN = "true";
      let handlerRuns = 0;
      const result = await wrapToolHandler("list_email_labels", {}, async () => {
        handlerRuns += 1;
        return okResult;
      });
      expect(handlerRuns).toBe(1);
      expect(result).toEqual(okResult);
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
