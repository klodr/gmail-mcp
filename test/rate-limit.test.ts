import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RateLimitError,
  callWeight,
  enforceRateLimit,
  formatRateLimitError,
  resetRateLimitHistory,
  _DEFAULT_BUCKET_LIMITS,
  _TOOL_BUCKET,
} from "../src/rate-limit.js";
import { readFileSync } from "node:fs";

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
    // Default is 100/day for send — must not throw on the first call
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
    // Open once and run both fstat + read via the same file descriptor
    // so CodeQL's TOCTOU check is satisfied (no window between the mode
    // check and the content read where the file could be swapped).
    const fd = openSync(statePath, "r");
    try {
      const stat = fstatSync(fd);
      // mode 0o600 = owner read/write only (0o100600 with file-type bits)
      expect(stat.mode & 0o777).toBe(0o600);
      const buf = Buffer.alloc(stat.size);
      readSync(fd, buf, 0, stat.size, 0);
      const parsed = JSON.parse(buf.toString("utf8")) as Record<string, number[]>;
      expect(parsed.send).toBeDefined();
      expect(parsed.send?.length).toBe(1);
    } finally {
      closeSync(fd);
    }
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

  it("recovers from a corrupted state file by starting fresh + warning", () => {
    const statePath = join(stateDir, "ratelimit.json");
    writeFileSync(statePath, "{ this is not valid json", { mode: 0o600 });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      process.env.GMAIL_MCP_RATE_LIMIT_send = "5/day,100/month";
      expect(() => enforceRateLimit("send_email")).not.toThrow();
      const msgs = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(msgs).toMatch(/corrupted state/i);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("does not clobber an unreadable state file (read error other than ENOENT)", () => {
    const statePath = join(stateDir, "ratelimit.json");
    // Write a valid state so we know what we expect to NOT see overwritten,
    // then make the file unreadable so the load path takes the EACCES branch.
    writeFileSync(statePath, '{"send":[1,2,3]}', { mode: 0o600 });
    chmodSync(statePath, 0o000);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      process.env.GMAIL_MCP_RATE_LIMIT_send = "5/day,100/month";
      // Must not throw — readState swallows the error and stays in
      // readOk=false mode.
      expect(() => enforceRateLimit("send_email")).not.toThrow();
      const msgs = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(msgs).toMatch(/failed to read state/i);
      // Restore perms so afterEach rmSync can clean up; check the file
      // contents were NOT clobbered (persistCallHistory should be a no-op
      // when readOk=false).
      chmodSync(statePath, 0o600);
      const fd = openSync(statePath, "r");
      try {
        const stat = fstatSync(fd);
        const buf = Buffer.alloc(stat.size);
        readSync(fd, buf, 0, stat.size, 0);
        expect(buf.toString("utf8")).toBe('{"send":[1,2,3]}');
      } finally {
        closeSync(fd);
      }
    } finally {
      try {
        chmodSync(statePath, 0o600);
      } catch {
        // already restored or gone
      }
      errSpy.mockRestore();
    }
  });

  it("logs but does not throw when persisting the state file fails", () => {
    // STATE_DIR is a read-only directory: read step takes the ENOENT
    // branch (no state file under it yet) → readOk=true → persist tries
    // to write a tmp + rename and fails with EACCES. The catch in
    // persistCallHistory must log to stderr, not throw.
    const roDir = join(stateDir, "ro");
    chmodSync(stateDir, 0o755); // ensure parent stays writable for cleanup
    // Use mkdtempSync-style by creating the dir then locking it.
    require("node:fs").mkdirSync(roDir, { mode: 0o755 });
    chmodSync(roDir, 0o500); // r-x only — writes fail with EACCES
    process.env.GMAIL_MCP_STATE_DIR = roDir;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      process.env.GMAIL_MCP_RATE_LIMIT_send = "5/day,100/month";
      expect(() => enforceRateLimit("send_email")).not.toThrow();
      const msgs = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(msgs).toMatch(/failed to persist state/i);
    } finally {
      // Restore perms so afterEach rmSync can clean up.
      chmodSync(roDir, 0o700);
      errSpy.mockRestore();
    }
  });
});

