/**
 * Regression tests for the test-state isolation:
 *   - `test/isolate-state.setup.ts` points every state override at a
 *     temporary directory before each test file;
 *   - `src/state-guard.ts` refuses, under vitest, every write that still
 *     resolves into the default `~/.gmail-mcp/`, `~/GmailDownloads/` or
 *     `~/GmailAttachments/`.
 *
 * Every test runs with `HOME` pointed at a scratch directory, so even a
 * broken guard could only write there — never into the real home of the
 * person running the suite. Each test that triggers the guard drains the
 * refusals it expects with `takeRefusedDefaultStateWrites()`; anything
 * left over fails the test in the setup file's `afterEach`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os, { tmpdir } from "node:os";
import path, { join } from "node:path";
import { OAuth2Client } from "google-auth-library";
import {
  assertNotDefaultStateUnderTest,
  DefaultStateWriteError,
  takeRefusedDefaultStateWrites,
} from "../src/state-guard.js";
import { enforceRateLimit, resetRateLimitHistory } from "../src/rate-limit.js";
import { addPairedAddress } from "../src/recipient-pairing.js";
import { getDownloadDirectory, resetJailDirectoryCache, safeWriteFile } from "../src/utl.js";
import { logAudit } from "../src/audit-log.js";
import { authenticate, loadCredentials } from "../src/oauth-flow.js";

// Addresses are built at runtime: the leak scan rejects literal
// addresses added in a diff (existing fixtures interpolate too).
const mail = (user: string): string => `${user}@example.com`;

const STATE_ENV = [
  "GMAIL_MCP_STATE_DIR",
  "GMAIL_MCP_PAIRED_PATH",
  "GMAIL_OAUTH_PATH",
  "GMAIL_CREDENTIALS_PATH",
  "GMAIL_MCP_DOWNLOAD_DIR",
  "GMAIL_MCP_ATTACHMENT_DIR",
] as const;

/** The account's passwd home, or null when the uid has none (some containers). */
function passwdHome(): string | null {
  try {
    return os.userInfo().homedir;
  } catch {
    return null;
  }
}

function isInside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

let fakeHome: string;
let scratch: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "gmail-mcp-fake-home-"));
  scratch = mkdtempSync(join(tmpdir(), "gmail-mcp-guard-scratch-"));
  vi.stubEnv("HOME", fakeHome);
  vi.stubEnv("USERPROFILE", fakeHome);
  vi.stubEnv("GMAIL_MCP_RATE_LIMIT_DISABLE", undefined);
  // Precondition: the default locations now resolve under the scratch
  // home. If `HOME` could not be redirected, stop here rather than run
  // writers whose default would be the real home.
  expect(path.resolve(os.homedir())).toBe(path.resolve(fakeHome));
  resetRateLimitHistory();
  resetJailDirectoryCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetRateLimitHistory();
  resetJailDirectoryCache();
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

describe("test/isolate-state.setup.ts", () => {
  it("points every state override at a temporary directory, away from the defaults", () => {
    for (const key of STATE_ENV) {
      const value = process.env[key];
      expect(value, key).toBeTruthy();
      expect(isInside(path.resolve(value ?? ""), path.resolve(tmpdir())), key).toBe(true);
      // Not a default state location of the account (`tmpdir()` itself
      // may sit under the home, e.g. `AppData\Local\Temp` on Windows).
      expect(() => {
        assertNotDefaultStateUnderTest(value ?? "", key);
      }, key).not.toThrow();
    }
    expect(takeRefusedDefaultStateWrites()).toEqual([]);
  });

  it("removes an inherited GMAIL_MCP_AUDIT_LOG", () => {
    expect(process.env.GMAIL_MCP_AUDIT_LOG).toBeUndefined();
  });
});

