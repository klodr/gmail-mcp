import fs from "fs";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";
import nodemailer from "nodemailer";

// Env-var names for the two jails. Hoisted to constants so a future
// rename is a single-line change and the names cannot drift between
// the resolver, the error messages, and the tests.
const ENV_ATTACHMENT_DIR = "GMAIL_MCP_ATTACHMENT_DIR";
const ENV_DOWNLOAD_DIR = "GMAIL_MCP_DOWNLOAD_DIR";

/**
 * Resolve a jail root from an env var (or fall back to `~/<defaultName>/`),
 * materialize it at mode `0o700` on first use, canonicalize via realpath,
 * and cache the result for the life of the process.
 *
 * The returned path is always absolute and realpath-resolved, so a caller's
 * `startsWith` check against a realpath-resolved candidate is sound.
 *
 * Shared by the attachment jail (source files we're willing to read for
 * outgoing email) and the download jail (destinations we're willing to
 * write to for incoming messages/attachments).
 */
const jailDirCache = new Map<string, string>();
function resolveJailDir(envVar: string, defaultName: string): string {
  const cached = jailDirCache.get(envVar);
  if (cached) return cached;
  const envPath = process.env[envVar];
  const target =
    envPath && envPath.trim() !== "" ? path.resolve(envPath) : path.join(os.homedir(), defaultName);
  // `recursive: true` is idempotent on an existing dir, so no existsSync
  // gate — one syscall instead of two, no TOCTOU between the stat and
  // the create.
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const resolved = fs.realpathSync(target);
  jailDirCache.set(envVar, resolved);
  return resolved;
}

function getAttachmentDir(): string {
  return resolveJailDir(ENV_ATTACHMENT_DIR, "GmailAttachments");
}

export function getDownloadDir(): string {
  return resolveJailDir(ENV_DOWNLOAD_DIR, "GmailDownloads");
}

/**
 * Exposed for tests. Clears the in-process jail-root cache so a test
 * can flip `GMAIL_MCP_ATTACHMENT_DIR` / `GMAIL_MCP_DOWNLOAD_DIR`
 * between cases and see the new root take effect.
 */
export function resetJailDirCache(): void {
  jailDirCache.clear();
}

/**
 * Verify that `resolved` (an already realpath-canonicalized absolute
 * path) sits inside `jail` (itself realpath-canonicalized). Throws
 * with a message that names the env var to override if the caller
 * wants a different root. `kind` distinguishes the attachment side
 * ("attachment") from the download side ("savePath") in the error.
 */
function assertInsideJail(
  resolved: string,
  jail: string,
  opts: { envVar: string; kind: "attachment" | "savePath"; original: string },
): void {
  if (resolved === jail || resolved.startsWith(jail + path.sep)) return;
  const label = opts.kind === "attachment" ? "Attachment path" : "savePath";
  const jailLabel = opts.kind === "attachment" ? "directory" : "download directory";
  throw new Error(
    `${label} is outside the allowed ${jailLabel}. ` +
      `Got: ${resolved} (resolved from ${opts.original}). ` +
      `Allowed: ${jail}. ` +
      `Override with ${opts.envVar}=/abs/path if you need a different jail.`,
  );
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
    // fs.writeSync returns the byte count actually written, which may be
    // less than the buffer length on short writes (large payloads, slow
    // storage). Loop until the whole buffer has been flushed or a zero
    // write signals we cannot make progress.
    const buffer = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
    let offset = 0;
    while (offset < buffer.length) {
      const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
      if (written === 0) {
        throw new Error(
          `safeWriteFile: zero-byte write at offset ${offset}/${buffer.length} for ${fullPath}`,
        );
      }
      offset += written;
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
        `or set ${ENV_DOWNLOAD_DIR} to change the allowed root.`,
    );
  }
  // Validate containment BEFORE creating the directory, otherwise a
  // path like /etc/rogue would be materialised on disk at 0o700 and
  // only then rejected — a side-effect on invalid input. Walk up to
  // the first existing ancestor, realpath it (that blocks symlink
  // escape on an existing parent), compose the still-missing tail,
  // then check.
  const jail = getDownloadDir();
  const resolvedTarget = path.resolve(savePath);
  let probe = resolvedTarget;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) {
    probe = path.dirname(probe);
  }
  const probeReal = fs.realpathSync(probe);
  // Diff computed against the *non-realpathed* probe so the
  // still-missing leaf is preserved verbatim. On macOS /var/folders/…
  // is a symlink to /private/var/folders/…; computing relative from
  // probeReal would produce `../../../var/folders/…` and falsely
  // escape the jail.
  const relative = path.relative(probe, resolvedTarget);
  const effectivePath = relative === "" ? probeReal : path.resolve(probeReal, relative);
  assertInsideJail(effectivePath, jail, {
    envVar: ENV_DOWNLOAD_DIR,
    kind: "savePath",
    original: savePath,
  });
  // `recursive: true` is idempotent on existing dirs.
  fs.mkdirSync(resolvedTarget, { recursive: true, mode: 0o700 });
  // Re-realpath after mkdir. If a missing component was swapped to a
  // symlink between the pre-check and the mkdir, the materialised leaf
  // lives outside the jail — catch that here.
  const finalPath = fs.realpathSync(resolvedTarget);
  assertInsideJail(finalPath, jail, {
    envVar: ENV_DOWNLOAD_DIR,
    kind: "savePath",
    original: savePath,
  });
  return finalPath;
}

