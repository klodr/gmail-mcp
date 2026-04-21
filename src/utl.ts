import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { lookup as mimeLookup } from 'mime-types';
import nodemailer from 'nodemailer';

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
    const target = envPath && envPath.trim() !== ''
        ? path.resolve(envPath)
        : path.join(os.homedir(), 'GmailAttachments');
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
    const target = envPath && envPath.trim() !== ''
        ? path.resolve(envPath)
        : path.join(os.homedir(), 'GmailDownloads');
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
    if (!fs.existsSync(savePath)) {
        fs.mkdirSync(savePath, { recursive: true, mode: 0o700 });
    }
    const resolved = fs.realpathSync(savePath);
    const jail = getDownloadDir();
    if (resolved !== jail && !resolved.startsWith(jail + path.sep)) {
        throw new Error(
            `savePath is outside the allowed download directory. ` +
            `Got: ${resolved} (resolved from ${savePath}). ` +
            `Allowed: ${jail}. ` +
            `Override with GMAIL_MCP_DOWNLOAD_DIR=/abs/path if you need a different jail.`,
        );
    }
    return resolved;
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
        return '=?UTF-8?B?' + Buffer.from(text).toString('base64') + '?=';
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
    return value.replace(/[\r\n\0]/g, '');
}

export function createEmailMessage(validatedArgs: any): string {
    const encodedSubject = encodeEmailHeader(sanitizeHeaderValue(validatedArgs.subject));
    // Determine content type based on available content and explicit mimeType
    let mimeType = validatedArgs.mimeType || 'text/plain';
    
    // If htmlBody is provided and mimeType isn't explicitly set to text/plain,
    // use multipart/alternative to include both versions
    if (validatedArgs.htmlBody && mimeType !== 'text/plain') {
        mimeType = 'multipart/alternative';
    }

    // Generate a cryptographically random boundary string for multipart
    // messages. Math.random() is predictable enough that a crafted body
    // could in theory collide with the boundary and inject headers.
    const boundary = `----=_NextPart_${randomBytes(16).toString('hex')}`;

    // Validate email addresses
    (validatedArgs.to as string[]).forEach(email => {
        if (!validateEmail(email)) {
            throw new Error(`Recipient email address is invalid: ${email}`);
        }
    });

    // Sanitize all user-supplied header values to prevent CRLF injection
    const from = sanitizeHeaderValue(validatedArgs.from || 'me');
    const to = (validatedArgs.to as string[]).map(sanitizeHeaderValue).join(', ');
    const cc = validatedArgs.cc ? (validatedArgs.cc as string[]).map(sanitizeHeaderValue).join(', ') : '';
    const bcc = validatedArgs.bcc ? (validatedArgs.bcc as string[]).map(sanitizeHeaderValue).join(', ') : '';
    const inReplyTo = validatedArgs.inReplyTo ? sanitizeHeaderValue(validatedArgs.inReplyTo) : '';
    const references = validatedArgs.references
        ? sanitizeHeaderValue(validatedArgs.references)
        : validatedArgs.inReplyTo ? sanitizeHeaderValue(validatedArgs.inReplyTo) : '';

    // Common email headers
    const emailParts = [
        `From: ${from}`,
        `To: ${to}`,
        cc ? `Cc: ${cc}` : '',
        bcc ? `Bcc: ${bcc}` : '',
        `Subject: ${encodedSubject}`,
        inReplyTo ? `In-Reply-To: ${inReplyTo}` : '',
        references ? `References: ${references}` : '',
        'MIME-Version: 1.0',
    ].filter(Boolean);

    // Construct the email based on the content type
    if (mimeType === 'multipart/alternative') {
        // Multipart email with both plain text and HTML
        emailParts.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
        emailParts.push('');
        
        // Plain text part
        emailParts.push(`--${boundary}`);
        emailParts.push('Content-Type: text/plain; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 7bit');
        emailParts.push('');
        emailParts.push(validatedArgs.body);
        emailParts.push('');
        
        // HTML part
        emailParts.push(`--${boundary}`);
        emailParts.push('Content-Type: text/html; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 7bit');
        emailParts.push('');
        emailParts.push(validatedArgs.htmlBody || validatedArgs.body); // Use body as fallback
        emailParts.push('');
        
        // Close the boundary
        emailParts.push(`--${boundary}--`);
    } else if (mimeType === 'text/html') {
        // HTML-only email
        emailParts.push('Content-Type: text/html; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 7bit');
        emailParts.push('');
        emailParts.push(validatedArgs.htmlBody || validatedArgs.body);
    } else {
        // Plain text email (default)
        emailParts.push('Content-Type: text/plain; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 7bit');
        emailParts.push('');
        emailParts.push(validatedArgs.body);
    }

    return emailParts.join('\r\n');
}


export async function createEmailWithNodemailer(validatedArgs: any): Promise<string> {
    // Validate email addresses
    (validatedArgs.to as string[]).forEach(email => {
        if (!validateEmail(email)) {
            throw new Error(`Recipient email address is invalid: ${email}`);
        }
    });

    // Create a nodemailer transporter (we won't actually send, just generate the message)
    const transporter = nodemailer.createTransport({
        streamTransport: true,
        newline: 'unix',
        buffer: true
    });

    // Prepare attachments for nodemailer.
    // Every candidate path is validated against the attachment jail (see
    // assertAttachmentPathAllowed) so a prompt-injected agent cannot attach
    // ~/.ssh/id_rsa, OAuth credentials, or other secrets to outgoing email.
    const attachments = [];
    for (const filePath of validatedArgs.attachments) {
        assertAttachmentPathAllowed(filePath);

        const fileName = path.basename(filePath);

        attachments.push({
            filename: fileName,
            path: filePath
        });
    }

    const mailOptions = {
        from: validatedArgs.from || 'me', // Gmail API uses default send-as if 'me', or specified alias
        to: validatedArgs.to.join(', '),
        cc: validatedArgs.cc?.join(', '),
        bcc: validatedArgs.bcc?.join(', '),
        subject: validatedArgs.subject,
        text: validatedArgs.body,
        html: validatedArgs.htmlBody,
        attachments: attachments,
        inReplyTo: validatedArgs.inReplyTo,
        references: validatedArgs.references || validatedArgs.inReplyTo
    };

    // Generate the raw message
    const info = await transporter.sendMail(mailOptions);
    const rawMessage = info.message.toString();
    
    return rawMessage;
}

