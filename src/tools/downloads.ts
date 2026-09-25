/**
 * Download-domain tool registrars (`download_email`,
 * `download_attachment`, `download_all_attachments`). Every tool
 * writes under the `GMAIL_MCP_DOWNLOAD_DIR` jail (default
 * `~/GmailDownloads`) via `safeWriteFile` (O_NOFOLLOW on the leaf,
 * O_EXCL against silent overwrites). PR #7 deletes the corresponding
 * switch arms from the legacy dispatcher in `src/index.ts`.
 */

import path from "node:path";
import fs from "node:fs";
import type { gmail_v1 } from "googleapis";
import { Zip, ZipDeflate, type FlateError } from "fflate";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, pullToolMeta as pull } from "./_shared.js";
import {
  DownloadEmailSchema,
  DownloadAttachmentSchema,
  DownloadAllAttachmentsSchema,
} from "../tools.js";
import {
  resolveDownloadSavePath,
  getDownloadDirectory,
  safeWriteFile,
  toSafeAttachmentFilename,
  claimUniqueFilename,
} from "../utl.js";
import { extractHeaders } from "../gmail-headers.js";
import {
  extractEmailContent,
  extractAttachments,
  listAttachmentParts,
  collectCidReferences,
  isInlinePart,
  type AttachmentPart,
} from "../mime-walkers.js";
import { gmailMessageToJson, emailToTxt, emailToHtml } from "../email-export.js";
import { asGmailApiError } from "../gmail-errors.js";
import { downloadEmailOutputSchema, downloadAllAttachmentsOutputSchema } from "./output-schemas.js";

type GmailMessagePart = gmail_v1.Schema$MessagePart;

/**
 * Upper bound on the same-size candidates whose bytes
 * `resolveOriginalFilename` downloads to disambiguate an attachment.
 * Real messages have a handful of attachments at most; the cap stops
 * an attacker-crafted message with hundreds of identical-size parts
 * from turning one `download_attachment` call into hundreds of Gmail
 * API round-trips.
 */
const MAX_CONTENT_PROBES = 10;

/**
 * Upper bound on the attachments `download_all_attachments` fetches in
 * one call. Gmail caps a message at ~25 MB of attachments, so a
 * legitimate message stays far below this; the cap bounds API
 * round-trips and memory on attacker-crafted many-part messages.
 */
const MAX_BULK_ATTACHMENTS = 100;

/** Attachment bodies fetched in parallel by `download_all_attachments`. */
const FETCH_CONCURRENCY = 4;

/**
 * Fetch the decoded bytes of one attachment part — from the payload
 * when Gmail inlined the body, otherwise via `messages.attachments.get`.
 */
async function loadAttachmentBytes(
  gmail: gmail_v1.Gmail,
  messageId: string,
  part: Pick<AttachmentPart, "attachmentId" | "data">,
): Promise<Buffer> {
  if (part.data !== undefined) {
    return Buffer.from(part.data, "base64url");
  }
  const response = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: part.attachmentId,
  });
  if (!response.data.data) {
    throw new Error("No attachment data received");
  }
  return Buffer.from(response.data.data, "base64url");
}

/**
 * Find the MIME `filename` of the attachment the caller downloaded.
 *
 * The caller only hands us an `attachmentId`, and Gmail re-issues a
 * fresh `attachmentId` for every part on EVERY `messages.get` — the id
 * the caller got from an earlier `read_email` never string-matches the
 * one in the payload fetched here (verified against the live API: all
 * ids differ between two consecutive reads, yet every one of them stays
 * valid for `attachments.get`). Matching on the id alone therefore
 * almost always missed, and the attachment was saved as
 * `attachment-<id prefix>` instead of its real name.
 *
 * Resolution order:
 *   1. exact `attachmentId` match (cheap; hits when both ids come from
 *      the same read);
 *   2. decoded byte size — `attachments.get` returns exactly the bytes
 *      the part's `body.size` counts — when the same-size parts all
 *      carry the same name (the common case: sizes are unique);
 *   3. otherwise, byte-for-byte comparison of each same-size candidate
 *      (fetched through its fresh id, at most `MAX_CONTENT_PROBES`).
 *      Two parts with identical bytes but different names resolve to
 *      the first one in MIME order — both names describe those exact
 *      bytes.
 *
 * Returns `undefined` when nothing matches (or the matching part has no
 * name); the caller then falls back to `attachment-<id prefix>`.
 */
