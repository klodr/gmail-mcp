import fs from "fs";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";
import { lookup as mimeLookup } from "mime-types";
import nodemailer from "nodemailer";

/**
 * Resolve the directory that attachment file paths MUST live under,
 * canonicalized via realpath. The MCP refuses to attach files outside
 * this jail — without it, a prompt-injected agent could attach
 * ~/.ssh/id_rsa or ~/.gmail-mcp/credentials.json to an outgoing email.
 *
 * Override with GMAIL_MCP_ATTACHMENT_DIR; default is ~/GmailAttachments
 * (auto-created with mode 0o700 on first use). The returned path is
 * always absolute and realpath-resolved, so the caller's startsWith
 * check against a realpath-resolved candidate is sound.
 */
let cachedAttachmentDir: string | null = null;
function getAttachmentDir(): string {
  if (cachedAttachmentDir) return cachedAttachmentDir;
  const envPath = process.env.GMAIL_MCP_ATTACHMENT_DIR;
  const target =
    envPath && envPath.trim() !== ""
      ? path.resolve(envPath)
      : path.join(os.homedir(), "GmailAttachments");
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  }
  cachedAttachmentDir = fs.realpathSync(target);
  return cachedAttachmentDir;
}

/** Exposed for tests. Clears the cached attachment-dir so a new env can take effect. */
export function resetAttachmentDirCache(): void {
  cachedAttachmentDir = null;
}

/**
 * Resolve the directory that download destinations (both `download_email`
 * and `download_attachment`) must live under. Without this, a prompt-
 * injected agent could instruct the MCP to write attachments into
 * /etc/cron.d/, the user's login-shell startup file, or another sensitive
 * path and achieve code execution.
 *
 * Override with GMAIL_MCP_DOWNLOAD_DIR; default is ~/GmailDownloads
 * (auto-created with mode 0o700 on first use).
 */
let cachedDownloadDir: string | null = null;
export function getDownloadDir(): string {
  if (cachedDownloadDir) return cachedDownloadDir;
  const envPath = process.env.GMAIL_MCP_DOWNLOAD_DIR;
  const target =
    envPath && envPath.trim() !== ""
      ? path.resolve(envPath)
      : path.join(os.homedir(), "GmailDownloads");
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  }
  cachedDownloadDir = fs.realpathSync(target);
  return cachedDownloadDir;
}

/** Exposed for tests. Clears the cached download-dir so a new env can take effect. */
export function resetDownloadDirCache(): void {
  cachedDownloadDir = null;
}

/**
 * Write a file without following symlinks on the final component.
 *
 * The caller is expected to have validated that `dirPath` (the parent
 * of `fullPath`) already resolves inside the download jail — typically
 * by passing it through resolveDownloadSavePath first. This helper
 * closes the remaining attack window: if `fullPath` itself pre-exists
 * as a symlink pointing outside the jail, a naive fs.writeFileSync()
 * would follow it and write outside. O_NOFOLLOW on the leaf makes the
 * open fail with ELOOP instead.
 *
 * Mode 0o600 on create. Overwrites existing regular files by design
 * (re-downloads of the same attachment should be idempotent).
 */
