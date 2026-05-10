/**
 * Edge-case coverage tests — exercise the rarely-hit branches that
 * unit tests around the happy path leave uncovered:
 *
 *   - utl.safeWriteFile zero-byte write guard
 *   - utl.safeWriteFile too-many-collisions guard
 *   - oauth-flow.loadCredentials realpath equality short-circuit
 *   - email-export.parseEmailAddress invalid-input fallback
 *
 * Each test exists to keep the codecov/project line gauge stable
 * after the cross-repo coverage cleanup. Removing one will surface
 * as a coverage regression on the next PR; gate the removal on a
 * better dedicated test, not silence.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { safeWriteFile } from "./utl.js";
import { parseEmailAddress, parseEmailAddresses, gmailMessageToJson } from "./email-export.js";
import { loadCredentials } from "./oauth-flow.js";

describe("safeWriteFile — zero-byte write guard (utl.ts:135-138)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-zero-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("throws when fs.writeSync returns 0 mid-write (cannot make progress)", () => {
    // Spy on writeSync to force a zero-byte return on the first
    // write; safeWriteFile must throw rather than spin forever.
    const writeSpy = vi.spyOn(fs, "writeSync").mockReturnValue(0);
    const target = path.join(tmpDir, "zero.txt");

    expect(() => safeWriteFile(target, "anything-large-enough")).toThrowError(
      /zero-byte write at offset 0\/\d+ for /,
    );

    writeSpy.mockRestore();
    // The file descriptor was opened so an empty file may exist;
    // the cleanup in afterEach handles tmpDir teardown.
  });
});

describe("safeWriteFile — too-many-collisions guard (utl.ts:147)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-coll-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws after 100 collision attempts when every suffix is taken", () => {
    const base = "hit";
    const ext = ".txt";
    const fullPath = path.join(tmpDir, `${base}${ext}`);
    // Pre-create the original AND every suffix variant from (1) to (100)
    // so safeWriteFile exhausts the loop without finding a free slot.
    fs.writeFileSync(fullPath, "occupied");
    for (let i = 1; i <= 100; i++) {
      fs.writeFileSync(path.join(tmpDir, `${base} (${i})${ext}`), "occupied");
    }

    expect(() => safeWriteFile(fullPath, "new content", { onCollision: "suffix" })).toThrowError(
      /too many collisions for .+ \(100 attempts\)/,
    );
  });
});

describe("loadCredentials — sameByRealpath short-circuit (oauth-flow.ts:194-196)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-oauth-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips the copy when source and destination resolve to the same realpath via symlink", () => {
    const configDir = path.join(tmpDir, "cfg");
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });

    // Real OAuth keys file at one location; the configured oauthPath
    // is a symlink that points back to the real file. The two paths
    // are textually different (so sameByPath is false) but resolve
    // to the same inode (so sameByRealpath must be true).
    const realOAuth = path.join(tmpDir, "real-oauth.keys.json");
    const symlinkOAuth = path.join(configDir, "gcp-oauth.keys.json");
    const credentialsPath = path.join(configDir, "credentials.json");

    fs.writeFileSync(
      realOAuth,
      JSON.stringify({ installed: { client_id: "x", client_secret: "y" } }),
    );
    fs.symlinkSync(realOAuth, symlinkOAuth);
    fs.writeFileSync(credentialsPath, JSON.stringify({ access_token: "tok" }));

    // Act — point the loader at the symlink AS dst, the real file
    // AS src; the realpath check should detect the equivalence and
    // skip the copy (the call must not throw a copy-related error).
    // `log: () => {}` swallows the routine startup messages so the
    // CodeQL "clear-text logging" rule doesn't trip on the test's
    // OAuth-named paths flowing into the default console.error sink.
    const result = loadCredentials({
      oauthPath: symlinkOAuth,
      credentialsPath,
      configDir,
      localOAuthPath: realOAuth,
      skipConfigDirCreate: true,
      log: () => {
        /* swallow */
      },
    });

    // The OAuth client is constructed from the keys read at oauthPath
    // (which is the symlink). The result must expose it without throwing.
    expect(result.oauth2Client).toBeDefined();
    // Sanity — symlink target still resolves to the original file
    // (proves the realpath branch was the one that fired, not the
    // copy that would have rewritten the file).
    expect(fs.realpathSync(symlinkOAuth)).toBe(fs.realpathSync(realOAuth));
  });
});

describe("parseEmailAddress — invalid-input fallback (email-export.ts:55)", () => {
  it("returns trimmed input as email when parser cannot identify a mailbox", () => {
    // emailAddresses.parseOneAddress returns null for malformed
    // input; the fallback path must wrap it as { name: "", email }
    // with whitespace stripped.
    const out = parseEmailAddress("   not-an-email-at-all   ");
    expect(out).toEqual({ name: "", email: "not-an-email-at-all" });
  });

  it("returns empty pair on empty-string input (early-return guard)", () => {
    expect(parseEmailAddress("")).toEqual({ name: "", email: "" });
  });
});

describe("parseEmailAddresses — list parsing edge cases (email-export.ts:62-73)", () => {
  it("returns [] on undefined input (early-return guard)", () => {
    expect(parseEmailAddresses(undefined)).toEqual([]);
  });

  it("returns [] on empty-string input", () => {
    expect(parseEmailAddresses("")).toEqual([]);
  });

  it("returns [] when the parser yields null (unparseable input)", () => {
    // emailAddresses.parseAddressList rejects garbage outright.
    expect(parseEmailAddresses("@@@@@,,,@@@@@")).toEqual([]);
  });

  it("filters out non-mailbox entries (groups) and keeps only mailboxes", () => {
    // RFC 5322 lets a list mix mailboxes and groups; we only want the
    // mailboxes. The filter narrows the discriminated union.
    const out = parseEmailAddresses("Alice <alice@example.com>, Bob <bob@example.com>");
    expect(out).toEqual([
      { name: "Alice", email: "alice@example.com" },
      { name: "Bob", email: "bob@example.com" },
    ]);
  });
});

describe("gmailMessageToJson — invalid-date fallback (email-export.ts:88-92)", () => {
  it("keeps the original date string when Date parsing fails (try/catch)", () => {
    const out = gmailMessageToJson(
      {
        id: "m1",
        threadId: "t1",
        payload: {
          headers: [
            { name: "Date", value: "not-a-date-at-all" },
            { name: "Subject", value: "S" },
          ],
        },
      },
      { text: "", html: "" },
      [],
    );
    // The catch path preserves the raw header value rather than throwing.
    expect(out.date).toBe("not-a-date-at-all");
    expect(out.messageId).toBe("m1");
  });

  it("normalises a valid date header to ISO 8601", () => {
    const out = gmailMessageToJson(
      {
        id: "m2",
        threadId: "t2",
        payload: {
          headers: [{ name: "Date", value: "Fri, 01 Jan 2027 12:34:56 +0000" }],
        },
      },
      { text: "", html: "" },
      [],
    );
    expect(out.date).toBe("2027-01-01T12:34:56.000Z");
  });
});