async function resolveOriginalFilename(
  gmail: gmail_v1.Gmail,
  messageId: string,
  attachmentId: string,
  bytes: Buffer,
): Promise<string | undefined> {
  const messageResponse = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });
  const payload = messageResponse.data.payload;
  const parts = payload ? listAttachmentParts(payload) : [];

  const exact = parts.find((part) => part.attachmentId === attachmentId);
  if (exact) return exact.filename || undefined;

  const sameSize = parts.filter((part) => part.size === bytes.length);
  if (new Set(sameSize.map((part) => part.filename)).size <= 1) {
    return sameSize[0]?.filename || undefined;
  }
  for (const candidate of sameSize.slice(0, MAX_CONTENT_PROBES)) {
    const candidateBytes = await loadAttachmentBytes(gmail, messageId, candidate);
    if (candidateBytes.equals(bytes)) return candidate.filename || undefined;
  }
  return undefined;
}

/**
 * Resolve `filename` inside `directory` (an already jail-validated,
 * realpath-canonicalized directory) and refuse anything that would
 * land outside it.
 */
function jailedFilePath(directory: string, filename: string): string {
  const fullPath = path.resolve(directory, filename);
  /* v8 ignore start -- defence-in-depth path-traversal guard
     that's unreachable through the public surface today:
     toSafeAttachmentFilename replaces `/` with `_`, so a
     hostile `../../etc/passwd` filename becomes
     `_.._etc_passwd` and resolves INSIDE the directory. Kept as
     a guard against a future sanitize change that lets a
     separator slip through. */
  if (!fullPath.startsWith(directory + path.sep) && fullPath !== directory) {
    throw new Error("Invalid filename: path traversal detected");
  }
  /* v8 ignore stop */
  return fullPath;
}

/**
 * Build a ZIP archive in memory. Uses fflate's streaming `Zip` API with
 * the entry name passed as a plain string — `zipSync` keys its input by
 * filename in an ordinary object, where an attachment literally named
 * `__proto__` would be swallowed by the prototype setter. Entry names
 * are expected to be unique (see `claimUniqueFilename`); non-ASCII
 * names are flagged UTF-8 in the archive by fflate. Every callback
 * fires synchronously here (`ZipDeflate` is the synchronous codec), so
 * the archive is complete when `end()` returns.
 */
export function buildZipArchive(
  entries: ReadonlyArray<{ name: string; data: Uint8Array }>,
): Buffer {
  const chunks: Uint8Array[] = [];
  const failures: FlateError[] = [];
  const archive = new Zip((error, chunk) => {
    /* v8 ignore start -- fflate only reports errors for misuse (adding
       after end(), a >64 KiB entry name); see the re-throw below. */
    if (error) {
      failures.push(error);
      return;
    }
    /* v8 ignore stop */
    chunks.push(chunk);
  });
  for (const entry of entries) {
    const file = new ZipDeflate(entry.name, { level: 6 });
    archive.add(file);
    file.push(entry.data, true);
  }
  archive.end();
  /* v8 ignore start -- fflate only reports errors for misuse (adding
     after end(), a >64 KiB entry name); the entry names we pass are
     sanitized leaf names, so this is a defensive re-throw. */
  if (failures.length > 0) {
    throw new Error(`Failed to build ZIP archive: ${failures[0]?.message ?? "unknown error"}`);
  }
  /* v8 ignore stop */
  return Buffer.concat(chunks);
}

