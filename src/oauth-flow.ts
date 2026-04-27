/**
 * OAuth flow for the Gmail MCP server.
 *
 * Two responsibilities, both extracted from `src/index.ts` so they
 * can be unit-tested without spinning the whole MCP entry point
 * (which calls `main()` on module load):
 *
 *   - `loadCredentials({ oauthPath, credentialsPath, configDir, ...})`
 *     reads (or stubs) the OAuth keys + stored credentials from disk
 *     and returns a hydrated `OAuth2Client` plus the authorised
 *     scope set. Pure — returns a value instead of mutating
 *     module-level `let` bindings.
 *
 *   - `authenticate({ oauth2Client, oauthCallbackUrl, scopes,
 *     credentialsPath })` runs the interactive browser-based OAuth
 *     callback flow and writes the resulting tokens to
 *     `credentialsPath`.
 *
 * The mutations to module-level state previously living in
 * `src/index.ts` are gone; `index.ts` now wires the return value
 * of `loadCredentials` straight into `createServer({ oauth2Client,
 * authorizedScopes })`. Testability and lazy-boot semantics are
 * preserved bit-for-bit.
 */

import fs from "fs";
import path from "path";
import http from "http";
import crypto from "crypto";
import open from "open";
import { OAuth2Client } from "google-auth-library";
import { DEFAULT_SCOPES, scopeNamesToUrls } from "./scopes.js";

// Defensive size cap on the OAuth keys + credentials files before
// reading them into memory + JSON.parse. Both files are normally
// 1-3 KB; 64 KB is ~30× the realistic upper bound while still
// negligible vs heap budget. Hard-fails before either an attacker-
// controlled (unlikely — these files are user-local) OR
// accidentally-corrupted (more likely — disk corruption, partial
// write) multi-GB file consumes the memory budget. Security audit
// finding (no CVE, defence-in-depth).
export const MAX_OAUTH_FILE_BYTES = 64 * 1024;

/**
 * Read a JSON file with a hard size cap, then `JSON.parse`. Throws
 * a clear `Error` when the file exceeds `MAX_OAUTH_FILE_BYTES` so
 * the caller can surface the boot-time misconfiguration without
 * loading the full payload into memory.
 *
 * TOCTOU note (CodeQL finding on PR #103): the size check and the
 * read use the SAME file descriptor (open → fstat → read on
 * `fd`), so a swap between the two calls cannot widen the read
 * past the cap. Without this, an `fs.statSync(path)` followed by
 * an `fs.readFileSync(path)` would re-resolve the path and could
 * race against a concurrent writer that grew the file in the gap.
 *
 * Exported so the size-cap branch is reachable from a unit test
 * without spinning up a full `loadCredentials` boot path.
 */
