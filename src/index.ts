#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { google } from "googleapis";
import path from "path";
import os from "os";
import { DEFAULT_SCOPES, parseScopes, validateScopes, getAvailableScopeNames } from "./scopes.js";
import { buildInvalidGrantPayload, isInvalidGrantError } from "./gmail-errors.js";
import { createServer } from "./server.js";
import { loadCredentials, authenticate } from "./oauth-flow.js";

// Configuration paths
const CONFIG_DIR = path.join(os.homedir(), ".gmail-mcp");
const OAUTH_PATH = process.env.GMAIL_OAUTH_PATH || path.join(CONFIG_DIR, "gcp-oauth.keys.json");
const CREDENTIALS_PATH =
  process.env.GMAIL_CREDENTIALS_PATH || path.join(CONFIG_DIR, "credentials.json");

// Main function
async function main() {
  // Parse callback URL from args (must be a URL, not a flag).
  // Only loopback callbacks are supported (hostname must resolve to
  // localhost / 127.0.0.1 / ::1); non-loopback targets would require
  // an externally reachable endpoint, which this flow does not set up.
  // Supports: node index.js auth http://localhost:8080/oauth2callback
  // Or: node index.js auth --scopes=gmail.readonly (uses default callback)
  const callbackArg = process.argv.find(
    (arg) => arg.startsWith("http://") || arg.startsWith("https://"),
  );

  const { oauth2Client, oauthCallbackUrl, authorizedScopes } = loadCredentials({
    oauthPath: OAUTH_PATH,
    credentialsPath: CREDENTIALS_PATH,
    configDir: CONFIG_DIR,
    // Skip auto-creating ~/.gmail-mcp when either env-var override is
    // set: the operator pointed somewhere outside the default tree
    // and may not want a stub directory created at $HOME.
    skipConfigDirCreate:
      Boolean(process.env.GMAIL_OAUTH_PATH) || Boolean(process.env.GMAIL_CREDENTIALS_PATH),
    callbackArg,
  });

  if (process.argv[2] === "auth") {
    // Parse --scopes flag from CLI arguments
    // Usage: node dist/index.js auth --scopes=<scope1,scope2,...>
    // Example: node dist/index.js auth --scopes=gmail.readonly
    // Example: node dist/index.js auth --scopes=gmail.readonly,gmail.settings.basic
    const scopesArg = process.argv.find((arg) => arg.startsWith("--scopes="));
    let scopes: string[] = [...DEFAULT_SCOPES];

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

    if (!oauthCallbackUrl) {
      // Lazy-boot mode: no OAuth keys present, so `loadCredentials`
      // returned a stub client without a callback URL. Running `auth`
      // here would have nowhere to redirect the OAuth grant.
      console.error(
        `Cannot run \`auth\` without OAuth keys at ${OAUTH_PATH}. Provide \`gcp-oauth.keys.json\` (download from Google Cloud Console → APIs & Services → Credentials).`,
      );
      process.exit(1);
    }

    await authenticate({
      oauth2Client,
      oauthCallbackUrl,
      scopes,
      credentialsPath: CREDENTIALS_PATH,
    });
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
