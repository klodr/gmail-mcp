/**
 * E2E tests for the trivial-tool registrars introduced in PR #3.
 *
 * Each registrar wires its tools into a real `McpServer` (built via
 * `createServer`), connected to an `InMemoryTransport` pair. A
 * `Client` then issues real `tools/call` requests and we assert on
 * the parsed result. This pins the entire `Client → SDK → defineTool
 * adapter → wrapToolHandler → handler → gmail mock` round-trip — the
 * exact pipeline that PR #7's switchover will run in production.
 *
 * Note: the legacy dispatcher in `src/index.ts` is not exercised
 * here. Until PR #7 wires `createServer` into the entry point, the
 * production runtime still routes tool calls through that dispatcher;
 * these tests cover the parallel `McpServer` path that PR #7 will
 * promote to default.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { gmail_v1 } from "googleapis";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import { resetRateLimitHistory } from "../rate-limit.js";
import { resetJailDirCache } from "../utl.js";

// Per-test rate-limit isolation: each test gets its own GMAIL_MCP_STATE_DIR
// so the persistent rate-limit ledger does not leak across tests (without
// this, the ~20 filter-tool calls below the 24h cap of the "filters"
// bucket and subsequent tests get 429-ed). Same for download-jail
// (GMAIL_MCP_DOWNLOAD_DIR + the in-process jail-root cache) so the
// download tests in PR #6 do not write to one another's directories.
let stateDir: string;
let downloadDir: string;
let attachmentDir: string;
let pairedPath: string;
const originalEnv = { ...process.env };

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "gmail-mcp-registrars-test-"));
  downloadDir = mkdtempSync(join(tmpdir(), "gmail-mcp-download-test-"));
  // Send-email attachment jail. Defaults to `~/GmailAttachments/` in
  // production; pin per-test to a tempdir so the host's real
  // attachment dir is never touched and each test gets an isolated
  // realpath-resolved jail root.
  attachmentDir = mkdtempSync(join(tmpdir(), "gmail-mcp-attach-test-"));
  // pair_recipient writes to GMAIL_MCP_PAIRED_PATH — point it at a
  // file inside the temp state-dir so each test gets a fresh
  // allowlist and the host's real ~/.gmail-mcp/paired.json is never
  // touched.
  pairedPath = join(stateDir, "paired.json");
  process.env.GMAIL_MCP_PAIRED_PATH = pairedPath;
  process.env.GMAIL_MCP_STATE_DIR = stateDir;
  process.env.GMAIL_MCP_DOWNLOAD_DIR = downloadDir;
  process.env.GMAIL_MCP_ATTACHMENT_DIR = attachmentDir;
  delete process.env.GMAIL_MCP_RATE_LIMIT_DISABLE;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("GMAIL_MCP_RATE_LIMIT_") && k !== "GMAIL_MCP_RATE_LIMIT_DISABLE") {
      delete process.env[k];
    }
  }
  resetRateLimitHistory();
  resetJailDirCache();
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(downloadDir, { recursive: true, force: true });
  rmSync(attachmentDir, { recursive: true, force: true });
  process.env = { ...originalEnv };
  resetRateLimitHistory();
  resetJailDirCache();
});

interface MockedGmailCalls {
  messageDelete: Array<unknown>;
  messageGet: Array<unknown>;
  messageList: Array<unknown>;
  messageModify: Array<unknown>;
  attachmentGet: Array<unknown>;
  messageSend: Array<unknown>;
  draftCreate: Array<unknown>;
  draftList: Array<unknown>;
  draftGet: Array<unknown>;
  draftUpdate: Array<unknown>;
  draftDelete: Array<unknown>;
  draftSend: Array<unknown>;
  getProfile: Array<unknown>;
  threadModify: Array<unknown>;
  threadGet: Array<unknown>;
  threadList: Array<unknown>;
  filterDelete: Array<unknown>;
  filterCreate: Array<unknown>;
  filterList: Array<unknown>;
  filterGet: Array<unknown>;
  labelDelete: Array<unknown>;
  labelCreate: Array<unknown>;
  labelUpdate: Array<unknown>;
  labelList: Array<unknown>;
  sendAsList: Array<unknown>;
}

interface MockGmailOpts {
  /**
   * Pre-existing labels returned by `gmail.users.labels.list`. Used by
   * `getOrCreateLabel` (look up by name first; create if absent).
   */
  existingLabels?: Array<{ id: string; name: string; type?: string }>;
  /**
   * Body bytes returned by `gmail.users.messages.get`'s `text/plain`
   * MIME part for the `read_email` truncation tests.
   */
  messageBodyText?: string;
  /**
   * Optional `text/html` MIME part body. When set, the mock adds a
   * second part with `mimeType: "text/html"` so tests that need an
   * HTML alternative (e.g., `download_email format=html`) can
   * exercise the `emailToHtml` branch.
   */
  messageBodyHtml?: string;
  /**
   * Override the default `From: Alice <alice@example.com>` header on
   * `messages.get` responses. Used by tests that need an
   * empty-recipients reply_all path (the throw at
   * `messaging.ts:171`): set `messageFromOverride: "me@example.com"`
   * so `filterOutEmail` strips the only sender and `replyTo` ends
   * up empty.
   */
  messageFromOverride?: string;
  /**
   * Override the optional `Sender:` header on `messages.get`
   * responses. Default: header is absent. Used by the reply_to_email
   * tests that pin RFC 5322 §3.6.2 behaviour — when both From: and
   * Sender: are present, the resolver prefers Sender.
   */
  messageSenderOverride?: string;
  /**
   * Override the optional `Reply-To:` header on `messages.get`
   * responses. Default: header is absent. Used by reply_to_email
   * tests that pin RFC 5322 §3.6.2 precedence: when both Reply-To:
   * and From: are present, the resolver prefers Reply-To (the
   * mailing-list pattern: From=list, Reply-To=author).
   */
  messageReplyToOverride?: string;
  /**
   * Messages list returned by `gmail.users.messages.list` for
   * `search_emails`.
   */
  searchResults?: Array<{ id: string; subject?: string; from?: string; date?: string }>;
  /**
   * Pre-existing thread structure returned by
   * `gmail.users.threads.list` + `gmail.users.threads.get`. Keyed by
   * threadId for the `get` lookup.
   */
  threads?: Record<
    string,
    {
      snippet?: string;
      historyId?: string;
      messages: Array<{
        id: string;
        labelIds?: string[];
        bodyText?: string;
        from?: string;
        subject?: string;
      }>;
    }
  >;
  /**
   * Attachment payload returned by `gmail.users.messages.attachments.get`
   * (base64url-encoded). Used by `download_attachment` tests.
   */
  attachmentData?: string;
  /**
   * When set to an empty string, `gmail.users.messages.attachments.get`
   * returns `{ data: { data: "", size: 0 } }` so the
   * "No attachment data received" guard in `download_attachment`
   * (`src/tools/downloads.ts:125-127`) fires.
   */
  attachmentDataEmpty?: boolean;
  /**
   * When set, `gmail.users.messages.get` injects an additional
   * attachment-bearing part into the payload — `{ partId, filename,
   * mimeType, body: { attachmentId, size } }`. Used by tests that
   * exercise the attachment-mapping branches in `read_email`,
   * `get_thread`, `get_inbox_with_threads`, and the
   * "filename found in payload" path in `download_attachment`.
   */
  messageAttachments?: Array<{
    partId: string;
    filename: string;
    mimeType: string;
    attachmentId: string;
    size: number;
  }>;
  /**
   * When true, `gmail.users.settings.filters.list` returns an empty
   * `filter` array instead of the default single-seeded filter.
   * Used to exercise the empty-list branch in `list_filters`.
   */
  noFilters?: boolean;
  /**
   * When set to a numeric HTTP status, `gmail.users.messages.get` (and
   * `attachments.get`) throw an Error with `.code = <status>` so the
   * `asGmailApiError` formatter prefixes the failure with `(HTTP <status>)`.
   * Pins the HTTP-error branch in `download_email` / `download_attachment`.
   */
  messageGetHttpError?: number;
  attachmentGetHttpError?: number;
  /**
   * When set, `gmail.users.threads.get` throws an Error with this
   * code. Pins the degraded `update_draft` path where thread-header
   * backfill fails — handler logs a warning and continues without
   * threading headers.
   */
  threadGetHttpError?: number;
  /**
   * When set, `gmail.users.messages.modify` and
   * `gmail.users.messages.delete` throw a generic Error for any
   * `id` listed here. Pins the per-item failure-collection branch in
   * `batch_modify_emails` / `batch_delete_emails`
   * (`processBatches` records `failures[]` and the registrar prints
   * the "Failed to … N messages" footer).
   */
  failOnIds?: string[];
  /**
   * Drafts seed data returned by `gmail.users.drafts.list`. Each entry
   * becomes a `{id, message:{id, threadId}}` row in the response.
   */
  drafts?: Array<{ id: string; messageId?: string; threadId?: string }>;
  /**
   * `nextPageToken` for `drafts.list`. Set to a non-empty string to
   * exercise the pagination branch (the registrar appends a "Next
   * page token: …" footer when present).
   */
  draftsNextPageToken?: string;
  /**
   * `resultSizeEstimate` for `drafts.list`. Defaults to `drafts.length`
   * — override only to test count-vs-estimate divergence.
   */
  draftsResultSizeEstimate?: number;
  /**
   * When set to a numeric HTTP status, the matching `drafts.*` mock
   * throws an Error with `.code = <status>`. Pins the catch branch in
   * `src/tools/drafts.ts` for each verb.
   */
  draftListHttpError?: number;
  draftGetHttpError?: number;
  draftUpdateHttpError?: number;
  draftDeleteHttpError?: number;
  draftSendHttpError?: number;
  /**
   * Inject a `Bcc:` header into the draft returned by
   * `drafts.get`. Used by the send_draft pairing-gate Bcc bypass
   * test (the metadata projection from Gmail can omit Bcc;
   * full-format must round-trip it).
   */
  draftBccHeader?: string;
  /**
   * Inject extra `{name, value}` headers into the draft returned by
   * `drafts.get`. Used by the send_draft multi-header bypass test:
   * RFC 5322 allows repeated `To` / `Cc` / `Bcc` and Gmail merges
   * them when sending, so the pairing gate must collect *every*
   * matching header instance, not just the first.
   */
  draftExtraHeaders?: Array<{ name: string; value: string }>;
}

