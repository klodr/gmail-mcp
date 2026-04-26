/**
 * Unit tests for the boot orchestration in `src/runtime.ts`.
 *
 * Pure helpers (`parseCallbackArg`, `parseScopesArg`,
 * `parseTimeoutMs`) are exercised directly. The full `runServer`
 * orchestration is covered on the `auth` subcommand path (which
 * exits before the stdio transport handoff) via dependency
 * injection: `argv`, `env`, `log`, `exit` are all overridable.
 *
 * The non-auth path's `transport.connect()` glue stays uncovered
 * by design — booting a real `StdioServerTransport` from a unit
 * test would deadlock waiting for the next stdio frame. Those
 * lines carry a `v8 ignore` annotation in `runtime.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TIMEOUT_MS,
  parseCallbackArg,
  parseScopesArg,
  parseTimeoutMs,
  runServer,
} from "./runtime.js";

let scratch: string;
let configDir: string;
let oauthPath: string;
let credentialsPath: string;
let logCapture: string[];

const log = (msg: string, ...rest: unknown[]) => {
  logCapture.push(
    [msg, ...rest.map((x) => (x instanceof Error ? x.message : String(x)))].join(" "),
  );
};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "gmail-mcp-runtime-test-"));
  configDir = join(scratch, ".gmail-mcp");
  oauthPath = join(configDir, "gcp-oauth.keys.json");
  credentialsPath = join(configDir, "credentials.json");
  logCapture = [];
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("parseCallbackArg", () => {
  it("returns undefined when no argv arg starts with http(s)://", () => {
    expect(parseCallbackArg(["node", "index.js", "auth"])).toBeUndefined();
    expect(parseCallbackArg([])).toBeUndefined();
    expect(parseCallbackArg(["--scopes=gmail.readonly"])).toBeUndefined();
  });

  it("returns the first http:// arg verbatim (loopback callback)", () => {
    const arg = "http://localhost:8080/oauth2callback";
    expect(parseCallbackArg(["node", "index.js", "auth", arg])).toBe(arg);
  });

  it("also matches https:// (loopback HTTPS — rejected later by authenticate, but parse is lenient)", () => {
    // Defensive: parsing accepts the protocol, the validation in
    // `authenticate` enforces http://-only. Pinning the parser as a
    // pass-through means we surface a helpful "https not supported"
    // error at the validation layer instead of silently dropping
    // the URL here.
    const arg = "https://localhost:443/oauth2callback";
    expect(parseCallbackArg(["node", "index.js", "auth", arg])).toBe(arg);
  });

  it("picks the first match when multiple URLs are present", () => {
    expect(
      parseCallbackArg([
        "node",
        "index.js",
        "auth",
        "http://localhost:3000/cb",
        "http://localhost:9999/other",
      ]),
    ).toBe("http://localhost:3000/cb");
  });
});

describe("parseScopesArg", () => {
  it("returns DEFAULT_SCOPES + flagPresent=false when no --scopes flag", () => {
    const result = parseScopesArg(["node", "index.js", "auth"]);
    expect(result.flagPresent).toBe(false);
    expect(result.valid).toBe(true);
    expect(result.invalid).toEqual([]);
    expect(result.scopes.length).toBeGreaterThan(0); // DEFAULT_SCOPES non-empty
  });

  it("parses a single valid scope from --scopes=", () => {
    const result = parseScopesArg(["node", "index.js", "auth", "--scopes=gmail.readonly"]);
    expect(result.flagPresent).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.invalid).toEqual([]);
    expect(result.scopes).toEqual(["gmail.readonly"]);
  });

  it("parses multiple comma-separated scopes", () => {
    const result = parseScopesArg([
      "node",
      "index.js",
      "auth",
      "--scopes=gmail.readonly,gmail.settings.basic",
    ]);
    expect(result.scopes).toEqual(["gmail.readonly", "gmail.settings.basic"]);
    expect(result.valid).toBe(true);
  });

  it("flags invalid shorthand scope names", () => {
    const result = parseScopesArg([
      "node",
      "index.js",
      "auth",
      "--scopes=gmail.notarealscope,gmail.readonly",
    ]);
    expect(result.flagPresent).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.invalid).toContain("gmail.notarealscope");
  });
});

describe("parseTimeoutMs", () => {
  it("returns DEFAULT_TIMEOUT_MS (60_000) when env var is undefined", () => {
    expect(parseTimeoutMs(undefined, log)).toBe(DEFAULT_TIMEOUT_MS);
    expect(logCapture).toEqual([]); // no warning emitted
  });

  it("returns the parsed integer when raw is a positive integer", () => {
    expect(parseTimeoutMs("30000", log)).toBe(30_000);
    expect(parseTimeoutMs("1", log)).toBe(1);
    expect(parseTimeoutMs("120000", log)).toBe(120_000);
    expect(logCapture).toEqual([]);
  });

  it("falls back to DEFAULT_TIMEOUT_MS + warns on a negative value", () => {
    expect(parseTimeoutMs("-1000", log)).toBe(DEFAULT_TIMEOUT_MS);
    expect(logCapture.join("\n")).toContain('Invalid GMAIL_MCP_TIMEOUT_MS="-1000"');
    expect(logCapture.join("\n")).toContain("must be a positive integer");
  });

  it("falls back to DEFAULT_TIMEOUT_MS + warns on zero", () => {
    expect(parseTimeoutMs("0", log)).toBe(DEFAULT_TIMEOUT_MS);
    expect(logCapture.join("\n")).toContain('Invalid GMAIL_MCP_TIMEOUT_MS="0"');
  });

  it("falls back to DEFAULT_TIMEOUT_MS + warns on a decimal", () => {
    // Number.isInteger("30.5") → false → fallback
    expect(parseTimeoutMs("30.5", log)).toBe(DEFAULT_TIMEOUT_MS);
    expect(logCapture.join("\n")).toContain('Invalid GMAIL_MCP_TIMEOUT_MS="30.5"');
  });

  it("falls back to DEFAULT_TIMEOUT_MS + warns on a non-numeric string", () => {
    expect(parseTimeoutMs("not-a-number", log)).toBe(DEFAULT_TIMEOUT_MS);
    expect(logCapture.join("\n")).toContain('Invalid GMAIL_MCP_TIMEOUT_MS="not-a-number"');
  });

  it("falls back to DEFAULT_TIMEOUT_MS + warns on the empty string", () => {
    // `Number("")` returns 0 — caught by the > 0 guard.
    expect(parseTimeoutMs("", log)).toBe(DEFAULT_TIMEOUT_MS);
    expect(logCapture.join("\n")).toContain('Invalid GMAIL_MCP_TIMEOUT_MS=""');
  });
});

describe("runServer auth subcommand", () => {
  /**
   * The auth subcommand path exits BEFORE reaching the stdio
   * transport handoff, so it's the cleanest end-to-end orchestration
   * exercise reachable from a unit test. Tests stub `exit` to throw
   * a sentinel + drive the auth flow to a clean refusal (lazy-boot
   * "no OAuth keys" path) so we never hit Google.
   */
  function expectExit(opts: {
    argv: readonly string[];
    env: NodeJS.ProcessEnv;
    expectedCode: number;
  }): Promise<{ caughtCode: number; logs: string }> {
    return new Promise((resolve) => {
      const exitCalls: number[] = [];
      const exitFn = (code: number): never => {
        exitCalls.push(code);
        throw new Error(`__exit_${code}__`);
      };
      runServer({ argv: opts.argv, env: opts.env, log, exit: exitFn }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.startsWith("__exit_")) {
          throw err;
        }
        resolve({ caughtCode: exitCalls[0]!, logs: logCapture.join("\n") });
      });
    });
  }

  it("exits with code 1 when --scopes contains an invalid shorthand", async () => {
    const { caughtCode, logs } = await expectExit({
      argv: ["node", "index.js", "auth", "--scopes=gmail.notarealscope"],
      env: { GMAIL_OAUTH_PATH: oauthPath, GMAIL_CREDENTIALS_PATH: credentialsPath },
      expectedCode: 1,
    });
    expect(caughtCode).toBe(1);
    expect(logs).toContain("Invalid scope(s)");
    expect(logs).toContain("gmail.notarealscope");
  });

  it("exits with code 1 when auth runs without OAuth keys present (lazy-boot)", async () => {
    // Env vars point at a non-existent OAUTH_PATH so loadCredentials
    // returns the lazy-boot stub — `oauthCallbackUrl` is undefined.
    // runServer must refuse to start the auth flow with a clear
    // diagnostic instead of silently no-op'ing or crashing.
    const { caughtCode, logs } = await expectExit({
      argv: ["node", "index.js", "auth"],
      env: { GMAIL_OAUTH_PATH: oauthPath, GMAIL_CREDENTIALS_PATH: credentialsPath },
      expectedCode: 1,
    });
    expect(caughtCode).toBe(1);
    expect(logs).toContain("Cannot run `auth` without OAuth keys");
    // The "no --scopes flag, using defaults" diagnostic also fires —
    // confirms the scope branch ran before the lazy-boot refusal.
    expect(logs).toContain("No --scopes flag specified");
  });

  it("logs the no-flag diagnostics + lists available scopes when --scopes is omitted", async () => {
    // Same env as above (lazy-boot triggers exit(1) cleanly), so we
    // can assert the no-flag UX without spinning a real auth flow.
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const { logs } = await expectExit({
      argv: ["node", "index.js", "auth"],
      env: { GMAIL_OAUTH_PATH: oauthPath, GMAIL_CREDENTIALS_PATH: credentialsPath },
      expectedCode: 1,
    });
    expect(logs).toContain("No --scopes flag specified, using defaults");
    expect(logs).toContain("Tip: Use --scopes=gmail.readonly for read-only access");
    expect(logs).toContain("Available scopes:");
  });

  it("threads a positional callback URL through to loadCredentials", async () => {
    // Hydrate a real OAuth keys file so loadCredentials returns a
    // real OAuth2Client (not the lazy-boot stub) and the callback
    // URL is honoured. The auth flow then reaches the
    // `authenticate(...)` call — which we don't want to actually
    // run — so we rely on a port-binding failure to exit (port 1
    // is privileged, fails the `port < 1024` validation in
    // authenticate). We pass a privileged-port callback in the
    // positional arg to trigger that path.
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(oauthPath, JSON.stringify({ installed: { client_id: "x", client_secret: "y" } }));
    let caughtErr: Error | undefined;
    const exitFn = (code: number): never => {
      throw new Error(`__exit_${code}__`);
    };
    await runServer({
      argv: [
        "node",
        "index.js",
        "auth",
        "http://localhost:1023/oauth2callback",
        "--scopes=gmail.readonly",
      ],
      env: { GMAIL_OAUTH_PATH: oauthPath, GMAIL_CREDENTIALS_PATH: credentialsPath },
      log,
      exit: exitFn,
    }).catch((err: unknown) => {
      caughtErr = err instanceof Error ? err : new Error(String(err));
    });
    // Should have rejected via authenticate's port < 1024 guard,
    // confirming the positional callback URL was threaded through
    // loadCredentials → authenticate. The port-validation guard
    // fires BEFORE listen, so no "Requesting scopes" log is
    // emitted; the precise port-1023 error message is the proof.
    expect(caughtErr?.message).toMatch(/Callback port '1023' is invalid/);
  });
});