describe("rate-limit — per-message weight for batch tools", () => {
  let stateDir: string;
  const originalEnv = { ...process.env };
  const DAY = 86_400_000;
  const T0 = Date.UTC(2026, 9, 19, 8, 0, 0);

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "gmail-mcp-ratelimit-weight-"));
    process.env.GMAIL_MCP_STATE_DIR = stateDir;
    delete process.env.GMAIL_MCP_RATE_LIMIT_DISABLE;
    process.env.GMAIL_MCP_RATE_LIMIT_modify = "10/day,100/month";
    resetRateLimitHistory();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(stateDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
    resetRateLimitHistory();
  });

  const ids = (n: number): { messageIds: string[] } => ({
    messageIds: Array.from({ length: n }, (_, i) => `m${i}`),
  });

  it("weighs the batch tools by message count and everything else by 1", () => {
    expect(callWeight("batch_modify_emails", ids(250))).toBe(250);
    expect(callWeight("batch_delete_emails", ids(3))).toBe(3);
    expect(callWeight("move_to_spam_batch", ids(7))).toBe(7);
    expect(callWeight("modify_email", ids(7))).toBe(1);
    expect(callWeight("send_email", { to: ["x"] })).toBe(1);
    // Empty or malformed batches still count as one call.
    expect(callWeight("batch_modify_emails", { messageIds: [] })).toBe(1);
    expect(callWeight("batch_modify_emails", null)).toBe(1);
    expect(callWeight("batch_modify_emails", { messageIds: "m1,m2" })).toBe(1);
  });

  it("sizes the modify and delete defaults in messages", () => {
    expect(_DEFAULT_BUCKET_LIMITS.modify).toEqual({ daily: 5000, monthly: 50_000 });
    expect(_DEFAULT_BUCKET_LIMITS.delete).toEqual({ daily: 1000, monthly: 10_000 });
  });

  it("counts a batch's messages against the cap", () => {
    enforceRateLimit("batch_modify_emails", 6);
    expect(() => enforceRateLimit("batch_modify_emails", 5)).toThrow(RateLimitError);
    // 6 + 4 = 10 still fits; then the bucket is full, even for one call.
    enforceRateLimit("batch_modify_emails", 4);
    expect(() => enforceRateLimit("modify_email")).toThrow(/Daily Limit Exceeded/);
  });

  it("refuses a single batch bigger than the whole cap and says to split it", () => {
    let caught: unknown;
    try {
      enforceRateLimit("batch_modify_emails", 11);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RateLimitError);
    const err = caught as RateLimitError;
    expect(err.requested).toBe(11);
    expect(err.retryAfterMs).toBe(0);
    expect(err.message).toContain("This call alone needs 11 units");
    expect(err.message).toContain("split the batch");
    expect(formatRateLimitError(err)).toContain("one per message for batch tools");
  });

  it("derives the retry delay from the entries that must expire first", () => {
    enforceRateLimit("batch_modify_emails", 3); // at T0
    vi.setSystemTime(T0 + 3_600_000);
    enforceRateLimit("batch_modify_emails", 7); // at T0 + 1 h, bucket full
    vi.setSystemTime(T0 + 2 * 3_600_000);
    let caught: RateLimitError | undefined;
    try {
      enforceRateLimit("batch_modify_emails", 3);
    } catch (error) {
      caught = error as RateLimitError;
    }
    // Freeing the T0 entry (3 units) is enough: retry when it leaves the 24 h window.
    expect(caught?.retryAfterMs).toBe(DAY - 2 * 3_600_000);
    expect(caught?.message).toContain("Retry in ~");
  });

  it("persists a weighted call as [timestamp, weight] and reloads it", () => {
    enforceRateLimit("batch_modify_emails", 6);
    enforceRateLimit("modify_email");
    const state = JSON.parse(readFileSync(join(stateDir, "ratelimit.json"), "utf8")) as Record<
      string,
      unknown[]
    >;
    expect(state.modify).toEqual([[T0, 6], T0]);
    resetRateLimitHistory();
    // 6 + 1 recorded, 4 more would make 11 > 10.
    expect(() => enforceRateLimit("batch_modify_emails", 4)).toThrow(RateLimitError);
  });

  it("still reads a state file written in the old timestamps-only format", () => {
    writeFileSync(
      join(stateDir, "ratelimit.json"),
      JSON.stringify({ modify: Array.from({ length: 9 }, (_, i) => T0 - i * 1000) }),
    );
    resetRateLimitHistory();
    enforceRateLimit("modify_email");
    expect(() => enforceRateLimit("modify_email")).toThrow(RateLimitError);
  });

  it("drops a bucket whose entries are malformed", () => {
    writeFileSync(
      join(stateDir, "ratelimit.json"),
      JSON.stringify({ modify: [[T0, 0]], send: [[T0, 1.5]], labels: [[T0]] }),
    );
    resetRateLimitHistory();
    // The malformed modify history is ignored, so a full batch fits.
    expect(() => enforceRateLimit("batch_modify_emails", 10)).not.toThrow();
  });

  it("applies the weight to the monthly window as well", () => {
    process.env.GMAIL_MCP_RATE_LIMIT_modify = "1000/day,8/month";
    enforceRateLimit("batch_modify_emails", 5);
    vi.setSystemTime(T0 + 2 * DAY);
    expect(() => enforceRateLimit("batch_modify_emails", 4)).toThrow(/Monthly Limit Exceeded/);
    expect(() => enforceRateLimit("batch_modify_emails", 9)).toThrow(
      /This call alone needs 9 units/,
    );
    enforceRateLimit("batch_modify_emails", 3);
  });
});