function mockGmail(opts: MockGmailOpts = {}): {
  client: gmail_v1.Gmail;
  calls: MockedGmailCalls;
} {
  const calls: MockedGmailCalls = {
    messageDelete: [],
    messageGet: [],
    messageList: [],
    messageModify: [],
    messageSend: [],
    draftCreate: [],
    draftList: [],
    draftGet: [],
    draftUpdate: [],
    draftDelete: [],
    draftSend: [],
    getProfile: [],
    attachmentGet: [],
    threadModify: [],
    threadGet: [],
    threadList: [],
    filterDelete: [],
    filterCreate: [],
    filterList: [],
    filterGet: [],
    labelDelete: [],
    labelCreate: [],
    labelUpdate: [],
    labelList: [],
    sendAsList: [],
  };
  const client = {
    users: {
      messages: {
        attachments: {
          get: async (params: unknown) => {
            calls.attachmentGet.push(params);
            if (opts.attachmentGetHttpError !== undefined) {
              const err: Error & { code?: number } = new Error("Simulated Gmail API failure");
              err.code = opts.attachmentGetHttpError;
              throw err;
            }
            if (opts.attachmentDataEmpty) {
              // Pin the "No attachment data received" guard branch in
              // `src/tools/downloads.ts:125-127`. Gmail returns an
              // empty `data` field rarely (corrupt server-side state,
              // expired temporary URL) and the guard surfaces it as
              // a clean error.
              return { data: { data: "", size: 0 } };
            }
            const data =
              opts.attachmentData ??
              Buffer.from("%PDF-1.4 fake pdf content", "utf-8").toString("base64url");
            return { data: { data, size: data.length } };
          },
        },
        delete: async (params: unknown) => {
          calls.messageDelete.push(params);
          const id = (params as { id?: string }).id;
          if (id !== undefined && opts.failOnIds?.includes(id)) {
            throw new Error(`Simulated delete failure for ${id}`);
          }
          return { data: {} };
        },
        modify: async (params: unknown) => {
          calls.messageModify.push(params);
          const id = (params as { id?: string }).id;
          if (id !== undefined && opts.failOnIds?.includes(id)) {
            throw new Error(`Simulated modify failure for ${id}`);
          }
          return { data: {} };
        },
        send: async (params: unknown) => {
          calls.messageSend.push(params);
          return { data: { id: `msg_sent_${calls.messageSend.length}` } };
        },
        get: async (params: unknown) => {
          calls.messageGet.push(params);
          if (opts.messageGetHttpError !== undefined) {
            const err: Error & { code?: number } = new Error("Simulated Gmail API failure");
            err.code = opts.messageGetHttpError;
            throw err;
          }
          const id = (params as { id?: string }).id ?? "msg_unknown";
          const format = (params as { format?: string }).format ?? "full";
          // Reject unsupported formats so the test fixture does not
          // accidentally pass when a registrar regression switches to
          // `format: "minimal"` (or anything else not actually wired).
          // The 3 supported formats are: "full" (read_email,
          // download_email, get_inbox_with_threads), "raw"
          // (download_email format=eml), "metadata" (search_emails
          // header-only fetch). CR finding on PR #84.
          const SUPPORTED = new Set(["full", "raw", "metadata"]);
          if (!SUPPORTED.has(format)) {
            throw new Error(
              `mockGmail: messages.get called with unexpected format=${format}; supported: ${[...SUPPORTED].join(", ")} (id=${id})`,
            );
          }
          // Build a minimal MIME tree with one text/plain part
          // carrying the supplied body. Sufficient for read_email's
          // header + body + truncation logic, and for download_email
          // (json/txt/html) which extracts the same shape.
          const bodyText = opts.messageBodyText ?? "default body content";
          const bodyB64 = Buffer.from(bodyText, "utf-8")
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
          // Optionally inject attachment-bearing parts so tests can
          // exercise the attachment-mapping branches in read_email
          // (`messages.ts:108-115`), get_thread / get_inbox_with_threads
          // (`threads.ts:107`/`289`), and download_attachment's
          // "filename found in payload" path (`downloads.ts:142-144`).
          const attParts = (opts.messageAttachments ?? []).map((a) => ({
            partId: a.partId,
            filename: a.filename,
            mimeType: a.mimeType,
            body: { attachmentId: a.attachmentId, size: a.size },
          }));
          // Optional text/html alternative — needed by
          // `download_email format=html` (otherwise `emailToHtml`
          // throws "This email has no HTML content") and the
          // multi-alternative resolver tests in `email-resolver.ts`.
          const htmlParts = opts.messageBodyHtml
            ? [
                {
                  mimeType: "text/html",
                  body: {
                    size: opts.messageBodyHtml.length,
                    data: Buffer.from(opts.messageBodyHtml, "utf-8")
                      .toString("base64")
                      .replace(/\+/g, "-")
                      .replace(/\//g, "_")
                      .replace(/=+$/, ""),
                  },
                },
              ]
            : [];
          const fullBase = {
            id,
            threadId: `thread_for_${id}`,
            payload: {
              headers: [
                {
                  name: "From",
                  value: opts.messageFromOverride ?? "Alice <alice@example.com>",
                },
                { name: "To", value: opts.messageFromOverride ? "" : "bob@example.com" },
                { name: "Subject", value: `Test message ${id}` },
                { name: "Date", value: "Fri, 25 Apr 2026 10:00:00 +0000" },
                { name: "Message-ID", value: `<${id}@example.com>` },
                ...(opts.messageSenderOverride
                  ? [{ name: "Sender", value: opts.messageSenderOverride }]
                  : []),
                ...(opts.messageReplyToOverride
                  ? [{ name: "Reply-To", value: opts.messageReplyToOverride }]
                  : []),
              ],
              parts: [
                {
                  mimeType: "text/plain",
                  body: { size: bodyText.length, data: bodyB64 },
                },
                ...htmlParts,
                ...attParts,
              ],
            },
          };
          if (format === "raw") {
            // download_email format=eml issues a separate raw fetch
            // alongside the full one. Return a minimal RFC822 payload.
            const rfc822 = `From: alice@example.com\r\nTo: bob@example.com\r\nSubject: Test message ${id}\r\n\r\n${bodyText}`;
            return {
              data: { ...fullBase, raw: Buffer.from(rfc822, "utf-8").toString("base64url") },
            };
          }
          return { data: fullBase };
        },
        list: async (params: unknown) => {
          calls.messageList.push(params);
          const items = opts.searchResults ?? [];
          return {
            data: { messages: items.map((m) => ({ id: m.id, threadId: `thread_${m.id}` })) },
          };
        },
      },
      drafts: {
        create: async (params: unknown) => {
          calls.draftCreate.push(params);
          return { data: { id: `draft_${calls.draftCreate.length}` } };
        },
        list: async (params: unknown) => {
          calls.draftList.push(params);
          if (opts.draftListHttpError !== undefined) {
            const err: Error & { code?: number } = new Error("Simulated Gmail API failure");
            err.code = opts.draftListHttpError;
            throw err;
          }
          const items = opts.drafts ?? [];
          return {
            data: {
              drafts: items.map((d) => ({
                id: d.id,
                message: {
                  id: d.messageId ?? `msg_${d.id}`,
                  threadId: d.threadId ?? `thread_${d.id}`,
                },
              })),
              nextPageToken: opts.draftsNextPageToken,
              resultSizeEstimate: opts.draftsResultSizeEstimate ?? items.length,
            },
          };
        },
        get: async (params: unknown) => {
          calls.draftGet.push(params);
          if (opts.draftGetHttpError !== undefined) {
            const err: Error & { code?: number } = new Error("Simulated Gmail API failure");
            err.code = opts.draftGetHttpError;
            throw err;
          }
          const id = (params as { id?: string }).id ?? "draft_unknown";
          // Reject unsupported formats so a registrar regression
          // that asks for, say, `format: "html"` (not in the
          // `users.drafts.get` enum) cannot silently pass on the
          // default-format payload. Mirrors the messages.get mock's
          // SUPPORTED guard. CR finding (PR #100): the previous
          // mock returned the same payload for every format and
          // hid format-forwarding regressions.
          const format = (params as { format?: string }).format ?? "full";
          const SUPPORTED = new Set(["full", "metadata", "minimal", "raw"]);
          if (!SUPPORTED.has(format)) {
            throw new Error(
              `mockGmail: drafts.get called with unexpected format=${format}; supported: ${[...SUPPORTED].join(", ")} (id=${id})`,
            );
          }
          // Branch the payload shape on `format` so each
          // registrar-supplied format is exercised distinctly.
          // - `minimal` → only id + threadId + labelIds (no
          //   headers, no body, no payload).
          // - `metadata` → id + threadId + payload.headers (no
          //   body parts).
          // - `full` → headers + parts[].
          // - `raw` → adds an RFC 822 raw blob alongside the full
          //   payload, mirroring the messages.get raw shape.
          const headers: Array<{ name: string; value: string }> = [
            { name: "From", value: "alice@example.com" },
            { name: "To", value: "bob@example.com" },
            { name: "Subject", value: `Draft ${id}` },
          ];
          if (opts.draftBccHeader !== undefined) {
            headers.push({ name: "Bcc", value: opts.draftBccHeader });
          }
          if (opts.draftExtraHeaders) {
            for (const h of opts.draftExtraHeaders) headers.push(h);
          }
          const baseMessage = {
            id: `msg_in_${id}`,
            threadId: `thread_in_${id}`,
            labelIds: ["DRAFT"],
          };
          let message: Record<string, unknown> = baseMessage;
          if (format === "metadata") {
            message = { ...baseMessage, payload: { headers } };
          } else if (format === "full") {
            const bodyB64 = Buffer.from(`Body of ${id}`, "utf-8")
              .toString("base64")
              .replace(/\+/g, "-")
              .replace(/\//g, "_")
              .replace(/=+$/, "");
            message = {
              ...baseMessage,
              payload: {
                headers,
                parts: [
                  {
                    mimeType: "text/plain",
                    body: { size: 12, data: bodyB64 },
                  },
                ],
              },
            };
          } else if (format === "raw") {
            const rfc822 = `From: alice@example.com\r\nTo: bob@example.com\r\nSubject: Draft ${id}\r\n\r\nBody of ${id}`;
            message = {
              ...baseMessage,
              payload: { headers },
              raw: Buffer.from(rfc822, "utf-8").toString("base64url"),
            };
          }
          // `minimal` falls through with no payload — matches the
          // Gmail API behaviour for that format value.
          return { data: { id, message } };
        },
        update: async (params: unknown) => {
          calls.draftUpdate.push(params);
          if (opts.draftUpdateHttpError !== undefined) {
            const err: Error & { code?: number } = new Error("Simulated Gmail API failure");
            err.code = opts.draftUpdateHttpError;
            throw err;
          }
          const id = (params as { id?: string }).id ?? "draft_updated";
          return {
            data: {
              id,
              message: { id: `msg_after_update_${id}`, threadId: `thread_${id}` },
            },
          };
        },
        delete: async (params: unknown) => {
          calls.draftDelete.push(params);
          if (opts.draftDeleteHttpError !== undefined) {
            const err: Error & { code?: number } = new Error("Simulated Gmail API failure");
            err.code = opts.draftDeleteHttpError;
            throw err;
          }
          return { data: {} };
        },
        send: async (params: unknown) => {
          calls.draftSend.push(params);
          if (opts.draftSendHttpError !== undefined) {
            const err: Error & { code?: number } = new Error("Simulated Gmail API failure");
            err.code = opts.draftSendHttpError;
            throw err;
          }
          const body = (params as { requestBody?: { id?: string } }).requestBody ?? {};
          return {
            data: {
              id: `sent_from_${body.id ?? "unknown"}`,
              threadId: `thread_sent_${body.id ?? "unknown"}`,
            },
          };
        },
      },
      // reply_all uses getProfile to figure out which address to drop
      // from the recipient list (so the user is not CC'd on their own
      // reply).
      getProfile: async (params: unknown) => {
        calls.getProfile.push(params);
        return { data: { emailAddress: "me@example.com" } };
      },
      threads: {
        modify: async (params: unknown) => {
          calls.threadModify.push(params);
          return { data: {} };
        },
        get: async (params: unknown) => {
          calls.threadGet.push(params);
          if (opts.threadGetHttpError !== undefined) {
            const err = new Error(`Mock thread HTTP ${opts.threadGetHttpError}`) as Error & {
              code?: number;
            };
            err.code = opts.threadGetHttpError;
            throw err;
          }
          const id = (params as { id?: string }).id ?? "thread_unknown";
          const t = opts.threads?.[id];
          if (!t) {
            return { data: { messages: [] } };
          }
          return {
            data: {
              messages: t.messages.map((m) => {
                const bodyText = m.bodyText ?? "thread body";
                const bodyB64 = Buffer.from(bodyText, "utf-8")
                  .toString("base64")
                  .replace(/\+/g, "-")
                  .replace(/\//g, "_")
                  .replace(/=+$/, "");
                // Same `messageAttachments` opt as the messages.get
                // mock — appends attachment-bearing parts to the
                // thread message payload so the attachment-mapping
                // branch in `threads.ts:107`/`289` is reachable from
                // the get_thread / get_inbox_with_threads tests.
                const attParts = (opts.messageAttachments ?? []).map((a) => ({
                  partId: a.partId,
                  filename: a.filename,
                  mimeType: a.mimeType,
                  body: { attachmentId: a.attachmentId, size: a.size },
                }));
                return {
                  id: m.id,
                  threadId: id,
                  labelIds: m.labelIds ?? [],
                  payload: {
                    headers: [
                      { name: "From", value: m.from ?? "alice@example.com" },
                      { name: "Subject", value: m.subject ?? `Msg ${m.id}` },
                      { name: "Date", value: "Fri, 25 Apr 2026 10:00:00 +0000" },
                      { name: "Message-ID", value: `<${m.id}@example.com>` },
                    ],
                    parts: [
                      {
                        mimeType: "text/plain",
                        body: { size: bodyText.length, data: bodyB64 },
                      },
                      ...attParts,
                    ],
                  },
                };
              }),
            },
          };
        },
        list: async (params: unknown) => {
          calls.threadList.push(params);
          const ids = Object.keys(opts.threads ?? {});
          return {
            data: {
              threads: ids.map((id) => ({
                id,
                snippet: opts.threads?.[id]?.snippet ?? "",
                historyId: opts.threads?.[id]?.historyId ?? "",
              })),
            },
          };
        },
      },
      labels: {
        // `deleteLabel` (src/label-manager.ts) does a `get` first to
        // refuse system-label deletion + to surface the label name in
        // the success message. Mock returns a non-system label so the
        // delete proceeds.
        get: async (params: unknown) => {
          const id = (params as { id?: string }).id ?? "Unknown";
          return { data: { id, name: id, type: "user" } };
        },
        delete: async (params: unknown) => {
          calls.labelDelete.push(params);
          return { data: {} };
        },
        create: async (params: unknown) => {
          calls.labelCreate.push(params);
          const body = (params as { requestBody?: { name?: string } }).requestBody ?? {};
          return {
            data: { id: `Label_${calls.labelCreate.length}`, name: body.name ?? "", type: "user" },
          };
        },
        update: async (params: unknown) => {
          calls.labelUpdate.push(params);
          const body = (params as { requestBody?: { name?: string } }).requestBody ?? {};
          const id = (params as { id?: string }).id ?? "Label_X";
          return { data: { id, name: body.name ?? id, type: "user" } };
        },
        list: async (params: unknown) => {
          calls.labelList.push(params);
          return { data: { labels: opts.existingLabels ?? [] } };
        },
      },
      settings: {
        // resolveDefaultSender (used by sendOrDraftEmail when `from`
        // is empty) calls users.settings.sendAs.list — return one
        // default sendAs so the resolver picks `me@example.com`.
        sendAs: {
          list: async (params: unknown) => {
            calls.sendAsList.push(params);
            return {
              data: { sendAs: [{ sendAsEmail: "me@example.com", isDefault: true }] },
            };
          },
        },
        filters: {
          delete: async (params: unknown) => {
            calls.filterDelete.push(params);
            return { data: {} };
          },
          create: async (params: unknown) => {
            calls.filterCreate.push(params);
            const body = (params as { requestBody?: unknown }).requestBody ?? {};
            return {
              data: {
                id: `filter_${calls.filterCreate.length}`,
                criteria: (body as { criteria?: unknown }).criteria,
                action: (body as { action?: unknown }).action,
              },
            };
          },
          list: async (params: unknown) => {
            calls.filterList.push(params);
            if (opts.noFilters) {
              return { data: { filter: [] } };
            }
            return {
              data: {
                filter: [
                  {
                    id: "filter_existing",
                    criteria: { from: "newsletter@example.com" },
                    action: { addLabelIds: ["Label_5"] },
                  },
                ],
              },
            };
          },
          get: async (params: unknown) => {
            calls.filterGet.push(params);
            const id = (params as { id?: string }).id ?? "filter_unknown";
            return {
              data: {
                id,
                criteria: { from: "vendor@example.com" },
                action: { addLabelIds: ["Label_42"] },
              },
            };
          },
        },
      },
    },
  } as unknown as gmail_v1.Gmail;
  return { client, calls };
}

interface ConnectedFixture {
  client: Client;
  calls: MockedGmailCalls;
  close: () => Promise<void>;
}

/**
 * Boilerplate-killer: build a fixture, run the test body, always close
 * the fixture (even on assertion failure inside `body`). Replaces the
 * 12 `try/finally` blocks the file would otherwise carry. CR Trivial
 * suggestion on PR #84.
 */
async function withFix(
  scopes: string[],
  body: (fix: ConnectedFixture) => Promise<void>,
  mockOpts: MockGmailOpts = {},
): Promise<void> {
  const fix = await buildAndConnect(scopes, mockOpts);
  try {
    await body(fix);
  } finally {
    await fix.close();
  }
}

async function buildAndConnect(
  scopes: string[],
  mockOpts: MockGmailOpts = {},
): Promise<ConnectedFixture> {
  const { client: gmail, calls } = mockGmail(mockOpts);
  // PR #7 wired createServer to take a gmail client directly and to
  // register every per-domain tool via `registerAllTools`. The fixture
  // now passes the mock gmail straight to the factory; the per-tool
  // `register*Tools` calls are not needed (and would double-register).
  const server = createServer({
    gmail,
    authorizedScopes: scopes,
  });

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "registrars-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    calls,
    close: async () => {
      await Promise.all([client.close(), server.close()]);
    },
  };
}

describe("PR #3 registrars — delete_email (mail.google.com scope)", () => {
  it("calls gmail.users.messages.delete with the supplied messageId", async () => {
    // First test on the file to demo the `withFix` helper introduced
    // in the PR #4 fix-up commit (CR thread on PR #84). Subsequent
    // tests still use the explicit try/finally form for minimum diff;
    // PR #5+ tests adopt `withFix` directly.
    await withFix(["mail.google.com"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "delete_email",
        arguments: { messageId: "msg_target_123" },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("msg_target_123");
      expect(result.content[0]?.text).toContain("deleted successfully");
      expect(fix.calls.messageDelete).toHaveLength(1);
      expect(fix.calls.messageDelete[0]).toMatchObject({
        userId: "me",
        id: "msg_target_123",
      });
    });
  });

  it("is NOT advertised when the token only carries gmail.modify (delete needs mail.google.com)", async () => {
    const fix = await buildAndConnect(["gmail.modify"]);
    try {
      const list = await fix.client.listTools();
      expect(list.tools.find((t) => t.name === "delete_email")).toBeUndefined();
    } finally {
      await fix.close();
    }
  });
});

describe("PR #3 registrars — delete_label", () => {
  it("calls gmail.users.labels.delete with the supplied id", async () => {
    const fix = await buildAndConnect(["gmail.modify", "gmail.labels"]);
    try {
      const result = (await fix.client.callTool({
        name: "delete_label",
        arguments: { id: "Label_42" },
      })) as { content: Array<{ type: string; text: string }> };
      expect(result.content[0]?.text).toContain("Label_42");
      expect(fix.calls.labelDelete).toHaveLength(1);
      expect(fix.calls.labelDelete[0]).toMatchObject({
        userId: "me",
        id: "Label_42",
      });
    } finally {
      await fix.close();
    }
  });
});

describe("PR #3 registrars — delete_filter", () => {
  it("calls gmail.users.settings.filters.delete with the supplied filterId", async () => {
    const fix = await buildAndConnect(["gmail.settings.basic"]);
    try {
      const result = (await fix.client.callTool({
        name: "delete_filter",
        arguments: { filterId: "filter_xyz" },
      })) as { content: Array<{ type: string; text: string }> };
      expect(result.content[0]?.text.length).toBeGreaterThan(0);
      expect(fix.calls.filterDelete).toHaveLength(1);
      expect(fix.calls.filterDelete[0]).toMatchObject({
        userId: "me",
        id: "filter_xyz",
      });
    } finally {
      await fix.close();
    }
  });
});

describe("PR #3 registrars — modify_thread", () => {
  it("forwards addLabelIds + removeLabelIds to gmail.users.threads.modify", async () => {
    const fix = await buildAndConnect(["gmail.modify"]);
    try {
      const result = (await fix.client.callTool({
        name: "modify_thread",
        arguments: {
          threadId: "thread_999",
          addLabelIds: ["L_A", "L_B"],
          removeLabelIds: ["INBOX"],
        },
      })) as { content: Array<{ type: string; text: string }> };
      expect(result.content[0]?.text).toContain("thread_999");
      expect(fix.calls.threadModify).toHaveLength(1);
      expect(fix.calls.threadModify[0]).toMatchObject({
        userId: "me",
        id: "thread_999",
        requestBody: { addLabelIds: ["L_A", "L_B"], removeLabelIds: ["INBOX"] },
      });
    } finally {
      await fix.close();
    }
  });

  it("omits empty label arrays from the request body (no addLabelIds when not supplied)", async () => {
    const fix = await buildAndConnect(["gmail.modify"]);
    try {
      await fix.client.callTool({
        name: "modify_thread",
        arguments: {
          threadId: "thread_only_remove",
          removeLabelIds: ["UNREAD"],
        },
      });
      const params = fix.calls.threadModify[0] as {
        requestBody: { addLabelIds?: string[]; removeLabelIds?: string[] };
      };
      expect(params.requestBody.addLabelIds).toBeUndefined();
      expect(params.requestBody.removeLabelIds).toEqual(["UNREAD"]);
    } finally {
      await fix.close();
    }
  });
});

describe("PR #4 registrars — label management", () => {
  it("create_label forwards name + visibility flags to gmail.users.labels.create", async () => {
    const fix = await buildAndConnect(["gmail.modify", "gmail.labels"]);
    try {
      const result = (await fix.client.callTool({
        name: "create_label",
        arguments: {
          name: "Project/Acme",
          messageListVisibility: "show",
          labelListVisibility: "labelShow",
        },
      })) as { content: Array<{ type: string; text: string }> };
      expect(result.content[0]?.text).toContain("Project/Acme");
      expect(result.content[0]?.text).toContain("Label created successfully");
      expect(fix.calls.labelCreate).toHaveLength(1);
      expect(fix.calls.labelCreate[0]).toMatchObject({
        userId: "me",
        requestBody: {
          name: "Project/Acme",
          messageListVisibility: "show",
          labelListVisibility: "labelShow",
        },
      });
    } finally {
      await fix.close();
    }
  });

  it("update_label includes only the fields the caller supplied", async () => {
    const fix = await buildAndConnect(["gmail.modify", "gmail.labels"]);
    try {
      await fix.client.callTool({
        name: "update_label",
        arguments: { id: "Label_1", name: "Renamed" },
      });
      // No `messageListVisibility` / `labelListVisibility` supplied →
      // they must NOT appear in the requestBody (avoiding accidental
      // Gmail API resets to "show"/"labelShow").
      expect(fix.calls.labelUpdate).toHaveLength(1);
      const body = (fix.calls.labelUpdate[0] as { requestBody: Record<string, unknown> })
        .requestBody;
      expect(body.name).toBe("Renamed");
      expect(body.messageListVisibility).toBeUndefined();
      expect(body.labelListVisibility).toBeUndefined();
    } finally {
      await fix.close();
    }
  });

  it("update_label forwards messageListVisibility + labelListVisibility when supplied", async () => {
    // Pin the two if-branches in `src/tools/labels.ts:86-91` that
    // assemble the partial-update body. Without this, a regression
    // that drops either field from the merge silently swallows
    // visibility changes on the wire.
    await withFix(["gmail.modify", "gmail.labels"], async (fix) => {
      await fix.client.callTool({
        name: "update_label",
        arguments: {
          id: "Label_2",
          messageListVisibility: "hide",
          labelListVisibility: "labelHide",
        },
      });
      expect(fix.calls.labelUpdate).toHaveLength(1);
      const body = (fix.calls.labelUpdate[0] as { requestBody: Record<string, unknown> })
        .requestBody;
      expect(body.messageListVisibility).toBe("hide");
      expect(body.labelListVisibility).toBe("labelHide");
      // No name supplied → it stays unset on the wire.
      expect(body.name).toBeUndefined();
    });
  });

  it("get_or_create_label returns 'found existing' when the label is already present", async () => {
    const fix = await buildAndConnect(["gmail.modify", "gmail.labels"], {
      existingLabels: [{ id: "Label_existing", name: "Acme/Invoices", type: "user" }],
    });
    try {
      const result = (await fix.client.callTool({
        name: "get_or_create_label",
        arguments: { name: "Acme/Invoices" },
      })) as { content: Array<{ type: string; text: string }> };
      expect(result.content[0]?.text).toContain("found existing");
      expect(result.content[0]?.text).toContain("Label_existing");
      // No create call — the label was already there.
      expect(fix.calls.labelCreate).toHaveLength(0);
    } finally {
      await fix.close();
    }
  });

  it("get_or_create_label creates a fresh label when none matches", async () => {
    const fix = await buildAndConnect(["gmail.modify", "gmail.labels"], {
      existingLabels: [{ id: "Label_other", name: "Different", type: "user" }],
    });
    try {
      const result = (await fix.client.callTool({
        name: "get_or_create_label",
        arguments: { name: "Brand/New" },
      })) as { content: Array<{ type: string; text: string }> };
      expect(result.content[0]?.text).toContain("Brand/New");
      expect(fix.calls.labelCreate).toHaveLength(1);
    } finally {
      await fix.close();
    }
  });

  it("list_email_labels groups system + user labels and shows the counts", async () => {
    const fix = await buildAndConnect(["gmail.readonly"], {
      existingLabels: [
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "SENT", name: "SENT", type: "system" },
        { id: "Label_1", name: "Acme", type: "user" },
      ],
    });
    try {
      const result = (await fix.client.callTool({
        name: "list_email_labels",
        arguments: {},
      })) as { content: Array<{ type: string; text: string }> };
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Found 3 labels");
      expect(text).toContain("2 system");
      expect(text).toContain("1 user");
      expect(text).toContain("INBOX");
      expect(text).toContain("Acme");
    } finally {
      await fix.close();
    }
  });
});

describe("PR #4 registrars — filter management", () => {
  it("create_filter forwards criteria + action to filters.create and pretty-prints the response", async () => {
    const fix = await buildAndConnect(["gmail.settings.basic"]);
    try {
      const result = (await fix.client.callTool({
        name: "create_filter",
        arguments: {
          criteria: { from: "noreply@vendor.com", hasAttachment: true },
          action: { addLabelIds: ["Label_42"] },
        },
      })) as { content: Array<{ type: string; text: string }> };
      expect(result.content[0]?.text).toContain("Filter created successfully");
      expect(result.content[0]?.text).toContain("from: noreply@vendor.com");
      expect(result.content[0]?.text).toContain("addLabelIds: Label_42");
      expect(fix.calls.filterCreate).toHaveLength(1);
    } finally {
      await fix.close();
    }
  });

  it("create_filter rejects an action.forward target that is not in the paired allowlist", async () => {
    // Pin the recipient-pairing gate at `src/tools/filters.ts:79-81`
    // — installing a server-side forwarding rule must require the
    // destination to be paired (mirrors send_email / reply_all /
    // draft_email). Without this branch tested, a regression that
    // drops the `requirePairedRecipients` call silently re-opens
    // the prompt-injection-driven exfiltration channel on the
    // create_filter surface.
    process.env.GMAIL_MCP_RECIPIENT_PAIRING = "true";
    try {
      await withFix(["gmail.settings.basic"], async (fix) => {
        const result = (await fix.client.callTool({
          name: "create_filter",
          arguments: {
            criteria: { from: "noreply@vendor.com" },
            action: { forward: "exfil@evil.example" },
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
        expect(result.isError).toBe(true);
        // Pairing-violation messages mention the unpaired address.
        expect(result.content[0]?.text).toContain("exfil@evil.example");
        // No filterCreate call was issued — the throw fires before
        // the API call.
        expect(fix.calls.filterCreate).toHaveLength(0);
      });
    } finally {
      delete process.env.GMAIL_MCP_RECIPIENT_PAIRING;
    }
  });

  it("list_filters renders the seeded filter (non-empty branch)", async () => {
    const fix = await buildAndConnect(["gmail.settings.basic"]);
    try {
      const result = (await fix.client.callTool({
        name: "list_filters",
        arguments: {},
      })) as { content: Array<{ type: string; text: string }> };
      const text = result.content[0]?.text ?? "";
      expect(text).toMatch(/Found \d+ filters/);
      expect(text).toContain("filter_existing");
    } finally {
      await fix.close();
    }
  });

  it("list_filters renders 'No filters found.' when the API returns an empty list", async () => {
    // CR finding on PR #84: the previous test's title claimed empty-
    // branch coverage but the mock always seeded one filter, so only
    // the non-empty path was exercised. With `noFilters: true` the
    // mock truly returns `{ filter: [] }` and the empty-branch
    // wording is now pinned.
    await withFix(
      ["gmail.settings.basic"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "list_filters",
          arguments: {},
        })) as { content: Array<{ type: string; text: string }> };
        // The text travels through `wrapToolHandler` which wraps every
        // tool response in the `<untrusted-tool-output>` sanitize fence.
        expect(result.content[0]?.text).toContain("No filters found.");
        expect(result.content[0]?.text).toContain("<untrusted-tool-output>");
      },
      { noFilters: true },
    );
  });

  it("get_filter pretty-prints the criteria + action of a known filter", async () => {
    const fix = await buildAndConnect(["gmail.settings.basic"]);
    try {
      const result = (await fix.client.callTool({
        name: "get_filter",
        arguments: { filterId: "filter_xyz" },
      })) as { content: Array<{ type: string; text: string }> };
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("ID: filter_xyz");
      expect(text).toContain("from: vendor@example.com");
      expect(fix.calls.filterGet).toHaveLength(1);
    } finally {
      await fix.close();
    }
  });

  it("create_filter_from_template (fromSender) wires the template through to filters.create", async () => {
    const fix = await buildAndConnect(["gmail.settings.basic"]);
    try {
      const result = (await fix.client.callTool({
        name: "create_filter_from_template",
        arguments: {
          template: "fromSender",
          parameters: { senderEmail: "spam@example.com", archive: true },
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("Filter created from template 'fromSender'");
      expect(fix.calls.filterCreate).toHaveLength(1);
    } finally {
      await fix.close();
    }
  });

  it("create_filter_from_template (withAttachments) accepts a parameter-less call", async () => {
    const fix = await buildAndConnect(["gmail.settings.basic"]);
    try {
      const result = (await fix.client.callTool({
        name: "create_filter_from_template",
        arguments: {
          template: "withAttachments",
          parameters: { labelIds: ["Label_attach"] },
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("withAttachments");
      expect(fix.calls.filterCreate).toHaveLength(1);
    } finally {
      await fix.close();
    }
  });
});

describe("PR #5 registrars — read_email truncation (highest-risk extraction)", () => {
  it("returns the full headers + body when format=full and body is below the cap", async () => {
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "read_email",
          arguments: { messageId: "msg_short", format: "full" },
        })) as { content: Array<{ type: string; text: string }> };
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("Subject: Test message msg_short");
        expect(text).toContain("Alice <alice@example.com>");
        expect(text).toContain("default body content");
        expect(text).not.toContain("[Message clipped");
      },
      { messageBodyText: "default body content" },
    );
  });

  it("returns ONLY the header block when format=headers_only", async () => {
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "read_email",
          arguments: { messageId: "msg_h", format: "headers_only" },
        })) as { content: Array<{ type: string; text: string }> };
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("Subject: Test message msg_h");
        // Body MUST NOT be in the response.
        expect(text).not.toContain("default body content");
      },
      { messageBodyText: "this body must not appear" },
    );
  });

  it("clamps the body at 500 bytes in summary mode and emits the summary marker", async () => {
    const longBody = "X".repeat(2000);
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "read_email",
          arguments: { messageId: "msg_sum", format: "summary" },
        })) as { content: Array<{ type: string; text: string }> };
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("[Summary truncated at 500 bytes");
        // The summary cap is 500 bytes — `XXX...` (500 of them) should
        // appear, but not all 2000.
        const xCount = (text.match(/X/g) || []).length;
        expect(xCount).toBeGreaterThanOrEqual(500);
        expect(xCount).toBeLessThan(2000);
      },
      { messageBodyText: longBody },
    );
  });

  it("clamps the body at maxBodyLength in full mode and emits the [Message clipped] marker", async () => {
    const longBody = "Y".repeat(2000);
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "read_email",
          arguments: { messageId: "msg_full", format: "full", maxBodyLength: 100 },
        })) as { content: Array<{ type: string; text: string }> };
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("[Message clipped");
        const yCount = (text.match(/Y/g) || []).length;
        expect(yCount).toBeGreaterThanOrEqual(100);
        expect(yCount).toBeLessThan(2000);
      },
      { messageBodyText: longBody },
    );
  });

  it("does NOT truncate when maxBodyLength=0 (operator opt-out)", async () => {
    const longBody = "Z".repeat(5000);
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "read_email",
          arguments: { messageId: "msg_zero", format: "full", maxBodyLength: 0 },
        })) as { content: Array<{ type: string; text: string }> };
        const text = result.content[0]?.text ?? "";
        expect(text).not.toContain("[Message clipped");
        const zCount = (text.match(/Z/g) || []).length;
        expect(zCount).toBe(5000);
      },
      { messageBodyText: longBody },
    );
  });

  it("multi-byte safe: a truncation cut on a multi-byte sequence does not produce U+FFFD", async () => {
    // 250× "é" (UTF-8: 0xC3 0xA9, 2 bytes per char) = 500 bytes total.
    // With format=summary (cap=500) the body fits exactly; with cap=499
    // the slice would land mid-`é` and TextDecoder ignores the trailing
    // partial byte. The trailing U+FFFD trim guard in read_email
    // handles the case where TextDecoder still emits one. Pin that
    // neither case shows U+FFFD in the displayed body.
    const accentBody = "é".repeat(250);
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "read_email",
          arguments: { messageId: "msg_acc", format: "full", maxBodyLength: 11 },
        })) as { content: Array<{ type: string; text: string }> };
        const text = result.content[0]?.text ?? "";
        // U+FFFD is the Unicode REPLACEMENT CHARACTER. It should NEVER
        // appear in the body of a truncated read_email response.
        expect(text).not.toContain("�");
        expect(text).toContain("[Message clipped");
      },
      { messageBodyText: accentBody },
    );
  });

  it("renders the attachment summary line when the message carries attachments", async () => {
    // Pin the attachment-mapping branch in `read_email` (`messages.ts:108-115`)
    // — only fires when the payload has at least one
    // `body.attachmentId`-bearing part. Without this test, the
    // `Attachments (N): - filename (mime, KB, ID: X)` formatter is
    // never executed and a regression that mis-formats the line
    // (wrong unit, missing ID, off-by-one count) goes undetected.
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "read_email",
          arguments: { messageId: "msg_with_pdf", format: "full" },
        })) as { content: Array<{ type: string; text: string }> };
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("Attachments (2):");
        expect(text).toContain("- report.pdf (application/pdf, 4 KB, ID: att_pdf)");
        expect(text).toContain("- icon.png (image/png, 1 KB, ID: att_png)");
      },
      {
        messageAttachments: [
          {
            partId: "1.1",
            filename: "report.pdf",
            mimeType: "application/pdf",
            attachmentId: "att_pdf",
            size: 4096,
          },
          {
            partId: "1.2",
            filename: "icon.png",
            mimeType: "image/png",
            attachmentId: "att_png",
            size: 1024,
          },
        ],
      },
    );
  });
});

