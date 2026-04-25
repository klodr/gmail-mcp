/**
 * Shared helpers for reading Gmail API message headers.
 *
 * `gmail.users.messages.get` returns headers as an unordered array of
 * `{ name, value }` records with case-variable names ("From" vs "from",
 * "Message-ID" vs "Message-Id"). Three sites in the codebase used to
 * inline the same "find by case-insensitive name, coalesce missing
 * to empty string" pattern:
 *
 *   - `src/email-export.ts` inside `gmailMessageToJson`
 *   - `src/email-export.ts` inside `emailToTxt`
 *   - `src/index.ts` inside `extractHeaders`
 *
 * Consolidating into one factory avoids the three copies drifting
 * (e.g. one site adding a null guard the others missed) and gives a
 * single place to add future header-specific logic (MIME-encoded
 * values, multi-occurrence folding) when the need arises.
 */

import type { gmail_v1 } from "googleapis";

/**
 * Build a function that returns the value of a header by name,
 * case-insensitively, or an empty string if the header is absent.
 *
 * `headers` is accepted as `undefined` so call sites can pass
 * `message.payload?.headers` directly without a local `|| []` fallback
 * — the returned getter short-circuits on missing input.
 *
 * Usage:
 *   const getHeader = makeHeaderGetter(message.payload?.headers);
 *   const subject = getHeader("subject");
 *   const from    = getHeader("from");
 */
export function makeHeaderGetter(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
): (name: string) => string {
  return (name) => headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

/**
 * Extract the canonical set of headers (`subject`, `from`, `to`, `date`,
 * `rfcMessageId`) from a Gmail message payload. Used by `read_email`,
 * `download_email`, and the thread-listing tools to build the
 * single-line summary block at the top of each rendered message.
 *
 * Returns empty strings for any missing header so callers can format
 * unconditionally without null checks.
 */
export function extractHeaders(payload: gmail_v1.Schema$MessagePart | undefined): {
  subject: string;
  from: string;
  to: string;
  date: string;
  rfcMessageId: string;
} {
  const getHeader = makeHeaderGetter(payload?.headers);
  return {
    subject: getHeader("subject"),
    from: getHeader("from"),
    to: getHeader("to"),
    date: getHeader("date"),
    rfcMessageId: getHeader("message-id"),
  };
}
