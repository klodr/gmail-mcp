/**
 * Runtime entry point for the Gmail MCP server.
 *
 * `runServer({ argv, env, log, exit })` orchestrates the full boot
 * sequence — credentials load, optional `auth` subcommand, gaxios
 * timeout, startup invalid_grant probe, and the stdio transport
 * handoff to the `createServer` factory in `src/server.ts`.
 *
 * Extracted from `src/index.ts` so the orchestration is reachable
 * from unit tests via dependency injection (`argv`/`env`/`log`/`exit`)
 * without booting a real `StdioServerTransport`. Aligns with the
 * `klodr/faxdrop-mcp` and `klodr/mercury-invoicing-mcp` pattern
 * where `src/index.ts` collapses to a 10-line CLI shim.
 *
 * Pure helpers exported for direct testing:
 *   - `parseCallbackArg(argv)` — finds the `http(s)://…` positional
 *   - `parseScopesArg(argv)` — `--scopes=` parsing + validation
 *   - `parseTimeoutMs(raw, log)` — `GMAIL_MCP_TIMEOUT_MS` parsing
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { google } from "googleapis";
import path from "path";
import os from "os";
import { DEFAULT_SCOPES, parseScopes, validateScopes, getAvailableScopeNames } from "./scopes.js";
import { buildInvalidGrantPayload, isInvalidGrantError } from "./gmail-errors.js";
import { createServer } from "./server.js";
import { loadCredentials, authenticate } from "./oauth-flow.js";

export const DEFAULT_TIMEOUT_MS = 60_000;

export interface RunServerOpts {
  /**
   * The full argv slice as passed by Node (`process.argv`). The
   * orchestrator scans for a positional callback URL and the
   * `--scopes=` flag.
   */
  argv: readonly string[];
  /**
   * Process env (`process.env`). Honoured keys: `GMAIL_OAUTH_PATH`,
   * `GMAIL_CREDENTIALS_PATH`, `GMAIL_MCP_TIMEOUT_MS`. Defaults
   * resolve `~/.gmail-mcp/{gcp-oauth.keys,credentials}.json`.
   */
  env: NodeJS.ProcessEnv;
  /**
   * stderr writer (defaults to `console.error`). Lets tests capture
   * the boot diagnostic stream without polluting test output.
   */
  log?: (msg: string, ...rest: unknown[]) => void;
  /**
   * Process-exit hook (defaults to `process.exit`). Lets tests
   * assert the exit code on the auth-subcommand paths without
   * killing the test runner.
   */
  exit?: (code: number) => never;
}

/**
 * Find the positional callback URL in argv (first arg starting with
 * `http://` or `https://`). Returns `undefined` when no positional is
 * present — `loadCredentials` then defaults to
 * `http://localhost:3000/oauth2callback`.
 */
export function parseCallbackArg(argv: readonly string[]): string | undefined {
  return argv.find((arg) => arg.startsWith("http://") || arg.startsWith("https://"));
}

/**
 * Parse `--scopes=…` from argv. Returns the requested scope set
 * (defaulting to `DEFAULT_SCOPES` when no flag is supplied),
 * validation result, the list of unknown shorthand scope names, and
 * a `flagPresent` boolean so the caller can branch on "no flag, use
 * defaults" vs "flag with valid scopes".
 */
export function parseScopesArg(argv: readonly string[]): {
  scopes: string[];
  valid: boolean;
  invalid: string[];
  flagPresent: boolean;
} {
  const scopesArg = argv.find((arg) => arg.startsWith("--scopes="));
  if (!scopesArg) {
    return { scopes: [...DEFAULT_SCOPES], valid: true, invalid: [], flagPresent: false };
  }
  const value = scopesArg.slice("--scopes=".length);
  const scopes = parseScopes(value);
  // Empty after parse means the user supplied `--scopes=` (no
  // value), `--scopes=,,,` (only separators), or whitespace-only.
  // `validateScopes([])` returns `valid: true` vacuously (no
  // invalid entries in a zero-length set), but proceeding with
  // zero scopes would issue an OAuth grant the user can't do
  // anything with. Fail fast with a synthetic-invalid entry that
  // surfaces what the user actually typed in the CLI's
  // "Invalid scope(s): …" diagnostic.
  if (scopes.length === 0) {
    return {
      scopes: [],
      valid: false,
      invalid: [`(empty: --scopes=${JSON.stringify(value)})`],
      flagPresent: true,
    };
  }
  const validation = validateScopes(scopes);
  return {
    scopes,
    valid: validation.valid,
    invalid: validation.invalid,
    flagPresent: true,
  };
}