describe("assertNotDefaultStateUnderTest", () => {
  it.each([
    [".gmail-mcp"],
    [".gmail-mcp/ratelimit.json"],
    [".gmail-mcp/paired.json"],
    [".gmail-mcp/credentials.json"],
    ["GmailDownloads"],
    ["GmailDownloads/sub/file.eml"],
    ["GmailAttachments/report.pdf"],
  ])("refuses ~/%s and records the refusal", (relative) => {
    const target = join(fakeHome, relative);
    expect(() => {
      assertNotDefaultStateUnderTest(target, "GMAIL_MCP_STATE_DIR");
    }).toThrow(DefaultStateWriteError);
    const refused = takeRefusedDefaultStateWrites();
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain(path.resolve(target));
    expect(refused[0]).toContain("GMAIL_MCP_STATE_DIR");
    // The list is drained by the read.
    expect(takeRefusedDefaultStateWrites()).toEqual([]);
  });

  it.each([
    [".gmail-mcp-backup/ratelimit.json"],
    [".gmail-mcpx"],
    ["GmailDownloadsOld/file.eml"],
    ["Documents/ratelimit.json"],
    [""],
  ])("allows ~/%s (not a default state location)", (relative) => {
    expect(() => {
      assertNotDefaultStateUnderTest(join(fakeHome, relative), "GMAIL_MCP_STATE_DIR");
    }).not.toThrow();
    expect(takeRefusedDefaultStateWrites()).toEqual([]);
  });

  it("allows a temporary directory", () => {
    expect(() => {
      assertNotDefaultStateUnderTest(join(scratch, "ratelimit.json"), "GMAIL_MCP_STATE_DIR");
    }).not.toThrow();
    expect(takeRefusedDefaultStateWrites()).toEqual([]);
  });

  it.skipIf(passwdHome() === null)(
    "refuses the account's real home even when HOME points elsewhere",
    () => {
      const target = join(passwdHome() ?? "", ".gmail-mcp", "ratelimit.json");
      expect(() => {
        assertNotDefaultStateUnderTest(target, "GMAIL_MCP_STATE_DIR");
      }).toThrow(DefaultStateWriteError);
      expect(takeRefusedDefaultStateWrites()).toHaveLength(1);
    },
  );

  it("still guards $HOME when the account has no passwd entry", () => {
    vi.spyOn(os, "userInfo").mockImplementation(() => {
      throw new Error("ENOENT: no passwd entry for the uid");
    });
    expect(() => {
      assertNotDefaultStateUnderTest(join(fakeHome, ".gmail-mcp"), "GMAIL_MCP_STATE_DIR");
    }).toThrow(DefaultStateWriteError);
    expect(takeRefusedDefaultStateWrites()).toHaveLength(1);
  });

  it("is a no-op outside vitest (production behaviour unchanged)", () => {
    const vitest = process.env.VITEST;
    vi.stubEnv("VITEST", undefined);
    try {
      expect(() => {
        assertNotDefaultStateUnderTest(join(fakeHome, ".gmail-mcp", "ratelimit.json"), "X");
      }).not.toThrow();
    } finally {
      vi.stubEnv("VITEST", vitest);
    }
    expect(takeRefusedDefaultStateWrites()).toEqual([]);
  });
});