export function safeWriteFile(fullPath: string, content: string | Buffer): void {
  const flags =
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(fullPath, flags, 0o600);
  try {
    if (typeof content === "string") {
      fs.writeSync(fd, content, 0, "utf-8");
    } else {
      fs.writeSync(fd, content);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Validate and canonicalize a user-supplied savePath for downloads.
 * Creates the directory (mode 0o700) if it does not exist yet, then
 * enforces that it resolves inside the download jail. Returns the
 * realpath-canonicalized savePath for the caller to use.
 */
export function resolveDownloadSavePath(savePath: string): string {
  if (!path.isAbsolute(savePath)) {
    throw new Error(
      `savePath must be absolute: "${savePath}". ` +
        `Place the download under ${getDownloadDir()} and use the absolute path, ` +
        `or set GMAIL_MCP_DOWNLOAD_DIR to change the allowed root.`,
    );
  }
  // Validate containment BEFORE creating the directory. Otherwise a
  // path like /etc/rogue would be materialised on disk with mode
  // 0o700, then rejected — we'd fail with a side effect. Walk up to
  // the first ancestor that exists, realpath it (blocks symlink
  // escapes on an existing parent), then confirm the full resolved
  // path sits inside the jail before any mkdirSync.
  const jail = getDownloadDir();
  const resolvedTarget = path.resolve(savePath);
  let probe = resolvedTarget;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) {
    probe = path.dirname(probe);
  }
  const probeReal = fs.realpathSync(probe);
  // Diff computed against the *original* (non-realpathed) probe so
  // the "still-missing leaf" portion is preserved verbatim. On macOS
  // /var/folders/... is a symlink to /private/var/folders/..., so
  // computing `relative(probeReal, resolvedTarget)` would produce
  // `../../../var/folders/...` and falsely escape the jail.
  const relative = path.relative(probe, resolvedTarget);
  const effectivePath = relative === "" ? probeReal : path.resolve(probeReal, relative);
  if (effectivePath !== jail && !effectivePath.startsWith(jail + path.sep)) {
    throw new Error(
      `savePath is outside the allowed download directory. ` +
        `Got: ${effectivePath} (resolved from ${savePath}). ` +
        `Allowed: ${jail}. ` +
        `Override with GMAIL_MCP_DOWNLOAD_DIR=/abs/path if you need a different jail.`,
    );
  }
  if (!fs.existsSync(resolvedTarget)) {
    fs.mkdirSync(resolvedTarget, { recursive: true, mode: 0o700 });
  }
  // Re-realpath after mkdir. If a missing component was swapped to a
  // symlink in the window between the pre-check and the mkdir, the
  // leaf would now live outside the jail — catch that here.
  const finalPath = fs.realpathSync(resolvedTarget);
  if (finalPath !== jail && !finalPath.startsWith(jail + path.sep)) {
    throw new Error(
      `savePath resolved outside the allowed download directory after mkdir. ` +
        `Got: ${finalPath} (resolved from ${savePath}). Allowed: ${jail}.`,
    );
  }
  return finalPath;
}

/**
 * Validate that a user-supplied attachment path is inside the attachment
 * jail after realpath canonicalization. Throws with a clear error that
 * names the allowed directory so the user can reconfigure if needed.
 * Symlinks pointing outside the jail are rejected.
 */
function assertAttachmentPathAllowed(filePath: string): void {
  if (!path.isAbsolute(filePath)) {
    throw new Error(
      `Attachment path must be absolute: "${filePath}". ` +
        `Place files inside ${getAttachmentDir()} (or set GMAIL_MCP_ATTACHMENT_DIR) and use the absolute path.`,
    );
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`File does not exist: ${filePath}`);
  }
  const resolved = fs.realpathSync(filePath);
  const jail = getAttachmentDir();
  if (resolved !== jail && !resolved.startsWith(jail + path.sep)) {
    throw new Error(
      `Attachment path is outside the allowed directory. ` +
        `Got: ${resolved} (resolved from ${filePath}). ` +
        `Allowed: ${jail}. ` +
        `Override with GMAIL_MCP_ATTACHMENT_DIR=/abs/path if you need a different jail.`,
    );
  }
}

/**
 * Helper function to encode email headers containing non-ASCII characters
 * according to RFC 2047 MIME specification
 */
function encodeEmailHeader(text: string): string {
  // Only encode if the text contains non-ASCII characters
  if (/[^\x00-\x7F]/.test(text)) {
    // Use MIME Words encoding (RFC 2047)
    return "=?UTF-8?B?" + Buffer.from(text).toString("base64") + "?=";
  }
  return text;
}

export const validateEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

/**
 * Sanitize a value destined for an email header to prevent CRLF injection.
 * Strips \r, \n, and \0 characters that could inject additional headers.
 */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n\0]/g, "");
}

