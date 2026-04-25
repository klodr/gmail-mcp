#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import open from "open";
import os from "os";
import {
  DEFAULT_SCOPES,
  scopeNamesToUrls,
  parseScopes,
  validateScopes,
  getAvailableScopeNames,
} from "./scopes.js";
import { buildInvalidGrantPayload, isInvalidGrantError } from "./gmail-errors.js";
import { createServer } from "./server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration paths
const CONFIG_DIR = path.join(os.homedir(), ".gmail-mcp");
const OAUTH_PATH = process.env.GMAIL_OAUTH_PATH || path.join(CONFIG_DIR, "gcp-oauth.keys.json");
const CREDENTIALS_PATH =
  process.env.GMAIL_CREDENTIALS_PATH || path.join(CONFIG_DIR, "credentials.json");

// OAuth2 configuration. The two `let` bindings persist across the boot
// sequence; both are mutated by `loadCredentials()` once and then
// passed into `createServer()` by `main()`.
let oauth2Client: OAuth2Client;
let oauthCallbackUrl: string;
let authorizedScopes: string[] = DEFAULT_SCOPES;

function loadCredentials() {
  try {
    // Create config directory if it doesn't exist
    if (
      !process.env.GMAIL_OAUTH_PATH &&
      !process.env.GMAIL_CREDENTIALS_PATH &&
      !fs.existsSync(CONFIG_DIR)
    ) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }

    // Check for OAuth keys in current directory first, then in config directory
    const localOAuthPath = path.join(process.cwd(), "gcp-oauth.keys.json");

    if (fs.existsSync(localOAuthPath)) {
      // If found in current directory, copy to config directory.
      // The CONFIG_DIR guard above skips mkdirSync when only
      // GMAIL_CREDENTIALS_PATH is overridden — but OAUTH_PATH still
      // defaults under ~/.gmail-mcp in that case, so without this
      // explicit mkdir the copy would ENOENT. Also force 0o600 on
      // the copy: copyFileSync preserves the source mode, so a 0o644
      // `gcp-oauth.keys.json` sitting in cwd would keep that mode.
      fs.mkdirSync(path.dirname(OAUTH_PATH), { recursive: true, mode: 0o700 });
      fs.copyFileSync(localOAuthPath, OAUTH_PATH);
      fs.chmodSync(OAUTH_PATH, 0o600);
      console.error("OAuth keys found in current directory, copied to global config.");
    }

    if (!fs.existsSync(OAUTH_PATH)) {
      // Lazy-boot mode: no OAuth keys at startup. Hosted MCP runners
      // (Glama, Smithery, etc.) run a smoke test on `tools/list` before
      // the user has any chance to mount credentials, and exiting here
      // would mark the server as broken on the registry. Boot with a
      // stub OAuth2Client instead — `tools/list` (which does not touch
      // gmail.users.*) succeeds, and any tool call that needs auth
      // fails cleanly through the `asGmailApiError` path with an
      // `INVALID_GRANT`-shaped payload that surfaces the missing-auth
      // condition to the agent.
      console.error(
        "Warning: OAuth keys file not found at",
        OAUTH_PATH,
        "— booting in lazy-auth mode. Tool calls that need Gmail will fail until `npx @klodr/gmail-mcp auth` is run.",
      );
      oauth2Client = new OAuth2Client();
      // Narrow the advertised tool surface to the empty set until
      // credentials are mounted — none of the 26 Gmail tools can
      // succeed without an authorised scope, so advertising them on
      // `tools/list` is misleading to agent operators inspecting
      // capabilities pre-auth. `tools/list` then returns `[]`, and the
      // first authenticated `tools/list` (post `npx @klodr/gmail-mcp
      // auth`) sees the real surface.
      authorizedScopes = [];
      return;
    }

    const keysContent = JSON.parse(fs.readFileSync(OAUTH_PATH, "utf8"));
    const keys = keysContent.installed || keysContent.web;

    if (!keys) {
      console.error(
        'Error: Invalid OAuth keys file format. File should contain either "installed" or "web" credentials.',
      );
      process.exit(1);
    }

    // Parse callback URL from args (must be a URL, not a flag).
    // Only loopback callbacks are supported (hostname must resolve to
    // localhost / 127.0.0.1 / ::1); non-loopback targets would require
    // an externally reachable endpoint, which this flow does not set up.
    // Supports: node index.js auth http://localhost:8080/oauth2callback
    // Or: node index.js auth --scopes=gmail.readonly (uses default callback)
    const callbackArg = process.argv.find(
      (arg) => arg.startsWith("http://") || arg.startsWith("https://"),
    );
    oauthCallbackUrl = callbackArg || "http://localhost:3000/oauth2callback";

    oauth2Client = new OAuth2Client(keys.client_id, keys.client_secret, oauthCallbackUrl);

    if (fs.existsSync(CREDENTIALS_PATH)) {
      const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));

      // Credentials file structure (v1.2.0+):
      //   { "tokens": { access_token, refresh_token, ... }, "scopes": ["gmail.readonly", ...] }
      //
      // Legacy structure (pre-v1.2.0):
      //   { access_token, refresh_token, ... }
      //
      // We support both formats for backwards compatibility. Users with legacy
      // credentials will get DEFAULT_SCOPES (full access) until they re-authenticate.
      const tokens = credentials.tokens || credentials;
      oauth2Client.setCredentials(tokens);

      if (credentials.scopes) {
        authorizedScopes = credentials.scopes;
      }
    }
  } catch (error) {
    // Log only the error message, not the full Error object — a JSON.parse
    // failure on a partially-corrupted OAuth file carries a snippet of
    // the faulty content (position/line pointer) that could include
    // client_secret if the corruption landed near it. Stderr is forwarded
    // to the MCP host's logs.
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Error loading credentials: ${msg}`);
    process.exit(1);
  }
}

async function authenticate(scopes: string[]) {
  const parsed = new URL(oauthCallbackUrl);

  // The built-in callback listener is plain http.createServer(). If the
  // caller passes an https:// URL, OAuth would redirect to a TLS target
  // that nothing on this process is listening on — silent failure.
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
  // Range-check the callback port up-front. The built-in auth server
  // is a non-privileged loopback listener — privileged ports (1-1023)
  // require root and are almost certainly a misconfiguration; ports
  // outside 1-65535 are not valid TCP at all. Catching this here gives
  // a clean error before `server.listen` would emit a less obvious
  // EACCES/RANGE_ERR diagnostic.
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(
      `Callback port '${parsed.port || "(default)"}' is invalid. ` +
        `The built-in auth server requires an unprivileged TCP port (1024-65535). ` +
        `Pick a free port in that range and pass it via the callback URL.`,
    );
  }
  const callbackPath = parsed.pathname || "/oauth2callback";

  const httpServer = http.createServer();
  // Convert shorthand scope names (e.g., "gmail.readonly") to full Google API URLs
  const scopeUrls = scopeNamesToUrls(scopes);

  return new Promise<void>((resolve, reject) => {
    // Surface listen-time failures (port in use, address bind, etc.)
    // immediately. Without this listener, `server.listen` failures would
    // crash the process via an `uncaughtException`, hiding the real
    // cause behind a generic stack trace.
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
    httpServer.listen(port, hostname);

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: scopeUrls,
    });

    console.error("Requesting scopes:", scopes.join(", "));
    console.error("Please visit this URL to authenticate:", authUrl);
    void open(authUrl);

    // Wrap bare IPv6 hostnames in brackets so `new URL()` accepts the base.
    const hostForUrl = hostname.includes(":") ? `[${hostname}]` : hostname;
    const baseUrl = `http://${hostForUrl}:${port}`;

    httpServer.on("request", (req, res) => {
      void (async () => {
        if (!req.url) return;

        const url = new URL(req.url, baseUrl);
        // Exact pathname match — startsWith would let `/oauth2callback-evil`
        // (or any extension) slip through on the loopback server.
        if (url.pathname !== callbackPath) return;

        const code = url.searchParams.get("code");

        if (!code) {
          res.writeHead(400);
          res.end("No code provided");
          reject(new Error("No code provided"));
          return;
        }

        try {
          const { tokens } = await oauth2Client.getToken(code);
          oauth2Client.setCredentials(tokens);

          // Store both tokens and authorized scopes for runtime filtering.
          // writeFileSync's `mode` option only applies on CREATE, so an
          // existing credentials.json with broader perms (e.g. 0o644
          // from a prior setup) would keep those bytes after re-auth.
          // Force 0o600 explicitly after write to match .github/SECURITY.md.
          const credentials = { tokens, scopes };
          fs.mkdirSync(path.dirname(CREDENTIALS_PATH), { recursive: true, mode: 0o700 });
          fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2), {
            mode: 0o600,
          });
          fs.chmodSync(CREDENTIALS_PATH, 0o600);

          res.writeHead(200);
          res.end("Authentication successful! You can close this window.");
          console.error("Credentials saved with scopes:", scopes.join(", "));
          httpServer.close();
          resolve();
        } catch (error) {
          res.writeHead(500);
          res.end("Authentication failed");
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
  });
}

// Main function
async function main() {
  loadCredentials();

  if (process.argv[2] === "auth") {
    // Parse --scopes flag from CLI arguments
    // Usage: node dist/index.js auth --scopes=<scope1,scope2,...>
    // Example: node dist/index.js auth --scopes=gmail.readonly
    // Example: node dist/index.js auth --scopes=gmail.readonly,gmail.settings.basic
    const scopesArg = process.argv.find((arg) => arg.startsWith("--scopes="));
    let scopes = DEFAULT_SCOPES;

    if (scopesArg) {
      const scopesValue = scopesArg.slice("--scopes=".length);
      scopes = parseScopes(scopesValue);
      const validation = validateScopes(scopes);

      if (!validation.valid) {
        console.error("Error: Invalid scope(s):", validation.invalid.join(", "));
        console.error("Available scopes:", getAvailableScopeNames().join(", "));
        process.exit(1);
      }
    } else {
      console.error("No --scopes flag specified, using defaults:", DEFAULT_SCOPES.join(", "));
      console.error("Tip: Use --scopes=gmail.readonly for read-only access");
      console.error("Available scopes:", getAvailableScopeNames().join(", "));
    }

    await authenticate(scopes);
    console.error("Authentication completed successfully");
    process.exit(0);
  }

  // Hard timeout on every outbound Gmail API call. Applied globally
  // via `google.options` before the gmail client is constructed
  // inside `createServer`, so every subsequent `gmail.users.*` call
  // inherits the timeout through gaxios. Without this, a slow Gmail
  // response hangs the entire MCP stdio session and the client
  // cannot recover without killing the process.
  //
  // 60 s default (vs mercury's 30 s at `src/client.ts:72`) because
  // gmail carries two slow-path surfaces that mercury does not:
  //   (1) attachment upload on `send_email` — a 25 MB PDF base64-
  //       encoded on a mid-tier mobile uplink routinely pushes
  //       the single POST past 30 s even on a healthy Google edge;
  //   (2) round-trip inflation from non-US regions (a Bangkok →
  //       googleapis.com hop adds 200–500 ms per request, compounded
  //       across the ~3 internal redirects gaxios follows on a
  //       `messages.send` with attachments).
  //
  // The `GMAIL_MCP_TIMEOUT_MS` env var lets an operator extend the
  // cap further. Must be a positive integer — a negative / decimal /
  // non-numeric value would silently reopen the hang-forever path,
  // so we validate explicitly and fall back to the default with a
  // stderr warning on misconfiguration.
  const DEFAULT_TIMEOUT_MS = 60_000;
  const rawTimeout = process.env.GMAIL_MCP_TIMEOUT_MS;
  let gmailTimeoutMs = DEFAULT_TIMEOUT_MS;
  if (rawTimeout !== undefined) {
    const parsed = Number(rawTimeout);
    if (Number.isInteger(parsed) && parsed > 0) {
      gmailTimeoutMs = parsed;
    } else {
      console.error(
        `Invalid GMAIL_MCP_TIMEOUT_MS="${rawTimeout}" (must be a positive integer); falling back to ${DEFAULT_TIMEOUT_MS}ms.`,
      );
    }
  }
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
    /* v8 ignore next 8 -- requires a live OAuth2Client exercising
       either a revoked refresh token or a transient transport
       failure to fire; the invalid_grant path is covered by
       isInvalidGrantError / buildInvalidGrantPayload unit tests in
       src/gmail-errors.test.ts, the fallback log is plain
       console.error with no branching logic worth asserting. */
    if (isInvalidGrantError(err)) {
      const payload = buildInvalidGrantPayload(CREDENTIALS_PATH);
      console.error(`[startup] ${payload.code}: ${payload.recovery_action}`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[startup] getAccessToken probe failed: ${msg}`);
    }
  });

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  const server = createServer({ gmail, authorizedScopes });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