describe("PR #5 registrars — search_emails", () => {
  it("calls list+get for each result and renders them line-by-line", async () => {
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "search_emails",
          arguments: { query: "from:alice@example.com", maxResults: 2 },
        })) as { content: Array<{ type: string; text: string }> };
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("ID: msg_1");
        expect(text).toContain("ID: msg_2");
        expect(fix.calls.messageList).toHaveLength(1);
        // Pin the forwarded query + maxResults so a regression that
        // drops them (e.g. switching to a hard-coded "in:inbox") is
        // caught at test time. CR finding on PR #84.
        expect(fix.calls.messageList[0]).toMatchObject({
          userId: "me",
          q: "from:alice@example.com",
          maxResults: 2,
        });
        expect(fix.calls.messageGet).toHaveLength(2);
      },
      { searchResults: [{ id: "msg_1" }, { id: "msg_2" }] },
    );
  });
});

describe("PR #5 registrars — modify_email + batch_*", () => {
  it("modify_email forwards label changes to gmail.users.messages.modify", async () => {
    await withFix(["gmail.modify"], async (fix) => {
      await fix.client.callTool({
        name: "modify_email",
        arguments: {
          messageId: "msg_mod",
          addLabelIds: ["L_A"],
          removeLabelIds: ["INBOX"],
        },
      });
      expect(fix.calls.messageModify).toHaveLength(1);
      expect(fix.calls.messageModify[0]).toMatchObject({
        userId: "me",
        id: "msg_mod",
        requestBody: { addLabelIds: ["L_A"], removeLabelIds: ["INBOX"] },
      });
    });
  });

  it("batch_modify_emails calls modify once per messageId via processBatches", async () => {
    await withFix(["gmail.modify"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "batch_modify_emails",
        arguments: {
          messageIds: ["m1", "m2", "m3"],
          addLabelIds: ["L_X"],
          batchSize: 5,
        },
      })) as { content: Array<{ type: string; text: string }> };
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Successfully processed: 3 messages");
      expect(fix.calls.messageModify).toHaveLength(3);
    });
  });

  it("batch_delete_emails deletes each messageId and reports the count", async () => {
    await withFix(["mail.google.com"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "batch_delete_emails",
        arguments: { messageIds: ["m1", "m2"] },
      })) as { content: Array<{ type: string; text: string }> };
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Successfully deleted: 2 messages");
      expect(fix.calls.messageDelete).toHaveLength(2);
    });
  });

  it("batch_modify_emails reports per-item failures separately from successes", async () => {
    // Pin the failure-collection branch in `batch_modify_emails`
    // (`src/tools/messages.ts:240-243`): when `processBatches`
    // records `failures[]`, the registrar prints the success count
    // PLUS the "Failed to process: N messages" footer with the
    // truncated failed IDs. Without this branch tested, a regression
    // that drops the failure footer (or that mis-counts the
    // partition) still passes the success-only assertions above.
    await withFix(
      ["gmail.modify"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "batch_modify_emails",
          arguments: {
            messageIds: ["good_a", "fail_b", "good_c"],
            addLabelIds: ["L_X"],
            batchSize: 5,
          },
        })) as { content: Array<{ type: string; text: string }> };
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("Successfully processed: 2 messages");
        expect(text).toContain("Failed to process: 1 messages");
        expect(text).toContain("Failed message IDs:");
        // The failed-ID renderer truncates each id to 16 chars and
        // appends `...` — pin the truncation contract.
        expect(text).toContain("fail_b...");
        expect(text).toContain("(Simulated modify failure for fail_b)");
        // `processBatches` retries the whole batch item-by-item on a
        // failure (so 3 batch calls + 3 retry calls = 6 modify calls
        // for a 3-item input with one bad ID). Pin the lower bound
        // (>=3) to allow `processBatches` to optimise away the
        // retry one day, and pin that `fail_b` was actually
        // attempted (so a regression that drops the bad ID before
        // the API call is caught).
        expect(fix.calls.messageModify.length).toBeGreaterThanOrEqual(3);
        const modifiedIds = fix.calls.messageModify.map((c) => (c as { id?: string }).id);
        expect(modifiedIds).toContain("good_a");
        expect(modifiedIds).toContain("good_c");
        expect(modifiedIds).toContain("fail_b");
      },
      { failOnIds: ["fail_b"] },
    );
  });

  it("batch_delete_emails reports per-item failures separately from successes", async () => {
    // Same shape as the batch_modify failure test above, against
    // `src/tools/messages.ts:275-278`. Distinct branch: a regression
    // that copies the modify-arm's footer logic but mishandles the
    // delete-arm wording (e.g., "Failed to process" instead of
    // "Failed to delete") would fail this test, not the modify one.
    await withFix(
      ["mail.google.com"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "batch_delete_emails",
          arguments: { messageIds: ["m1", "m2", "fail_3"] },
        })) as { content: Array<{ type: string; text: string }> };
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("Successfully deleted: 2 messages");
        expect(text).toContain("Failed to delete: 1 messages");
        expect(text).toContain("fail_3...");
        expect(text).toContain("(Simulated delete failure for fail_3)");
        // Same retry-on-batch-failure semantics as the modify test
        // above — pin the lower bound + verify each ID was
        // attempted at least once.
        expect(fix.calls.messageDelete.length).toBeGreaterThanOrEqual(3);
        const deletedIds = fix.calls.messageDelete.map((c) => (c as { id?: string }).id);
        expect(deletedIds).toContain("m1");
        expect(deletedIds).toContain("m2");
        expect(deletedIds).toContain("fail_3");
      },
      { failOnIds: ["fail_3"] },
    );
  });
});

