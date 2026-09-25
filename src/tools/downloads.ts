/**
 * Download-domain tool registrars (`download_email`,
 * `download_attachment`). Both tools write under the `GMAIL_MCP_DOWNLOAD_DIR` jail (default
 * `~/GmailDownloads`) via `safeWriteFile` (O_NOFOLLOW on the leaf,
 * O_EXCL against silent overwrites). PR #7 deletes the corresponding
 * switch arms from the legacy dispatcher in `src/index.ts`.
 */

import path from "node:path";
import fs from "node:fs";
import type { gmail_v1 } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, pullToolMeta as pull } from "./_shared.js";
import { DownloadEmailSchema, DownloadAttachmentSchema } from "../tools.js";
import {
  resolveDownloadSavePath,
  getDownloadDirectory,
  safeWriteFile,
  toSafeAttachmentFilename,
} from "../utl.js";
import { extractHeaders } from "../gmail-headers.js";
import {
  extractEmailContent,
  extractAttachments,
  listAttachmentParts,
  type AttachmentPart,
} from "../mime-walkers.js";
import { gmailMessageToJson, emailToTxt, emailToHtml } from "../email-export.js";
import { asGmailApiError } from "../gmail-errors.js";
import { downloadEmailOutputSchema } from "./output-schemas.js";

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
}