export function readJsonBounded(absPath: string): unknown {
  const fd = fs.openSync(absPath, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size > MAX_OAUTH_FILE_BYTES) {
      // Branch the remediation hint by file role. Both files are
      // 1-3 KB in the happy path; the same 64 KB ceiling applies
      // to both, but the recovery action differs.
      const base = path.basename(absPath);
      const remediation =
        base === "gcp-oauth.keys.json"
          ? "Replace with the original `gcp-oauth.keys.json` exported from Google Cloud Console (Credentials → OAuth 2.0 Client IDs)."
          : base === "credentials.json"
            ? "Delete the file and re-run `npx @klodr/gmail-mcp auth` to regenerate a fresh credentials JSON."
            : "Inspect the file for corruption.";
      throw new Error(
        `OAuth-related file at ${absPath} is ${stat.size} bytes, exceeding the ${MAX_OAUTH_FILE_BYTES}-byte cap. ${remediation}`,
      );
    }
    const buf = Buffer.alloc(stat.size);
    fs.readSync(fd, buf, 0, stat.size, 0);
    return JSON.parse(buf.toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

export interface LoadCredentialsOpts {
  /** Path to the OAuth keys JSON (`gcp-oauth.keys.json` shape). */
  oauthPath: string;
  /** Path to the stored credentials JSON (`credentials.json` shape). */
  credentialsPath: string;
  /** Config dir to create at `0o700` if it doesn't exist. */
  configDir: string;
  /**
   * Whether to skip the `mkdirSync(configDir)` step when env vars
   * point at custom paths outside the default `~/.gmail-mcp` tree.
   * `src/index.ts` honours `GMAIL_OAUTH_PATH` / `GMAIL_CREDENTIALS_PATH`
   * — when either is set, the default `~/.gmail-mcp` directory must
   * not be auto-created.
   */
  skipConfigDirCreate: boolean;
  /**
   * Optional positional CLI arg holding the callback URL for the
   * `auth` flow (`http://localhost:8080/oauth2callback` etc.). When
   * absent, defaults to `http://localhost:3000/oauth2callback`.
   */
  callbackArg?: string;
  /**
   * Optional path to a `gcp-oauth.keys.json` in the current working
   * directory. When present, it is copied to `oauthPath` at `0o600`
   * before the lookup. Defaults to `path.join(process.cwd(),
   * "gcp-oauth.keys.json")`.
   */
  localOAuthPath?: string;
  /**
   * Process-exit hook (defaults to `process.exit`). Lets tests
   * replace the hard exit on invalid OAuth keys with a thrown
   * sentinel so the test process is not killed.
   */
  exitOnInvalidKeys?: (code: number) => never;
  /**
   * stderr writer (defaults to `console.error`). Lets tests capture
   * the lazy-boot warning + the "OAuth keys copied" notice without
   * polluting test output.
   */
  log?: (msg: string, ...rest: unknown[]) => void;
}

export interface LoadCredentialsResult {
  oauth2Client: OAuth2Client;
  /**
   * The authorised scope set carried by the stored token (if any).
   * Empty `[]` when no OAuth keys were found at all (lazy-boot mode);
   * `DEFAULT_SCOPES` when keys are present but no `credentials.json`
   * has been written yet (i.e. before the first `auth` run).
   */
  authorizedScopes: readonly string[];
  /**
   * The OAuth callback URL the `authenticate` step should bind to.
   * `undefined` in lazy-boot mode (no `auth` is going to run yet).
   */
  oauthCallbackUrl?: string;
}

/**
 * Sentinel thrown when the OAuth keys file is present but malformed
 * (missing `installed` AND `web` properties). The legacy code called
 * `process.exit(1)` here; the new shape lets the caller decide
 * whether to exit or surface the error elsewhere.
 */
export class InvalidOAuthKeysError extends Error {
  constructor(public readonly keysPath: string) {
    super(
      `Invalid OAuth keys file format at ${keysPath}. File should contain either "installed" or "web" credentials.`,
    );
    this.name = "InvalidOAuthKeysError";
  }
}

export function loadCredentials(opts: LoadCredentialsOpts): LoadCredentialsResult {
  const log = opts.log ?? ((msg: string, ...rest: unknown[]) => console.error(msg, ...rest));
  const exit = opts.exitOnInvalidKeys ?? ((code: number) => process.exit(code));

  try {
    if (!opts.skipConfigDirCreate && !fs.existsSync(opts.configDir)) {
      fs.mkdirSync(opts.configDir, { recursive: true, mode: 0o700 });
    }

    const localOAuthPath = opts.localOAuthPath ?? path.join(process.cwd(), "gcp-oauth.keys.json");

    if (fs.existsSync(localOAuthPath)) {
      // Skip the copy when source and destination are the same
      // file — e.g. `GMAIL_OAUTH_PATH=$(pwd)/gcp-oauth.keys.json`
      // (the cwd file IS the configured path), or the default
      // resolution lands on the same realpath. Without this guard
      // `fs.copyFileSync` opens the destination with `O_TRUNC`
      // BEFORE reading the source, which on POSIX truncates the
      // file to 0 bytes and silently destroys the OAuth keys.
      // Compare absolute paths up-front; fall back to
      // `realpathSync` on the destination only if it exists (it
      // may not — that's the whole point of the copy).
      const srcAbs = path.resolve(localOAuthPath);
      const dstAbs = path.resolve(opts.oauthPath);
      const sameByPath = srcAbs === dstAbs;
      let sameByRealpath = false;
      if (!sameByPath && fs.existsSync(opts.oauthPath)) {
        try {
          sameByRealpath = fs.realpathSync(srcAbs) === fs.realpathSync(dstAbs);
        } catch {
          // realpath failure (broken symlink, EACCES) — fall through
          // to the copy. Worst case: the existing file gets
          // overwritten with itself, but that's safe via two
          // different inodes.
        }
      }
      if (sameByPath || sameByRealpath) {
        // No-op: source == destination already.
      } else {
        // Copy from cwd to the global config. The `mkdir` here
        // covers the case where `skipConfigDirCreate` is true
        // because only `GMAIL_CREDENTIALS_PATH` was overridden —
        // `OAUTH_PATH` still defaults under `~/.gmail-mcp` and
        // would ENOENT without explicit mkdir. Also force `0o600`:
        // `copyFileSync` preserves the source mode, so a `0o644`
        // cwd file would keep that mode.
        fs.mkdirSync(path.dirname(opts.oauthPath), { recursive: true, mode: 0o700 });
        fs.copyFileSync(localOAuthPath, opts.oauthPath);
        fs.chmodSync(opts.oauthPath, 0o600);
        log("OAuth keys found in current directory, copied to global config.");
      }
    }

    if (!fs.existsSync(opts.oauthPath)) {
      // Lazy-boot mode: no OAuth keys at startup. Hosted MCP runners
      // (Glama, Smithery, etc.) run a smoke test on `tools/list`
      // before the user has any chance to mount credentials, and
      // exiting here would mark the server as broken on the
      // registry. Boot with a stub `OAuth2Client` instead — the
      // factory's `tools/list` (which does not touch
      // `gmail.users.*`) succeeds, and any tool call that needs
      // auth fails cleanly through the `asGmailApiError` path with
      // an `INVALID_GRANT`-shaped payload.
      log(
        `Warning: OAuth keys file not found at ${opts.oauthPath} — booting in lazy-auth mode. Tool calls that need Gmail will fail until \`npx @klodr/gmail-mcp auth\` is run.`,
      );
      // Empty `authorizedScopes` narrows the advertised tool surface
      // to `[]` until credentials are mounted — none of the 26 Gmail
      // tools can succeed without an authorised scope.
      return {
        oauth2Client: new OAuth2Client(),
        authorizedScopes: [],
      };
    }

    const keysContent = readJsonBounded(opts.oauthPath) as {
      installed?: { client_id?: string; client_secret?: string };
      web?: { client_id?: string; client_secret?: string };
    };
    const keys = keysContent.installed || keysContent.web;

    // Partial-keys defence (CR Major): `{ installed: {} }` or
    // `{ web: { client_id: "x" } }` (no client_secret) currently
    // passes the truthy `installed || web` check and produces an
    // `OAuth2Client` with `undefined` credentials. That defers the
    // failure to the first `getToken(...)` call (where the error
    // surfaces as a Google `invalid_client` token-exchange
    // rejection, far from the boot configuration root cause).
    // Fail at boot with the existing invalid-keys path instead so
    // the operator sees the real diagnostic.
    if (
      !keys ||
      typeof keys.client_id !== "string" ||
      keys.client_id.length === 0 ||
      typeof keys.client_secret !== "string" ||
      keys.client_secret.length === 0
    ) {
      log(
        `Error: Invalid OAuth keys file format. File should contain either "installed" or "web" credentials with non-empty client_id and client_secret values.`,
      );
      // Default behaviour matches the legacy dispatcher: hard exit
      // so the operator notices a malformed file at boot. Tests
      // override `exitOnInvalidKeys` to throw an
      // `InvalidOAuthKeysError` instead.
      exit(1);
      // `exit` is `(code: number) => never`; the throw below is dead
      // code at runtime but lets the type-checker know the function
      // does not fall through into the next statement.
      throw new InvalidOAuthKeysError(opts.oauthPath);
    }

    const oauthCallbackUrl = opts.callbackArg ?? "http://localhost:3000/oauth2callback";
    const oauth2Client = new OAuth2Client(keys.client_id, keys.client_secret, oauthCallbackUrl);

    let authorizedScopes: readonly string[] = DEFAULT_SCOPES;

    if (fs.existsSync(opts.credentialsPath)) {
      const credentials = readJsonBounded(opts.credentialsPath) as {
        tokens?: Record<string, unknown>;
        scopes?: string[];
        [key: string]: unknown;
      };

      // Credentials file structure (v1.2.0+):
      //   { "tokens": { access_token, refresh_token, ... }, "scopes": [...] }
      // Legacy structure (pre-v1.2.0):
      //   { access_token, refresh_token, ... }
      // We support both formats for backwards compatibility. Users
      // with legacy credentials get DEFAULT_SCOPES (full access)
      // until they re-authenticate.
      const tokens = credentials.tokens ?? credentials;
      oauth2Client.setCredentials(tokens);

      if (credentials.scopes) {
        authorizedScopes = credentials.scopes;
      }
    }

    return { oauth2Client, oauthCallbackUrl, authorizedScopes };
  } catch (error) {
    if (error instanceof InvalidOAuthKeysError) {
      throw error;
    }
    // Log only the error message, not the full Error object — a
    // JSON.parse failure on a partially-corrupted OAuth file carries
    // a snippet of the faulty content (position/line pointer) that
    // could include `client_secret` if the corruption landed near
    // it. Stderr is forwarded to the MCP host's logs.
    const msg = error instanceof Error ? error.message : String(error);
    log(`Error loading credentials: ${msg}`);
    exit(1);
    throw error;
  }
}

export interface AuthenticateOpts {
  oauth2Client: OAuth2Client;
  oauthCallbackUrl: string;
  scopes: string[];
  credentialsPath: string;
  /**
   * Process-launch hook (defaults to `open(authUrl)`). Lets tests
   * skip the actual browser launch.
   */
  openBrowser?: (url: string) => unknown;
  log?: (msg: string, ...rest: unknown[]) => void;
  /**
   * Per-flow OAuth `state` generator (defaults to
   * `crypto.randomBytes(32).toString("base64url")`). Lets tests pin
   * a deterministic value so the fetch in the callback can supply
   * the matching `?state=…` parameter without first having to read
   * the URL the server printed to stderr.
   */
  generateState?: () => string;
}

export async function authenticate(opts: AuthenticateOpts): Promise<void> {
  const log = opts.log ?? ((msg: string, ...rest: unknown[]) => console.error(msg, ...rest));
  const launchBrowser = opts.openBrowser ?? open;

  const parsed = new URL(opts.oauthCallbackUrl);

  // The built-in callback listener is plain `http.createServer`. If
  // the caller passes an `https://` URL, OAuth would redirect to a
  // TLS target that nothing on this process is listening on —
  // silent failure.
  if (parsed.protocol !== "http:") {
    throw new Error(
      `Callback protocol '${parsed.protocol}' is not supported. ` +
        `The built-in auth server only accepts loopback HTTP callbacks (http://localhost...).`,
    );
  }

  const hostname = parsed.hostname;
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

  if (!isLoopback) {
    throw new Error(
      `Callback hostname '${hostname}' is not loopback. ` +
        `Only http://localhost / 127.0.0.1 / [::1] are supported by the built-in ` +
        `auth flow. Either (a) rerun 'auth' without a positional callback URL, ` +
        `or (b) point your Web OAuth client at a loopback URL.`,
    );
  }

  const port = parsed.port ? Number(parsed.port) : 80;
  // Range-check the callback port up-front. The built-in auth
  // server is a non-privileged loopback listener — privileged ports
  // (1-1023) require root and are almost certainly a misconfig;
  // ports outside 1-65535 are not valid TCP at all.
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(
      `Callback port '${parsed.port || "(default)"}' is invalid. ` +
        `The built-in auth server requires an unprivileged TCP port (1024-65535). ` +
        `Pick a free port in that range and pass it via the callback URL.`,
    );
  }
  const callbackPath = parsed.pathname || "/oauth2callback";

  const httpServer = http.createServer();
  const scopeUrls = scopeNamesToUrls(opts.scopes);

  // Per-flow OAuth `state` (RFC 6749 §10.12 — login-CSRF defence).
  // 256-bit random value, base64url-encoded. Without this, an
  // attacker who tricks the user into clicking
  // `http://localhost:<port>/oauth2callback?code=ATTACKER_CODE`
  // during the auth window can swap the user's flow for theirs
  // (the user ends up authenticated against the attacker's Google
  // account). Tests inject a deterministic generator so the
  // callback fetch can supply the matching `?state=…`.
  const expectedState = opts.generateState?.() ?? crypto.randomBytes(32).toString("base64url");

  return new Promise<void>((resolve, reject) => {
    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      const hint =
        err.code === "EADDRINUSE"
          ? ` Another process is already listening on that port — pick a different one or stop the conflicting process.`
          : err.code === "EACCES"
            ? ` Insufficient privilege to bind that port — pick a port >= 1024.`
            : "";
      reject(
        new Error(`OAuth callback server failed to listen on ${hostname}:${port}.${hint}`, {
          cause: err,
        }),
      );
    });
    // Defer the auth-URL build + browser launch into the listen
    // callback so they run only after the server is actually bound.
    // CR Major: kicking the browser before listen() is bound is a
    // race — the user could click through to the callback URL on a
    // port that hasn't started listening yet, and the redirect
    // would 404 silently. The catch on `launchBrowser` swallows the
    // browser process's exit code (a missing default browser is
    // not a fatal auth-flow failure — the URL is also printed to
    // stderr above so the user can paste it manually).
    httpServer.listen(port, hostname, () => {
      const authUrl = opts.oauth2Client.generateAuthUrl({
        access_type: "offline",
        scope: scopeUrls,
        state: expectedState,
      });

      log("Requesting scopes:", opts.scopes.join(", "));
      log("Please visit this URL to authenticate:", authUrl);
      // `Promise.resolve().then(...)` (instead of
      // `Promise.resolve(launchBrowser(authUrl))`) so a SYNC throw
      // from the launcher (e.g. `xdg-open` not on PATH on a
      // headless box, or `open` rejecting a malformed URL before
      // returning the Promise) is also caught — the bare
      // `Promise.resolve(throwing-call)` shape lets sync throws
      // escape the `.catch` chain, which would crash the auth flow
      // for what should be a non-fatal "no default browser" event.
      void Promise.resolve()
        .then(() => launchBrowser(authUrl))
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log(`Failed to open browser automatically: ${msg}`);
        });
    });

    const hostForUrl = hostname.includes(":") ? `[${hostname}]` : hostname;
    const baseUrl = `http://${hostForUrl}:${port}`;

    httpServer.on("request", (req, res) => {
      void (async () => {
        if (!req.url) return;

        const url = new URL(req.url, baseUrl);
        if (url.pathname !== callbackPath) return;

        const code = url.searchParams.get("code");
        const stateParam = url.searchParams.get("state");

        // Settle the auth promise only after the http server is
        // fully closed: stop accepting new connections AND tear
        // down keepalive sockets so the port is released
        // immediately. Without `closeAllConnections`, a fetch
        // client holding the connection open keeps `close()`'s
        // callback hanging and the promise never settles.
        const finalize = (settle: () => void): void => {
          httpServer.close(() => settle());
          httpServer.closeAllConnections?.();
        };

        if (!code) {
          res.writeHead(400);
          res.end("No code provided");
          // CR Major: close the listener before rejecting so the
          // port is released and a subsequent drive-by request
          // cannot keep executing the handler against an
          // already-settled promise.
          finalize(() => reject(new Error("No code provided")));
          return;
        }

        // Validate the OAuth `state` round-trip BEFORE exchanging
        // the code. A missing or mismatched state means the
        // callback was not initiated by this flow — refuse the
        // grant rather than potentially binding the user to an
        // attacker-controlled Google account.
        //
        // Compare BYTE lengths, not String.length (UTF-16 code-unit
        // count). An attacker who supplies a multi-byte UTF-8 state
        // with a String.length matching `expectedState` would
        // otherwise reach `timingSafeEqual` with mismatched-byte
        // Buffers, which throws TypeError → unhandled rejection on
        // the fire-and-forget IIFE → request hangs + listener stays
        // up. Fix: build both Buffers up front and compare their
        // `.length` (which is byte length, not UTF-16 units).
        const expectedBuf = Buffer.from(expectedState, "utf-8");
        const stateBuf = stateParam === null ? null : Buffer.from(stateParam, "utf-8");
        if (
          stateBuf === null ||
          stateBuf.length !== expectedBuf.length ||
          !crypto.timingSafeEqual(stateBuf, expectedBuf)
        ) {
          res.writeHead(400);
          res.end("Invalid state");
          finalize(() =>
            reject(
              new Error(
                "OAuth state mismatch: refusing to exchange the authorization code. The callback may have been initiated by a different OAuth flow.",
              ),
            ),
          );
          return;
        }

        try {
          const { tokens } = await opts.oauth2Client.getToken(code);
          opts.oauth2Client.setCredentials(tokens);

          // writeFileSync's `mode` only applies on CREATE; force
          // `0o600` after to match `.github/SECURITY.md`.
          const credentials = { tokens, scopes: opts.scopes };
          fs.mkdirSync(path.dirname(opts.credentialsPath), { recursive: true, mode: 0o700 });
          fs.writeFileSync(opts.credentialsPath, JSON.stringify(credentials, null, 2), {
            mode: 0o600,
          });
          fs.chmodSync(opts.credentialsPath, 0o600);

          res.writeHead(200);
          res.end("Authentication successful! You can close this window.");
          log("Credentials saved with scopes:", opts.scopes.join(", "));
          // Resolve only AFTER the server has actually closed so
          // the caller's `await authenticate(...)` does not race
          // with a still-bound listener (symmetric with the error
          // paths below).
          finalize(resolve);
        } catch (error) {
          res.writeHead(500);
          res.end("Authentication failed");
          // CR Major: same as the missing-code branch — close the
          // listener before rejecting so the port is released and
          // a subsequent request cannot keep firing against the
          // settled promise.
          finalize(() => reject(error instanceof Error ? error : new Error(String(error))));
        }
      })();
    });
  });
}
