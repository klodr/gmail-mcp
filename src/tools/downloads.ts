/**
 * Download-domain tool registrars (`download_email`, `download_attachment`).
 * Both tools write a file under the `GMAIL_MCP_DOWNLOAD_DIR` jail
 * (default `~/GmailDownloads`) via `safeWriteFile` (O_NOFOLLOW on the
 * leaf, O_EXCL against silent overwrites). PR #7 deletes the
 * corresponding switch arms from the legacy dispatcher in
 * `src/index.ts`.
 */

import path from "path";
import fs from "fs";
import type { gmail_v1 } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, pullToolMeta as pull } from "./_shared.js";
import { DownloadEmailSchema, DownloadAttachmentSchema } from "../tools.js";
import {
  resolveDownloadSavePath,
  getDownloadDir,
  safeWriteFile,
  sanitizeAttachmentFilename,
} from "../utl.js";
import { extractHeaders } from "../gmail-headers.js";
import { extractEmailContent, extractAttachments } from "../mime-walkers.js";
import { gmailMessageToJson, emailToTxt, emailToHtml } from "../email-export.js";
import { asGmailApiError } from "../gmail-errors.js";

type GmailMessagePart = gmail_v1.Schema$MessagePart;

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
          content = Buffer.from(rawResponse!.data.raw || "", "base64url").toString("utf-8");
        } else {
          const emailContent = extractEmailContent(
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
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error: unknown) {
        const { code, message } = asGmailApiError(error);
        const prefix =
          code !== undefined
            ? `Failed to download email (HTTP ${code})`
            : "Failed to download email";
        return {
          content: [{ type: "text", text: `${prefix}: ${message}` }],
          isError: true,
        };
      }
    },
    downloadEmail.annotations,
    downloadEmail.scopes,
    authorizedScopes,
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
        const attachmentResponse = await gmail.users.messages.attachments.get({
          userId: "me",
          messageId: args.messageId,
          id: args.attachmentId,
        });

        if (!attachmentResponse.data.data) {
          throw new Error("No attachment data received");
        }

        const data = attachmentResponse.data.data;
        const buffer = Buffer.from(data, "base64url");

        const savePath = resolveDownloadSavePath(args.savePath ?? getDownloadDir());
        let filename = args.filename;

        if (!filename) {
          const messageResponse = await gmail.users.messages.get({
            userId: "me",
            id: args.messageId,
            format: "full",
          });

          const findAttachment = (part: GmailMessagePart): string | null => {
            if (part.body && part.body.attachmentId === args.attachmentId) {
              return part.filename || `attachment-${args.attachmentId}`;
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
            (messageResponse.data.payload ? findAttachment(messageResponse.data.payload) : null) ||
            `attachment-${args.attachmentId}`;
        }

        // Sanitize filename: backslash / NUL / C0 / control chars from
        // a hostile sender's MIME `filename` attribute. Order matters:
        // sanitize first so backslash-separated segments survive for
        // basename to strip; belt-and-braces basename after.
        filename = path.basename(sanitizeAttachmentFilename(filename));

        /* v8 ignore start -- defence-in-depth fallback that's
           unreachable through the public surface today:
           sanitizeAttachmentFilename collapses empty/NUL/control
           inputs to the literal "attachment", so path.basename
           never returns "" or "." here. Kept as a guard against a
           future sanitize change that returns "" or "." instead
           of "attachment". */
        if (filename === "" || filename === ".") {
          filename = `attachment-${args.attachmentId}`;
        }
        /* v8 ignore stop */

        const fullPath = path.resolve(savePath, filename);
        /* v8 ignore start -- defence-in-depth path-traversal guard
           that's unreachable through the public surface today:
           sanitizeAttachmentFilename replaces `/` with `_`, so a
           hostile `../../etc/passwd` filename becomes
           `..___etc_passwd` and resolves INSIDE savePath. Kept as
           a guard against a future sanitize change that lets a
           separator slip through. */
        if (!fullPath.startsWith(savePath + path.sep) && fullPath !== savePath) {
          throw new Error("Invalid filename: path traversal detected");
        }
        /* v8 ignore stop */
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