describe("PR #6 registrars — download_email + download_attachment", () => {
  it("download_email json format writes a JSON file under the download jail", async () => {
    await withFix(["gmail.readonly"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "download_email",
        arguments: { messageId: "msg_dl_json", savePath: downloadDir, format: "json" },
      })) as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
      };
      expect(result.isError).toBeFalsy();
      const text = result.content[0]?.text ?? "";
      expect(text).toContain('"status": "saved"');
      expect(text).toContain("msg_dl_json.json");
      // Verify the file actually exists in the jail.
      const written = readdirSync(downloadDir);
      expect(written).toContain("msg_dl_json.json");
      // Pin the explicit structuredContent emission (PR #97 +
      // follow-up). The handler now lifts the typed `result`
      // object onto the structured channel directly instead of
      // relying on `attachStructuredContent`'s auto-attach
      // best-effort heuristic; the SDK validator then runs
      // against `downloadEmailOutputSchema` on every emit.
      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent?.status).toBe("saved");
      expect(result.structuredContent?.messageId).toBe("msg_dl_json");
      expect(typeof result.structuredContent?.path).toBe("string");
      expect(typeof result.structuredContent?.size).toBe("number");
      expect(Array.isArray(result.structuredContent?.attachments)).toBe(true);
    });
  });

  it("download_email txt format writes the rendered text file", async () => {
    // Pin the txt branch (`downloads.ts:68-69` → `emailToTxt`).
    await withFix(["gmail.readonly"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "download_email",
        arguments: { messageId: "msg_dl_txt", savePath: downloadDir, format: "txt" },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("msg_dl_txt.txt");
      expect(readdirSync(downloadDir)).toContain("msg_dl_txt.txt");
    });
  });

  it("download_email html format writes the rendered HTML file", async () => {
    // Pin the html branch (`downloads.ts:70-71` → `emailToHtml`).
    // `emailToHtml` throws if the message has no HTML alternative,
    // so the test fixture supplies one via `messageBodyHtml`.
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "download_email",
          arguments: { messageId: "msg_dl_html", savePath: downloadDir, format: "html" },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
        expect(result.isError).toBeFalsy();
        expect(result.content[0]?.text).toContain("msg_dl_html.html");
        expect(readdirSync(downloadDir)).toContain("msg_dl_html.html");
      },
      { messageBodyHtml: "<html><body><p>HTML body</p></body></html>" },
    );
  });

  it("download_email eml format issues both full+raw fetches in parallel", async () => {
    await withFix(["gmail.readonly"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "download_email",
        arguments: { messageId: "msg_dl_eml", savePath: downloadDir, format: "eml" },
      })) as { content: Array<{ type: string; text: string }> };
      expect(result.content[0]?.text).toContain("msg_dl_eml.eml");
      // Two get calls: one full, one raw.
      expect(fix.calls.messageGet).toHaveLength(2);
      const formats = fix.calls.messageGet.map((c) => (c as { format?: string }).format).sort();
      expect(formats).toEqual(["full", "raw"]);
    });
  });

  it("download_attachment writes the bytes under the download jail", async () => {
    await withFix(["gmail.modify"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "download_attachment",
        arguments: {
          messageId: "msg_with_att",
          attachmentId: "att_1",
          filename: "report.pdf",
          savePath: downloadDir,
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("report.pdf");
      const written = readdirSync(downloadDir);
      expect(written).toContain("report.pdf");
    });
  });
});

describe("PR #6 registrars — get_thread + list_inbox_threads + get_inbox_with_threads", () => {
  const fixtureThreads = {
    thread_a: {
      snippet: "thread A snippet",
      historyId: "h1",
      messages: [
        { id: "m1", from: "alice@example.com", subject: "First", bodyText: "First body" },
        { id: "m2", from: "bob@example.com", subject: "Second", bodyText: "Second body" },
      ],
    },
    thread_b: {
      snippet: "thread B snippet",
      historyId: "h2",
      messages: [{ id: "m3", from: "carol@example.com", subject: "Third", bodyText: "Body 3" }],
    },
  };

  it("get_thread returns each message's headers + body in JSON", async () => {
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "get_thread",
          arguments: { threadId: "thread_a" },
        })) as { content: Array<{ type: string; text: string }> };
        const text = result.content[0]?.text ?? "";
        expect(text).toContain('"messageCount": 2');
        expect(text).toContain("First body");
        expect(text).toContain("Second body");
        expect(text).toContain("alice@example.com");
        expect(text).toContain("bob@example.com");
      },
      { threads: fixtureThreads },
    );
  });

  it("list_inbox_threads returns a metadata summary per thread + forwards q/maxResults", async () => {
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "list_inbox_threads",
          arguments: { query: "in:inbox label:Project", maxResults: 25 },
        })) as { content: Array<{ type: string; text: string }> };
        const text = result.content[0]?.text ?? "";
        expect(text).toContain('"resultCount": 2');
        expect(text).toContain("thread_a");
        expect(text).toContain("thread_b");
        // Latest message metadata pulled.
        expect(text).toContain("Second");
        // Pin the forwarded q + maxResults — CR finding on PR #84.
        expect(fix.calls.threadList).toHaveLength(1);
        expect(fix.calls.threadList[0]).toMatchObject({
          userId: "me",
          q: "in:inbox label:Project",
          maxResults: 25,
        });
      },
      { threads: fixtureThreads },
    );
  });

  it("get_inbox_with_threads expandThreads=false returns the lightweight summary", async () => {
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "get_inbox_with_threads",
          arguments: { expandThreads: false, query: "in:inbox", maxResults: 10 },
        })) as { content: Array<{ type: string; text: string }> };
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("thread_a");
        // Summary path → no body content rendered.
        expect(text).not.toContain("First body");
      },
      { threads: fixtureThreads },
    );
  });

  it("get_inbox_with_threads expandThreads=true fetches and renders every message body", async () => {
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "get_inbox_with_threads",
          arguments: { expandThreads: true, query: "in:inbox", maxResults: 10 },
        })) as { content: Array<{ type: string; text: string }> };
        const text = result.content[0]?.text ?? "";
        // Both bodies rendered.
        expect(text).toContain("First body");
        expect(text).toContain("Second body");
        expect(text).toContain("Body 3");
      },
      { threads: fixtureThreads },
    );
  });

  it("get_thread maps attachment metadata onto each message in the JSON output", async () => {
    // Pin the attachment-mapping callback in `threads.ts:107`. The
    // map fires only when a thread message has at least one
    // `body.attachmentId`-bearing part. Without this test, a
    // regression that drops the attachment array (or that
    // mis-formats the per-attachment shape) would still pass the
    // body-rendering tests above.
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "get_thread",
          arguments: { threadId: "thread_a" },
        })) as { content: Array<{ type: string; text: string }> };
        const text = result.content[0]?.text ?? "";
        // The attachment is added to EVERY message in the fixture
        // (the mock injects it into all thread messages), so the
        // filename appears in the JSON output for both messages.
        expect(text).toContain("contract.pdf");
        expect(text).toContain("application/pdf");
      },
      {
        threads: fixtureThreads,
        messageAttachments: [
          {
            partId: "1.1",
            filename: "contract.pdf",
            mimeType: "application/pdf",
            attachmentId: "att_contract",
            size: 8192,
          },
        ],
      },
    );
  });

  it("get_inbox_with_threads expandThreads=true maps attachments onto each message", async () => {
    // Pin the symmetric attachment-mapping callback in
    // `threads.ts:289` (the get_inbox_with_threads expand path).
    // Same shape as `get_thread`, distinct call site → distinct
    // coverage marker.
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "get_inbox_with_threads",
          arguments: { expandThreads: true, query: "in:inbox", maxResults: 10 },
        })) as { content: Array<{ type: string; text: string }> };
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("spec.pdf");
      },
      {
        threads: fixtureThreads,
        messageAttachments: [
          {
            partId: "1.1",
            filename: "spec.pdf",
            mimeType: "application/pdf",
            attachmentId: "att_spec",
            size: 4096,
          },
        ],
      },
    );
  });
});

