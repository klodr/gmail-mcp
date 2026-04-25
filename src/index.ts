#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import open from "open";
import os from "os";
import {
  createEmailMessage,
  createEmailWithNodemailer,
  resolveDownloadSavePath,
  getDownloadDir,
  safeWriteFile,
  sanitizeAttachmentFilename,
  pickBody,
  pickBodyAnnotated,
  HTML_FALLBACK_NOTE,
  ValidatedEmailArgs,
} from "./utl.js";
import {
  createLabel,
  updateLabel,
  deleteLabel,
  listLabels,
  getOrCreateLabel,
  GmailLabel,
} from "./label-manager.js";
import {
  createFilter,
  listFilters,
  getFilter,
  deleteFilter,
  filterTemplates,
} from "./filter-manager.js";
import {
  addRePrefix,
  buildReferencesHeader,
  buildReplyAllRecipients,
} from "./reply-all-helpers.js";
import {
  DEFAULT_SCOPES,
  scopeNamesToUrls,
  parseScopes,
  validateScopes,
  hasScope,
  getAvailableScopeNames,
} from "./scopes.js";
import {
  toolDefinitions,
  toMcpTools,
  getToolByName,
  SendEmailSchema,
  ReadEmailSchema,
  SearchEmailsSchema,
  ModifyEmailSchema,
  DeleteEmailSchema,
  BatchModifyEmailsSchema,
  BatchDeleteEmailsSchema,
  CreateLabelSchema,
  UpdateLabelSchema,
  DeleteLabelSchema,
  GetOrCreateLabelSchema,
  CreateFilterSchema,
  GetFilterSchema,
  DeleteFilterSchema,
  CreateFilterFromTemplateSchema,
  DownloadAttachmentSchema,
  ReplyAllSchema,
  GetThreadSchema,
  ListInboxThreadsSchema,
  GetInboxWithThreadsSchema,
  DownloadEmailSchema,
  ModifyThreadSchema,
  PairRecipientSchema,
} from "./tools.js";
import { gmailMessageToJson, emailToTxt, emailToHtml } from "./email-export.js";
import { makeHeaderGetter } from "./gmail-headers.js";
import { logAudit } from "./audit-log.js";
import { listPrompts, getPrompt } from "./prompts.js";
import { wrapToolHandler } from "./middleware.js";
import { sanitizeForLlm } from "./sanitize.js";
import { asGmailApiError, buildInvalidGrantPayload, isInvalidGrantError } from "./gmail-errors.js";
import { resolveDefaultSender } from "./sender-resolver.js";
import {
  addPairedAddress,
  readPairedList,
  removePairedAddress,
  requirePairedRecipients,
} from "./recipient-pairing.js";
import {
  MAX_MIME_DEPTH,
  collectAttachmentsForThread,
  extractAttachments,
  extractEmailContent,
} from "./mime-walkers.js";

// Re-export for downstream consumers / tests that previously imported
// from this module's barrel.
export { MAX_MIME_DEPTH, extractAttachments, extractEmailContent };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration paths
const CONFIG_DIR = path.join(os.homedir(), ".gmail-mcp");
const OAUTH_PATH = process.env.GMAIL_OAUTH_PATH || path.join(CONFIG_DIR, "gcp-oauth.keys.json");
const CREDENTIALS_PATH =
  process.env.GMAIL_CREDENTIALS_PATH || path.join(CONFIG_DIR, "credentials.json");

// Type definitions for Gmail API responses.
// Accepts both our canonical shape and googleapis' `Schema$MessagePart`,
// which differs only by widening every optional `string` to `string | null`.
import type { gmail_v1 as gmail_v1_types } from "googleapis";
type GmailMessagePart = gmail_v1_types.Schema$MessagePart;

// `EmailContent`, `MAX_MIME_DEPTH`, `extractEmailContent`, and
// `extractAttachments` live in src/mime-walkers.ts so they can be
// unit-tested without importing this dispatcher (which calls main()
// on module load).

// OAuth2 configuration
let oauth2Client: OAuth2Client;
let oauthCallbackUrl: string;
let authorizedScopes: string[] = DEFAULT_SCOPES;

// `resolveDefaultSender` + its cache live in their own module so they
// can be unit-tested without exercising the 1300-line dispatcher
// below. See src/sender-resolver.ts for the fallback chain (GongRzhe#77).

/**
 * Extract common headers from Gmail message payload
 */
