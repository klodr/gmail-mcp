/**
 * Tests for security hardening added in the feat/security-hardening branch:
 *
 * - Cryptographic multipart boundary (crypto.randomBytes, not Math.random)
 * - Attachment path jail (assertAttachmentPathAllowed via createEmailWithNodemailer)
 * - Download path jail (resolveDownloadSavePath)
 * - Zod schema bounds (maxResults, batchSize, messageIds length)
 *
 * All fs operations use tmpdir with per-test mkdtemp to avoid cross-test pollution.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createEmailMessage,
  createEmailWithNodemailer,
  resolveDownloadSavePath,
  getDownloadDir,
  safeWriteFile,
  resetAttachmentDirCache,
  resetDownloadDirCache,
} from "./utl.js";
import {
  SearchEmailsSchema,
  BatchModifyEmailsSchema,
  BatchDeleteEmailsSchema,
  ListInboxThreadsSchema,
  GetInboxWithThreadsSchema,
} from "./tools.js";

describe("createEmailMessage boundary is cryptographically random", () => {
  it('uses a 32-hex-char boundary (crypto.randomBytes(16).toString("hex"))', () => {
    const args = {
      to: ["a@example.com"],
      subject: "hex boundary",
      body: "hi",
      htmlBody: "<p>hi</p>",
      mimeType: "multipart/alternative" as const,
    };
    const raw = createEmailMessage(args);
    const boundary = raw.match(/boundary="([^"]+)"/)?.[1];
    expect(boundary).toBeDefined();
    // Format: ----=_NextPart_<32 hex chars>
    expect(boundary).toMatch(/^----=_NextPart_[0-9a-f]{32}$/);
  });

  it("emits distinct boundaries across two calls (no predictable PRNG reuse)", () => {
    const args = {
      to: ["a@example.com"],
      subject: "s",
      body: "b",
      htmlBody: "<p>b</p>",
      mimeType: "multipart/alternative" as const,
    };
    const a = createEmailMessage(args).match(/boundary="([^"]+)"/)?.[1];
    const b = createEmailMessage(args).match(/boundary="([^"]+)"/)?.[1];
    expect(a).not.toBe(b);
  });
});

describe("Attachment path jail", () => {
  let jailDir: string;
  let outsideDir: string;

  beforeEach(() => {
    jailDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-attach-jail-"));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-attach-outside-"));
    process.env.GMAIL_MCP_ATTACHMENT_DIR = jailDir;
    resetAttachmentDirCache();
  });

  afterEach(() => {
    delete process.env.GMAIL_MCP_ATTACHMENT_DIR;
    resetAttachmentDirCache();
    fs.rmSync(jailDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  const baseArgs = {
    to: ["recipient@example.com"],
    subject: "attach test",
    body: "body",
  };

  it("rejects a relative attachment path", async () => {
    await expect(
      createEmailWithNodemailer({ ...baseArgs, attachments: ["relative/file.pdf"] }),
    ).rejects.toThrow(/must be absolute/);
  });

  it("rejects a non-existent file path", async () => {
    await expect(
      createEmailWithNodemailer({
        ...baseArgs,
        attachments: [path.join(jailDir, "does-not-exist.pdf")],
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it("rejects a file outside the jail (e.g. user home SSH key analogue)", async () => {
    const outsideFile = path.join(outsideDir, "id_rsa");
    fs.writeFileSync(outsideFile, "pretend-secret-key");
    await expect(
      createEmailWithNodemailer({ ...baseArgs, attachments: [outsideFile] }),
    ).rejects.toThrow(/outside the allowed directory/);
  });

  it("rejects a symlink inside the jail pointing outside (realpath escape)", async () => {
    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "sensitive");
    const symlinkInJail = path.join(jailDir, "innocent-looking.txt");
    fs.symlinkSync(outsideFile, symlinkInJail);
    await expect(
      createEmailWithNodemailer({ ...baseArgs, attachments: [symlinkInJail] }),
    ).rejects.toThrow(/outside the allowed directory/);
  });

  it("accepts a file inside the jail", async () => {
    const ok = path.join(jailDir, "letter.txt");
    fs.writeFileSync(ok, "hello");
    const raw = await createEmailWithNodemailer({ ...baseArgs, attachments: [ok] });
    expect(raw).toContain("letter.txt");
  });
});

describe("Download path jail", () => {
  let jailDir: string;
  let outsideDir: string;

  beforeEach(() => {
    jailDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-download-jail-"));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-download-outside-"));
    process.env.GMAIL_MCP_DOWNLOAD_DIR = jailDir;
    resetDownloadDirCache();
  });

  afterEach(() => {
    delete process.env.GMAIL_MCP_DOWNLOAD_DIR;
    resetDownloadDirCache();
    fs.rmSync(jailDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("rejects a relative savePath", () => {
    expect(() => resolveDownloadSavePath("relative/path")).toThrow(/must be absolute/);
  });

  it("rejects an absolute savePath outside the jail", () => {
    expect(() => resolveDownloadSavePath(outsideDir)).toThrow(/outside the allowed download/);
  });

  it("accepts the jail root itself", () => {
    const out = resolveDownloadSavePath(jailDir);
    // mkdtempSync on macOS adds /private prefix via realpath — accept either
    // direct match or realpath match.
    expect(out).toBe(fs.realpathSync(jailDir));
  });

  it("accepts a nested subdirectory and creates it with mode 0o700", () => {
    const nested = path.join(jailDir, "sub", "deep");
    expect(fs.existsSync(nested)).toBe(false);
    const out = resolveDownloadSavePath(nested);
    expect(fs.existsSync(out)).toBe(true);
    const mode = fs.statSync(out).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("safeWriteFile refuses to follow a pre-existing symlink at the leaf (O_NOFOLLOW)", () => {
    const outsideFile = path.join(outsideDir, "target.txt");
    fs.writeFileSync(outsideFile, "original");
    // Plant a symlink inside the jail pointing out — simulates a
    // race where an attacker pre-creates the target filename as a
    // symlink to a sensitive file (e.g. ~/.ssh/id_rsa). Without
    // O_NOFOLLOW, fs.writeFileSync() would follow the link and
    // truncate-overwrite the outside target.
    const evilLeaf = path.join(jailDir, "innocent-looking.pdf");
    fs.symlinkSync(outsideFile, evilLeaf);
    expect(() => safeWriteFile(evilLeaf, Buffer.from("attacker payload"))).toThrow();
    // The outside target must remain untouched (symlink was not followed)
    expect(fs.readFileSync(outsideFile, "utf-8")).toBe("original");
  });

  it("safeWriteFile creates a new file with mode 0o600 inside the jail", () => {
    const fullPath = path.join(jailDir, "fresh.txt");
    safeWriteFile(fullPath, "hello");
    expect(fs.readFileSync(fullPath, "utf-8")).toBe("hello");
    expect(fs.statSync(fullPath).mode & 0o777).toBe(0o600);
  });

  it("getDownloadDir materialises the configured dir (0o700) on first access", () => {
    // Override GMAIL_MCP_DOWNLOAD_DIR to a fresh subdir that does not
    // exist yet. On first getDownloadDir() call the helper must create
    // it and apply mode 0o700 — mirroring the cold-start behaviour a
    // user would see immediately after setting the env var.
    const fresh = path.join(jailDir, "first-boot");
    process.env.GMAIL_MCP_DOWNLOAD_DIR = fresh;
    resetDownloadDirCache();
    const dir = getDownloadDir();
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe("Zod schema bounds", () => {
  it("SearchEmailsSchema rejects maxResults > 500", () => {
    expect(() => SearchEmailsSchema.parse({ query: "x", maxResults: 501 })).toThrow();
  });

  it("SearchEmailsSchema rejects non-integer maxResults", () => {
    expect(() => SearchEmailsSchema.parse({ query: "x", maxResults: 1.5 })).toThrow();
  });

  it("SearchEmailsSchema accepts maxResults = 500", () => {
    expect(() => SearchEmailsSchema.parse({ query: "x", maxResults: 500 })).not.toThrow();
  });

  it("BatchModifyEmailsSchema rejects messageIds > 1000", () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `m${i}`);
    expect(() => BatchModifyEmailsSchema.parse({ messageIds: ids })).toThrow();
  });

  it("BatchModifyEmailsSchema rejects batchSize > 100", () => {
    expect(() => BatchModifyEmailsSchema.parse({ messageIds: ["m1"], batchSize: 500 })).toThrow();
  });

  it("BatchDeleteEmailsSchema rejects messageIds > 1000", () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `m${i}`);
    expect(() => BatchDeleteEmailsSchema.parse({ messageIds: ids })).toThrow();
  });

  it("ListInboxThreadsSchema rejects maxResults > 500", () => {
    expect(() => ListInboxThreadsSchema.parse({ maxResults: 501 })).toThrow();
  });

  it("GetInboxWithThreadsSchema caps maxResults at 100 when expandThreads is true", () => {
    // Default expandThreads=true
    expect(() => GetInboxWithThreadsSchema.parse({ maxResults: 101 })).toThrow();
    expect(() => GetInboxWithThreadsSchema.parse({ maxResults: 100 })).not.toThrow();
    // Explicit expandThreads=true
    expect(() =>
      GetInboxWithThreadsSchema.parse({ maxResults: 101, expandThreads: true }),
    ).toThrow();
  });

  it("GetInboxWithThreadsSchema allows maxResults up to 500 when expandThreads is false", () => {
    expect(() =>
      GetInboxWithThreadsSchema.parse({ maxResults: 500, expandThreads: false }),
    ).not.toThrow();
    expect(() =>
      GetInboxWithThreadsSchema.parse({ maxResults: 501, expandThreads: false }),
    ).toThrow();
    // Summary-path can exceed the expanded cap
    expect(() =>
      GetInboxWithThreadsSchema.parse({ maxResults: 200, expandThreads: false }),
    ).not.toThrow();
  });
});
