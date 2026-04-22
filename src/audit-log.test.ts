import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SENSITIVE_KEYS, logAudit, redactSensitive } from "./audit-log.js";

describe("audit-log redactSensitive", () => {
  it("redacts OAuth token keys case-insensitively", () => {
    const input = {
      access_token: "ya29.abc",
      refresh_token: "1//xyz",
      ID_TOKEN: "eyJhbGc...",
      client_secret: "GOCSPX-...",
    };
    const out = redactSensitive(input) as Record<string, unknown>;
    expect(out.access_token).toBe("[REDACTED]");
    expect(out.refresh_token).toBe("[REDACTED]");
    expect(out.ID_TOKEN).toBe("[REDACTED]");
    expect(out.client_secret).toBe("[REDACTED]");
  });

  it("redacts nested sensitive keys", () => {
    const input = { outer: { inner: { access_token: "secret" } } };
    const out = redactSensitive(input) as Record<string, unknown>;
    const outer = out.outer as Record<string, unknown>;
    const inner = outer.inner as Record<string, unknown>;
    expect(inner.access_token).toBe("[REDACTED]");
  });

  it("redacts sensitive keys inside arrays", () => {
    const input = { items: [{ credentials: "x" }, { credentials: "y" }] };
    const out = redactSensitive(input) as Record<string, unknown>;
    const items = out.items as Array<Record<string, unknown>>;
    expect(items[0]?.credentials).toBe("[REDACTED]");
    expect(items[1]?.credentials).toBe("[REDACTED]");
  });

  it("elides body/htmlBody strings with length marker", () => {
    const body =
      "This is a 100-character email body padding padding padding padding padding padding padding padding";
    const input = { to: ["a@b.com"], subject: "hi", body, htmlBody: "<p>x</p>" };
    const out = redactSensitive(input) as Record<string, unknown>;
    expect(out.to).toEqual(["a@b.com"]);
    expect(out.subject).toBe("hi");
    expect(out.body).toMatch(/^\[ELIDED:\d+ chars\]$/);
    expect(out.htmlBody).toMatch(/^\[ELIDED:\d+ chars\]$/);
  });

  it("elides attachments arrays with length marker", () => {
    const input = { attachments: ["/tmp/a.pdf", "/tmp/b.pdf"] };
    const out = redactSensitive(input) as Record<string, unknown>;
    expect(out.attachments).toBe("[ELIDED:2 items]");
  });

  it("leaves non-sensitive fields intact", () => {
    const input = { to: ["x@y.com"], subject: "ok", threadId: "abc123" };
    const out = redactSensitive(input) as Record<string, unknown>;
    expect(out).toEqual(input);
  });

  it("handles primitives and null without throwing", () => {
    expect(redactSensitive(null)).toBeNull();
    expect(redactSensitive("plain string")).toBe("plain string");
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive(undefined)).toBeUndefined();
  });

  it("SENSITIVE_KEYS is frozen", () => {
    expect(Object.isFrozen(SENSITIVE_KEYS)).toBe(true);
  });
});

describe("audit-log logAudit", () => {
  let tmpDir: string;
  const originalEnv = process.env.GMAIL_MCP_AUDIT_LOG;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gmail-mcp-audit-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.GMAIL_MCP_AUDIT_LOG;
    else process.env.GMAIL_MCP_AUDIT_LOG = originalEnv;
  });

  it("is a no-op when GMAIL_MCP_AUDIT_LOG is unset", () => {
    delete process.env.GMAIL_MCP_AUDIT_LOG;
    logAudit("send_email", { to: ["a@b.com"] }, "ok");
    // Nothing to assert other than "does not throw"
  });

  it("refuses relative paths and warns instead of writing", () => {
    process.env.GMAIL_MCP_AUDIT_LOG = "relative/path.jsonl";
    // Will hit console.error but must not create a file nor throw
    logAudit("send_email", {}, "ok");
  });

  it("writes a JSONL entry with mode 0o600 when given an absolute path", () => {
    const path = join(tmpDir, "audit.jsonl");
    process.env.GMAIL_MCP_AUDIT_LOG = path;
    logAudit("send_email", { to: ["a@b.com"], access_token: "secret" }, "ok");
    // Open once and run both fstat + read via the same file descriptor
    // so CodeQL's TOCTOU check is satisfied (no window between the mode
    // check and the content read where the file could be swapped).
    const fd = openSync(path, "r");
    let content: string;
    try {
      const stat = fstatSync(fd);
      expect(stat.mode & 0o777).toBe(0o600);
      const buf = Buffer.alloc(stat.size);
      readSync(fd, buf, 0, stat.size, 0);
      content = buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
    const entries = content.trim().split("\n");
    expect(entries).toHaveLength(1);
    const first = entries[0];
    expect(first).toBeDefined();
    const entry = JSON.parse(first as string) as Record<string, unknown>;
    expect(entry.tool).toBe("send_email");
    expect(entry.result).toBe("ok");
    expect((entry.args as Record<string, unknown>).access_token).toBe("[REDACTED]");
    expect((entry.args as Record<string, unknown>).to).toEqual(["a@b.com"]);
    expect(typeof entry.ts).toBe("string");
  });

  it("appends subsequent calls as new lines", () => {
    const path = join(tmpDir, "audit.jsonl");
    process.env.GMAIL_MCP_AUDIT_LOG = path;
    logAudit("send_email", { to: ["a@b.com"] }, "ok");
    logAudit("delete_email", { messageId: "m1" }, "error");
    logAudit("send_email", { to: ["c@d.com"] }, "rate_limited");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed[0]?.result).toBe("ok");
    expect(parsed[1]?.result).toBe("error");
    expect(parsed[2]?.result).toBe("rate_limited");
  });
});