export function registerDownloadTools(
  server: McpServer,
  gmail: gmail_v1.Gmail,
  authorizedScopes: readonly string[],
): void {
  // download_email
  const downloadEmail = pull("download_email");
  defineTool(
    server,
    "download_email",
    downloadEmail.description,
    DownloadEmailSchema.shape,
    async (args) => {
      const { messageId, format } = args;
      try {
        const savePath = resolveDownloadSavePath(args.savePath);
        // `full` carries headers + payload tree; `raw` only when
        // format=eml. Issue both in parallel so EML downloads do not
        // pay a second round-trip after the full fetch returns.
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
          // `rawResponse` is fetched only on the `eml` branch above,
          // so it is defined here. TS's narrowing across the if/else
          // doesn't reach the parallel fetch.
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          content = Buffer.from(rawResponse!.data.raw || "", "base64url").toString("utf8");
        } else {
          const emailContent = extractEmailContent(
            // The cast widens `payload` to non-nullable but Gmail can
            // omit the field on some response shapes (esp. metadata
            // formats). Keep the runtime fallback.
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            (fullResponse.data.payload as GmailMessagePart) || {},
          );
          if (format === "json") {
            const jsonData = gmailMessageToJson(fullResponse.data, emailContent, attachments);
            content = JSON.stringify(jsonData, null, 2);
          } else if (format === "txt") {
            content = emailToTxt(fullResponse.data, emailContent, attachments);
          } else {
            content = emailToHtml(emailContent);
          }
        }

        const filename = `${messageId}.${format}`;
        const requestedPath = path.join(savePath, filename);
        const writtenPath = safeWriteFile(requestedPath, content, { onCollision: "suffix" });
        const stats = fs.statSync(writtenPath);

        const result = {
          status: "saved" as const,
          path: writtenPath,
          size: stats.size,
          messageId,
          subject,
          from,
          date,
          attachments,
        };
        // Explicit structuredContent in addition to the JSON text
        // — `attachStructuredContent` middleware would auto-attach
        // here (the text starts with `{` and parses), but typing
        // the result object as `as const` and lifting it
        // explicitly guarantees the SDK validator sees the
        // expected `downloadEmailOutputSchema` shape on every
        // emit, decoupling correctness from the auto-attach
        // best-effort heuristic.
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error: unknown) {
        const { code, message } = asGmailApiError(error);
        const prefix =
          code === undefined
            ? "Failed to download email"
            : `Failed to download email (HTTP ${code})`;
        return {
          content: [{ type: "text", text: `${prefix}: ${message}` }],
          isError: true,
        };
      }
    },
    downloadEmail.annotations,
    downloadEmail.scopes,
    authorizedScopes,
    downloadEmailOutputSchema,
  );

  // download_attachment
  const downloadAttachment = pull("download_attachment");
  defineTool(
    server,
    "download_attachment",
    downloadAttachment.description,
    DownloadAttachmentSchema.shape,
    async (args) => {
      try {
        const buffer = await loadAttachmentBytes(gmail, args.messageId, {
          attachmentId: args.attachmentId,
        });

        const savePath = resolveDownloadSavePath(args.savePath ?? getDownloadDirectory());
        const fallbackName = `attachment-${args.attachmentId.slice(0, 24)}`;
        const requestedName =
          args.filename ||
          (await resolveOriginalFilename(gmail, args.messageId, args.attachmentId, buffer));

        // Sanitize filename: backslash / NUL / C0 / control chars from
        // a hostile sender's MIME `filename` attribute (or the caller's
        // override), then basename — see toSafeAttachmentFilename.
        const filename = toSafeAttachmentFilename(requestedName, fallbackName);
        const fullPath = jailedFilePath(savePath, filename);
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
          code === undefined
            ? "Failed to download attachment"
            : `Failed to download attachment (HTTP ${code})`;
        return {
          content: [{ type: "text", text: `${prefix}: ${message}` }],
          isError: true,
        };
      }
    },
    downloadAttachment.annotations,
    downloadAttachment.scopes,
    authorizedScopes,
  );

  // download_all_attachments
  //
  // One `messages.get`, then one `attachments.get` per part using the
  // attachmentIds from THAT payload — names come straight from the
  // parts, so there is no id matching involved (see
  // `resolveOriginalFilename` for why id matching across reads fails).
  // All bodies are fetched before anything is written: a Gmail error
  // mid-way leaves no partial set of files or truncated ZIP behind.
  const downloadAllAttachments = pull("download_all_attachments");
  defineTool(
    server,
    "download_all_attachments",
    downloadAllAttachments.description,
    DownloadAllAttachmentsSchema.shape,
    async (args) => {
      try {
        const savePath = resolveDownloadSavePath(args.savePath ?? getDownloadDirectory());
        const messageResponse = await gmail.users.messages.get({
          userId: "me",
          id: args.messageId,
          format: "full",
        });
        const payload = messageResponse.data.payload ?? {};
        const parts = listAttachmentParts(payload);

        const cidReferences = args.includeInline
          ? new Set<string>()
          : collectCidReferences(extractEmailContent(payload).html);
        const selected: AttachmentPart[] = [];
        const skipped: Array<{
          filename: string;
          mimeType: string;
          size: number;
          reason: "inline";
        }> = [];
        for (const part of parts) {
          if (!args.includeInline && isInlinePart(part, cidReferences)) {
            skipped.push({
              filename: toSafeAttachmentFilename(part.filename, "inline-part"),
              mimeType: part.mimeType,
              size: part.size,
              reason: "inline",
            });
          } else {
            selected.push(part);
          }
        }

        if (selected.length === 0) {
          const hint =
            skipped.length > 0
              ? ` (${skipped.length} inline part(s) skipped; pass includeInline: true to download them)`
              : "";
          throw new Error(`Message ${args.messageId} has no attachments to download${hint}`);
        }
        if (selected.length > MAX_BULK_ATTACHMENTS) {
          throw new Error(
            `Message ${args.messageId} has ${selected.length} attachments; download_all_attachments handles at most ${MAX_BULK_ATTACHMENTS} per call`,
          );
        }

        const fetched: Array<{ part: AttachmentPart; data: Buffer }> = [];
        for (let index = 0; index < selected.length; index += FETCH_CONCURRENCY) {
          const batch = selected.slice(index, index + FETCH_CONCURRENCY);
          fetched.push(
            ...(await Promise.all(
              batch.map(async (part) => ({
                part,
                data: await loadAttachmentBytes(gmail, args.messageId, part),
              })),
            )),
          );
        }

        const taken = new Set<string>();
        const entries = fetched.map(({ part, data }, index) => ({
          name: claimUniqueFilename(
            toSafeAttachmentFilename(part.filename, `attachment-${index + 1}`),
            taken,
          ),
          mimeType: part.mimeType,
          data,
        }));

        let result: {
          status: "saved";
          messageId: string;
          mode: "files" | "zip";
          directory: string;
          zipPath?: string;
          zipSize?: number;
          files: Array<{ filename: string; path?: string; size: number; mimeType: string }>;
          skipped: typeof skipped;
        };
        if (args.zip) {
          let zipName = toSafeAttachmentFilename(
            args.zipFilename,
            `${args.messageId}-attachments.zip`,
          );
          if (!zipName.toLowerCase().endsWith(".zip")) zipName += ".zip";
          const archive = buildZipArchive(entries);
          const zipPath = safeWriteFile(jailedFilePath(savePath, zipName), archive, {
            onCollision: "suffix",
          });
          result = {
            status: "saved",
            messageId: args.messageId,
            mode: "zip",
            directory: savePath,
            zipPath,
            zipSize: archive.length,
            files: entries.map((entry) => ({
              filename: entry.name,
              size: entry.data.length,
              mimeType: entry.mimeType,
            })),
            skipped,
          };
        } else {
          const files = entries.map((entry) => {
            const writtenPath = safeWriteFile(jailedFilePath(savePath, entry.name), entry.data, {
              onCollision: "suffix",
            });
            return {
              filename: path.basename(writtenPath),
              path: writtenPath,
              size: entry.data.length,
              mimeType: entry.mimeType,
            };
          });
          result = {
            status: "saved",
            messageId: args.messageId,
            mode: "files",
            directory: savePath,
            files,
            skipped,
          };
        }

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error: unknown) {
        const { code, message } = asGmailApiError(error);
        const prefix =
          code === undefined
            ? "Failed to download attachments"
            : `Failed to download attachments (HTTP ${code})`;
        return {
          content: [{ type: "text", text: `${prefix}: ${message}` }],
          isError: true,
        };
      }
    },
    downloadAllAttachments.annotations,
    downloadAllAttachments.scopes,
    authorizedScopes,
    downloadAllAttachmentsOutputSchema,
  );
}