function extractHeaders(payload: GmailMessagePart | undefined): {
  subject: string;
  from: string;
  to: string;
  date: string;
  rfcMessageId: string;
} {
  const getHeader = makeHeaderGetter(payload?.headers);
  return {
    subject: getHeader("subject"),
    from: getHeader("from"),
    to: getHeader("to"),
    date: getHeader("date"),
    rfcMessageId: getHeader("message-id"),
  };
}

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

  const server = http.createServer();
  // Convert shorthand scope names (e.g., "gmail.readonly") to full Google API URLs
  const scopeUrls = scopeNamesToUrls(scopes);

  return new Promise<void>((resolve, reject) => {
    // Surface listen-time failures (port in use, address bind, etc.)
    // immediately. Without this listener, `server.listen` failures would
    // crash the process via an `uncaughtException`, hiding the real
    // cause behind a generic stack trace.
    server.on("error", (err: NodeJS.ErrnoException) => {
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
    server.listen(port, hostname);

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

    server.on("request", (req, res) => {
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
          server.close();
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
  // via `google.options` before constructing the gmail client so
  // every subsequent `gmail.users.*` call inherits the timeout
  // through gaxios. Without this, a slow Gmail response hangs the
  // entire MCP stdio session and the client cannot recover without
  // killing the process.
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
  // cap further for mailboxes where a single `messages.list` with
  // a heavy `q:` legitimately runs long. Must be a positive integer
  // — a negative / decimal / non-numeric value would silently reopen
  // the hang-forever path, so we validate explicitly and fall back
  // to the default with a stderr warning on misconfiguration.
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

  // Initialize Gmail API
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  // Startup smoke test: request an access token up-front. If the
  // stored refresh token was revoked / expired / reissued elsewhere,
  // google-auth-library throws `invalid_grant` here — surface a
  // single structured log line so the failure appears at boot
  // rather than on the first real tool call. The MCP stays up so
  // tools still return the same `code: "INVALID_GRANT"` payload
  // (see catch block in the CallToolRequestSchema handler), giving
  // the client a programmatic path to prompt the user to re-auth.
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
      // Non-invalid_grant errors (network failure, transient DNS,
      // malformed credentials file surviving the JSON parse) are not
      // fatal — the first real tool call will surface them through
      // the CallToolRequestSchema catch block — but we log here so
      // they show up at boot alongside the invalid_grant case
      // rather than being silently swallowed (CR #51).
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[startup] getAccessToken probe failed: ${msg}`);
    }
  });

  // Server implementation
  const server = new Server(
    {
      name: "gmail",
      version: "0.21.0",
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
      },
    },
  );

  // Tool handlers
  // Filter available tools based on authorized scopes
  server.setRequestHandler(ListToolsRequestSchema, () => {
    const availableTools = toolDefinitions.filter((tool) =>
      hasScope(authorizedScopes, tool.scopes),
    );
    return Promise.resolve({ tools: toMcpTools(availableTools) });
  });

  // Prompt handlers — user-facing slash commands (see src/prompts.ts).
  // Prompts do not themselves perform Gmail API calls; they return
  // message templates that tell the LLM which tools to invoke. Scope
  // enforcement happens at the tool layer when the LLM actually calls
  // a write tool, so read-only clients can still list/get prompts.
  server.setRequestHandler(ListPromptsRequestSchema, () => {
    return Promise.resolve({ prompts: listPrompts() });
  });

  server.setRequestHandler(GetPromptRequestSchema, (request) => {
    const { name, arguments: args } = request.params;
    // Explicit error boundary so callers get a clean structured error
    // instead of whatever the SDK defaults to on uncaught throws. The
    // three classes worth distinguishing: "unknown prompt" (404-shape),
    // "invalid args" (422-shape) — Zod throws ZodError on refine/parse
    // failures — and everything else (500-shape).
    try {
      // Cast is a deliberate workaround: the SDK's response type is a
      // discriminated union that includes a task-result variant (with a
      // required `task` field) used by the experimental async-tasks
      // API. Our prompts are synchronous, so we return the plain
      // GetPromptResult shape; the cast keeps TS honest at the boundary.
      return Promise.resolve(getPrompt(name, args) as unknown as Record<string, unknown>);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unexpected error generating prompt body";
      // Re-throw as a typed Error so the SDK surfaces it as a JSON-RPC
      // error to the caller (the SDK converts uncaught Errors into
      // -32603 "Internal error" responses, which is the right shape
      // here — the prompt call never made it to a successful result).
      // `cause` carries the original error for server-side logs.
      throw new Error(`Prompt "${name}": ${message}`, { cause: err });
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Verify the tool is authorized for the current scopes
    // This guards against direct tool calls that bypass ListTools
    const toolDef = getToolByName(name);
    if (!toolDef || !hasScope(authorizedScopes, toolDef.scopes)) {
      logAudit(name, args, "error");
      return {
        content: [
          {
            type: "text",
            text: sanitizeForLlm(
              `Error: Tool "${name}" is not available. You may need to re-authenticate with additional scopes.`,
            ),
          },
        ],
        isError: true,
      };
    }

    // Validate args against the tool's Zod schema BEFORE charging the
    // bucket quota. A malformed send_email / delete_email request must
    // not burn daily/monthly budget — otherwise a buggy client or a
    // bad prompt can lock out later valid writes. The Schema.parse
    // happens again inside each tool case (for type narrowing), which
    // is redundant but cheap; the contract here is just
    // "if args cannot possibly succeed, don't consume quota".
    const parseResult = toolDef.schema.safeParse(args);
    if (!parseResult.success) {
      logAudit(name, args, "error");
      return {
        content: [
          {
            type: "text",
            text: sanitizeForLlm(
              `Error: invalid arguments for "${name}": ${parseResult.error.message}`,
            ),
          },
        ],
        isError: true,
      };
    }

    // Rate-limit + audit-log are now handled by wrapToolHandler
    // (src/middleware.ts). The helper trips rate-limit BEFORE the
    // handler runs, maps RateLimitError → isError payload with the
    // mcp_safeguard error-type, and logs audit in a `finally` with one
    // of three states: "ok" | "error" | "rate_limited".

    async function handleEmailAction(
      action: "send" | "draft",
      validatedArgs: ValidatedEmailArgs & { threadId?: string; inReplyTo?: string },
    ) {
      let message: string;

      try {
        // Recipient pairing gate — no-op unless
        // GMAIL_MCP_RECIPIENT_PAIRING=true. When enabled, every
        // To/Cc/Bcc address must appear in ~/.gmail-mcp/paired.json
        // (manage via the `pair_recipient` tool). Caps the blast
        // radius of a prompt-injection-driven send.
        requirePairedRecipients([
          ...(validatedArgs.to ?? []),
          ...(validatedArgs.cc ?? []),
          ...(validatedArgs.bcc ?? []),
        ]);

        // Resolve `from` from the user's default send-as alias (with
        // displayName) when the caller didn't specify one. Using the
        // literal "me" works for the envelope but renders a bare
        // email address in the recipient's `From:` header — see
        // GongRzhe/Gmail-MCP-Server#77. Scope-degraded: on
        // `gmail.send`-only tokens the sendAs/getProfile calls fail
        // and we fall back to "me" (original behaviour).
        if (!validatedArgs.from || validatedArgs.from.trim() === "") {
          validatedArgs.from = await resolveDefaultSender(gmail);
        }

        // Auto-resolve threading headers when threadId is provided but inReplyTo is missing
        if (validatedArgs.threadId && !validatedArgs.inReplyTo) {
          try {
            const threadResponse = await gmail.users.threads.get({
              userId: "me",
              id: validatedArgs.threadId,
              format: "metadata",
              metadataHeaders: ["Message-ID"],
            });

            const threadMessages = threadResponse.data.messages || [];
            if (threadMessages.length > 0) {
              // Collect all Message-ID values for the References chain
              const allMessageIds: string[] = [];
              for (const msg of threadMessages) {
                const msgHeaders = msg.payload?.headers || [];
                const messageIdHeader = msgHeaders.find(
                  (h) => h.name?.toLowerCase() === "message-id",
                );
                if (messageIdHeader?.value) {
                  allMessageIds.push(messageIdHeader.value);
                }
              }

              // Last message's Message-ID becomes In-Reply-To.
              // threadMessages.length > 0 is guaranteed by the outer if;
              // the `?.` keeps the compiler happy under noUncheckedIndexedAccess.
              const lastMessage = threadMessages[threadMessages.length - 1];
              const lastHeaders = lastMessage?.payload?.headers || [];
              const lastMessageId = lastHeaders.find(
                (h) => h.name?.toLowerCase() === "message-id",
              )?.value;

              if (lastMessageId) {
                validatedArgs.inReplyTo = lastMessageId;
              }
              if (allMessageIds.length > 0) {
                validatedArgs.references = allMessageIds.join(" ");
              }
            }
          } catch (threadError: unknown) {
            const msg = threadError instanceof Error ? threadError.message : String(threadError);
            console.warn(
              `Warning: Could not fetch thread ${validatedArgs.threadId} for header resolution: ${msg}`,
            );
            // Continue without threading headers - degraded but not broken
          }
        }

        // Check if we have attachments
        if (validatedArgs.attachments && validatedArgs.attachments.length > 0) {
          // Use Nodemailer to create properly formatted RFC822 message
          message = await createEmailWithNodemailer(validatedArgs);

          if (action === "send") {
            const encodedMessage = Buffer.from(message)
              .toString("base64")
              .replace(/\+/g, "-")
              .replace(/\//g, "_")
              .replace(/=+$/, "");

            const result = await gmail.users.messages.send({
              userId: "me",
              requestBody: {
                raw: encodedMessage,
                ...(validatedArgs.threadId && { threadId: validatedArgs.threadId }),
              },
            });

            return {
              content: [
                {
                  type: "text",
                  text: `Email sent successfully with ID: ${result.data.id}`,
                },
              ],
            };
          } else {
            // For drafts with attachments, use the raw message
            const encodedMessage = Buffer.from(message)
              .toString("base64")
              .replace(/\+/g, "-")
              .replace(/\//g, "_")
              .replace(/=+$/, "");

            const messageRequest = {
              raw: encodedMessage,
              ...(validatedArgs.threadId && { threadId: validatedArgs.threadId }),
            };

            const response = await gmail.users.drafts.create({
              userId: "me",
              requestBody: {
                message: messageRequest,
              },
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Email draft created successfully with ID: ${response.data.id}`,
                },
              ],
            };
          }
        } else {
          // For emails without attachments, use the existing simple method
          message = createEmailMessage(validatedArgs);

          const encodedMessage = Buffer.from(message)
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");

          // Define the type for messageRequest
          interface GmailMessageRequest {
            raw: string;
            threadId?: string;
          }

          const messageRequest: GmailMessageRequest = {
            raw: encodedMessage,
          };

          // Add threadId if specified
          if (validatedArgs.threadId) {
            messageRequest.threadId = validatedArgs.threadId;
          }

          if (action === "send") {
            const response = await gmail.users.messages.send({
              userId: "me",
              requestBody: messageRequest,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Email sent successfully with ID: ${response.data.id}`,
                },
              ],
            };
          } else {
            const response = await gmail.users.drafts.create({
              userId: "me",
              requestBody: {
                message: messageRequest,
              },
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Email draft created successfully with ID: ${response.data.id}`,
                },
              ],
            };
          }
        }
      } catch (error: unknown) {
        // Log attachment-related errors for debugging
        if (validatedArgs.attachments && validatedArgs.attachments.length > 0) {
          const { code, message } = asGmailApiError(error);
          const codeTag = code !== undefined ? ` (HTTP ${code})` : "";
          console.error(
            `Failed to send email with ${validatedArgs.attachments.length} attachments${codeTag}:`,
            message,
          );
        }
        throw error;
      }
    }

    // Helper function to process operations in batches
    async function processBatches<T, U>(
      items: T[],
      batchSize: number,
      processFn: (batch: T[]) => Promise<U[]>,
    ): Promise<{ successes: U[]; failures: { item: T; error: Error }[] }> {
      const successes: U[] = [];
      const failures: { item: T; error: Error }[] = [];

      // Process in batches
      for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        try {
          const results = await processFn(batch);
          successes.push(...results);
        } catch {
          // If batch fails, try individual items
          for (const item of batch) {
            try {
              const result = await processFn([item]);
              successes.push(...result);
            } catch (itemError) {
              failures.push({ item, error: itemError as Error });
            }
          }
        }
      }

      return { successes, failures };
    }

    try {
      return await wrapToolHandler(name, args, async () => {
        switch (name) {
          case "send_email":
          case "draft_email": {
            const validatedArgs = SendEmailSchema.parse(args);
            const action = name === "send_email" ? "send" : "draft";
            return await handleEmailAction(action, validatedArgs);
          }

          case "pair_recipient": {
            const validatedArgs = PairRecipientSchema.parse(args);
            const { action, email } = validatedArgs;
            if (action === "list") {
              const addresses = readPairedList();
              return {
                content: [
                  {
                    type: "text",
                    text: `Paired recipients (${addresses.length}):\n${addresses.length > 0 ? addresses.map((a) => `  - ${a}`).join("\n") : "  (none)"}`,
                  },
                ],
                structuredContent: { addresses, count: addresses.length },
              };
            }
            if (!email || email.trim() === "") {
              return {
                content: [
                  {
                    type: "text",
                    text: `pair_recipient action "${action}" requires an \`email\` argument.`,
                  },
                ],
                isError: true,
              };
            }
            if (action === "add") {
              const res = addPairedAddress(email);
              return {
                content: [
                  {
                    type: "text",
                    text: res.added
                      ? `Added "${res.address}" to the paired allowlist.`
                      : `"${res.address}" was already paired; no change.`,
                  },
                ],
                structuredContent: res,
              };
            }
            // action === "remove"
            const res = removePairedAddress(email);
            return {
              content: [
                {
                  type: "text",
                  text: res.removed
                    ? `Removed "${res.address}" from the paired allowlist.`
                    : `"${res.address}" was not in the paired allowlist; no change.`,
                },
              ],
              structuredContent: res,
            };
          }

          case "read_email": {
            const validatedArgs = ReadEmailSchema.parse(args);
            // Fetch the full message even when the caller asked for
            // `headers_only` — the Gmail API's `format: "metadata"`
            // would skip body+attachment parsing server-side, but in
            // our handler we already parse both after the fetch, so the
            // bandwidth save isn't worth the extra code path. The
            // truncation below is what keeps the MCP response under
            // 25k tokens.
            const response = await gmail.users.messages.get({
              userId: "me",
              id: validatedArgs.messageId,
              format: "full",
            });

            const { subject, from, to, date, rfcMessageId } = extractHeaders(response.data.payload);
            const threadId = response.data.threadId || "";
            const headerBlock = `Thread ID: ${threadId}\nMessage-ID: ${rfcMessageId}\nSubject: ${subject}\nFrom: ${from}\nTo: ${to}\nDate: ${date}`;

            if (validatedArgs.format === "headers_only") {
              return { content: [{ type: "text", text: headerBlock }] };
            }

            const { text, html } = extractEmailContent(
              (response.data.payload as GmailMessagePart) || {},
            );

            // Use plain text by default, but fall back to HTML when text is a
            // placeholder stub ("view in browser…") or suspiciously short
            // relative to the HTML body. pickBody centralises that heuristic.
            // read_email keeps the note separate from the body so the body's
            // byte cap (see below) is measured against the actual content, not
            // the marker — get_thread / get_inbox_with_threads inline the
            // marker via pickBodyAnnotated since they don't truncate.
            const { body, source } = pickBody(text, html);
            const contentTypeNote = source === "html" ? HTML_FALLBACK_NOTE : "";

            // Summary mode clamps the body at 500 bytes regardless of
            // maxBodyLength. Full mode uses maxBodyLength (0 disables).
            // Byte-based cap so the threshold lines up with Gmail's own
            // "[Message clipped]" rule (which is byte-based on the raw
            // text+HTML) and so multi-byte characters don't quietly
            // balloon the char-count past the MCP response cap.
            const bodyBytes = Buffer.byteLength(body, "utf-8");
            const hardCap = validatedArgs.format === "summary" ? 500 : validatedArgs.maxBodyLength;
            let displayBody = body;
            let truncationNote = "";
            if (hardCap > 0 && bodyBytes > hardCap) {
              // Slice on a byte boundary, then let TextDecoder drop any
              // trailing incomplete multi-byte sequence — that way a
              // truncated emoji or accent doesn't produce an invisible
              // replacement character in the output.
              const buf = Buffer.from(body, "utf-8").subarray(0, hardCap);
              displayBody = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(buf);
              // Trim the last char if it came back as U+FFFD from a
              // partial code point at the cut point.
              if (displayBody.endsWith("�")) {
                displayBody = displayBody.slice(0, -1);
              }
              const remainingBytes = bodyBytes - hardCap;
              const remainingKB = Math.round((remainingBytes / 1024) * 10) / 10;
              const marker =
                validatedArgs.format === "summary"
                  ? `\n\n[Summary truncated at 500 bytes — ${remainingKB.toLocaleString("en-US")} KB more.]`
                  : `\n\n[Message clipped — ${remainingKB.toLocaleString("en-US")} KB more. Gmail clips at 102 KB in its own UI. Call download_email(messageId: "${validatedArgs.messageId}") to save the full payload to disk, or re-call read_email with maxBodyLength: 0 to disable truncation.]`;
              truncationNote = marker;
            }

            const attachments =
              validatedArgs.includeAttachments && validatedArgs.format !== "summary"
                ? extractAttachments(response.data.payload as GmailMessagePart)
                : [];
            const attachmentInfo =
              attachments.length > 0
                ? `\n\nAttachments (${attachments.length}):\n` +
                  attachments
                    .map(
                      (a) =>
                        `- ${a.filename} (${a.mimeType}, ${Math.round(a.size / 1024)} KB, ID: ${a.id})`,
                    )
                    .join("\n")
                : "";

            return {
              content: [
                {
                  type: "text",
                  text: `${headerBlock}\n\n${contentTypeNote}${displayBody}${truncationNote}${attachmentInfo}`,
                },
              ],
            };
          }

          case "search_emails": {
            const validatedArgs = SearchEmailsSchema.parse(args);
            const response = await gmail.users.messages.list({
              userId: "me",
              q: validatedArgs.query,
              maxResults: validatedArgs.maxResults || 10,
            });

            const messages = response.data.messages || [];
            const results = await Promise.all(
              messages.map(async (msg) => {
                const detail = await gmail.users.messages.get({
                  userId: "me",
                  id: msg.id!,
                  format: "metadata",
                  metadataHeaders: ["Subject", "From", "Date"],
                });
                const headers = detail.data.payload?.headers || [];
                return {
                  id: msg.id,
                  subject: headers.find((h) => h.name === "Subject")?.value || "",
                  from: headers.find((h) => h.name === "From")?.value || "",
                  date: headers.find((h) => h.name === "Date")?.value || "",
                };
              }),
            );

            return {
              content: [
                {
                  type: "text",
                  text: results
                    .map(
                      (r) =>
                        `ID: ${r.id}\nSubject: ${r.subject}\nFrom: ${r.from}\nDate: ${r.date}\n`,
                    )
                    .join("\n"),
                },
              ],
            };
          }

          case "download_email": {
            const validatedArgs = DownloadEmailSchema.parse(args);
            const { messageId, format } = validatedArgs;

            try {
              // Jail the savePath inside GMAIL_MCP_DOWNLOAD_DIR
              // (default ~/GmailDownloads). Prevents a prompt-
              // injected agent from writing downloaded emails into
              // /etc/cron.d/, the user's shell rc file, etc.
              const savePath = resolveDownloadSavePath(validatedArgs.savePath);

              // `full` carries the headers + payload tree the response
              // always needs (subject/from/date + attachments list).
              // When `format === "eml"`, the RFC822 bytes also need a
              // separate `format: "raw"` fetch. Issue both in parallel
              // so EML downloads don't pay a second round-trip to Gmail
              // after the full fetch returns.
              const [fullResponse, rawResponse] = await Promise.all([
                gmail.users.messages.get({ userId: "me", id: messageId, format: "full" }),
                format === "eml"
                  ? gmail.users.messages.get({ userId: "me", id: messageId, format: "raw" })
                  : Promise.resolve(null),
              ]);

              const { subject, from, date } = extractHeaders(fullResponse.data.payload);
              const attachments = extractAttachments(fullResponse.data.payload as GmailMessagePart);

              let content: string;

              if (format === "eml") {
                content = Buffer.from(rawResponse!.data.raw || "", "base64url").toString("utf-8");
              } else {
                // Extract email content for json/txt/html
                const emailContent = extractEmailContent(
                  (fullResponse.data.payload as GmailMessagePart) || {},
                );

                if (format === "json") {
                  const jsonData = gmailMessageToJson(fullResponse.data, emailContent, attachments);
                  content = JSON.stringify(jsonData, null, 2);
                } else if (format === "txt") {
                  content = emailToTxt(fullResponse.data, emailContent, attachments);
                } else {
                  // html - just return the raw HTML content
                  content = emailToHtml(emailContent);
                }
              }

              // Write file via safeWriteFile (O_NOFOLLOW on the
              // leaf, O_EXCL against silent overwrites) so a
              // pre-existing symlink OR regular file at `fullPath`
              // cannot be used to escape the jail that
              // resolveDownloadSavePath already verified for
              // the parent directory. On name collision, suffix
              // ` (1)`, ` (2)`, … — matches browser behavior.
              const filename = `${messageId}.${format}`;
              const requestedPath = path.join(savePath, filename);
              const writtenPath = safeWriteFile(requestedPath, content, { onCollision: "suffix" });
              const stats = fs.statSync(writtenPath);

              // Return metadata with attachments
              const result = {
                status: "saved",
                path: writtenPath,
                size: stats.size,
                messageId,
                subject,
                from,
                date,
                attachments,
              };

              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(result, null, 2),
                  },
                ],
              };
            } catch (error: unknown) {
              const { code, message } = asGmailApiError(error);
              const prefix =
                code !== undefined
                  ? `Failed to download email (HTTP ${code})`
                  : "Failed to download email";
              return {
                content: [
                  {
                    type: "text",
                    text: `${prefix}: ${message}`,
                  },
                ],
                isError: true,
              };
            }
          }

          // Updated implementation for the modify_email handler
          case "modify_email": {
            const validatedArgs = ModifyEmailSchema.parse(args);

            // Prepare request body
            const requestBody: Record<string, unknown> = {};

            if (validatedArgs.labelIds) {
              requestBody.addLabelIds = validatedArgs.labelIds;
            }

            if (validatedArgs.addLabelIds) {
              requestBody.addLabelIds = validatedArgs.addLabelIds;
            }

            if (validatedArgs.removeLabelIds) {
              requestBody.removeLabelIds = validatedArgs.removeLabelIds;
            }

            await gmail.users.messages.modify({
              userId: "me",
              id: validatedArgs.messageId,
              requestBody: requestBody,
            });

            return {
              content: [
                {
                  type: "text",
                  text: `Email ${validatedArgs.messageId} labels updated successfully`,
                },
              ],
            };
          }

          case "delete_email": {
            const validatedArgs = DeleteEmailSchema.parse(args);
            await gmail.users.messages.delete({
              userId: "me",
              id: validatedArgs.messageId,
            });

            return {
              content: [
                {
                  type: "text",
                  text: `Email ${validatedArgs.messageId} deleted successfully`,
                },
              ],
            };
          }

          case "list_email_labels": {
            const labelResults = await listLabels(gmail);
            const systemLabels = labelResults.system;
            const userLabels = labelResults.user;

            return {
              content: [
                {
                  type: "text",
                  text:
                    `Found ${labelResults.count.total} labels (${labelResults.count.system} system, ${labelResults.count.user} user):\n\n` +
                    "System Labels:\n" +
                    systemLabels
                      .map((l: GmailLabel) => `ID: ${l.id}\nName: ${l.name}\n`)
                      .join("\n") +
                    "\nUser Labels:\n" +
                    userLabels.map((l: GmailLabel) => `ID: ${l.id}\nName: ${l.name}\n`).join("\n"),
                },
              ],
            };
          }

          case "batch_modify_emails": {
            const validatedArgs = BatchModifyEmailsSchema.parse(args);
            const messageIds = validatedArgs.messageIds;
            const batchSize = validatedArgs.batchSize || 50;

            // Prepare request body
            const requestBody: Record<string, unknown> = {};

            if (validatedArgs.addLabelIds) {
              requestBody.addLabelIds = validatedArgs.addLabelIds;
            }

            if (validatedArgs.removeLabelIds) {
              requestBody.removeLabelIds = validatedArgs.removeLabelIds;
            }

            // Process messages in batches
            const { successes, failures } = await processBatches(
              messageIds,
              batchSize,
              async (batch) => {
                const results = await Promise.all(
                  batch.map(async (messageId) => {
                    await gmail.users.messages.modify({
                      userId: "me",
                      id: messageId,
                      requestBody: requestBody,
                    });
                    return { messageId, success: true };
                  }),
                );
                return results;
              },
            );

            // Generate summary of the operation
            const successCount = successes.length;
            const failureCount = failures.length;

            let resultText = `Batch label modification complete.\n`;
            resultText += `Successfully processed: ${successCount} messages\n`;

            if (failureCount > 0) {
              resultText += `Failed to process: ${failureCount} messages\n\n`;
              resultText += `Failed message IDs:\n`;
              resultText += failures
                .map((f) => `- ${f.item.substring(0, 16)}... (${f.error.message})`)
                .join("\n");
            }

            return {
              content: [
                {
                  type: "text",
                  text: resultText,
                },
              ],
            };
          }

          case "batch_delete_emails": {
            const validatedArgs = BatchDeleteEmailsSchema.parse(args);
            const messageIds = validatedArgs.messageIds;
            const batchSize = validatedArgs.batchSize || 50;

            // Process messages in batches
            const { successes, failures } = await processBatches(
              messageIds,
              batchSize,
              async (batch) => {
                const results = await Promise.all(
                  batch.map(async (messageId) => {
                    await gmail.users.messages.delete({
                      userId: "me",
                      id: messageId,
                    });
                    return { messageId, success: true };
                  }),
                );
                return results;
              },
            );

            // Generate summary of the operation
            const successCount = successes.length;
            const failureCount = failures.length;

            let resultText = `Batch delete operation complete.\n`;
            resultText += `Successfully deleted: ${successCount} messages\n`;

            if (failureCount > 0) {
              resultText += `Failed to delete: ${failureCount} messages\n\n`;
              resultText += `Failed message IDs:\n`;
              resultText += failures
                .map((f) => `- ${f.item.substring(0, 16)}... (${f.error.message})`)
                .join("\n");
            }

            return {
              content: [
                {
                  type: "text",
                  text: resultText,
                },
              ],
            };
          }

          // New label management handlers
          case "create_label": {
            const validatedArgs = CreateLabelSchema.parse(args);
            const result = await createLabel(gmail, validatedArgs.name, {
              messageListVisibility: validatedArgs.messageListVisibility,
              labelListVisibility: validatedArgs.labelListVisibility,
            });

            return {
              content: [
                {
                  type: "text",
                  text: `Label created successfully:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`,
                },
              ],
            };
          }

          case "update_label": {
            const validatedArgs = UpdateLabelSchema.parse(args);

            // Prepare request body with only the fields that were provided
            const updates: Record<string, unknown> = {};
            if (validatedArgs.name) updates.name = validatedArgs.name;
            if (validatedArgs.messageListVisibility)
              updates.messageListVisibility = validatedArgs.messageListVisibility;
            if (validatedArgs.labelListVisibility)
              updates.labelListVisibility = validatedArgs.labelListVisibility;

            const result = await updateLabel(gmail, validatedArgs.id, updates);

            return {
              content: [
                {
                  type: "text",
                  text: `Label updated successfully:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`,
                },
              ],
            };
          }

          case "delete_label": {
            const validatedArgs = DeleteLabelSchema.parse(args);
            const result = await deleteLabel(gmail, validatedArgs.id);

            return {
              content: [
                {
                  type: "text",
                  text: result.message,
                },
              ],
            };
          }

          case "get_or_create_label": {
            const validatedArgs = GetOrCreateLabelSchema.parse(args);
            const result = await getOrCreateLabel(gmail, validatedArgs.name, {
              messageListVisibility: validatedArgs.messageListVisibility,
              labelListVisibility: validatedArgs.labelListVisibility,
            });

            const action =
              result.type === "user" && result.name === validatedArgs.name
                ? "found existing"
                : "created new";

            return {
              content: [
                {
                  type: "text",
                  text: `Successfully ${action} label:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`,
                },
              ],
            };
          }

          // Filter management handlers
          case "create_filter": {
            const validatedArgs = CreateFilterSchema.parse(args);
            // The `action.forward` field installs a persistent server-side
            // mail-forwarding rule. Gmail itself only allows forwarding to
            // pre-verified addresses, but a prompt-injected agent on a
            // settings.basic token could still pick any verified address —
            // including one the human added long ago and forgot. Gate the
            // forward action through the same recipient-pairing allowlist
            // that protects send_email / reply_all / draft_email so the
            // exfil channel stays closed when the gate is enabled.
            if (validatedArgs.action.forward) {
              requirePairedRecipients([validatedArgs.action.forward]);
            }
            const result = await createFilter(gmail, validatedArgs.criteria, validatedArgs.action);

            // Format criteria for display
            const criteriaText = Object.entries(validatedArgs.criteria)
              .filter(([_, value]) => value !== undefined)
              .map(([key, value]) => `${key}: ${value}`)
              .join(", ");

            // Format actions for display
            const actionText = Object.entries(validatedArgs.action)
              .filter(
                ([_, value]) =>
                  value !== undefined && (Array.isArray(value) ? value.length > 0 : true),
              )
              .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
              .join(", ");

            return {
              content: [
                {
                  type: "text",
                  text: `Filter created successfully:\nID: ${result.id}\nCriteria: ${criteriaText}\nActions: ${actionText}`,
                },
              ],
            };
          }

          case "list_filters": {
            const result = await listFilters(gmail);
            const filters = result.filters;

            if (filters.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: "No filters found.",
                  },
                ],
              };
            }

            const filtersText = filters
              .map((filter) => {
                const criteriaEntries = Object.entries(filter.criteria || {})
                  .filter(([_, value]) => value !== undefined)
                  .map(([key, value]) => `${key}: ${value}`)
                  .join(", ");

                const actionEntries = Object.entries(filter.action || {})
                  .filter(
                    ([_, value]) =>
                      value !== undefined && (Array.isArray(value) ? value.length > 0 : true),
                  )
                  .map(
                    ([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`,
                  )
                  .join(", ");

                return `ID: ${filter.id}\nCriteria: ${criteriaEntries}\nActions: ${actionEntries}\n`;
              })
              .join("\n");

            return {
              content: [
                {
                  type: "text",
                  text: `Found ${result.count} filters:\n\n${filtersText}`,
                },
              ],
            };
          }

          case "get_filter": {
            const validatedArgs = GetFilterSchema.parse(args);
            const result = await getFilter(gmail, validatedArgs.filterId);

            const criteriaText = Object.entries(result.criteria || {})
              .filter(([_, value]) => value !== undefined)
              .map(([key, value]) => `${key}: ${value}`)
              .join(", ");

            const actionText = Object.entries(result.action || {})
              .filter(
                ([_, value]) =>
                  value !== undefined && (Array.isArray(value) ? value.length > 0 : true),
              )
              .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
              .join(", ");

            return {
              content: [
                {
                  type: "text",
                  text: `Filter details:\nID: ${result.id}\nCriteria: ${criteriaText}\nActions: ${actionText}`,
                },
              ],
            };
          }

          case "delete_filter": {
            const validatedArgs = DeleteFilterSchema.parse(args);
            const result = await deleteFilter(gmail, validatedArgs.filterId);

            return {
              content: [
                {
                  type: "text",
                  text: result.message,
                },
              ],
            };
          }

          case "create_filter_from_template": {
            const validatedArgs = CreateFilterFromTemplateSchema.parse(args);
            const template = validatedArgs.template;
            const params = validatedArgs.parameters;

            let filterConfig;

            switch (template) {
              case "fromSender":
                if (!params.senderEmail)
                  throw new Error("senderEmail is required for fromSender template");
                filterConfig = filterTemplates.fromSender(
                  params.senderEmail,
                  params.labelIds,
                  params.archive,
                );
                break;
              case "withSubject":
                if (!params.subjectText)
                  throw new Error("subjectText is required for withSubject template");
                filterConfig = filterTemplates.withSubject(
                  params.subjectText,
                  params.labelIds,
                  params.markAsRead,
                );
                break;
              case "withAttachments":
                filterConfig = filterTemplates.withAttachments(params.labelIds);
                break;
              case "largeEmails":
                if (!params.sizeInBytes)
                  throw new Error("sizeInBytes is required for largeEmails template");
                filterConfig = filterTemplates.largeEmails(params.sizeInBytes, params.labelIds);
                break;
              case "containingText":
                if (!params.searchText)
                  throw new Error("searchText is required for containingText template");
                filterConfig = filterTemplates.containingText(
                  params.searchText,
                  params.labelIds,
                  params.markImportant,
                );
                break;
              case "mailingList":
                if (!params.listIdentifier)
                  throw new Error("listIdentifier is required for mailingList template");
                filterConfig = filterTemplates.mailingList(
                  params.listIdentifier,
                  params.labelIds,
                  params.archive,
                );
                break;
              default:
                throw new Error(`Unknown template: ${template}`);
            }

            const result = await createFilter(gmail, filterConfig.criteria, filterConfig.action);

            return {
              content: [
                {
                  type: "text",
                  text: `Filter created from template '${template}':\nID: ${result.id}\nTemplate used: ${template}`,
                },
              ],
            };
          }
          case "download_attachment": {
            const validatedArgs = DownloadAttachmentSchema.parse(args);

            try {
              // Get the attachment data from Gmail API
              const attachmentResponse = await gmail.users.messages.attachments.get({
                userId: "me",
                messageId: validatedArgs.messageId,
                id: validatedArgs.attachmentId,
              });

              if (!attachmentResponse.data.data) {
                throw new Error("No attachment data received");
              }

              // Decode the base64 data
              const data = attachmentResponse.data.data;
              const buffer = Buffer.from(data, "base64url");

              // Jail the savePath inside GMAIL_MCP_DOWNLOAD_DIR
              // (default ~/GmailDownloads). The previous behavior
              // (fall back to process.cwd()) wrote attachments to
              // the MCP server's working directory, which could be
              // anywhere — including directories containing the
              // user's source code or config files.
              //
              // Fall back to the *configured* jail root via
              // getDownloadDir(), not a hardcoded ~/GmailDownloads
              // — otherwise when the user sets GMAIL_MCP_DOWNLOAD_DIR
              // to a custom path, the hardcoded default would be
              // rejected by resolveDownloadSavePath() and the tool
              // would break whenever savePath is omitted.
              const savePath = resolveDownloadSavePath(validatedArgs.savePath ?? getDownloadDir());
              let filename = validatedArgs.filename;

              if (!filename) {
                // Get original filename from message if not provided
                const messageResponse = await gmail.users.messages.get({
                  userId: "me",
                  id: validatedArgs.messageId,
                  format: "full",
                });

                // Find the attachment part to get original filename
                const findAttachment = (part: GmailMessagePart): string | null => {
                  if (part.body && part.body.attachmentId === validatedArgs.attachmentId) {
                    return part.filename || `attachment-${validatedArgs.attachmentId}`;
                  }
                  if (part.parts) {
                    for (const subpart of part.parts) {
                      const found = findAttachment(subpart);
                      if (found) return found;
                    }
                  }
                  return null;
                };

                filename =
                  (messageResponse.data.payload
                    ? findAttachment(messageResponse.data.payload)
                    : null) || `attachment-${validatedArgs.attachmentId}`;
              }

              // Sanitize filename to prevent path traversal. `basename`
              // only strips `/`-delimited prefixes; `sanitizeAttachmentFilename`
              // also handles Windows backslashes, NUL bytes, and control
              // chars that a hostile sender can embed in the MIME
              // `filename` attribute. Order matters: sanitize first so
              // backslash-separated segments survive for basename to
              // strip; belt-and-braces basename after in case the
              // sanitizer ever lets a `/` through.
              filename = path.basename(sanitizeAttachmentFilename(filename));

              // savePath is already realpath-resolved inside the
              // download jail by resolveDownloadSavePath above.
              // Defense-in-depth: re-check the final path, then
              // use safeWriteFile (O_NOFOLLOW on the leaf, O_EXCL
              // against silent overwrites) so neither a pre-existing
              // symlink NOR a pre-existing regular file at `fullPath`
              // can be used to escape the jail or clobber a user
              // file sharing the same name. On collision, suffix
              // ` (1)`, ` (2)`, …
              const fullPath = path.resolve(savePath, filename);
              if (!fullPath.startsWith(savePath + path.sep) && fullPath !== savePath) {
                throw new Error("Invalid filename: path traversal detected");
              }
              const writtenPath = safeWriteFile(fullPath, buffer, { onCollision: "suffix" });

              return {
                content: [
                  {
                    type: "text",
                    text: `Attachment downloaded successfully:\nFile: ${path.basename(writtenPath)}\nSize: ${buffer.length} bytes\nSaved to: ${writtenPath}`,
                  },
                ],
              };
            } catch (error: unknown) {
              const { code, message } = asGmailApiError(error);
              const prefix =
                code !== undefined
                  ? `Failed to download attachment (HTTP ${code})`
                  : "Failed to download attachment";
              return {
                content: [
                  {
                    type: "text",
                    text: `${prefix}: ${message}`,
                  },
                ],
                isError: true,
              };
            }
          }

          case "get_thread": {
            const validatedArgs = GetThreadSchema.parse(args);
            const threadResponse = await gmail.users.threads.get({
              userId: "me",
              id: validatedArgs.threadId,
              format: validatedArgs.format || "full",
            });

            const threadMessages = threadResponse.data.messages || [];

            // Process each message in the thread (already chronological from API)
            const messagesOutput = threadMessages.map((msg) => {
              const headers = msg.payload?.headers || [];
              const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
              const from = headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
              const to = headers.find((h) => h.name?.toLowerCase() === "to")?.value || "";
              const cc = headers.find((h) => h.name?.toLowerCase() === "cc")?.value || "";
              const bcc = headers.find((h) => h.name?.toLowerCase() === "bcc")?.value || "";
              const date = headers.find((h) => h.name?.toLowerCase() === "date")?.value || "";

              // Extract body content. pickBodyAnnotated prepends the same
              // "[Note: This email is HTML-formatted…]" marker that read_email
              // uses when pickBody falls back to the HTML part, so a thread
              // message carries the identical annotation.
              let body = "";
              if (validatedArgs.format !== "minimal") {
                const { text, html } = extractEmailContent((msg.payload as GmailMessagePart) || {});
                body = pickBodyAnnotated(text, html).body;
              }

              // Extract attachment metadata.
              // Depth-bounded via collectAttachmentsForThread.
              const attachments = msg.payload
                ? collectAttachmentsForThread(msg.payload, "get_thread.processAttachmentParts")
                : [];

              return {
                messageId: msg.id || "",
                threadId: msg.threadId || "",
                from,
                to,
                cc,
                bcc,
                subject,
                date,
                body,
                labelIds: msg.labelIds || [],
                attachments: attachments.map((a) => ({
                  filename: a.filename,
                  mimeType: a.mimeType,
                  size: a.size,
                })),
              };
            });

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      threadId: validatedArgs.threadId,
                      messageCount: messagesOutput.length,
                      messages: messagesOutput,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }

          case "list_inbox_threads": {
            const validatedArgs = ListInboxThreadsSchema.parse(args);
            const threadsResponse = await gmail.users.threads.list({
              userId: "me",
              q: validatedArgs.query || "in:inbox",
              maxResults: validatedArgs.maxResults || 50,
            });

            const threads = threadsResponse.data.threads || [];

            // Fetch metadata for each thread to get message count and latest message info
            const threadDetails = await Promise.all(
              threads.map(async (thread) => {
                const detail = await gmail.users.threads.get({
                  userId: "me",
                  id: thread.id!,
                  format: "metadata",
                  metadataHeaders: ["Subject", "From", "Date"],
                });

                const messages = detail.data.messages || [];
                const latestMessage = messages[messages.length - 1];
                const latestHeaders = latestMessage?.payload?.headers || [];

                return {
                  threadId: thread.id || "",
                  snippet: thread.snippet || "",
                  historyId: thread.historyId || "",
                  messageCount: messages.length,
                  latestMessage: {
                    from: latestHeaders.find((h) => h.name === "From")?.value || "",
                    subject: latestHeaders.find((h) => h.name === "Subject")?.value || "",
                    date: latestHeaders.find((h) => h.name === "Date")?.value || "",
                  },
                };
              }),
            );

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      resultCount: threadDetails.length,
                      threads: threadDetails,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }

          case "get_inbox_with_threads": {
            const validatedArgs = GetInboxWithThreadsSchema.parse(args);
            const threadsResponse = await gmail.users.threads.list({
              userId: "me",
              q: validatedArgs.query || "in:inbox",
              maxResults: validatedArgs.maxResults || 50,
            });

            const threads = threadsResponse.data.threads || [];

            if (!validatedArgs.expandThreads) {
              // Return basic thread list without expansion (same as list_inbox_threads)
              const threadSummaries = await Promise.all(
                threads.map(async (thread) => {
                  const detail = await gmail.users.threads.get({
                    userId: "me",
                    id: thread.id!,
                    format: "metadata",
                    metadataHeaders: ["Subject", "From", "Date"],
                  });

                  const messages = detail.data.messages || [];
                  const latestMessage = messages[messages.length - 1];
                  const latestHeaders = latestMessage?.payload?.headers || [];

                  return {
                    threadId: thread.id || "",
                    snippet: thread.snippet || "",
                    historyId: thread.historyId || "",
                    messageCount: messages.length,
                    latestMessage: {
                      from: latestHeaders.find((h) => h.name === "From")?.value || "",
                      subject: latestHeaders.find((h) => h.name === "Subject")?.value || "",
                      date: latestHeaders.find((h) => h.name === "Date")?.value || "",
                    },
                  };
                }),
              );

              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      {
                        resultCount: threadSummaries.length,
                        threads: threadSummaries,
                      },
                      null,
                      2,
                    ),
                  },
                ],
              };
            }

            // Expand each thread with full message content (parallel fetch)
            const expandedThreads = await Promise.all(
              threads.map(async (thread) => {
                const threadDetail = await gmail.users.threads.get({
                  userId: "me",
                  id: thread.id!,
                  format: "full",
                });

                const threadMessages = threadDetail.data.messages || [];

                const messages = threadMessages.map((msg) => {
                  const headers = msg.payload?.headers || [];
                  const subject =
                    headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
                  const from = headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
                  const to = headers.find((h) => h.name?.toLowerCase() === "to")?.value || "";
                  const cc = headers.find((h) => h.name?.toLowerCase() === "cc")?.value || "";
                  const bcc = headers.find((h) => h.name?.toLowerCase() === "bcc")?.value || "";
                  const date = headers.find((h) => h.name?.toLowerCase() === "date")?.value || "";

                  const { text, html } = extractEmailContent(
                    (msg.payload as GmailMessagePart) || {},
                  );
                  // Same HTML-fallback note as `read_email` / `get_thread`.
                  const body = pickBodyAnnotated(text, html).body;

                  // Extract attachment metadata.
                  // Depth-bounded via collectAttachmentsForThread.
                  const attachments = msg.payload
                    ? collectAttachmentsForThread(
                        msg.payload,
                        "list_inbox_threads.processAttachmentParts",
                      )
                    : [];

                  return {
                    messageId: msg.id || "",
                    threadId: msg.threadId || "",
                    from,
                    to,
                    cc,
                    bcc,
                    subject,
                    date,
                    body,
                    labelIds: msg.labelIds || [],
                    attachments: attachments.map((a) => ({
                      filename: a.filename,
                      mimeType: a.mimeType,
                      size: a.size,
                    })),
                  };
                });

                return {
                  threadId: thread.id || "",
                  messageCount: messages.length,
                  messages,
                };
              }),
            );

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      resultCount: expandedThreads.length,
                      threads: expandedThreads,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }

          case "reply_all": {
            const validatedArgs = ReplyAllSchema.parse(args);

            // Fetch the original email to get headers
            const originalEmail = await gmail.users.messages.get({
              userId: "me",
              id: validatedArgs.messageId,
              format: "full",
            });

            const headers = originalEmail.data.payload?.headers || [];
            const threadId = originalEmail.data.threadId || "";

            // Extract relevant headers
            const originalFrom = headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
            const originalTo = headers.find((h) => h.name?.toLowerCase() === "to")?.value || "";
            const originalCc = headers.find((h) => h.name?.toLowerCase() === "cc")?.value || "";
            const originalSubject =
              headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
            const originalMessageId =
              headers.find((h) => h.name?.toLowerCase() === "message-id")?.value || "";
            const originalReferences =
              headers.find((h) => h.name?.toLowerCase() === "references")?.value || "";

            // Get authenticated user's email to exclude from recipients
            const profile = await gmail.users.getProfile({ userId: "me" });
            const myEmail = profile.data.emailAddress?.toLowerCase() || "";

            // Build recipient list using helper functions
            const { to: replyTo, cc: replyCc } = buildReplyAllRecipients(
              originalFrom,
              originalTo,
              originalCc,
              myEmail,
            );

            if (replyTo.length === 0) {
              throw new Error("Could not determine recipient for reply");
            }

            // Build subject with "Re:" prefix if not already present
            const replySubject = addRePrefix(originalSubject);

            // Build References header (original References + original Message-ID)
            const references = buildReferencesHeader(originalReferences, originalMessageId);

            // Prepare the email arguments for handleEmailAction
            const emailArgs = {
              to: replyTo,
              cc: replyCc.length > 0 ? replyCc : undefined,
              subject: replySubject,
              body: validatedArgs.body,
              htmlBody: validatedArgs.htmlBody,
              mimeType: validatedArgs.mimeType,
              threadId: threadId,
              inReplyTo: originalMessageId,
              references,
              attachments: validatedArgs.attachments,
            };

            // Use the existing handleEmailAction to send the reply
            await handleEmailAction("send", emailArgs);

            // Enhance the response with reply-all specific info
            return {
              content: [
                {
                  type: "text",
                  text: `Reply-all sent successfully!\nTo: ${replyTo.join(", ")}${replyCc.length > 0 ? `\nCC: ${replyCc.join(", ")}` : ""}\nSubject: ${replySubject}\nThread ID: ${threadId}`,
                },
              ],
            };
          }

          case "modify_thread": {
            const validatedArgs = ModifyThreadSchema.parse(args);

            // Prepare request body for threads.modify
            const modifyRequestBody: Record<string, unknown> = {};

            if (validatedArgs.addLabelIds) {
              modifyRequestBody.addLabelIds = validatedArgs.addLabelIds;
            }

            if (validatedArgs.removeLabelIds) {
              modifyRequestBody.removeLabelIds = validatedArgs.removeLabelIds;
            }

            await gmail.users.threads.modify({
              userId: "me",
              id: validatedArgs.threadId,
              requestBody: modifyRequestBody,
            });

            return {
              content: [
                {
                  type: "text",
                  text: `Thread ${validatedArgs.threadId} labels updated successfully (all messages in thread modified)`,
                },
              ],
            };
          }

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      });
    } catch (error: unknown) {
      // wrapToolHandler has already logged the audit entry as "error"
      // and re-thrown. Format the failure as a user-readable MCP
      // response here (behaviour preserved from the prior inline
      // catch).
      //
      // Special-case `invalid_grant` before the generic fallback:
      // google-auth-library throws when the stored refresh token is
      // rejected (user revoked consent, 6-month inactivity expiry,
      // token reissued elsewhere). Surface a stable structured
      // payload so clients can branch on `code === "INVALID_GRANT"`
      // and present the recovery action, rather than parsing a
      // free-text Gmail message.
      if (isInvalidGrantError(error)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(buildInvalidGrantPayload(CREDENTIALS_PATH), null, 2),
            },
          ],
          isError: true,
        };
      }
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: sanitizeForLlm(`Error: ${msg}`),
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