describe("writers refuse the default state under vitest", () => {
  it("rate limiter: no ratelimit.json in ~/.gmail-mcp when GMAIL_MCP_STATE_DIR is unset", () => {
    vi.stubEnv("GMAIL_MCP_STATE_DIR", undefined);
    expect(() => {
      enforceRateLimit("send_email");
    }).toThrow(DefaultStateWriteError);
    expect(existsSync(join(fakeHome, ".gmail-mcp"))).toBe(false);
    expect(takeRefusedDefaultStateWrites()).toEqual([
      expect.stringContaining(join(fakeHome, ".gmail-mcp", "ratelimit.json")),
    ]);
  });

  it("rate limiter: an override pointing at ~/.gmail-mcp is refused too", () => {
    vi.stubEnv("GMAIL_MCP_STATE_DIR", join(fakeHome, ".gmail-mcp"));
    expect(() => {
      enforceRateLimit("draft_email");
    }).toThrow(DefaultStateWriteError);
    expect(existsSync(join(fakeHome, ".gmail-mcp"))).toBe(false);
    expect(takeRefusedDefaultStateWrites()).toHaveLength(1);
  });

  it("rate limiter: a temporary GMAIL_MCP_STATE_DIR is written as usual", () => {
    vi.stubEnv("GMAIL_MCP_STATE_DIR", scratch);
    enforceRateLimit("send_email");
    expect(existsSync(join(scratch, "ratelimit.json"))).toBe(true);
    expect(takeRefusedDefaultStateWrites()).toEqual([]);
  });

  it("paired recipients: no paired.json in ~/.gmail-mcp when GMAIL_MCP_PAIRED_PATH is unset", () => {
    vi.stubEnv("GMAIL_MCP_PAIRED_PATH", undefined);
    expect(() => addPairedAddress(mail("alice"))).toThrow(DefaultStateWriteError);
    expect(existsSync(join(fakeHome, ".gmail-mcp"))).toBe(false);
    expect(takeRefusedDefaultStateWrites()).toHaveLength(1);
  });

  it("download jail: ~/GmailDownloads is not created when GMAIL_MCP_DOWNLOAD_DIR is unset", () => {
    vi.stubEnv("GMAIL_MCP_DOWNLOAD_DIR", undefined);
    expect(() => getDownloadDirectory()).toThrow(DefaultStateWriteError);
    expect(existsSync(join(fakeHome, "GmailDownloads"))).toBe(false);
    expect(takeRefusedDefaultStateWrites()).toHaveLength(1);
  });

  it("safeWriteFile: refuses a file inside ~/GmailDownloads", () => {
    mkdirSync(join(fakeHome, "GmailDownloads"), { recursive: true });
    const target = join(fakeHome, "GmailDownloads", "message.eml");
    expect(() => safeWriteFile(target, `From: ${mail("a")}\r\n`)).toThrow(DefaultStateWriteError);
    expect(existsSync(target)).toBe(false);
    expect(takeRefusedDefaultStateWrites()).toHaveLength(1);
  });

  it("audit log: an inherited GMAIL_MCP_AUDIT_LOG in ~/.gmail-mcp is not appended to", () => {
    mkdirSync(join(fakeHome, ".gmail-mcp"), { recursive: true });
    const auditPath = join(fakeHome, ".gmail-mcp", "audit.jsonl");
    vi.stubEnv("GMAIL_MCP_AUDIT_LOG", auditPath);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // logAudit keeps its never-throw contract…
    expect(() => {
      logAudit("send_email", { to: mail("a") }, "ok");
    }).not.toThrow();
    expect(existsSync(auditPath)).toBe(false);
    // …but the refusal is recorded, so the setup file fails a test that
    // writes there by mistake.
    expect(takeRefusedDefaultStateWrites()).toEqual([expect.stringContaining(auditPath)]);
  });

  it("OAuth: loadCredentials does not create ~/.gmail-mcp", () => {
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit ${String(code)}`);
    });
    const configDir = join(fakeHome, ".gmail-mcp");
    expect(() =>
      loadCredentials({
        oauthPath: join(configDir, "gcp-oauth.keys.json"),
        credentialsPath: join(configDir, "credentials.json"),
        configDir,
        skipConfigDirCreate: false,
        log: () => undefined,
        exitOnInvalidKeys: exit,
      }),
    ).toThrow(DefaultStateWriteError);
    // Surfaced to the test, not turned into an exit of the worker.
    expect(exit).not.toHaveBeenCalled();
    expect(existsSync(configDir)).toBe(false);
    expect(takeRefusedDefaultStateWrites()).toHaveLength(1);
  });

  it("OAuth: the auth key import does not copy into ~/.gmail-mcp", () => {
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit ${String(code)}`);
    });
    const localKeys = join(scratch, "gcp-oauth.keys.json");
    writeFileSync(
      localKeys,
      JSON.stringify({ installed: { client_id: "id", client_secret: "s" } }),
    );
    const oauthPath = join(fakeHome, ".gmail-mcp", "gcp-oauth.keys.json");
    expect(() =>
      loadCredentials({
        oauthPath,
        credentialsPath: join(scratch, "credentials.json"),
        configDir: join(scratch, "config"),
        skipConfigDirCreate: true,
        importLocalKeys: true,
        localOAuthPath: localKeys,
        log: () => undefined,
        exitOnInvalidKeys: exit,
      }),
    ).toThrow(DefaultStateWriteError);
    // Surfaced to the test, not turned into an exit of the worker.
    expect(exit).not.toHaveBeenCalled();
    expect(existsSync(oauthPath)).toBe(false);
    expect(takeRefusedDefaultStateWrites()).toHaveLength(1);
  });

  it("OAuth: authenticate does not write credentials.json into ~/.gmail-mcp", async () => {
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as { port: number };
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const callbackUrl = `http://127.0.0.1:${String(port)}/oauth2callback`;
    const client = new OAuth2Client("id-test", "secret-test", callbackUrl);
    (client as unknown as { getToken: () => Promise<unknown> }).getToken = () =>
      Promise.resolve({ tokens: { access_token: "at", refresh_token: "rt" } });
    const credentialsPath = join(fakeHome, ".gmail-mcp", "credentials.json");

    let caught: unknown;
    const flow = authenticate({
      oauth2Client: client,
      oauthCallbackUrl: callbackUrl,
      scopes: ["gmail.readonly"],
      credentialsPath,
      openBrowser: () => undefined,
      log: () => undefined,
      generateState: () => "state-token",
    }).catch((error: unknown) => {
      caught = error;
    });
    const response = await fetch(`${callbackUrl}?code=auth-code&state=state-token`);
    expect(response.status).toBe(500);
    await flow;
    expect(caught).toBeInstanceOf(DefaultStateWriteError);
    expect(existsSync(join(fakeHome, ".gmail-mcp"))).toBe(false);
    expect(takeRefusedDefaultStateWrites()).toHaveLength(1);
  });
});