describe("PR #7 registrars — send_email / draft_email (messaging.ts)", () => {
  it("send_email forwards a base64url-encoded RFC822 payload to gmail.users.messages.send", async () => {
    await withFix(["gmail.send"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "send_email",
        arguments: {
          to: ["bob@example.com"],
          subject: "Hello from test",
          body: "This is the test body.",
          from: "me@example.com",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("sent successfully");
      expect(result.content[0]?.text).toContain("msg_sent_1");
      expect(fix.calls.messageSend).toHaveLength(1);
      const sent = fix.calls.messageSend[0] as { requestBody: { raw: string } };
      expect(typeof sent.requestBody.raw).toBe("string");
      // Decode the base64url and check the headers landed in the MIME.
      const decoded = Buffer.from(sent.requestBody.raw, "base64url").toString("utf-8");
      expect(decoded).toContain("To: bob@example.com");
      expect(decoded).toContain("Subject: Hello from test");
      expect(decoded).toContain("This is the test body.");
    });
  });

  it("draft_email routes through gmail.users.drafts.create instead of messages.send", async () => {
    await withFix(["gmail.compose"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "draft_email",
        arguments: {
          to: ["alice@example.com"],
          subject: "Draft subject",
          body: "Draft body",
          from: "me@example.com",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("draft created");
      expect(fix.calls.draftCreate).toHaveLength(1);
      expect(fix.calls.messageSend).toHaveLength(0);
    });
  });

  it("send_email with an in-jail attachment routes through Nodemailer + messages.send", async () => {
    await withFix(["gmail.send"], async (fix) => {
      // Drop a real PDF inside the per-test attachment jail so the
      // jail check (`assertAttachmentPathAllowed`) accepts it.
      // Nodemailer reads the file at send-time via its streaming
      // transport, so the bytes have to actually exist on disk —
      // a fake / non-existent path would fail at `fs.existsSync`.
      const pdfPath = join(attachmentDir, "report.pdf");
      writeFileSync(pdfPath, "%PDF-1.4\n%fake pdf payload for the test\n");

      const result = (await fix.client.callTool({
        name: "send_email",
        arguments: {
          to: ["bob@example.com"],
          subject: "With attachment",
          body: "See attached.",
          from: "me@example.com",
          attachments: [pdfPath],
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("sent successfully");
      expect(fix.calls.messageSend).toHaveLength(1);
      const sent = fix.calls.messageSend[0] as { requestBody: { raw: string } };
      const decoded = Buffer.from(sent.requestBody.raw, "base64url").toString("utf-8");
      // Pin two contracts that fall through Nodemailer's streaming
      // MIME builder when attachments > 0: the multipart envelope
      // (`Content-Type: multipart/...`) and the per-attachment
      // disposition with the original `path.basename(filePath)`
      // filename.
      expect(decoded).toMatch(/Content-Type: multipart\//);
      // Nodemailer emits unquoted filenames for ASCII-safe basenames:
      // `Content-Disposition: attachment; filename=report.pdf`. Pin
      // both the disposition AND the basename so a regression that
      // drops `path.basename(filePath)` (and leaks the full
      // attachment-jail path) is caught.
      expect(decoded).toMatch(/Content-Disposition: attachment; filename=report\.pdf/);
      // The base64-encoded PDF body lands inline in the part — pin
      // a deterministic prefix so a regression that drops the
      // attachment payload entirely (zero-byte attachment) fails.
      expect(decoded).toContain("JVBERi0xLjQK"); // %PDF-1.4\n base64 prefix
      // Headers still travel correctly through this branch (separate
      // code path from the no-attachment Buffer-build path above).
      expect(decoded).toContain("To: bob@example.com");
      expect(decoded).toContain("Subject: With attachment");
    });
  });

  it("send_email rejects an attachment outside the jail with the override hint", async () => {
    await withFix(["gmail.send"], async (fix) => {
      // Drop a file in a sibling tempdir — outside the configured
      // GMAIL_MCP_ATTACHMENT_DIR. The path is absolute and the file
      // exists, so the rejection comes from `assertInsideJail` (not
      // from the absolute-path or existsSync guards earlier in
      // `assertAttachmentPathAllowed`). Pins the prompt-injection
      // defence: an LLM prompt that names `/etc/passwd` (or any
      // out-of-jail path) cannot exfiltrate via send_email.
      const outsidePath = join(downloadDir, "out-of-jail.txt");
      writeFileSync(outsidePath, "This file is outside the attachment jail.");

      const result = (await fix.client.callTool({
        name: "send_email",
        arguments: {
          to: ["bob@example.com"],
          subject: "Should be rejected",
          body: "x",
          from: "me@example.com",
          attachments: [outsidePath],
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("outside the allowed");
      // The override hint names the env var so the operator knows
      // how to widen the jail if intentional.
      expect(result.content[0]?.text).toContain("GMAIL_MCP_ATTACHMENT_DIR");
      // No Gmail call was issued — short-circuited inside Nodemailer.
      expect(fix.calls.messageSend).toHaveLength(0);
    });
  });

  it("draft_email with an in-jail attachment routes through drafts.create (not messages.send)", async () => {
    await withFix(["gmail.compose"], async (fix) => {
      const pdfPath = join(attachmentDir, "draft.pdf");
      writeFileSync(pdfPath, "%PDF-1.4\n%fake pdf for the draft test\n");

      const result = (await fix.client.callTool({
        name: "draft_email",
        arguments: {
          to: ["alice@example.com"],
          subject: "Draft with attachment",
          body: "Draft body",
          from: "me@example.com",
          attachments: [pdfPath],
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("draft created");
      // Pin that the attachment-bearing draft path lands on
      // `drafts.create` (NOT `messages.send`) — distinct from the
      // attachment-bearing send path tested above. A regression
      // that flips the if/else on `action === "send"` would silently
      // send the draft.
      expect(fix.calls.draftCreate).toHaveLength(1);
      expect(fix.calls.messageSend).toHaveLength(0);
      // The Nodemailer-built RFC822 lives at requestBody.message.raw
      // for drafts (one extra wrapper level vs send).
      const draft = fix.calls.draftCreate[0] as {
        requestBody: { message: { raw: string } };
      };
      const decoded = Buffer.from(draft.requestBody.message.raw, "base64url").toString("utf-8");
      expect(decoded).toMatch(/Content-Type: multipart\//);
      expect(decoded).toMatch(/Content-Disposition: attachment; filename=draft\.pdf/);
    });
  });

  it("send_email forwards threadId when supplied (preserves threading on the wire)", async () => {
    await withFix(["gmail.send"], async (fix) => {
      await fix.client.callTool({
        name: "send_email",
        arguments: {
          to: ["bob@example.com"],
          subject: "Re: Project",
          body: "Reply body",
          from: "me@example.com",
          threadId: "thread_xyz",
          inReplyTo: "<orig@example.com>",
        },
      });
      const sent = fix.calls.messageSend[0] as { requestBody: { threadId?: string } };
      expect(sent.requestBody.threadId).toBe("thread_xyz");
    });
  });
});

describe("PR #7 registrars — pair_recipient", () => {
  it("list returns the empty allowlist when no addresses have been paired", async () => {
    await withFix(["gmail.modify"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "pair_recipient",
        arguments: { action: "list" },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      // Pin the exact handler wording so a wording change is caught.
      // Source of truth: src/tools/messaging.ts:71-79.
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Paired recipients (0):");
      expect(text).toContain("(none)");
    });
  });

  it("add → list round-trip persists the address through GMAIL_MCP_PAIRED_PATH", async () => {
    await withFix(["gmail.modify"], async (fix) => {
      const addRes = (await fix.client.callTool({
        name: "pair_recipient",
        arguments: { action: "add", email: "trusted@example.com" },
      })) as { content: Array<{ type: string; text: string }> };
      // Pin the exact "Added X to the paired allowlist." wording.
      expect(addRes.content[0]?.text).toContain(
        'Added "trusted@example.com" to the paired allowlist.',
      );

      const listRes = (await fix.client.callTool({
        name: "pair_recipient",
        arguments: { action: "list" },
      })) as { content: Array<{ type: string; text: string }> };
      // Count went from 0 to 1, and the address appears as "  - …".
      expect(listRes.content[0]?.text).toContain("Paired recipients (1):");
      expect(listRes.content[0]?.text).toContain("  - trusted@example.com");
      // CR finding: prove the GMAIL_MCP_PAIRED_PATH override is wired
      // through to the on-disk store. Without this, both the add and
      // the list could silently route to ~/.gmail-mcp/paired.json on
      // the host and the round-trip text assertions would still pass.
      // Pin the file at `pairedPath` exists, parses, and contains the
      // address (lowercased per the recipient-pairing.ts contract).
      expect(existsSync(pairedPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(pairedPath, "utf-8")) as {
        version: number;
        addresses: string[];
        updatedAt: string;
      };
      expect(parsed.version).toBe(1);
      expect(parsed.addresses).toContain("trusted@example.com");
      expect(typeof parsed.updatedAt).toBe("string");
    });
  });

  it("remove drops a previously-paired address", async () => {
    await withFix(["gmail.modify"], async (fix) => {
      await fix.client.callTool({
        name: "pair_recipient",
        arguments: { action: "add", email: "ephemeral@example.com" },
      });
      const removeRes = (await fix.client.callTool({
        name: "pair_recipient",
        arguments: { action: "remove", email: "ephemeral@example.com" },
      })) as { content: Array<{ type: string; text: string }> };
      // Pin the exact "Removed X from the paired allowlist." wording.
      expect(removeRes.content[0]?.text).toContain(
        'Removed "ephemeral@example.com" from the paired allowlist.',
      );
      // CR finding: the success-text alone would still pass if the
      // handler logged the removal but never updated the backing
      // store. Pin the actual state change two ways: the tool's own
      // `list` action returns "(none)" + a count of 0, AND the
      // on-disk JSON at pairedPath either contains an empty
      // `addresses` array or has been removed entirely.
      const listRes = (await fix.client.callTool({
        name: "pair_recipient",
        arguments: { action: "list" },
      })) as { content: Array<{ type: string; text: string }> };
      expect(listRes.content[0]?.text).not.toContain("ephemeral@example.com");
      expect(listRes.content[0]?.text).toContain("(none)");
      if (existsSync(pairedPath)) {
        const parsed = JSON.parse(readFileSync(pairedPath, "utf-8")) as {
          addresses: string[];
        };
        expect(parsed.addresses).not.toContain("ephemeral@example.com");
      }
    });
  });

  it("remove without an email argument returns isError with a descriptive message", async () => {
    await withFix(["gmail.modify"], async (fix) => {
      // pair_recipient's runtime `!email` guard fires AFTER Zod parse
      // and is shared between the `add` and `remove` arms. Calling
      // with `action: "remove"` and NO `email` field hits the same
      // shared guard — the Zod schema accepts the missing email on
      // `remove` (since some allowlist UIs surface a remove-by-id
      // shape), then the handler's runtime check rejects it with
      // the "requires an `email` argument" message. Pinning that
      // wording locks the contract on the user-visible error
      // surface.
      const result = (await fix.client.callTool({
        name: "pair_recipient",
        arguments: { action: "remove" },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("requires an `email` argument");
    });
  });
});

describe("PR #7 registrars — reply_all", () => {
  it("fetches the original, builds the recipient list, and sends via sendOrDraftEmail", async () => {
    await withFix(["gmail.send", "gmail.readonly"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "reply_all",
        arguments: {
          messageId: "msg_orig",
          body: "Thanks for the heads-up!",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("Reply-all sent successfully");
      // gmail.users.messages.get fetched the original; getProfile
      // fetched my own address; messages.send sent the reply.
      expect(fix.calls.messageGet).toHaveLength(1);
      expect(fix.calls.getProfile).toHaveLength(1);
      expect(fix.calls.messageSend).toHaveLength(1);
      // Pin the recipient filter on the encoded RFC822 payload, not
      // the user-facing status text — the success message is just a
      // log line, the actual `To:`/`Cc:` headers ride on
      // `requestBody.raw`. A regression that drops the
      // `me@example.com` filter from `buildReplyAllRecipients` would
      // still produce a "Reply-all sent successfully" message but
      // would silently CC the user themselves.
      const sent = fix.calls.messageSend[0] as { requestBody: { raw: string } };
      const decoded = Buffer.from(sent.requestBody.raw, "base64url").toString("utf-8");
      expect(decoded).toContain("alice@example.com");
      // me@example.com legitimately appears in `From:` (the sender);
      // what must NOT happen is buildReplyAllRecipients leaving it
      // in `To:` or `Cc:` — that would CC the user themselves on
      // their own reply. Pin that contract on the recipient lines
      // only, not the whole MIME blob.
      const toLine = /^To:\s*(.+)$/m.exec(decoded)?.[1] ?? "";
      const ccLine = /^Cc:\s*(.+)$/m.exec(decoded)?.[1] ?? "";
      const fromLine = /^From:\s*(.+)$/m.exec(decoded)?.[1] ?? "";
      expect(toLine).not.toContain("me@example.com");
      expect(ccLine).not.toContain("me@example.com");
      // CR finding: the `from` arg was omitted, so the only way
      // `From:` ends up populated is via `resolveDefaultSender()` →
      // `users.settings.sendAs.list`. Pin both the call AND the
      // resulting MIME stamp so a regression that drops the resolver
      // (or that mis-wires its result) cannot pass this test.
      expect(fix.calls.sendAsList).toHaveLength(1);
      expect(fromLine).toContain("me@example.com");
    });
  });

  it("reply_all surfaces an isError when no recipients survive the self-filter", async () => {
    // Pin the throw at `messaging.ts:171` ("Could not determine
    // recipient for reply"). Reached when `buildReplyAllRecipients`
    // returns an empty `to` array — happens when the original
    // message's only From/To are the user's own address (here
    // `me@example.com`, returned by the mock's getProfile). Without
    // this guard, reply_all would silently send a reply with no
    // recipient and Gmail's API would error opaquely.
    await withFix(
      ["gmail.send", "gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "reply_all",
          arguments: {
            messageId: "msg_self_only",
            body: "Reply to self?",
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("Could not determine recipient");
        // No send call was issued — short-circuited.
        expect(fix.calls.messageSend).toHaveLength(0);
      },
      { messageFromOverride: "me@example.com" },
    );
  });
});

describe("PR #7 registrars — reply_to_email (sender-only)", () => {
  it("fetches the source, picks the first From mailbox, and sends a sender-only reply", async () => {
    await withFix(["gmail.send", "gmail.readonly"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "reply_to_email",
        arguments: {
          messageId: "msg_orig",
          body: "Acknowledged.",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("Reply sent successfully");
      expect(fix.calls.messageGet).toHaveLength(1);
      // No getProfile call — the sender-only path does not need to
      // know the authenticated user's address (no self-filter to apply
      // when we are only writing back to the original `From:`).
      expect(fix.calls.getProfile).toHaveLength(0);
      expect(fix.calls.messageSend).toHaveLength(1);
      const sent = fix.calls.messageSend[0] as { requestBody: { raw: string } };
      const decoded = Buffer.from(sent.requestBody.raw, "base64url").toString("utf-8");
      // Pin: To is the source `From:` mailbox only; no Cc broadcast.
      const toLine = /^To:\s*(.+)$/m.exec(decoded)?.[1] ?? "";
      const ccLine = /^Cc:\s*(.+)$/m.exec(decoded);
      expect(toLine).toContain("alice@example.com");
      expect(ccLine).toBeNull();
      // Subject carries Re: prefix, threading headers wired.
      expect(decoded).toMatch(/^Subject:\s*Re: Test message msg_orig$/m);
      expect(decoded).toMatch(/^In-Reply-To:\s*<msg_orig@example\.com>$/m);
      expect(decoded).toMatch(/^References:\s*<msg_orig@example\.com>$/m);
    });
  });

  it("isError when the source message has no From: header", async () => {
    // `messageFromOverride: ""` empties the From header on the
    // mock's messages.get — the sender-only resolver then has no
    // mailbox to reply to and bails with isError BEFORE issuing a
    // send, mirroring the reply_all empty-recipients guard.
    await withFix(
      ["gmail.send", "gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "reply_to_email",
          arguments: {
            messageId: "msg_no_from",
            body: "Hello?",
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("Could not determine a unique recipient");
        expect(result.content[0]?.text).toContain("no From: / Sender: / Reply-To: header");
        expect(fix.calls.messageSend).toHaveLength(0);
      },
      { messageFromOverride: "" },
    );
  });

  it("isError when the source message has multiple From: mailboxes and no Sender:", async () => {
    // CR finding (PR #99): silently picking the first From: on a
    // multi-author message could route a private reply to the
    // wrong participant. Pin the post-fix behaviour: with two
    // From: addresses and no Sender: disambiguator, the resolver
    // bails with isError so the agent must explicitly choose.
    await withFix(
      ["gmail.send", "gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "reply_to_email",
          arguments: {
            messageId: "msg_multi_from",
            body: "Hello?",
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("Could not determine a unique recipient");
        expect(result.content[0]?.text).toContain("multiple From: mailboxes");
        expect(fix.calls.messageSend).toHaveLength(0);
      },
      { messageFromOverride: "alice@example.com, david@example.com" },
    );
  });

  it("prefers Sender: when the source carries one (RFC 5322 §3.6.2)", async () => {
    // CR finding (PR #99): when both From: and Sender: are
    // present, RFC 5322 §3.6.2 says Sender identifies the agent
    // that physically transmitted the message. Replying to Sender
    // is the conservative choice when From: is multi-party. Pin
    // the resolver: a multi-From + single-Sender source addresses
    // the reply To: the Sender mailbox.
    await withFix(
      ["gmail.send", "gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "reply_to_email",
          arguments: {
            messageId: "msg_with_sender",
            body: "Acknowledged.",
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
        expect(result.isError).toBeFalsy();
        expect(result.content[0]?.text).toContain("Reply sent successfully");
        expect(fix.calls.messageSend).toHaveLength(1);
        const sent = fix.calls.messageSend[0] as { requestBody: { raw: string } };
        const decoded = Buffer.from(sent.requestBody.raw, "base64url").toString("utf-8");
        const toLine = /^To:\s*(.+)$/m.exec(decoded)?.[1] ?? "";
        // Pin: To is the Sender mailbox, not the first From entry.
        expect(toLine).toContain("ops@example.com");
        expect(toLine).not.toContain("alice@example.com");
      },
      {
        messageFromOverride: "alice@example.com, david@example.com",
        messageSenderOverride: "ops@example.com",
      },
    );
  });

  it("prefers Reply-To: over From: (RFC 5322 §3.6.2; mailing-list pattern)", async () => {
    // CR finding (PR #99): the headline mailing-list bug. When a
    // message arrives with From=list@example.com (the list itself)
    // and Reply-To=author@example.com (the human who wrote it),
    // replying to From: would broadcast a "private" reply to the
    // entire list. Pin the resolver: a single-From + single-Reply-To
    // source addresses the reply To: the Reply-To mailbox.
    await withFix(
      ["gmail.send", "gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "reply_to_email",
          arguments: {
            messageId: "msg_listmail",
            body: "Thanks for posting this.",
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
        expect(result.isError).toBeFalsy();
        expect(result.content[0]?.text).toContain("Reply sent successfully");
        const sent = fix.calls.messageSend[0] as { requestBody: { raw: string } };
        const decoded = Buffer.from(sent.requestBody.raw, "base64url").toString("utf-8");
        const toLine = /^To:\s*(.+)$/m.exec(decoded)?.[1] ?? "";
        // Pin: To is the Reply-To mailbox, not the From: list address.
        expect(toLine).toContain("author@example.com");
        expect(toLine).not.toContain("list@example.com");
      },
      {
        messageFromOverride: "list@example.com",
        messageReplyToOverride: "author@example.com",
      },
    );
  });
});

describe("PR #7 registrars — forward_email", () => {
  it("fetches the source, builds Fwd: subject + quoted body, and sends to the new recipients", async () => {
    await withFix(["gmail.send", "gmail.readonly"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "forward_email",
        arguments: {
          messageId: "msg_orig",
          to: ["carol@example.com"],
          body: "FYI — see below.",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("Forward sent successfully");
      expect(fix.calls.messageGet).toHaveLength(1);
      expect(fix.calls.messageSend).toHaveLength(1);
      const sent = fix.calls.messageSend[0] as { requestBody: { raw: string; threadId?: string } };
      // Forward starts a fresh thread — must NOT carry over
      // `threadId` from the source, otherwise Gmail UI nests the
      // forward under the original conversation and the recipient
      // sees an out-of-context reply chain.
      expect(sent.requestBody.threadId).toBeUndefined();
      const decoded = Buffer.from(sent.requestBody.raw, "base64url").toString("utf-8");
      // Subject prefixed Fwd:, To carries the new recipient.
      expect(decoded).toMatch(/^Subject:\s*Fwd: Test message msg_orig$/m);
      expect(decoded).toMatch(/^To:\s*carol@example\.com$/m);
      // The quoted body MUST include the standard separator + the
      // From/Date/Subject/To headers of the source. Pinning the
      // exact strings guards against a regression that drops a
      // header line or restyles the separator (Gmail's UI is
      // strict about the exact ASCII for thread inference).
      expect(decoded).toContain("FYI — see below.");
      expect(decoded).toContain("---------- Forwarded message ---------");
      expect(decoded).toContain("From: Alice <alice@example.com>");
      expect(decoded).toContain("Subject: Test message msg_orig");
      expect(decoded).toContain("To: bob@example.com");
      // Original body verbatim — pinned so the mime-walker
      // extractEmailContent path stays wired.
      expect(decoded).toContain("default body content");
    });
  });

  it("supports cc and bcc recipients on the forward", async () => {
    await withFix(["gmail.send", "gmail.readonly"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "forward_email",
        arguments: {
          messageId: "msg_orig",
          to: ["carol@example.com"],
          cc: ["dave@example.com"],
          bcc: ["eve@example.com"],
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      const sent = fix.calls.messageSend[0] as { requestBody: { raw: string } };
      const decoded = Buffer.from(sent.requestBody.raw, "base64url").toString("utf-8");
      expect(decoded).toMatch(/^Cc:\s*dave@example\.com$/m);
      expect(decoded).toMatch(/^Bcc:\s*eve@example\.com$/m);
      // Sanity-check the user-facing summary surfaces the cc/bcc
      // counts so the agent can confirm the broadcast scope.
      expect(result.content[0]?.text).toContain("CC: dave@example.com");
      expect(result.content[0]?.text).toContain("BCC: eve@example.com");
    });
  });

  it("omits preface gracefully when no body is supplied", async () => {
    await withFix(["gmail.send", "gmail.readonly"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "forward_email",
        arguments: {
          messageId: "msg_orig",
          to: ["carol@example.com"],
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      const sent = fix.calls.messageSend[0] as { requestBody: { raw: string } };
      const decoded = Buffer.from(sent.requestBody.raw, "base64url").toString("utf-8");
      // First non-header line of the MIME body is the separator —
      // no preface gap. Use a non-greedy split to grab the body
      // section only (after the empty line that marks header end).
      const bodyStart = decoded
        .split(/\r?\n\r?\n/)
        .slice(1)
        .join("\n\n");
      expect(bodyStart.startsWith("---------- Forwarded message ---------")).toBe(true);
    });
  });
});

describe("PR #4 registrars — filter templates (4 paths)", () => {
  it("create_filter_from_template (withSubject) pins criteria.subject + action.addLabelIds on the wire", async () => {
    await withFix(["gmail.settings.basic"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "create_filter_from_template",
        arguments: {
          template: "withSubject",
          parameters: { subjectText: "[Newsletter]", labelIds: ["Label_news"] },
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("withSubject");
      // CR finding: pin the template-specific wiring on the actual
      // filterCreate request body. Without this, a regression that
      // mis-maps `withSubject` to `from:` (or drops `addLabelIds`)
      // still passes the success-text-only check.
      expect(fix.calls.filterCreate).toHaveLength(1);
      const body = (
        fix.calls.filterCreate[0] as {
          requestBody: {
            criteria: { subject?: string; from?: string };
            action: { addLabelIds?: string[] };
          };
        }
      ).requestBody;
      expect(body.criteria).toMatchObject({ subject: "[Newsletter]" });
      expect(body.criteria.from).toBeUndefined();
      expect(body.action.addLabelIds).toEqual(["Label_news"]);
    });
  });

  it("create_filter_from_template (largeEmails) pins criteria.size + sizeComparison on the wire", async () => {
    await withFix(["gmail.settings.basic"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "create_filter_from_template",
        arguments: {
          template: "largeEmails",
          parameters: { sizeInBytes: 5_000_000, labelIds: ["Label_big"] },
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("largeEmails");
      // CR finding: pin both the size threshold and the comparison
      // direction. A regression that flips `larger` → `smaller` (or
      // drops the comparison entirely) would silently invert the
      // filter's intent and still pass a count-only check.
      expect(fix.calls.filterCreate).toHaveLength(1);
      const body = (
        fix.calls.filterCreate[0] as {
          requestBody: {
            criteria: { size?: number; sizeComparison?: string };
            action: { addLabelIds?: string[] };
          };
        }
      ).requestBody;
      expect(body.criteria).toMatchObject({ size: 5_000_000, sizeComparison: "larger" });
      expect(body.action.addLabelIds).toEqual(["Label_big"]);
    });
  });

  it("create_filter_from_template (containingText) propagates markImportant on the wire", async () => {
    await withFix(["gmail.settings.basic"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "create_filter_from_template",
        arguments: {
          template: "containingText",
          parameters: { searchText: "urgent", labelIds: ["Label_urg"], markImportant: true },
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("containingText");
      // Pin the actual filter payload — without this assertion a
      // regression that silently drops `markImportant` from the
      // template-to-action mapping would still pass the success-text
      // check. `filterTemplates.containingText(text, labels, true)`
      // appends the system "IMPORTANT" label to the user labels.
      expect(fix.calls.filterCreate).toHaveLength(1);
      const body = (
        fix.calls.filterCreate[0] as { requestBody: { action: { addLabelIds?: string[] } } }
      ).requestBody;
      expect(body.action.addLabelIds).toEqual(expect.arrayContaining(["Label_urg", "IMPORTANT"]));
    });
  });

  it("create_filter_from_template (mailingList) pins criteria.query + INBOX-archive on the wire", async () => {
    await withFix(["gmail.settings.basic"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "create_filter_from_template",
        arguments: {
          template: "mailingList",
          parameters: { listIdentifier: "discuss@example.com", labelIds: ["Label_list"] },
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("mailingList");
      // CR finding: pin the dual-shape Gmail query (List-Id +
      // bracketed Subject) AND the INBOX-removal that the template's
      // `archive=true` default produces. A regression that drops
      // either branch of the OR (or that forgets to archive) still
      // passes the success-text-only check.
      expect(fix.calls.filterCreate).toHaveLength(1);
      const body = (
        fix.calls.filterCreate[0] as {
          requestBody: {
            criteria: { query?: string };
            action: { addLabelIds?: string[]; removeLabelIds?: string[] };
          };
        }
      ).requestBody;
      expect(body.criteria.query).toBe("list:discuss@example.com OR subject:[discuss@example.com]");
      expect(body.action.addLabelIds).toEqual(["Label_list"]);
      expect(body.action.removeLabelIds).toEqual(["INBOX"]);
    });
  });

  it("create_filter_from_template surfaces a parameter-missing error as isError=true", async () => {
    await withFix(["gmail.settings.basic"], async (fix) => {
      // `withSubject` requires `subjectText`. Omitting it should
      // make the tool throw, which wrapToolHandler maps to
      // `isError: true`.
      const result = (await fix.client.callTool({
        name: "create_filter_from_template",
        arguments: {
          template: "withSubject",
          parameters: { labelIds: ["Label_x"] },
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("subjectText is required");
    });
  });

  it.each([
    ["fromSender", { labelIds: ["L"] }, "senderEmail is required"],
    ["largeEmails", { labelIds: ["L"] }, "sizeInBytes is required"],
    ["containingText", { labelIds: ["L"] }, "searchText is required"],
    ["mailingList", { labelIds: ["L"] }, "listIdentifier is required"],
  ] as const)(
    "create_filter_from_template (%s) surfaces a missing-parameter error",
    async (template, params, errFragment) => {
      // Pins the per-template parameter-missing throws in
      // `src/tools/filters.ts:188-211`. Each template has its own
      // throw with a template-specific message — table-driven so
      // a regression that copies the wrong error message between
      // templates is caught.
      await withFix(["gmail.settings.basic"], async (fix) => {
        const result = (await fix.client.callTool({
          name: "create_filter_from_template",
          arguments: { template, parameters: params },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain(errFragment);
        // No filterCreate call was issued — the throw fires before
        // the registrar reaches `createFilter`.
        expect(fix.calls.filterCreate).toHaveLength(0);
      });
    },
  );
});

describe("PR #6 registrars — download error paths", () => {
  it("download_email rejects a relative savePath before reaching the Gmail API", async () => {
    await withFix(["gmail.readonly"], async (fix) => {
      // resolveDownloadSavePath enforces an absolute path; this catches
      // the local-validation branch which fires *before* any Gmail call.
      // Pinned separately from the HTTP-error path below — the prefix
      // here is the generic "Failed to download email" (no HTTP code).
      const result = (await fix.client.callTool({
        name: "download_email",
        arguments: { messageId: "msg_x", savePath: "relative/path", format: "json" },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("Failed to download email");
      expect(result.content[0]?.text).not.toContain("HTTP ");
      // No Gmail call was issued — it short-circuited on validation.
      expect(fix.calls.messageGet).toHaveLength(0);
    });
  });

  it("download_email surfaces the Gmail HTTP status when messages.get throws", async () => {
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        // savePath is absolute and inside the jail (downloadDir is the
        // GMAIL_MCP_DOWNLOAD_DIR set in beforeEach), so validation
        // passes and gmail.users.messages.get is reached. The mock then
        // throws a {.code = 502} Error which asGmailApiError formats as
        // "(HTTP 502)" in the catch-branch prefix.
        const result = (await fix.client.callTool({
          name: "download_email",
          arguments: { messageId: "msg_502", savePath: downloadDir, format: "json" },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("Failed to download email (HTTP 502)");
        expect(result.content[0]?.text).toContain("Simulated Gmail API failure");
        // Pin that the Gmail call was actually attempted.
        expect(fix.calls.messageGet).toHaveLength(1);
      },
      { messageGetHttpError: 502 },
    );
  });

  it("download_attachment falls back to attachment-${id} when filename is omitted", async () => {
    await withFix(["gmail.modify"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "download_attachment",
        arguments: {
          messageId: "msg_with_att",
          attachmentId: "att_default_name",
          savePath: downloadDir,
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      // The mock messages.get returns a payload without an
      // `attachmentId` match in any part, so the fallback name
      // `attachment-att_default_name` should be used.
      expect(result.content[0]?.text).toContain("attachment-att_default_name");
      const written = readdirSync(downloadDir);
      expect(written).toContain("attachment-att_default_name");
    });
  });

  it("download_attachment surfaces a clear error when Gmail returns empty data", async () => {
    // Pin the "No attachment data received" guard at
    // `src/tools/downloads.ts:125-127`. Gmail returns an empty
    // `data` field rarely (corrupt server-side state, expired
    // temporary URL) — the guard surfaces it as a clean
    // typed error instead of a confusing Buffer-from-empty
    // downstream failure.
    await withFix(
      ["gmail.modify"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "download_attachment",
          arguments: {
            messageId: "msg_x",
            attachmentId: "att_empty",
            savePath: downloadDir,
            filename: "x.bin",
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("No attachment data received");
        // No file was written.
        expect(readdirSync(downloadDir)).toHaveLength(0);
      },
      { attachmentDataEmpty: true },
    );
  });

  it("download_attachment uses the filename found inside the message payload", async () => {
    // Pin the "filename found in payload" path at
    // `src/tools/downloads.ts:142-144`. When the tool is called
    // WITHOUT a `filename` arg, it fetches the message and walks
    // `payload.parts` looking for the matching `attachmentId`.
    // The existing fallback test exercises the no-match case
    // (synthetic `attachment-${id}` name); this test pins the
    // success case (real filename from the payload).
    await withFix(
      ["gmail.modify"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "download_attachment",
          arguments: {
            messageId: "msg_with_pdf",
            attachmentId: "att_pdf_in_payload",
            savePath: downloadDir,
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
        expect(result.isError).toBeFalsy();
        expect(result.content[0]?.text).toContain("invoice-2026.pdf");
        const written = readdirSync(downloadDir);
        expect(written).toContain("invoice-2026.pdf");
      },
      {
        messageAttachments: [
          {
            partId: "1.1",
            filename: "invoice-2026.pdf",
            mimeType: "application/pdf",
            attachmentId: "att_pdf_in_payload",
            size: 4096,
          },
        ],
      },
    );
  });

  it("download_attachment surfaces the Gmail HTTP status when attachments.get throws", async () => {
    // Symmetric to the `download_email surfaces the Gmail HTTP
    // status` test above, against `src/tools/downloads.ts:192-197`.
    // The catch branch formats the prefix as
    // `Failed to download attachment (HTTP <status>)` when
    // `asGmailApiError` extracts a numeric `.code`. Without this
    // test, a regression that drops the HTTP-code lookup and falls
    // back to the no-code branch silently degrades the error
    // surface.
    await withFix(
      ["gmail.modify"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "download_attachment",
          arguments: {
            messageId: "msg_x",
            attachmentId: "att_503",
            savePath: downloadDir,
            filename: "x.bin",
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("Failed to download attachment (HTTP 503)");
        expect(result.content[0]?.text).toContain("Simulated Gmail API failure");
        expect(fix.calls.attachmentGet).toHaveLength(1);
      },
      { attachmentGetHttpError: 503 },
    );
  });
});

describe("Drafts CRUD registrars — list_drafts / get_draft / update_draft / delete_draft / send_draft", () => {
  it("list_drafts returns the seeded items + nextPageToken in structuredContent", async () => {
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "list_drafts",
          arguments: { maxResults: 50 },
        })) as {
          content: Array<{ type: string; text: string }>;
          structuredContent?: {
            drafts?: Array<{ id: string }>;
            nextPageToken?: string;
            count?: number;
          };
          isError?: boolean;
        };
        expect(result.isError).toBeFalsy();
        expect(fix.calls.draftList).toHaveLength(1);
        expect(fix.calls.draftList[0]).toMatchObject({ userId: "me", maxResults: 50 });
        expect(result.structuredContent?.count).toBe(2);
        expect(result.structuredContent?.drafts?.map((d) => d.id)).toEqual(["d_a", "d_b"]);
        expect(result.structuredContent?.nextPageToken).toBe("page2");
        // Pin the user-facing footer that surfaces nextPageToken so an
        // agent reading the text channel sees there is more data.
        expect(result.content[0]?.text).toContain("Next page token: page2");
      },
      {
        drafts: [
          { id: "d_a", messageId: "msg_a", threadId: "thr_a" },
          { id: "d_b", messageId: "msg_b", threadId: "thr_b" },
        ],
        draftsNextPageToken: "page2",
      },
    );
  });

  it("list_drafts forwards q + includeSpamTrash when supplied", async () => {
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "list_drafts",
          arguments: {
            q: "subject:invoice",
            includeSpamTrash: true,
            maxResults: 25,
          },
        })) as { isError?: boolean };
        expect(result.isError).toBeFalsy();
        expect(fix.calls.draftList).toHaveLength(1);
        expect(fix.calls.draftList[0]).toMatchObject({
          userId: "me",
          maxResults: 25,
          q: "subject:invoice",
          includeSpamTrash: true,
        });
      },
      {
        drafts: [{ id: "d_a", messageId: "msg_a", threadId: "thr_a" }],
      },
    );
  });

  it("list_drafts surfaces an HTTP error with isError + status prefix", async () => {
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "list_drafts",
          arguments: {},
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("HTTP 503");
      },
      { draftListHttpError: 503 },
    );
  });

  it("get_draft fetches one draft by id and returns id + message in the JSON envelope", async () => {
    await withFix(["gmail.readonly"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "get_draft",
        arguments: { id: "d_target" },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(fix.calls.draftGet).toHaveLength(1);
      expect(fix.calls.draftGet[0]).toMatchObject({ userId: "me", id: "d_target", format: "full" });
      // Pin id + nested message.id so a regression that drops the
      // message envelope on the wire is caught (the textual handler
      // would still emit "id: d_target" but agents that introspect
      // the JSON envelope would lose the headers + body).
      expect(result.content[0]?.text).toContain('"id": "d_target"');
      expect(result.content[0]?.text).toContain('"id": "msg_in_d_target"');
    });
  });

  it("update_draft assembles the new RFC 822 payload and routes drafts.update with the same id", async () => {
    await withFix(["gmail.modify"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "update_draft",
        arguments: {
          id: "d_target",
          to: ["bob@example.com"],
          subject: "Updated subject",
          body: "Updated body content",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(fix.calls.draftUpdate).toHaveLength(1);
      const sent = fix.calls.draftUpdate[0] as {
        userId: string;
        id: string;
        requestBody: { id: string; message: { raw: string; threadId?: string } };
      };
      // Pin the id duplication (URL path + body — Gmail's API is
      // strict that both match) and the absence of threadId when the
      // caller did not supply one.
      expect(sent.userId).toBe("me");
      expect(sent.id).toBe("d_target");
      expect(sent.requestBody.id).toBe("d_target");
      expect(sent.requestBody.message.threadId).toBeUndefined();
      // The encoded raw payload must round-trip back to a real
      // RFC 822 message containing the updated subject/body. A
      // regression that drops the buildEncodedRawMessage hop would
      // produce an empty `raw`.
      const decoded = Buffer.from(sent.requestBody.message.raw, "base64url").toString("utf-8");
      expect(decoded).toMatch(/^Subject:\s*Updated subject$/m);
      expect(decoded).toContain("Updated body content");
      expect(decoded).toMatch(/^To:\s*bob@example\.com$/m);
      // Surface message indicates the draft id + new message id.
      expect(result.content[0]?.text).toContain("Draft d_target updated successfully");
      expect(result.content[0]?.text).toContain("msg_after_update_d_target");
    });
  });

  it("update_draft backfills In-Reply-To / References from threadId (preserves threading)", async () => {
    // CR finding (PR #100, round 2): without this backfill, the
    // regenerated raw message strips In-Reply-To / References
    // headers when the caller supplies threadId without explicit
    // headers — the updated draft becomes orphaned in its
    // conversation when later sent. Mirror sendOrDraftEmail's
    // thread-header resolution path. Pin via the encoded raw
    // payload: threading headers must round-trip.
    await withFix(
      ["gmail.modify"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "update_draft",
          arguments: {
            id: "d_threaded",
            to: ["bob@example.com"],
            subject: "Updated subject",
            body: "Updated body",
            threadId: "t_existing",
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
        expect(result.isError).toBeFalsy();
        // Pin: threads.get fired (the backfill triggered).
        expect(fix.calls.threadGet).toHaveLength(1);
        expect(fix.calls.threadGet[0]).toMatchObject({
          userId: "me",
          id: "t_existing",
          format: "metadata",
        });
        const sent = fix.calls.draftUpdate[0] as {
          requestBody: { id: string; message: { raw: string; threadId?: string } };
        };
        expect(sent.requestBody.message.threadId).toBe("t_existing");
        const decoded = Buffer.from(sent.requestBody.message.raw, "base64url").toString("utf-8");
        // Pin: In-Reply-To and References headers ARE present in
        // the encoded payload — backfilled from the thread's
        // existing messages by the resolution path.
        expect(decoded).toMatch(/^In-Reply-To:\s*<t_msg2@example\.com>$/m);
        expect(decoded).toMatch(/^References:\s*<t_msg1@example\.com> <t_msg2@example\.com>$/m);
      },
      {
        threads: {
          t_existing: {
            messages: [
              { id: "t_msg1", from: "alice@example.com", subject: "Original" },
              { id: "t_msg2", from: "carol@example.com", subject: "Re: Original" },
            ],
          },
        },
      },
    );
  });

  it("update_draft continues degraded when threads.get fails (warning, no In-Reply-To backfill)", async () => {
    // Pins the catch arm of the thread-header backfill (drafts.ts
    // ~200-205): if `threads.get` throws, the handler logs and
    // proceeds without `In-Reply-To` / `References`. The encode +
    // drafts.update still fire so the user-visible draft body is
    // saved; only the threading metadata is lost.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withFix(
        ["gmail.modify"],
        async (fix) => {
          const result = (await fix.client.callTool({
            name: "update_draft",
            arguments: {
              id: "d_target",
              to: ["bob@example.com"],
              subject: "Updated subject",
              body: "Updated body content",
              threadId: "t_broken",
            },
          })) as { isError?: boolean };
          expect(result.isError).toBeFalsy();
          // threads.get fired (the backfill was attempted) but
          // threw; drafts.update still ran with the threadId.
          expect(fix.calls.threadGet).toHaveLength(1);
          expect(fix.calls.draftUpdate).toHaveLength(1);
          const sent = fix.calls.draftUpdate[0] as {
            requestBody: { message: { raw: string; threadId?: string } };
          };
          expect(sent.requestBody.message.threadId).toBe("t_broken");
          // No threading headers in the encoded body (degraded mode).
          const decoded = Buffer.from(sent.requestBody.message.raw, "base64url").toString("utf-8");
          expect(decoded).not.toMatch(/^In-Reply-To:/m);
          expect(decoded).not.toMatch(/^References:/m);
          // Console warn fired with the expected prefix.
          expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining("Could not fetch thread t_broken"),
          );
        },
        { threadGetHttpError: 500 },
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("delete_draft routes drafts.delete with the supplied id and surfaces a clean confirmation", async () => {
    await withFix(["gmail.modify"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "delete_draft",
        arguments: { id: "d_doomed" },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(fix.calls.draftDelete).toHaveLength(1);
      expect(fix.calls.draftDelete[0]).toMatchObject({ userId: "me", id: "d_doomed" });
      expect(result.content[0]?.text).toContain("Draft d_doomed deleted permanently");
    });
  });

  it("send_draft routes drafts.send with the id when pairing is disabled (no pre-flight fetch)", async () => {
    // CR follow-up on PR #100: when GMAIL_MCP_RECIPIENT_PAIRING is
    // off (the default), send_draft must NOT pay the cost of an
    // unconditional drafts.get round-trip just to gate recipients.
    // Pin: drafts.send fires, drafts.get does NOT.
    await withFix(["gmail.modify"], async (fix) => {
      const result = (await fix.client.callTool({
        name: "send_draft",
        arguments: { id: "d_outgoing" },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(fix.calls.draftGet).toHaveLength(0);
      expect(fix.calls.draftSend).toHaveLength(1);
      expect(fix.calls.draftSend[0]).toMatchObject({
        userId: "me",
        requestBody: { id: "d_outgoing" },
      });
      expect(result.content[0]?.text).toContain("Draft d_outgoing sent successfully");
      expect(result.content[0]?.text).toContain("sent_from_d_outgoing");
    });
  });

  it("send_draft fetches the draft + gates recipients when pairing is enabled (paired To passes)", async () => {
    // The complementary path: with pairing enabled and the
    // recipient pre-paired, send_draft DOES pay the drafts.get
    // round-trip but the gate clears and drafts.send still fires.
    process.env.GMAIL_MCP_RECIPIENT_PAIRING = "true";
    try {
      await withFix(["gmail.modify"], async (fix) => {
        // Pre-pair the recipient that the mock's drafts.get
        // returns (alice/bob @example.com per the mock fixture).
        await fix.client.callTool({
          name: "pair_recipient",
          arguments: { action: "add", email: "alice@example.com" },
        });
        await fix.client.callTool({
          name: "pair_recipient",
          arguments: { action: "add", email: "bob@example.com" },
        });
        const result = (await fix.client.callTool({
          name: "send_draft",
          arguments: { id: "d_paired" },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
        expect(result.isError).toBeFalsy();
        // Pin the pre-flight fetch fires under pairing with
        // format=full (CR security follow-up: metadata can omit
        // the Bcc header — full preserves all original headers
        // so an unpaired Bcc cannot bypass the gate).
        expect(fix.calls.draftGet).toHaveLength(1);
        expect(fix.calls.draftGet[0]).toMatchObject({
          userId: "me",
          id: "d_paired",
          format: "full",
        });
        expect(fix.calls.draftSend).toHaveLength(1);
      });
    } finally {
      delete process.env.GMAIL_MCP_RECIPIENT_PAIRING;
    }
  });

  it("send_draft pairing gate uses format=full so an unpaired Bcc cannot bypass the allowlist", async () => {
    // CR security finding (PR #100): metadata-format `drafts.get`
    // can omit the `Bcc:` header (Gmail strips Bcc from the
    // metadata projection of sent messages and may do the same
    // for drafts). With `metadata`, an attacker who staged a
    // draft with an unpaired Bcc via the Gmail UI / a different
    // session / a prior `update_draft` would slip past the gate
    // and reach `drafts.send`. Pin the post-fix behaviour: the
    // gate fetches with `format=full`, the mock returns the Bcc
    // header verbatim, the gate sees the unpaired recipient, and
    // `drafts.send` is short-circuited.
    process.env.GMAIL_MCP_RECIPIENT_PAIRING = "true";
    try {
      await withFix(
        ["gmail.modify"],
        async (fix) => {
          // Pre-pair the To/From mailboxes so the only unpaired
          // recipient is the injected Bcc — that proves the Bcc
          // is what blocks the send (not the To).
          await fix.client.callTool({
            name: "pair_recipient",
            arguments: { action: "add", email: "alice@example.com" },
          });
          await fix.client.callTool({
            name: "pair_recipient",
            arguments: { action: "add", email: "bob@example.com" },
          });
          const result = (await fix.client.callTool({
            name: "send_draft",
            arguments: { id: "d_bcc_attack" },
          })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
          expect(result.isError).toBe(true);
          // The error mentions the Bcc address that broke the
          // allowlist — operator gets actionable diagnostic.
          expect(result.content[0]?.text).toContain("eve@evil.example");
          // Drafts.get fired with format=full (preserves Bcc);
          // drafts.send did NOT — the gate caught the Bcc.
          expect(fix.calls.draftGet).toHaveLength(1);
          expect(fix.calls.draftGet[0]).toMatchObject({ format: "full" });
          expect(fix.calls.draftSend).toHaveLength(0);
        },
        { draftBccHeader: "eve@evil.example" },
      );
    } finally {
      delete process.env.GMAIL_MCP_RECIPIENT_PAIRING;
    }
  });

  it("send_draft pairing gate inspects ALL repeated To/Cc/Bcc headers, not just the first instance", async () => {
    // CR Major (PR #100, round 6): RFC 5322 allows repeated
    // destination headers and Gmail merges them when sending. A
    // `headers.find` (first-only) implementation would let an
    // attacker stage `To: alice@allowed` + `To: mallory@evil` —
    // pairing checks alice (paired), Gmail sends to BOTH. The
    // gate must walk every matching header instance and pass the
    // union of mailboxes to `requirePairedRecipients`.
    process.env.GMAIL_MCP_RECIPIENT_PAIRING = "true";
    try {
      await withFix(
        ["gmail.modify"],
        async (fix) => {
          // Pair only alice — the first `To:` instance. mallory
          // is the second instance and stays unpaired.
          await fix.client.callTool({
            name: "pair_recipient",
            arguments: { action: "add", email: "alice@example.com" },
          });
          await fix.client.callTool({
            name: "pair_recipient",
            arguments: { action: "add", email: "bob@example.com" },
          });
          const result = (await fix.client.callTool({
            name: "send_draft",
            arguments: { id: "d_multi_to_attack" },
          })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
          expect(result.isError).toBe(true);
          // The error names the unpaired second-instance address
          // — operator gets actionable diagnostic.
          expect(result.content[0]?.text).toContain("mallory@evil.example");
          // Gate fired before drafts.send.
          expect(fix.calls.draftSend).toHaveLength(0);
        },
        {
          draftExtraHeaders: [
            { name: "To", value: "alice@example.com" },
            { name: "To", value: "mallory@evil.example" },
          ],
        },
      );
    } finally {
      delete process.env.GMAIL_MCP_RECIPIENT_PAIRING;
    }
  });

  it("send_draft is blocked by the recipient-pairing gate when an unpaired To/Cc/Bcc is on the draft", async () => {
    // CR finding (PR #100): the headline send-draft pairing
    // bypass. Stage the env so pairing is enforced; the mock's
    // drafts.get returns a draft addressed to `bob@example.com`,
    // which is NOT in the paired allowlist. The gate must fire on
    // the union of To/Cc/Bcc parsed from the draft's headers and
    // throw before the drafts.send call lands.
    process.env.GMAIL_MCP_RECIPIENT_PAIRING = "true";
    try {
      await withFix(["gmail.modify"], async (fix) => {
        const result = (await fix.client.callTool({
          name: "send_draft",
          arguments: { id: "d_unpaired" },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("bob@example.com");
        // Drafts.get fired (we needed the headers to gate); but
        // drafts.send did NOT — short-circuited by the throw.
        expect(fix.calls.draftGet).toHaveLength(1);
        expect(fix.calls.draftSend).toHaveLength(0);
      });
    } finally {
      delete process.env.GMAIL_MCP_RECIPIENT_PAIRING;
    }
  });

  it("send_draft surfaces an HTTP error (e.g. 404 invalid draft id) with isError + status prefix", async () => {
    // With pairing disabled (the default in this test), the only
    // round-trip is drafts.send itself; surface a 404 from there.
    await withFix(
      ["gmail.modify"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "send_draft",
          arguments: { id: "d_missing" },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("HTTP 404");
      },
      { draftSendHttpError: 404 },
    );
  });

  it("send_draft is NOT advertised under a send-only token (Gmail API drafts.send rejects gmail.send)", async () => {
    // CR finding (PR #100, round 2): per Gmail API docs, the
    // `users.drafts.send` endpoint accepts only `mail.google.com |
    // gmail.modify | gmail.compose` — `gmail.send` (which covers
    // `users.messages.send`) is NOT sufficient. Pin the post-fix
    // scope gate so a regression that re-adds `gmail.send` to the
    // tool's scope set is caught.
    const fix = await buildAndConnect(["gmail.send"]);
    try {
      const list = await fix.client.listTools();
      const names = list.tools.map((t) => t.name);
      // send_email accepts gmail.send (messages.send endpoint), so
      // it stays advertised; send_draft does NOT.
      expect(names).toContain("send_email");
      expect(names).not.toContain("send_draft");
      expect(names).not.toContain("update_draft");
      expect(names).not.toContain("delete_draft");
    } finally {
      await fix.close();
    }
  });

  it("update_draft surfaces HTTP errors with isError + status prefix", async () => {
    await withFix(
      ["gmail.modify"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "update_draft",
          arguments: {
            id: "d_target",
            to: ["bob@example.com"],
            subject: "Subject",
            body: "Body",
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("HTTP 500");
      },
      { draftUpdateHttpError: 500 },
    );
  });

  it("delete_draft surfaces HTTP errors with isError + status prefix", async () => {
    await withFix(
      ["gmail.modify"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "delete_draft",
          arguments: { id: "d_missing" },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("HTTP 404");
      },
      { draftDeleteHttpError: 404 },
    );
  });

  it("get_draft surfaces HTTP errors with isError + status prefix", async () => {
    await withFix(
      ["gmail.readonly"],
      async (fix) => {
        const result = (await fix.client.callTool({
          name: "get_draft",
          arguments: { id: "d_unknown" },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("HTTP 404");
      },
      { draftGetHttpError: 404 },
    );
  });

  it("delete_draft is NOT advertised under a readonly token (gmail.modify only)", async () => {
    const fix = await buildAndConnect(["gmail.readonly"]);
    try {
      const list = await fix.client.listTools();
      const names = list.tools.map((t) => t.name);
      // delete_draft requires gmail.modify (irrevocable); list_drafts
      // and get_draft accept readonly. Pin both halves of the scope
      // gate so a regression that widens delete_draft to readonly is
      // caught.
      expect(names).toContain("list_drafts");
      expect(names).toContain("get_draft");
      expect(names).not.toContain("delete_draft");
      expect(names).not.toContain("update_draft");
      expect(names).not.toContain("send_draft");
    } finally {
      await fix.close();
    }
  });

  it("update_draft is NOT advertised under a compose-only token (gmail.modify required)", async () => {
    // CR finding (PR #100): update_draft was previously gated by
    // [gmail.modify, gmail.compose] which advertised the tool to
    // compose-only identities, contradicting the documented
    // 'update / delete require modify' mapping. Pin the post-fix
    // gate so a regression that re-adds gmail.compose to the
    // scopes list is caught.
    const fix = await buildAndConnect(["gmail.compose"]);
    try {
      const list = await fix.client.listTools();
      const names = list.tools.map((t) => t.name);
      // Compose token can read drafts (list/get accept compose),
      // create them (draft_email accepts compose), and SEND them
      // (send_draft accepts modify|compose per Gmail API), but
      // cannot mutate or destroy existing ones.
      expect(names).toContain("list_drafts");
      expect(names).toContain("get_draft");
      expect(names).toContain("draft_email");
      expect(names).toContain("send_draft");
      expect(names).not.toContain("update_draft");
      expect(names).not.toContain("delete_draft");
    } finally {
      await fix.close();
    }
  });
});

describe("PR #3+#4+#5+#6 registrars — combined tools/list shape", () => {
  it("advertises every PR-#3+#4+#5+#6 tool when the token covers every required scope", async () => {
    await withFix(
      ["mail.google.com", "gmail.modify", "gmail.labels", "gmail.settings.basic", "gmail.readonly"],
      async (fix) => {
        const list = await fix.client.listTools();
        const names = list.tools.map((t) => t.name).sort();
        expect(names).toEqual([
          "batch_delete_emails",
          "batch_modify_emails",
          "create_filter",
          "create_filter_from_template",
          "create_label",
          "delete_draft",
          "delete_email",
          "delete_filter",
          "delete_label",
          "download_attachment",
          "download_email",
          "draft_email",
          "forward_email",
          "get_draft",
          "get_filter",
          "get_inbox_with_threads",
          "get_or_create_label",
          "get_thread",
          "list_drafts",
          "list_email_labels",
          "list_filters",
          "list_inbox_threads",
          "modify_email",
          "modify_thread",
          "pair_recipient",
          "read_email",
          "reply_all",
          "reply_to_email",
          "search_emails",
          "send_draft",
          "send_email",
          "update_draft",
          "update_label",
        ]);
      },
    );
  });

  it("filters out tools whose required scopes are missing from the token", async () => {
    // Only gmail.modify + gmail.labels — covers the label management
    // tools, modify_thread, modify_email, batch_modify_emails. Does
    // NOT cover: delete_email (mail.google.com), filter tools
    // (gmail.settings.basic), batch_delete_emails (mail.google.com),
    // read_email / search_emails / list_email_labels (gmail.readonly,
    // even though gmail.modify is a strict superset upstream the tool
    // definition declares only gmail.modify for the write set, so the
    // ANY-of-required match still picks them up).
    await withFix(["gmail.modify", "gmail.labels"], async (fix) => {
      const list = await fix.client.listTools();
      const names = list.tools.map((t) => t.name).sort();
      expect(names).toContain("create_label");
      expect(names).toContain("modify_email");
      expect(names).toContain("batch_modify_emails");
      expect(names).not.toContain("delete_email");
      expect(names).not.toContain("batch_delete_emails");
      expect(names).not.toContain("create_filter");
    });
  });
});
