/**
 * Email export utilities for converting Gmail messages to various formats
 */

import emailAddresses from "email-addresses";
import type { gmail_v1 } from "googleapis";
import { makeHeaderGetter } from "./gmail-headers.js";

// Types
export interface ParsedAddress {
  name: string;
  email: string;
}

export interface EmailAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface EmailJson {
  messageId: string;
  threadId: string;
  subject: string;
  from: ParsedAddress;
  to: ParsedAddress[];
  cc: ParsedAddress[];
  bcc: ParsedAddress[];
  date: string;
  labels: string[];
  snippet: string;
  body: {
    plain: string;
    html: string;
  };
  attachments: EmailAttachment[];
  headers: Record<string, string>;
}

/**
 * Parse email address string into name and email components
 * Uses RFC 5322 compliant parser (email-addresses package)
 */
export function parseEmailAddress(address: string): ParsedAddress {
  if (!address) return { name: "", email: "" };

  const parsed = emailAddresses.parseOneAddress(address);
  if (parsed && parsed.type === "mailbox") {
    return {
      name: parsed.name || "",
      email: parsed.address || "",
    };
  }
  return { name: "", email: address.trim() };
}

/**
 * Parse comma-separated list of email addresses
 * Uses RFC 5322 compliant parser (email-addresses package)
 */
export function parseEmailAddresses(addresses: string | undefined): ParsedAddress[] {
  if (!addresses) return [];

  const parsed = emailAddresses.parseAddressList(addresses);
  if (!parsed) return [];

  return parsed
    .filter((entry): entry is emailAddresses.ParsedMailbox => entry.type === "mailbox")
    .map((entry) => ({
      name: entry.name || "",
      email: entry.address || "",
    }));
}

/**
 * Convert Gmail API message to structured JSON
 */
export function gmailMessageToJson(
  message: gmail_v1.Schema$Message,
  emailContent: { text: string; html: string },
  attachments: EmailAttachment[],
): EmailJson {
  const getHeader = makeHeaderGetter(message.payload?.headers);

  const dateString = getHeader("date");
  let isoDate: string;
  try {
    isoDate = new Date(dateString).toISOString();
  } catch {
    isoDate = dateString; // Keep original if parsing fails
  }

  return {
    messageId: message.id ?? "",
    threadId: message.threadId ?? "",
    subject: getHeader("subject"),
    from: parseEmailAddress(getHeader("from")),
    to: parseEmailAddresses(getHeader("to")),
    cc: parseEmailAddresses(getHeader("cc")),
    bcc: parseEmailAddresses(getHeader("bcc")),
    date: isoDate,
    labels: message.labelIds || [],
    snippet: message.snippet || "",
    body: {
      plain: emailContent.text,
      html: emailContent.html,
    },
    attachments,
    headers: {
      "Message-ID": getHeader("message-id"),
      "In-Reply-To": getHeader("in-reply-to"),
      References: getHeader("references"),
    },
  };
}

/**
 * Convert email to plain text format
 */
export function emailToTxt(
  message: gmail_v1.Schema$Message,
  emailContent: { text: string; html: string },
  attachments: EmailAttachment[],
): string {
  const getHeader = makeHeaderGetter(message.payload?.headers);

  const from = getHeader("from");
  const to = getHeader("to");
  const cc = getHeader("cc");
  const subject = getHeader("subject");
  const date = getHeader("date");

  const lines = [`From: ${from}`, `To: ${to}`];

  if (cc) {
    lines.push(`CC: ${cc}`);
  }

  lines.push(
    `Subject: ${subject}`,
    `Date: ${date}`,
    "",
    emailContent.text || "[No plain text content]",
  );

  if (attachments.length > 0) {
    lines.push("", "---", `Attachments: ${attachments.map((a) => a.filename).join(", ")}`);
  }

  return lines.join("\n");
}

/**
 * Content-Security-Policy stamped into every exported HTML file. The HTML
 * is the sender's, and the saved file is opened later in a browser from
 * `file://`: scripts, plugins, frames (a framed page runs its own
 * scripts), `<base>` rewrites and form submissions are blocked, none of
 * which Gmail renders either. Styles are left alone so the copy still
 * renders like the original. A sender's `<meta http-equiv="refresh">`,
 * which no CSP can stop, is neutralized separately (`HTTP_EQUIV_RE`).
 */
