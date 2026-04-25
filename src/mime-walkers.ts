/**
 * MIME-tree walkers for Gmail message payloads.
 *
 * Extracted from `src/index.ts` so they can be unit-tested without
 * importing the dispatcher (which calls `main()` at module load).
 *
 * All walkers are depth-bounded by `MAX_MIME_DEPTH` to defend against
 * pathologically nested attacker-crafted messages — beyond the cap,
 * sub-parts are skipped and a structured warning is logged to stderr
 * (forwarded to the MCP host log).
 */

import type { gmail_v1 as gmail_v1_types } from "googleapis";
import type { EmailAttachment } from "./email-export.js";

type GmailMessagePart = gmail_v1_types.Schema$MessagePart;

export interface EmailContent {
  text: string;
  html: string;
}

// Maximum MIME-tree recursion depth. Real-world Gmail messages cap out
// in the low single digits (text + html alternative inside a mixed
// envelope is depth 2, RFC 822 forwarded carrier ~4). 32 is ~10x that
// floor and well below the V8 default stack budget — pathologically
// nested attacker-crafted parts that exceed the cap are rejected with
// a structured warning instead of blowing the stack.
export const MAX_MIME_DEPTH = 32;

function logDepthExceeded(walker: string, depth: number): void {
  console.error(
    JSON.stringify({
      level: "warn",
      event: "mime_depth_exceeded",
      walker,
      max: MAX_MIME_DEPTH,
      depth,
    }),
  );
}

/**
 * Recursively extract email body content from MIME message parts.
 * Handles complex email structures with nested parts.
 */
export function extractEmailContent(messagePart: GmailMessagePart, depth = 0): EmailContent {
  let textContent = "";
  let htmlContent = "";

  if (depth > MAX_MIME_DEPTH) {
    logDepthExceeded("extractEmailContent", depth);
    return { text: textContent, html: htmlContent };
  }

  // If the part has a body with data, process it based on MIME type
  if (messagePart.body && messagePart.body.data) {
    const content = Buffer.from(messagePart.body.data, "base64").toString("utf8");

    if (messagePart.mimeType === "text/plain") {
      textContent = content;
    } else if (messagePart.mimeType === "text/html") {
      htmlContent = content;
    }
  }

  // Recurse into nested parts (depth-bounded)
  if (messagePart.parts && messagePart.parts.length > 0) {
    for (const part of messagePart.parts) {
      const { text, html } = extractEmailContent(part, depth + 1);
      if (text) textContent += text;
      if (html) htmlContent += html;
    }
  }

  return { text: textContent, html: htmlContent };
}

/**
 * Extract attachments from a Gmail message payload.
 *
 * Walks the MIME tree depth-bounded by `MAX_MIME_DEPTH` against
 * attacker-crafted nesting.
 */
export function extractAttachments(payload: GmailMessagePart): EmailAttachment[] {
  const attachments: EmailAttachment[] = [];

  function walk(part: GmailMessagePart, depth: number) {
    if (depth > MAX_MIME_DEPTH) {
      logDepthExceeded("extractAttachments", depth);
      return;
    }
    if (part.body && part.body.attachmentId) {
      attachments.push({
        id: part.body.attachmentId,
        filename: part.filename || `attachment-${part.body.attachmentId}`,
        mimeType: part.mimeType || "application/octet-stream",
        size: part.body.size || 0,
      });
    }
    if (part.parts) {
      part.parts.forEach((subpart: GmailMessagePart) => walk(subpart, depth + 1));
    }
  }

  walk(payload, 0);
  return attachments;
}

/**
 * Walk a message payload and collect attachment metadata into the
 * caller-supplied array. Used by `get_thread` and `list_inbox_threads`,
 * which both project attachments without IDs (id is filtered before
 * the response leaves the dispatcher).
 *
 * Depth-bounded by `MAX_MIME_DEPTH`.
 */
export function collectAttachmentsForThread(
  payload: GmailMessagePart,
  walker: string,
): EmailAttachment[] {
  const attachments: EmailAttachment[] = [];

  function walk(part: GmailMessagePart, depth: number) {
    if (depth > MAX_MIME_DEPTH) {
      logDepthExceeded(walker, depth);
      return;
    }
    if (part.body && part.body.attachmentId) {
      const filename = part.filename || `attachment-${part.body.attachmentId}`;
      attachments.push({
        id: part.body.attachmentId,
        filename,
        mimeType: part.mimeType || "application/octet-stream",
        size: part.body.size || 0,
      });
    }
    if (part.parts) {
      part.parts.forEach((subpart: GmailMessagePart) => walk(subpart, depth + 1));
    }
  }

  walk(payload, 0);
  return attachments;
}