export function createEmailMessage(validatedArgs: any): string {
  const encodedSubject = encodeEmailHeader(sanitizeHeaderValue(validatedArgs.subject));
  // Determine content type based on available content and explicit mimeType
  let mimeType = validatedArgs.mimeType || "text/plain";

  // If htmlBody is provided and mimeType isn't explicitly set to text/plain,
  // use multipart/alternative to include both versions
  if (validatedArgs.htmlBody && mimeType !== "text/plain") {
    mimeType = "multipart/alternative";
  }

  // Generate a cryptographically random boundary string for multipart
  // messages. Math.random() is predictable enough that a crafted body
  // could in theory collide with the boundary and inject headers.
  const boundary = `----=_NextPart_${randomBytes(16).toString("hex")}`;

  // Validate email addresses
  (validatedArgs.to as string[]).forEach((email) => {
    if (!validateEmail(email)) {
      throw new Error(`Recipient email address is invalid: ${email}`);
    }
  });

  // Sanitize all user-supplied header values to prevent CRLF injection
  const from = sanitizeHeaderValue(validatedArgs.from || "me");
  const to = (validatedArgs.to as string[]).map(sanitizeHeaderValue).join(", ");
  const cc = validatedArgs.cc
    ? (validatedArgs.cc as string[]).map(sanitizeHeaderValue).join(", ")
    : "";
  const bcc = validatedArgs.bcc
    ? (validatedArgs.bcc as string[]).map(sanitizeHeaderValue).join(", ")
    : "";
  const inReplyTo = validatedArgs.inReplyTo ? sanitizeHeaderValue(validatedArgs.inReplyTo) : "";
  const references = validatedArgs.references
    ? sanitizeHeaderValue(validatedArgs.references)
    : validatedArgs.inReplyTo
      ? sanitizeHeaderValue(validatedArgs.inReplyTo)
      : "";

  // Common email headers
  const emailParts = [
    `From: ${from}`,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : "",
    bcc ? `Bcc: ${bcc}` : "",
    `Subject: ${encodedSubject}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : "",
    references ? `References: ${references}` : "",
    "MIME-Version: 1.0",
  ].filter(Boolean);

  // Construct the email based on the content type
  if (mimeType === "multipart/alternative") {
    // Multipart email with both plain text and HTML
    emailParts.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    emailParts.push("");

    // Plain text part
    emailParts.push(`--${boundary}`);
    emailParts.push("Content-Type: text/plain; charset=UTF-8");
    emailParts.push("Content-Transfer-Encoding: 7bit");
    emailParts.push("");
    emailParts.push(validatedArgs.body);
    emailParts.push("");

    // HTML part
    emailParts.push(`--${boundary}`);
    emailParts.push("Content-Type: text/html; charset=UTF-8");
    emailParts.push("Content-Transfer-Encoding: 7bit");
    emailParts.push("");
    emailParts.push(validatedArgs.htmlBody || validatedArgs.body); // Use body as fallback
    emailParts.push("");

    // Close the boundary
    emailParts.push(`--${boundary}--`);
  } else if (mimeType === "text/html") {
    // HTML-only email
    emailParts.push("Content-Type: text/html; charset=UTF-8");
    emailParts.push("Content-Transfer-Encoding: 7bit");
    emailParts.push("");
    emailParts.push(validatedArgs.htmlBody || validatedArgs.body);
  } else {
    // Plain text email (default)
    emailParts.push("Content-Type: text/plain; charset=UTF-8");
    emailParts.push("Content-Transfer-Encoding: 7bit");
    emailParts.push("");
    emailParts.push(validatedArgs.body);
  }

  return emailParts.join("\r\n");
}

export async function createEmailWithNodemailer(validatedArgs: any): Promise<string> {
  // Validate email addresses
  (validatedArgs.to as string[]).forEach((email) => {
    if (!validateEmail(email)) {
      throw new Error(`Recipient email address is invalid: ${email}`);
    }
  });

  // Create a nodemailer transporter (we won't actually send, just generate the message)
  const transporter = nodemailer.createTransport({
    streamTransport: true,
    newline: "unix",
    buffer: true,
  });

  // Prepare attachments for nodemailer.
  // Every candidate path is validated against the attachment jail (see
  // assertAttachmentPathAllowed) so a prompt-injected agent cannot attach
  // ~/.ssh/id_rsa, OAuth credentials, or other secrets to outgoing email.
  const attachments = [];
  for (const filePath of validatedArgs.attachments) {
    assertAttachmentPathAllowed(filePath);

    // Resolve to realpath right after validation and push the
    // resolved path to nodemailer. Closes a TOCTOU where a
    // validated symlink could be repointed at a secret file
    // between assertAttachmentPathAllowed() and the actual
    // transporter.sendMail() read. nodemailer reads `path` at
    // send time, so locking in the real target here bounds the
    // race window to validation-against-itself.
    const resolvedPath = fs.realpathSync(filePath);
    const fileName = path.basename(filePath);

    attachments.push({
      filename: fileName,
      path: resolvedPath,
    });
  }

  const mailOptions = {
    from: validatedArgs.from || "me", // Gmail API uses default send-as if 'me', or specified alias
    to: validatedArgs.to.join(", "),
    cc: validatedArgs.cc?.join(", "),
    bcc: validatedArgs.bcc?.join(", "),
    subject: validatedArgs.subject,
    text: validatedArgs.body,
    html: validatedArgs.htmlBody,
    attachments: attachments,
    inReplyTo: validatedArgs.inReplyTo,
    references: validatedArgs.references || validatedArgs.inReplyTo,
  };

  // Generate the raw message
  const info = await transporter.sendMail(mailOptions);
  const rawMessage = info.message.toString();

  return rawMessage;
}
