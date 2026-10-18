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
 * `file://`: scripts, plugins, `<base>` rewrites and form submissions are
 * blocked, which Gmail never runs either. Styles and images are left
 * alone so the copy still renders like the original (blocking remote
 * images would also stop tracking pixels, but changes the rendering).
 */
export const EXPORTED_HTML_CSP =
  "script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${EXPORTED_HTML_CSP}">`;
// `[^>]*` keeps both scans linear. `\b` keeps `<header>` from matching `<head`.
const HEAD_OPEN_RE = /<head\b[^>]*>/i;
const HTML_OPEN_RE = /<html\b[^>]*>/i;

/**
 * Put the CSP `<meta>` where browsers honour it: a CSP meta is only
 * applied from inside `<head>`, so it goes right after an existing
 * `<head>` tag, else into a new `<head>` right after `<html>`, else the
 * fragment is wrapped in a complete document.
 */
function withExportCsp(html: string): string {
  const head = HEAD_OPEN_RE.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + CSP_META + html.slice(at);
  }
  const root = HTML_OPEN_RE.exec(html);
  if (root) {
    const at = root.index + root[0].length;
    return html.slice(0, at) + `<head>${CSP_META}</head>` + html.slice(at);
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${CSP_META}</head><body>${html}</body></html>`;
}

/**
 * Extract HTML content from email, or throw if none exists. The result
 * carries a restrictive CSP (see `EXPORTED_HTML_CSP`); use the `eml`
 * format for a byte-faithful copy.
 */
export function emailToHtml(emailContent: { text: string; html: string }): string {
  if (!emailContent.html) {
    throw new Error("This email has no HTML content");
  }
  return withExportCsp(emailContent.html);
}