export const EXPORTED_HTML_CSP =
  "script-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

/**
 * Added by default: nothing remote is fetched when the saved file is
 * opened — images (`<img src="https://…">`, CSS backgrounds),
 * stylesheets (`<link rel="stylesheet">`, `@import`), fonts, media, and
 * through `default-src 'none'` every fetch without a directive of its
 * own (manifest, prefetch…) — so a tracking pixel or a tracking
 * stylesheet cannot report when and from where the copy was read, as
 * Outlook blocks remote content by default. Inline `<style>` / `style=`
 * and `data:` resources still render. Connection hints (`dns-prefetch`,
 * `preconnect`) are outside CSP: they fetch nothing, but a browser may
 * still resolve or connect to the host they name. Opt out per call
 * (`allowRemoteImages: true`) or globally with
 * `GMAIL_MCP_EXPORT_REMOTE_IMAGES=true`; either lifts the whole block.
 */
export const BLOCK_REMOTE_CONTENT_CSP =
  "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline' data:; font-src data:; media-src data:";

export const ENV_EXPORT_REMOTE_IMAGES = "GMAIL_MCP_EXPORT_REMOTE_IMAGES";

/** Whether exported HTML may load remote images and other remote content (default: no). */
export function remoteImagesAllowed(override?: boolean): boolean {
  return override ?? process.env[ENV_EXPORT_REMOTE_IMAGES] === "true";
}

function cspMeta(allowRemoteImages: boolean): string {
  const policy = allowRemoteImages
    ? EXPORTED_HTML_CSP
    : `${EXPORTED_HTML_CSP}; ${BLOCK_REMOTE_CONTENT_CSP}`;
  return `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
}
// Anchored at the very start (`^\s*`, `[^>]*`): linear, and it cannot be
// fooled by a doctype-looking string inside a comment further down.
const LEADING_DOCTYPE_RE = /^\s*(<!doctype[^>]*>)/i;

// The sender's `http-equiv` attributes are renamed, so a
// `<meta http-equiv="refresh">` cannot send the browser elsewhere when the
// copy is opened: a CSP does not govern that navigation. Matching the bare
// name is enough — the HTML tokenizer lowercases only ASCII letters and
// decodes no character reference in an attribute name, so no other
// spelling becomes `http-equiv`. Text that merely mentions the word is
// renamed too.
const HTTP_EQUIV_RE = /http-equiv/gi;
const NEUTRALIZED_HTTP_EQUIV = "data-removed-http-equiv";

/**
 * Wrap the sender's HTML in a document whose `<head>` starts with the CSP
 * `<meta>` (a CSP meta is only enforced from inside the head). Searching
 * the sender's markup for its own `<head>` is unreliable: a `<head>` inside
 * a comment, a script string or an attribute would receive the tag and the
 * browser would ignore it. The HTML parser merges the sender's own
 * `<html>` / `<head>` / `<body>` tags into this document, so the copy
 * renders as before. A leading doctype is kept first, so the rendering
 * mode (standards or quirks) does not change; the UTF-8 charset matches the
 * encoding the file is written in. The sender's `http-equiv` attributes are
 * renamed (see `HTTP_EQUIV_RE`), whatever `allowRemoteImages` says.
 */
function withExportCsp(html: string, allowRemoteImages: boolean): string {
  const doctype = LEADING_DOCTYPE_RE.exec(html);
  const rest = (doctype ? html.slice(doctype[0].length) : html).replaceAll(
    HTTP_EQUIV_RE,
    NEUTRALIZED_HTTP_EQUIV,
  );
  return `${doctype?.[1] ?? ""}<html><head><meta charset="utf-8">${cspMeta(allowRemoteImages)}</head><body>${rest}</body></html>`;
}

/**
 * Extract HTML content from email, or throw if none exists. The result
 * carries a restrictive CSP (see `EXPORTED_HTML_CSP`), which also blocks
 * remote content unless `allowRemoteImages` is true; use the `eml` format
 * for a byte-faithful copy.
 */
export function emailToHtml(
  emailContent: { text: string; html: string },
  allowRemoteImages = false,
): string {
  if (!emailContent.html) {
    throw new Error("This email has no HTML content");
  }
  return withExportCsp(emailContent.html, allowRemoteImages);
}