/**
 * Parse `GMAIL_MCP_TIMEOUT_MS` env var into a positive integer. A
 * negative / decimal / non-numeric value silently reopens the
 * hang-forever path on a slow Gmail response, so we validate
 * explicitly and fall back to `DEFAULT_TIMEOUT_MS` (60 s) with a
 * stderr warning on misconfiguration. Pure — no side effects beyond
 * the optional `log` call.
 */
export function parseTimeoutMs(
  raw: string | undefined,
  log: (msg: string, ...rest: unknown[]) => void,
): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  log(
    `Invalid GMAIL_MCP_TIMEOUT_MS="${raw}" (must be a positive integer); falling back to ${DEFAULT_TIMEOUT_MS}ms.`,
  );
  return DEFAULT_TIMEOUT_MS;
}

/**
 * Full boot orchestration. Loads OAuth credentials, dispatches the
 * `auth` subcommand if present, otherwise wires the gmail client into
 * `createServer` and connects to the supplied stdio transport.
 *
 * The transport factory is hard-wired to `StdioServerTransport` —
 * tests that need to skip the actual server.connect() exercise the
 * exported pure helpers directly + the auth-subcommand path (which
 * exits before reaching the transport).
 */
export async function runServer(opts: RunServerOpts): Promise<void> {
  /* v8 ignore next 2 -- trivial pass-through defaults; tests
     always inject log + exit. The default arrow bodies are
     `console.error(...)` and `process.exit(code)` — calling either
     from a unit test would corrupt test output (the former) or
     kill the runner (the latter). */
  const log = opts.log ?? ((msg: string, ...rest: unknown[]) => console.error(msg, ...rest));
  const exit = opts.exit ?? ((code: number) => process.exit(code));

  const CONFIG_DIR = path.join(os.homedir(), ".gmail-mcp");
  /* v8 ignore start -- env-var-vs-default fallback branches for the
     two OAuth file paths. Tests always inject `env` with explicit
     paths so the `||` short-circuit's right-hand side
     (`path.join(CONFIG_DIR, ...)`) is never reached. The default
     `~/.gmail-mcp/gcp-oauth.keys.json` resolution is the production
     happy path and is exercised by every real `npx ... auth` run. */
  const OAUTH_PATH = opts.env.GMAIL_OAUTH_PATH || path.join(CONFIG_DIR, "gcp-oauth.keys.json");
  const CREDENTIALS_PATH =
    opts.env.GMAIL_CREDENTIALS_PATH || path.join(CONFIG_DIR, "credentials.json");
  /* v8 ignore stop */

  const callbackArg = parseCallbackArg(opts.argv);

  const { oauth2Client, oauthCallbackUrl, authorizedScopes } = loadCredentials({
    oauthPath: OAUTH_PATH,
    credentialsPath: CREDENTIALS_PATH,
    configDir: CONFIG_DIR,
    skipConfigDirCreate:
      Boolean(opts.env.GMAIL_OAUTH_PATH) || Boolean(opts.env.GMAIL_CREDENTIALS_PATH),
    callbackArg,
    log,
    // Thread the runServer-injected exit handler through to
    // loadCredentials. Without this, a malformed `gcp-oauth.keys.json`
    // (missing `installed`/`web`, partial keys, JSON.parse failure)
    // would call `process.exit(1)` directly, killing the test runner
    // even when the test injected its own `exit` to capture the code.
    exitOnInvalidKeys: exit,
  });

  if (opts.argv[2] === "auth") {
    const { scopes, valid, invalid, flagPresent } = parseScopesArg(opts.argv);
    if (!valid) {
      log("Error: Invalid scope(s):", invalid.join(", "));
      log("Available scopes:", getAvailableScopeNames().join(", "));
      exit(1);
    }
    if (!flagPresent) {
      log("No --scopes flag specified, using defaults:", DEFAULT_SCOPES.join(", "));
      log("Tip: Use --scopes=gmail.readonly for read-only access");
      log("Available scopes:", getAvailableScopeNames().join(", "));
    }

    if (!oauthCallbackUrl) {
      // Lazy-boot mode: no OAuth keys present, so `loadCredentials`
      // returned a stub client without a callback URL. Running `auth`
      // here would have nowhere to redirect the OAuth grant.
      log(
        `Cannot run \`auth\` without OAuth keys at ${OAUTH_PATH}. Provide \`gcp-oauth.keys.json\` (download from Google Cloud Console → APIs & Services → Credentials).`,
      );
      exit(1);
    }

    // Wrap authenticate's rejection paths so they exit through the
    // injected `exit` hook instead of propagating up to the
    // process-level uncaught handler. authenticate uses Promise
    // rejection (URL/port validation, EADDRINUSE, missing code,
    // state mismatch, getToken throw) — without this wrap, a test
    // that injects `exit` only sees the rejection on the
    // runServer promise but never observes the exit code.
    try {
      await authenticate({
        oauth2Client,
        oauthCallbackUrl: oauthCallbackUrl!,
        scopes,
        credentialsPath: CREDENTIALS_PATH,
        log,
      });
    } catch (err: unknown) {
      // `err instanceof Error` is the common path (authenticate
      // throws Error subclasses). The `String(err)` arm is the
      // defensive fallback when a non-Error value gets thrown
      // (e.g. legacy code that `throw "string-message"`).
      /* v8 ignore next -- non-Error throw is defensive; authenticate
         only ever throws Error subclasses today. */
      const msg = err instanceof Error ? err.message : String(err);
      log(`Authentication failed: ${msg}`);
      exit(1);
    }
    /* v8 ignore start -- success path runs only after a real
       browser-driven OAuth round-trip; the authenticate() success
       branch + the credentials-on-disk shape are pinned in
       oauth-flow.test.ts, here we just log + exit. */
    log("Authentication completed successfully");
    exit(0);
    /* v8 ignore stop */
  }

  /* v8 ignore start -- non-auth path: timeout config + startup
     getAccessToken probe + StdioServerTransport bootstrap glue.
     Booting a real StdioServerTransport from a unit test would
     deadlock the runner waiting for the next stdio frame. The
     timeout parser is exercised directly via parseTimeoutMs(),
     the invalid_grant payload shape is pinned in
     gmail-errors.test.ts, and createServer is exercised via the
     E2E InMemoryTransport pattern in registrars.test.ts. */
  // Hard timeout on every outbound Gmail API call. Applied globally
  // via `google.options` before the gmail client is constructed
  // inside `createServer`, so every subsequent `gmail.users.*` call
  // inherits the timeout through gaxios.
  //
  // 60 s default (vs mercury's 30 s) because gmail carries two slow-
  // path surfaces that mercury does not:
  //   (1) attachment upload on `send_email` — a 25 MB PDF base64-
  //       encoded on a mid-tier mobile uplink routinely pushes the
  //       single POST past 30 s even on a healthy Google edge;
  //   (2) round-trip inflation from non-US regions (a Bangkok →
  //       googleapis.com hop adds 200–500 ms per request, compounded
  //       across the ~3 internal redirects gaxios follows on a
  //       `messages.send` with attachments).
  const gmailTimeoutMs = parseTimeoutMs(opts.env.GMAIL_MCP_TIMEOUT_MS, log);
  google.options({ timeout: gmailTimeoutMs });

  // Startup smoke test: request an access token up-front. If the
  // stored refresh token was revoked / expired / reissued elsewhere,
  // google-auth-library throws `invalid_grant` here — surface a
  // single structured log line so the failure appears at boot
  // rather than on the first real tool call. The MCP stays up so
  // tools still return the same `code: "INVALID_GRANT"` payload
  // through `wrapToolHandler`'s catch, giving the client a
  // programmatic path to prompt the user to re-auth.
  // Fire-and-forget: the check must not delay `server.connect()`.
  oauth2Client.getAccessToken().catch((err: unknown) => {
    if (isInvalidGrantError(err)) {
      const payload = buildInvalidGrantPayload(CREDENTIALS_PATH);
      log(`[startup] ${payload.code}: ${payload.recovery_action}`);
    } else {
      // Full redaction (CR-major finding on PR #103). Certain
      // google-auth-library versions serialise the OAuth response
      // payload into `err.message`, which can include refresh
      // tokens or scope details. The previous defensive truncate
      // (200-char prefix + length suffix) still leaked the FIRST
      // 200 chars to stderr — and a token can fit comfortably
      // inside that window. Switch to type+length-only diagnostics:
      // log the constructor name and the raw message length so
      // operators can correlate the failure with the GaxiosError /
      // Error subclass without ever exposing the body. The
      // `INVALID_GRANT` branch above remains the actionable signal
      // for the headline "credentials revoked" case.
      const errType = err instanceof Error ? err.constructor.name : typeof err;
      const rawLen = err instanceof Error ? err.message.length : String(err).length;
      log(
        `[startup] getAccessToken probe failed: type=${errType}, message length=${rawLen} chars (redacted for credential safety; rerun \`npx @klodr/gmail-mcp auth\` if this persists)`,
      );
    }
  });

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  const server = createServer({ gmail, authorizedScopes });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  /* v8 ignore stop */
}
