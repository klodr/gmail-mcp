import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RateLimitError,
  enforceRateLimit,
  formatRateLimitError,
  resetRateLimitHistory,
  _TOOL_BUCKET,
} from "./rate-limit.js";

describe("rate-limit", () => {
  let stateDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "gmail-mcp-ratelimit-test-"));
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

  it("is a no-op for read tools absent from TOOL_BUCKET", () => {
    expect(() => enforceRateLimit("read_email")).not.toThrow();
    expect(() => enforceRateLimit("search_emails")).not.toThrow();
    expect(() => enforceRateLimit("list_inbox_threads")).not.toThrow();
    expect(() => enforceRateLimit("download_attachment")).not.toThrow();
  });

  it("is a no-op for unknown tool names", () => {
    expect(() => enforceRateLimit("this_tool_does_not_exist")).not.toThrow();
  });

  it("maps send-family tools to the 'send' bucket", () => {
    expect(_TOOL_BUCKET.send_email).toBe("send");
    expect(_TOOL_BUCKET.reply_all).toBe("send");
  });

  it("maps destructive tools to 'delete'", () => {
    expect(_TOOL_BUCKET.delete_email).toBe("delete");
    expect(_TOOL_BUCKET.batch_delete_emails).toBe("delete");
  });

  it("accepts a valid env override", () => {
    process.env.GMAIL_MCP_RATE_LIMIT_send = "2/day,10/month";
    expect(() => enforceRateLimit("send_email")).not.toThrow();
    expect(() => enforceRateLimit("send_email")).not.toThrow();
    // Third call should hit the daily cap of 2
    expect(() => enforceRateLimit("send_email")).toThrow(RateLimitError);
  });

  it("rejects malformed override and falls back to default (does not crash)", () => {
    process.env.GMAIL_MCP_RATE_LIMIT_send = "not a valid value";
    // Default is 400/day for send — must not throw on the first call
    expect(() => enforceRateLimit("send_email")).not.toThrow();
  });

  it("emits a daily RateLimitError with retry_after under 24h", () => {
    process.env.GMAIL_MCP_RATE_LIMIT_send = "1/day,100/month";
    enforceRateLimit("send_email");
    try {
      enforceRateLimit("send_email");
      expect.fail("expected RateLimitError");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      const rle = err as RateLimitError;
      expect(rle.limitType).toBe("daily");
      expect(rle.bucket).toBe("send");
      expect(rle.limit).toBe(1);
      expect(rle.retryAfterMs).toBeGreaterThan(0);
      expect(rle.retryAfterMs).toBeLessThanOrEqual(86_400_000);
    }
  });

  it("emits a monthly RateLimitError when the monthly cap is hit before daily", () => {
    process.env.GMAIL_MCP_RATE_LIMIT_send = "100/day,2/month";
    enforceRateLimit("send_email");
    enforceRateLimit("send_email");
    try {
      enforceRateLimit("send_email");
      expect.fail("expected RateLimitError");
    } catch (err) {
      const rle = err as RateLimitError;
      expect(rle.limitType).toBe("monthly");
      expect(rle.bucket).toBe("send");
      expect(rle.limit).toBe(2);
    }
  });

  it("GMAIL_MCP_RATE_LIMIT_DISABLE=true disables the limiter entirely", () => {
    process.env.GMAIL_MCP_RATE_LIMIT_send = "1/day,1/month";
    process.env.GMAIL_MCP_RATE_LIMIT_DISABLE = "true";
    // Would have thrown on the second call with limits 1/day, 1/month
    for (let i = 0; i < 5; i++) {
      expect(() => enforceRateLimit("send_email")).not.toThrow();
    }
  });

  it("shares state between send_email and reply_all (same bucket)", () => {
    process.env.GMAIL_MCP_RATE_LIMIT_send = "2/day,100/month";
    enforceRateLimit("send_email");
    enforceRateLimit("reply_all");
    // Both share bucket "send" → 2 calls already consumed, third throws
    expect(() => enforceRateLimit("send_email")).toThrow(RateLimitError);
  });

  it("does not share state between different buckets", () => {
    process.env.GMAIL_MCP_RATE_LIMIT_send = "1/day,100/month";
    process.env.GMAIL_MCP_RATE_LIMIT_delete = "1/day,100/month";
    enforceRateLimit("send_email");
    // delete_email is a different bucket, should not be affected
    expect(() => enforceRateLimit("delete_email")).not.toThrow();
  });

  it("persists state to <stateDir>/ratelimit.json with mode 0o600", () => {
    process.env.GMAIL_MCP_RATE_LIMIT_send = "10/day,100/month";
    enforceRateLimit("send_email");
    const statePath = join(stateDir, "ratelimit.json");
    const stat = statSync(statePath);
    // mode 0o600 = owner read/write only (0o100600 with file-type bits)
    expect(stat.mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, number[]>;
    expect(parsed.send).toBeDefined();
    expect(parsed.send?.length).toBe(1);
  });

  it("formatRateLimitError produces a structured JSON with mcp_safeguard source", () => {
    const err = new RateLimitError("send_email", "send", "daily", 50, 3_600_000);
    const formatted = formatRateLimitError(err);
    const parsed = JSON.parse(formatted) as Record<string, unknown>;
    expect(parsed.source).toBe("mcp_safeguard");
    expect(parsed.error_type).toBe("mcp_rate_limit_daily_exceeded");
    expect(parsed.retry_after).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.hint).toContain("GMAIL_MCP_RATE_LIMIT_send");
  });

  it("formatRateLimitError marks monthly errors with the right error_type", () => {
    const err = new RateLimitError("send_email", "send", "monthly", 500, 86_400_000);
    const parsed = JSON.parse(formatRateLimitError(err)) as Record<string, unknown>;
    expect(parsed.error_type).toBe("mcp_rate_limit_monthly_exceeded");
  });
});
