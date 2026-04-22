/**
 * Helper functions for reply_all email functionality.
 * Extracted for testability.
 */

/**
 * Parses email addresses from a header value.
 * Handles formats like:
 * - "email@example.com"
 * - "Name <email@example.com>"
 * - '"Doe, John" <john@example.com>' (quoted display-name containing a comma)
 * - Multiple addresses separated by commas
 *
 * Splits on commas only outside of double-quoted display names so a
 * header like `"Doe, Jane" <jane@e.com>, bob@e.com` returns two
 * addresses rather than three garbage tokens.
 *
 * @param headerValue - The raw header value (e.g., From, To, CC)
 * @returns Array of extracted email addresses
 */
export function parseEmailAddresses(headerValue: string): string[] {
  if (!headerValue) return [];

  // Tokenize on commas that are not inside double quotes.
  const parts: string[] = [];
  let buf = "";
  let inQuotes = false;
  for (let i = 0; i < headerValue.length; i++) {
    const ch = headerValue[i];
    if (ch === '"' && headerValue[i - 1] !== "\\") {
      inQuotes = !inQuotes;
      buf += ch;
    } else if (ch === "," && !inQuotes) {
      parts.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.length > 0) parts.push(buf);

  const emails: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    // Extract email from "Name <email>" format. Three traps guarded
    // against, all surfaced by the fast-check fuzzer:
    //   1. A display name that itself contains a '<…>' span (must
    //      pick the LAST bracketed address, not the first — so a
    //      `"Display <alias@meta>" <real@host>` returns `real@host`).
    //   2. Empty `< >` — skipped by the `@` requirement inside the
    //      brackets.
    //   3. Nested '<' or '>' — excluded from the capture class
    //      (`[^<>]`) so the regex anchors to a single bracketed span.
    const bracketMatches = [...trimmed.matchAll(/<([^<>]*@[^<>]*)>/g)];
    const lastBracketEmail = bracketMatches.at(-1)?.[1]?.trim();
    if (lastBracketEmail) {
      emails.push(lastBracketEmail);
    } else if (trimmed.includes("@")) {
      // Strip any surrounding quotes / whitespace from a bare address
      emails.push(trimmed.replace(/^["']|["']$/g, "").trim());
    }
  }

  return emails;
}

/**
 * Filters out the authenticated user's email from a list of emails.
 * Case-insensitive comparison.
 *
 * @param emails - Array of email addresses to filter
 * @param myEmail - The authenticated user's email address
 * @returns Filtered array excluding the user's email
 */
export function filterOutEmail(emails: string[], myEmail: string): string[] {
  const myEmailLower = myEmail.toLowerCase();
  return emails.filter((email) => email.toLowerCase() !== myEmailLower);
}

/**
 * Adds "Re: " prefix to a subject if not already present.
 * Case-insensitive check for existing prefix.
 *
 * @param subject - The original email subject
 * @returns Subject with "Re: " prefix
 */
export function addRePrefix(subject: string): string {
  if (subject.toLowerCase().startsWith("re:")) {
    return subject;
  }
  return `Re: ${subject}`;
}

/**
 * Builds the References header for a reply email.
 * Combines original References with original Message-ID.
 *
 * @param originalReferences - The References header from the original email
 * @param originalMessageId - The Message-ID of the original email
 * @returns Combined References header value
 */
export function buildReferencesHeader(
  originalReferences: string,
  originalMessageId: string,
): string {
  if (!originalMessageId) {
    return originalReferences;
  }
  return originalReferences ? `${originalReferences} ${originalMessageId}` : originalMessageId;
}

/**
 * Builds recipient lists for a reply-all email.
 *
 * Rules:
 * - TO: original From (sender of the email)
 * - CC: original To + original CC (excluding the authenticated user)
 *
 * @param originalFrom - From header value
 * @param originalTo - To header value
 * @param originalCc - CC header value
 * @param myEmail - The authenticated user's email address
 * @returns Object with 'to' and 'cc' arrays
 */
export function buildReplyAllRecipients(
  originalFrom: string,
  originalTo: string,
  originalCc: string,
  myEmail: string,
): { to: string[]; cc: string[] } {
  const fromEmails = parseEmailAddresses(originalFrom);
  const toEmails = parseEmailAddresses(originalTo);
  const ccEmails = parseEmailAddresses(originalCc);

  // TO recipients: original From (the person who sent the email), excluding myself
  const replyTo = dedupeAddresses(filterOutEmail(fromEmails, myEmail));

  // CC recipients: everyone else who was on To and CC, excluding myself
  // and excluding any address already landing in `To` (no To/CC overlap).
  const toSetLower = new Set(replyTo.map((e) => e.toLowerCase()));
  const replyCc = dedupeAddresses(filterOutEmail([...toEmails, ...ccEmails], myEmail)).filter(
    (email) => !toSetLower.has(email.toLowerCase()),
  );

  return {
    to: replyTo,
    cc: replyCc,
  };
}

/**
 * Case-insensitive dedupe that preserves the first occurrence's original casing.
 */
function dedupeAddresses(emails: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const email of emails) {
    const key = email.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(email);
    }
  }
  return out;
}
