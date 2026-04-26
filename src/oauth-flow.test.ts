/**
 * Unit tests for `loadCredentials` and `authenticate` (`src/oauth-flow.ts`).
 *
 * Both helpers were extracted from `src/index.ts` so they can be
 * exercised without the side-effect of `main()` running on import.
 * Tests use `tmpdir`-rooted scratch directories + dependency injection
 * (`exitOnInvalidKeys`, `log`, `openBrowser`) so the real `process.exit`,
 * `console.error`, and `open` are never touched.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  statSync,
  readFileSync,
  openSync,
  fstatSync,
  closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuth2Client } from "google-auth-library";
import { loadCredentials, authenticate, InvalidOAuthKeysError } from "./oauth-flow.js";

let scratch: string;
let oauthPath: string;
let credentialsPath: string;
let configDir: string;
let logCapture: string[];

const log = (msg: string, ...rest: unknown[]) => {
  // Stringify Error objects so `.toContain("EADDRINUSE")` style checks
  // match the captured representation.
  logCapture.push(
    [msg, ...rest.map((x) => (x instanceof Error ? x.message : String(x)))].join(" "),
  );
};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "gmail-mcp-oauth-flow-test-"));
  configDir = join(scratch, ".gmail-mcp");
  oauthPath = join(configDir, "gcp-oauth.keys.json");
  credentialsPath = join(configDir, "credentials.json");
  logCapture = [];
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("loadCredentials", () => {
  it("returns a stub OAuth2Client + empty scopes when oauthPath does not exist (lazy-boot)", () => {
    const result = loadCredentials({
      oauthPath,
      credentialsPath,
      configDir,
      skipConfigDirCreate: false,
      log,
    });
    expect(result.oauth2Client).toBeInstanceOf(OAuth2Client);
    expect(result.authorizedScopes).toEqual([]);
    // No callback URL in lazy-boot mode: no auth flow can run yet.
    expect(result.oauthCallbackUrl).toBeUndefined();
    // Should have logged a clear lazy-boot warning (used by hosted MCP
    // runners' log scrapers to identify a not-yet-authed instance).
    expect(logCapture.join("\n")).toContain("lazy-auth mode");
  });

  it("auto-creates the configDir at 0o700 when neither env var is set (skipConfigDirCreate=false)", () => {
    loadCredentials({
      oauthPath,
      credentialsPath,
      configDir,
      skipConfigDirCreate: false,
      log,
    });
    const stats = statSync(configDir);
    expect(stats.isDirectory()).toBe(true);
    // POSIX permission bits in lower 9 bits — pin 0o700 to confirm
    // host-other readers cannot list config files.
    expect(stats.mode & 0o777).toBe(0o700);
  });

  it("does NOT create the configDir when skipConfigDirCreate=true and no oauth keys present", () => {
    // Mirrors `src/index.ts` logic when GMAIL_OAUTH_PATH or
    // GMAIL_CREDENTIALS_PATH override the default — the operator
    // pointed elsewhere and may not want a stub ~/.gmail-mcp at $HOME.
    loadCredentials({
      oauthPath,
      credentialsPath,
      configDir,
      skipConfigDirCreate: true,
      // Force the local-OAuth check to look at a path that does not
      // exist either (so we don't fall through to the copy branch
      // which has its own mkdirSync).
      localOAuthPath: join(scratch, "no-such-keys.json"),
      log,
    });
    expect(() => statSync(configDir)).toThrow(/ENOENT/);
  });

  it("loads OAuth keys with `installed` shape and constructs an OAuth2Client", () => {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      oauthPath,
      JSON.stringify({
        installed: { client_id: "id-installed", client_secret: "secret-installed" },
      }),
    );
    const result = loadCredentials({
      oauthPath,
      credentialsPath,
      configDir,
      skipConfigDirCreate: true,
      log,
    });
    expect(result.oauth2Client).toBeInstanceOf(OAuth2Client);
    expect(result.oauthCallbackUrl).toBe("http://localhost:3000/oauth2callback");
    // No credentials.json yet → DEFAULT_SCOPES carry through.
    expect(result.authorizedScopes.length).toBeGreaterThan(0);
  });

  it("loads OAuth keys with the `web` shape (alternate Google Cloud Console export)", () => {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      oauthPath,
      JSON.stringify({ web: { client_id: "id-web", client_secret: "secret-web" } }),
    );
    const result = loadCredentials({
      oauthPath,
      credentialsPath,
      configDir,
      skipConfigDirCreate: true,
      log,
    });
    expect(result.oauth2Client).toBeInstanceOf(OAuth2Client);
  });

  it("calls exitOnInvalidKeys when the keys file is missing both `installed` and `web`", () => {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(oauthPath, JSON.stringify({ unknown: "shape" }));
    let exitCode: number | undefined;
    const exitFn = (code: number): never => {
      exitCode = code;
      // Throw a sentinel so loadCredentials' catch block re-throws and
      // we can `expect(...).toThrow` cleanly. `process.exit` in
      // production is `(code) => never`, so the catch path never
      // continues past `exit(1)` either.
      throw new InvalidOAuthKeysError(oauthPath);
    };
    expect(() =>
      loadCredentials({
        oauthPath,
        credentialsPath,
        configDir,
        skipConfigDirCreate: true,
        exitOnInvalidKeys: exitFn,
        log,
      }),
    ).toThrow(InvalidOAuthKeysError);
    expect(exitCode).toBe(1);
    expect(logCapture.join("\n")).toContain("Invalid OAuth keys file format");
  });

  it("uses the new credentials.json shape (`{ tokens, scopes }`) and surfaces the stored scopes", () => {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(oauthPath, JSON.stringify({ installed: { client_id: "x", client_secret: "y" } }));
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        tokens: { access_token: "at", refresh_token: "rt" },
        scopes: ["gmail.readonly"],
      }),
    );
    const result = loadCredentials({
      oauthPath,
      credentialsPath,
      configDir,
      skipConfigDirCreate: true,
      log,
    });
    expect(result.authorizedScopes).toEqual(["gmail.readonly"]);
  });

  it("falls back to DEFAULT_SCOPES when the credentials.json is the legacy flat shape", () => {
    // Legacy shape from before the v1.2.0 scope-storage rework — bare
    // OAuth tokens at the root, no `scopes` key. We have to keep
    // honouring this so users with an existing credentials.json don't
    // get logged out by an upgrade.
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(oauthPath, JSON.stringify({ installed: { client_id: "x", client_secret: "y" } }));
    writeFileSync(credentialsPath, JSON.stringify({ access_token: "at", refresh_token: "rt" }));
    const result = loadCredentials({
      oauthPath,
      credentialsPath,
      configDir,
      skipConfigDirCreate: true,
      log,
    });
    // No `scopes` key → default scope set carries through.
    expect(result.authorizedScopes.length).toBeGreaterThan(0);
  });

  it("honours an explicit callbackArg when provided (overrides the localhost:3000 default)", () => {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(oauthPath, JSON.stringify({ installed: { client_id: "x", client_secret: "y" } }));
    const result = loadCredentials({
      oauthPath,
      credentialsPath,
      configDir,
      skipConfigDirCreate: true,
      callbackArg: "http://localhost:9999/cb",
      log,
    });
    expect(result.oauthCallbackUrl).toBe("http://localhost:9999/cb");
  });

  it("copies a cwd `gcp-oauth.keys.json` to oauthPath at 0o600 and creates the parent dir", () => {
    const localOAuthPath = join(scratch, "gcp-oauth.keys.json");
    writeFileSync(
      localOAuthPath,
      JSON.stringify({ installed: { client_id: "id-cwd", client_secret: "secret-cwd" } }),
      { mode: 0o644 },
    );
    // configDir does not exist yet — the copy path must mkdir it.
    loadCredentials({
      oauthPath,
      credentialsPath,
      configDir,
      // Even when skipConfigDirCreate is true, the copy branch's own
      // `mkdirSync(path.dirname(oauthPath))` should still fire so the
      // copy target exists.
      skipConfigDirCreate: true,
      localOAuthPath,
      log,
    });
    const stats = statSync(oauthPath);
    expect(stats.isFile()).toBe(true);
    // copyFileSync preserves the source mode (0o644 above), so the
    // explicit chmodSync is what brings it down to 0o600. Pin it.
    expect(stats.mode & 0o777).toBe(0o600);
    expect(logCapture.join("\n")).toContain("OAuth keys found in current directory");
  });

  it("re-throws non-Invalid errors via exitOnInvalidKeys after logging only the message (no Error object)", () => {
    // A JSON.parse failure on a partial OAuth file — the catch block
    // must log only the error MESSAGE (not the full Error which can
    // include a content snippet near `client_secret`).
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(oauthPath, "{ this is not json"); // truncated → SyntaxError
    let exitCode: number | undefined;
    const exitFn = (code: number): never => {
      exitCode = code;
      throw new Error(`exit-${code}`);
    };
    expect(() =>
      loadCredentials({
        oauthPath,
        credentialsPath,
        configDir,
        skipConfigDirCreate: true,
        exitOnInvalidKeys: exitFn,
        log,
      }),
    ).toThrow(/exit-1/);
    expect(exitCode).toBe(1);
    const captured = logCapture.join("\n");
    expect(captured).toContain("Error loading credentials");
    // Belt-and-braces: confirm the captured log doesn't accidentally
    // dump a JSON content snippet (e.g. raw file bytes) into stderr —
    // this would be the regression-trap if a future change replaces
    // `error.message` with `error` (which on JSON.parse failures
    // includes a position pointer that may show partial content).
    expect(captured).not.toContain("this is not json");
  });
});

describe("authenticate", () => {
  /**
   * Build a hydrated OAuth2Client suitable for authenticate(). We
   * cannot rely on loadCredentials here because the OAuth2Client's
   * `redirect_uri` field is part of its private state, so the test
   * sets it directly with the expected callback URL.
   */
  function makeClient(callbackUrl: string): OAuth2Client {
    return new OAuth2Client("id-test", "secret-test", callbackUrl);
  }

  it("rejects an https:// callback URL (only loopback http is supported)", async () => {
    await expect(
      authenticate({
        oauth2Client: makeClient("https://localhost:3000/oauth2callback"),
        oauthCallbackUrl: "https://localhost:3000/oauth2callback",
        scopes: ["gmail.readonly"],
        credentialsPath,
        openBrowser: () => undefined,
        log,
      }),
    ).rejects.toThrow(/Callback protocol 'https:' is not supported/);
  });

  it("rejects a non-loopback callback hostname", async () => {
    await expect(
      authenticate({
        oauth2Client: makeClient("http://example.com/oauth2callback"),
        oauthCallbackUrl: "http://example.com/oauth2callback",
        scopes: ["gmail.readonly"],
        credentialsPath,
        openBrowser: () => undefined,
        log,
      }),
    ).rejects.toThrow(/Callback hostname 'example.com' is not loopback/);
  });

  it("rejects a privileged callback port (port < 1024 requires root)", async () => {
    // Port 1023 is privileged but URL-parser-friendly (port 80 would
    // be stripped from `new URL("http://localhost:80/...").port`).
    await expect(
      authenticate({
        oauth2Client: makeClient("http://localhost:1023/oauth2callback"),
        oauthCallbackUrl: "http://localhost:1023/oauth2callback",
        scopes: ["gmail.readonly"],
        credentialsPath,
        openBrowser: () => undefined,
        log,
      }),
    ).rejects.toThrow(/Callback port '1023' is invalid/);
  });

  it("rejects port-stripped default ports as the `(default)` placeholder", async () => {
    // `new URL("http://localhost:80/...")` strips :80 → `parsed.port`
    // becomes "". The port range check then logs `'(default)'`. Pin
    // the placeholder so a refactor that switches to `parsed.port` raw
    // (which would be the empty string) is caught.
    await expect(
      authenticate({
        oauth2Client: makeClient("http://localhost/oauth2callback"),
        oauthCallbackUrl: "http://localhost/oauth2callback",
        scopes: ["gmail.readonly"],
        credentialsPath,
        openBrowser: () => undefined,
        log,
      }),
    ).rejects.toThrow(/Callback port '\(default\)' is invalid/);
  });

  it("surfaces EADDRINUSE with a hint when the callback port is already taken", async () => {
    // Squat on a free port first, then ask authenticate() to listen
    // on the same port — the listener errors with EADDRINUSE which
    // the catch turns into a typed rejection with a hint.
    const squat = http.createServer();
    await new Promise<void>((res) => squat.listen(0, "127.0.0.1", res));
    const port = (squat.address() as { port: number }).port;
    const cb = `http://127.0.0.1:${port}/oauth2callback`;
    try {
      await expect(
        authenticate({
          oauth2Client: makeClient(cb),
          oauthCallbackUrl: cb,
          scopes: ["gmail.readonly"],
          credentialsPath,
          openBrowser: () => undefined,
          log,
        }),
      ).rejects.toThrow(
        /OAuth callback server failed to listen on 127\.0\.0\.1:\d+\..*Another process is already listening/s,
      );
    } finally {
      await new Promise<void>((res) => squat.close(() => res()));
    }
  });

  it("rejects when the OAuth callback request omits the `code` query parameter", async () => {
    const port = await pickFreePort();
    const cb = `http://127.0.0.1:${port}/oauth2callback`;
    // Capture-on-reject pattern: attach the .catch handler
    // synchronously so the listener-side `reject(new Error("No code
    // provided"))` always lands on a registered handler. Without
    // this, vitest can race the rejection against the
    // `await expect.rejects` and flag it as unhandled.
    let caughtErr: Error | undefined;
    const settled = authenticate({
      oauth2Client: makeClient(cb),
      oauthCallbackUrl: cb,
      scopes: ["gmail.readonly"],
      credentialsPath,
      openBrowser: () => undefined,
      log,
    }).catch((err: unknown) => {
      caughtErr = err instanceof Error ? err : new Error(String(err));
    });
    // Hit the callback with a missing `code` — this triggers the
    // `400 No code provided` branch + a reject inside the listener.
    const res = await fetch(`${cb}?state=foo`);
    expect(res.status).toBe(400);
    await settled;
    expect(caughtErr).toBeInstanceOf(Error);
    expect(caughtErr?.message).toBe("No code provided");
  });

  it("rejects when the OAuth state parameter is missing (CSRF defence)", async () => {
    const port = await pickFreePort();
    const cb = `http://127.0.0.1:${port}/oauth2callback`;
    const client = makeClient(cb);
    // Spy: if state validation fails, getToken MUST NOT be called.
    let getTokenCalled = false;
    (
      client as unknown as {
        getToken: (code: string) => Promise<{ tokens: Record<string, unknown> }>;
      }
    ).getToken = async () => {
      getTokenCalled = true;
      return Promise.resolve({ tokens: {} });
    };
    let caughtErr: Error | undefined;
    const settled = authenticate({
      oauth2Client: client,
      oauthCallbackUrl: cb,
      scopes: ["gmail.readonly"],
      credentialsPath,
      openBrowser: () => undefined,
      log,
      generateState: () => "expected-state-token",
    }).catch((err: unknown) => {
      caughtErr = err instanceof Error ? err : new Error(String(err));
    });
    // Send a `code` but no `state` — the CSRF guard must refuse
    // the exchange. Pin the 400 + the typed rejection AND that
    // `getToken` was never reached.
    const res = await fetch(`${cb}?code=anything`);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid state");
    await settled;
    expect(caughtErr).toBeInstanceOf(Error);
    expect(caughtErr?.message).toContain("OAuth state mismatch");
    expect(getTokenCalled).toBe(false);
  });

  it("rejects when the OAuth state parameter does not match the expected value", async () => {
    const port = await pickFreePort();
    const cb = `http://127.0.0.1:${port}/oauth2callback`;
    const client = makeClient(cb);
    let getTokenCalled = false;
    (
      client as unknown as {
        getToken: (code: string) => Promise<{ tokens: Record<string, unknown> }>;
      }
    ).getToken = async () => {
      getTokenCalled = true;
      return Promise.resolve({ tokens: {} });
    };
    let caughtErr: Error | undefined;
    const settled = authenticate({
      oauth2Client: client,
      oauthCallbackUrl: cb,
      scopes: ["gmail.readonly"],
      credentialsPath,
      openBrowser: () => undefined,
      log,
      generateState: () => "expected-state-token",
    }).catch((err: unknown) => {
      caughtErr = err instanceof Error ? err : new Error(String(err));
    });
    // Wrong state — same length and a non-trivial mismatch so the
    // length-fast-path doesn't short-circuit the timing-safe
    // comparison. Pin the same 400 + reject + getToken-not-called
    // contract as the missing-state case above.
    const res = await fetch(`${cb}?code=anything&state=attacker-state-value`);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid state");
    await settled;
    expect(caughtErr).toBeInstanceOf(Error);
    expect(caughtErr?.message).toContain("OAuth state mismatch");
    expect(getTokenCalled).toBe(false);
  });

  it("writes credentials at 0o600 when the OAuth code exchange succeeds", async () => {
    const port = await pickFreePort();
    const cb = `http://127.0.0.1:${port}/oauth2callback`;
    const client = makeClient(cb);
    // Stub the token exchange so we don't hit Google. Because
    // OAuth2Client.getToken is what `authenticate` calls in the
    // happy path, replacing it lets us simulate a successful grant.
    (
      client as unknown as {
        getToken: (code: string) => Promise<{ tokens: Record<string, unknown> }>;
      }
    ).getToken = async (code: string) => {
      expect(code).toBe("auth-code-xyz");
      return Promise.resolve({
        tokens: { access_token: "at", refresh_token: "rt" },
      });
    };
    mkdirSync(configDir, { recursive: true, mode: 0o700 });

    const flow = authenticate({
      oauth2Client: client,
      oauthCallbackUrl: cb,
      scopes: ["gmail.readonly"],
      credentialsPath,
      openBrowser: () => undefined,
      log,
      // Pin a deterministic state so the success-fetch can supply
      // the matching `?state=…`. Production uses
      // `crypto.randomBytes(32).toString("base64url")`.
      generateState: () => "test-state-deterministic",
    });
    // Trigger the success branch — must include the matching state.
    const res = await fetch(`${cb}?code=auth-code-xyz&state=test-state-deterministic`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Authentication successful");
    await flow;

    // Open + fstat to pin both the mode AND the bytes against the
    // SAME open file descriptor. The naive `statSync` then
    // `readFileSync` shape trips CodeQL's `js/file-system-race`
    // (TOCTOU between the metadata check and the read); using one
    // descriptor for both ops eliminates the race window.
    const fd = openSync(credentialsPath, "r");
    let stored: { tokens: Record<string, unknown>; scopes: string[] };
    try {
      const stats = fstatSync(fd);
      expect(stats.mode & 0o777).toBe(0o600);
      stored = JSON.parse(readFileSync(fd, "utf-8")) as {
        tokens: Record<string, unknown>;
        scopes: string[];
      };
    } finally {
      closeSync(fd);
    }
    // Pin both halves of the v1.2.0+ credentials.json shape so a
    // refactor that drops the scopes key (or that flips back to the
    // legacy flat shape) is caught.
    expect(stored.scopes).toEqual(["gmail.readonly"]);
    expect(stored.tokens).toMatchObject({ access_token: "at", refresh_token: "rt" });
  });

  it("rejects a multi-byte state without throwing TypeError on Buffer mismatch", async () => {
    // Defence regression: the previous shape compared
    // `String.length` (UTF-16 code units) and only later built
    // Buffers for `crypto.timingSafeEqual` (which requires
    // identical BYTE lengths). An attacker who supplies a state
    // with the same code-unit count but multi-byte UTF-8 chars
    // would have triggered TypeError → unhandled rejection on the
    // fire-and-forget IIFE → request hangs + listener stays up.
    // The fix builds both Buffers up front and compares
    // `.length` (byte length). Pin the no-throw + clean reject
    // contract on a "café" vs "cafe" pair (4 UTF-16 units, 5 vs 4
    // bytes).
    const port = await pickFreePort();
    const cb = `http://127.0.0.1:${port}/oauth2callback`;
    const client = makeClient(cb);
    let getTokenCalled = false;
    (
      client as unknown as {
        getToken: (code: string) => Promise<{ tokens: Record<string, unknown> }>;
      }
    ).getToken = async () => {
      getTokenCalled = true;
      return Promise.resolve({ tokens: {} });
    };
    let caughtErr: Error | undefined;
    const settled = authenticate({
      oauth2Client: client,
      oauthCallbackUrl: cb,
      scopes: ["gmail.readonly"],
      credentialsPath,
      openBrowser: () => undefined,
      log,
      generateState: () => "cafe", // 4 ASCII chars, 4 bytes
    }).catch((err: unknown) => {
      caughtErr = err instanceof Error ? err : new Error(String(err));
    });
    // "café" — 4 UTF-16 code units, but 5 UTF-8 bytes (é = 2 bytes).
    const res = await fetch(`${cb}?code=anything&state=caf%C3%A9`);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid state");
    await settled;
    expect(caughtErr).toBeInstanceOf(Error);
    expect(caughtErr?.message).toContain("OAuth state mismatch");
    expect(getTokenCalled).toBe(false);
  });

  it("logs but does not reject when launchBrowser fails (browser missing)", async () => {
    // The auth flow prints the authUrl to stderr regardless of
    // whether `open` can launch a browser, and a missing default
    // browser must not abort auth — the user can still paste the
    // URL manually. Pin the .catch handler on the launchBrowser
    // promise: a thrown launcher logs `Failed to open browser
    // automatically: ...` and the auth flow continues normally
    // (here we settle via missing-code to keep the test short).
    const port = await pickFreePort();
    const cb = `http://127.0.0.1:${port}/oauth2callback`;
    let caughtErr: Error | undefined;
    const settled = authenticate({
      oauth2Client: makeClient(cb),
      oauthCallbackUrl: cb,
      scopes: ["gmail.readonly"],
      credentialsPath,
      openBrowser: () => {
        throw new Error("xdg-open not found");
      },
      log,
    }).catch((err: unknown) => {
      caughtErr = err instanceof Error ? err : new Error(String(err));
    });
    // Wait one tick so the listen callback fires and the
    // launchBrowser .catch handler logs.
    await new Promise((r) => setTimeout(r, 30));
    // Settle the auth promise so the test can clean up the
    // listener — no-code path is the cheapest exit.
    await fetch(`${cb}`);
    await settled;
    expect(caughtErr?.message).toBe("No code provided");
    expect(logCapture.join("\n")).toContain("Failed to open browser automatically");
    expect(logCapture.join("\n")).toContain("xdg-open not found");
  });

  it("rejects with HTTP 500 when the token-exchange call throws", async () => {
    // After state validation passes, `opts.oauth2Client.getToken(code)`
    // is awaited inside the try/catch. A network/credentials/quota
    // error surfaces as a 500 + a typed reject through the catch
    // arm — pinned here on a synthetic error.
    const port = await pickFreePort();
    const cb = `http://127.0.0.1:${port}/oauth2callback`;
    const client = makeClient(cb);
    (client as unknown as { getToken: (code: string) => Promise<unknown> }).getToken = () =>
      Promise.reject(new Error("invalid_grant"));
    let caughtErr: Error | undefined;
    const settled = authenticate({
      oauth2Client: client,
      oauthCallbackUrl: cb,
      scopes: ["gmail.readonly"],
      credentialsPath,
      openBrowser: () => undefined,
      log,
      generateState: () => "deterministic",
    }).catch((err: unknown) => {
      caughtErr = err instanceof Error ? err : new Error(String(err));
    });
    const res = await fetch(`${cb}?code=anything&state=deterministic`);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Authentication failed");
    await settled;
    expect(caughtErr?.message).toBe("invalid_grant");
  });
});

/** Helper: bind to port 0, capture the OS-assigned port, release. */
async function pickFreePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((res) => probe.listen(0, "127.0.0.1", res));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((res) => probe.close(() => res()));
  return port;
}
