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
      for (const subpart of part.parts) {
        walk(subpart, depth + 1);
      }
    }
  }

  walk(payload, 0);
  return attachments;
}

/**
 * One attachment-bearing MIME part, as seen by the download tools.
 *
 * `partId` is the only per-part identifier that is stable across
 * `messages.get` calls: Gmail re-issues a fresh `attachmentId` on
 * every read of the same message (all of them stay valid for
 * `messages.attachments.get`), so an `attachmentId` obtained from one
 * read never string-matches the one returned by a later read.
 *
 * `filename` is the raw, attacker-controlled MIME `filename` ("" when
 * absent) — callers must pass it through `toSafeAttachmentFilename`
 * before touching the filesystem. `data` is set instead of
 * `attachmentId` when Gmail inlined the part body in the payload.
 */
export interface AttachmentPart {
  partId: string;
  filename: string;
  mimeType: string;
  size: number;
  attachmentId?: string;
  data?: string;
  /** `Content-ID` without the surrounding `<>`, lower-cased. */
  contentId?: string;
  /** `Content-Disposition` type (`inline`, `attachment`, …), lower-cased. */
  disposition?: string;
}

function headerValue(part: GmailMessagePart, name: string): string | undefined {
  const lower = name.toLowerCase();
  const header = part.headers?.find((h) => h.name?.toLowerCase() === lower);
  return header?.value ?? undefined;
}

/**
 * List every attachment-bearing part of a message: parts whose body is
 * stored out-of-line (`body.attachmentId`) plus named parts whose body
 * Gmail inlined in the payload (`filename` + `body.data`). Keeps the
 * `partId`, `Content-ID` and `Content-Disposition` the download tools
 * need to resolve original filenames and to tell inline images apart
 * from real attachments.
 *
 * Depth-bounded by `MAX_MIME_DEPTH`.
 */
export function listAttachmentParts(payload: GmailMessagePart): AttachmentPart[] {
  const parts: AttachmentPart[] = [];

  function walk(part: GmailMessagePart, depth: number) {
    if (depth > MAX_MIME_DEPTH) {
      logDepthExceeded("listAttachmentParts", depth);
      return;
    }
    const attachmentId = part.body?.attachmentId ?? undefined;
    const inlineData = part.filename && part.body?.data ? part.body.data : undefined;
    if (attachmentId || inlineData) {
      const contentId = headerValue(part, "Content-ID")
        ?.trim()
        .replace(/^<(.*)>$/, "$1")
        .toLowerCase();
      const disposition = headerValue(part, "Content-Disposition")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase();
      parts.push({
        partId: part.partId ?? "",
        filename: part.filename ?? "",
        mimeType: part.mimeType || "application/octet-stream",
        size: part.body?.size ?? 0,
        ...(attachmentId ? { attachmentId } : { data: inlineData }),
        ...(contentId ? { contentId } : {}),
        ...(disposition ? { disposition } : {}),
      });
    }
    for (const subpart of part.parts ?? []) {
      walk(subpart, depth + 1);
    }
  }

  walk(payload, 0);
  return parts;
}

/**
 * Collect the `cid:` references of an HTML body (RFC 2392 URLs, which
 * are percent-encoded), lower-cased so they compare against
 * `AttachmentPart.contentId`.
 */
export function collectCidReferences(html: string): Set<string> {
  const references = new Set<string>();
  for (const match of html.matchAll(/cid:([^\s"'<>()]+)/gi)) {
    /* v8 ignore next -- the capture group is mandatory in the regex, so
       match[1] is always set; `?? ""` only satisfies the type checker. */
    const raw = match[1] ?? "";
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      // Malformed percent-encoding: keep the raw token.
    }
    references.add(decoded.toLowerCase());
  }
  return references;
}

/**
 * An inline part is one the HTML body renders in place — a signature
 * logo, an embedded picture — rather than a file the sender attached:
 * it carries a `Content-ID` that the HTML references through `cid:`,
 * and it is not explicitly marked `Content-Disposition: attachment`.
 *
 * Deliberately narrow: a part with a `Content-ID` the HTML never
 * references (Gmail lists those as regular attachments), or a PDF that
 * Apple Mail sends with `Content-Disposition: inline` but no
 * `Content-ID`, is NOT inline — skipping it would silently drop a real
 * attachment.
 */
export function isInlinePart(part: AttachmentPart, cidReferences: ReadonlySet<string>): boolean {
  return (
    part.contentId !== undefined &&
    part.disposition !== "attachment" &&
    cidReferences.has(part.contentId)
  );
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
      for (const subpart of part.parts) {
        walk(subpart, depth + 1);
      }
    }
  }

  walk(payload, 0);
  return attachments;
}
