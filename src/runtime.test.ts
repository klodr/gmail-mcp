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
    return new Promise((resolve, reject) => {
      const exitCalls: number[] = [];
      const exitFn = (code: number): never => {
        exitCalls.push(code);
        throw new Error(`__exit_${code}__`);
      };
      runServer({ argv: opts.argv, env: opts.env, log, exit: exitFn }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        // CR finding: if an unexpected (non-sentinel) error fires,
        // `throw err` inside this `.catch` becomes an unhandled
        // rejection on the inner promise — the OUTER Promise stays
        // pending forever and the test hangs silently. Calling
        // `reject(err)` instead surfaces the unexpected failure
        // through the test's `await expectExit(...)`.
        if (!msg.startsWith("__exit_")) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
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

  it("threads a positional callback URL through loadCredentials → authenticate, then exits via the injected handler", async () => {
    // Hydrate a real OAuth keys file so loadCredentials returns a
    // real OAuth2Client (not the lazy-boot stub) and the callback
    // URL is honoured. The auth flow then reaches the
    // `authenticate(...)` call — which we don't want to actually
    // run — so we rely on a port-validation failure (port 1023 is
    // privileged, fails the `port < 1024` guard in authenticate).
    // The CR-Major fix wraps authenticate in try/catch + `exit(1)`,
    // so the rejection is now caught inside runServer and the
    // INJECTED exit fires with the diagnostic in the log capture.
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(oauthPath, JSON.stringify({ installed: { client_id: "x", client_secret: "y" } }));
    const { caughtCode, logs } = await expectExit({
      argv: [
        "node",
        "index.js",
        "auth",
        "http://localhost:1023/oauth2callback",
        "--scopes=gmail.readonly",
      ],
      env: { GMAIL_OAUTH_PATH: oauthPath, GMAIL_CREDENTIALS_PATH: credentialsPath },
      expectedCode: 1,
    });
    expect(caughtCode).toBe(1);
    // The "Authentication failed: ..." prefix proves the wrap
    // caught the rejection; the inner port-1023 error proves the
    // positional callback URL was threaded all the way through to
    // authenticate's URL/port validator.
    expect(logs).toContain("Authentication failed:");
    expect(logs).toMatch(/Callback port '1023' is invalid/);
  });

  it("threads the injected exit handler through to loadCredentials (malformed keys)", async () => {
    // CR Major: runServer injects `exit` but previously did not
    // forward it to `loadCredentials`. A malformed
    // `gcp-oauth.keys.json` (missing `installed`/`web`, partial
    // shape, JSON.parse failure) would call `process.exit(1)`
    // directly — killing the test runner even when the test
    // injected its own `exit` to capture the code. Pin the
    // `exitOnInvalidKeys: exit` propagation by writing a partial
    // keys file (no client_secret), confirming the runServer's
    // injected exit is the one that fires (caught via the sentinel
    // error pattern rather than crashing the runner).
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(oauthPath, JSON.stringify({ installed: { client_id: "x" } }));
    let caughtErr: Error | undefined;
    let exitCode: number | undefined;
    const exitFn = (code: number): never => {
      exitCode = code;
      throw new Error(`__runserver_exit_${code}__`);
    };
    await runServer({
      argv: ["node", "index.js"],
      env: { GMAIL_OAUTH_PATH: oauthPath, GMAIL_CREDENTIALS_PATH: credentialsPath },
      log,
      exit: exitFn,
    }).catch((err: unknown) => {
      caughtErr = err instanceof Error ? err : new Error(String(err));
    });
    // Sentinel error proves the INJECTED exit fired (not
    // process.exit, which would have killed the runner before we
    // could observe anything). Code is 1 — the invalid-keys path.
    expect(caughtErr?.message).toBe("__runserver_exit_1__");
    expect(exitCode).toBe(1);
    expect(logCapture.join("\n")).toContain("non-empty client_id and client_secret values");
  });
});