/**
 * Validate that a user-supplied attachment path is inside the attachment
 * jail after realpath canonicalization. Returns the realpath-resolved
 * path so the caller can pass the canonical target (not the original
 * possibly-symlink string) to nodemailer — eliminating a TOCTOU where
 * the symlink could be repointed at a secret file between validation
 * and the actual read at send time.
 */
function assertAttachmentPathAllowed(filePath: string): string {
  if (!path.isAbsolute(filePath)) {
    throw new Error(
      `Attachment path must be absolute: "${filePath}". ` +
        `Place files inside ${getAttachmentDir()} (or set ${ENV_ATTACHMENT_DIR}) and use the absolute path.`,
    );
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`File does not exist: ${filePath}`);
  }
  const resolved = fs.realpathSync(filePath);
  assertInsideJail(resolved, getAttachmentDir(), {
    envVar: ENV_ATTACHMENT_DIR,
    kind: "attachment",
    original: filePath,
  });
  return resolved;
}

/**
 * Helper function to encode email headers containing non-ASCII characters
 * according to RFC 2047 MIME specification
 */
function encodeEmailHeader(text: string): string {
  // Only encode if the text contains non-ASCII characters.
  // The range [^\x00-\x7F] is the canonical test for non-ASCII and is
  // the intended use of \x00 here — not a control-char regex smell.
  // eslint-disable-next-line no-control-regex -- intentional: detect non-ASCII range
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
 * Exported so test/fuzz.test.ts can fuzz the real implementation instead
 * of a drift-prone mirror.
 */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n\0]/g, "");
}

/**
 * Shape of every validated tool-input that reaches the MIME builders.
 * Matches the subset of fields from SendEmailSchema / ReplyAllSchema /
 * DraftEmailSchema that createEmailMessage + createEmailWithNodemailer
 * both touch.
 */
export interface ValidatedEmailArgs {
  subject: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  from?: string;
  body: string;
  htmlBody?: string;
  mimeType?: string;
  attachments?: string[];
  inReplyTo?: string;
  references?: string;
  threadId?: string;
}

export function createEmailMessage(validatedArgs: ValidatedEmailArgs): string {
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
  validatedArgs.to.forEach((email) => {
    if (!validateEmail(email)) {
      throw new Error(`Recipient email address is invalid: ${email}`);
    }
  });

  // Sanitize all user-supplied header values to prevent CRLF injection
  const from = sanitizeHeaderValue(validatedArgs.from || "me");
  const to = validatedArgs.to.map(sanitizeHeaderValue).join(", ");
  const cc = validatedArgs.cc ? validatedArgs.cc.map(sanitizeHeaderValue).join(", ") : "";
  const bcc = validatedArgs.bcc ? validatedArgs.bcc.map(sanitizeHeaderValue).join(", ") : "";
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

export async function createEmailWithNodemailer(
  validatedArgs: ValidatedEmailArgs,
): Promise<string> {
  // Validate email addresses
  validatedArgs.to.forEach((email) => {
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

  // Validate each attachment against the jail and push the
  // realpath-resolved target to nodemailer (not the possibly-symlink
  // original). Closes a TOCTOU where the link could be repointed at a
  // secret file between validation and the actual read at send time.
  const attachments: Array<{ filename: string; path: string }> = [];
  for (const filePath of validatedArgs.attachments ?? []) {
    const resolvedPath = assertAttachmentPathAllowed(filePath);
    attachments.push({
      filename: path.basename(filePath),
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

  // Generate the raw message. `info.message` is typed as `any` in
  // @types/nodemailer but in practice is a MessageStream whose toString
  // is meaningful; explicitly widen to an object with the method we use.
  const info = (await transporter.sendMail(mailOptions)) as unknown as {
    message: { toString: () => string };
  };
  return info.message.toString();
}
