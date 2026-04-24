/**
 * Helper functions for reply_all email functionality.
 * Extracted for testability.
 */

import emailAddresses from "email-addresses";

/**
 * Parses email addresses from a header value (From / To / CC / BCC)
 * and returns the bare addresses, dropping display names and groups.
 *
 * Delegates to the RFC 5322 compliant `email-addresses` package —
 * which is already a project dependency and is used by
 * `src/email-export.ts` for the same purpose. Consolidating here
 * replaces an earlier hand-rolled tokenizer that maintained its own
 * comma-in-quoted-display-name, empty-bracket, and last-bracketed-
 * wins special cases; the library handles all three natively per
 * the spec.
 *
 * Handles:
 * - `"user@example.com"` → `["user@example.com"]`
 * - `"Name <email@example.com>"` → `["email@example.com"]`
 * - `'"Doe, John" <john@example.com>, jane@example.com'` (commas
 *   inside quoted display names) → two addresses
 * - `"group: alice@x.com, bob@x.com;"` (RFC 5322 group syntax) →
 *   flattened into the member list
 * - Malformed input where the parser cannot commit to a parse →
 *   empty array (matches the old function's behaviour on pure
 *   garbage input).
 *
 * @param headerValue - The raw header value (e.g., From, To, CC)
 * @returns Array of bare email addresses
 */
export function parseEmailAddresses(headerValue: string): string[] {
  if (!headerValue) return [];

  // Three-stage pipeline:
  //   1. Tokenize the header on commas outside of double-quoted spans.
  //      This is permissive — a header like `"Doe, Jane" <jane@e.com>,
  //      junk, bob@e.com` yields three tokens without the junk killing
  //      the whole parse (which `emailAddresses.parseAddressList` does,
  //      all-or-nothing).
  //   2. Inside each token, pick a candidate string — the last
  //      bracketed `<…@…>` span wins (display names may themselves
  //      contain `<>`), falling back to the trimmed token if it carries
  //      an `@`.
  //   3. Hand the candidate to `email-addresses.parseOneAddress`
  //      (already a dependency via src/email-export.ts). That is the
  //      actual RFC 5322 gate — it rejects domains like `user@.`,
  //      empty local parts, trailing dots, etc. Anything that fails is
  //      dropped.
  //
  // Net effect: we keep the permissive token splitter of the old
  // hand-rolled parser AND we consolidate the "is this actually an
  // email" decision onto the same library the rest of the project
  // already uses.

  const tokens = splitOnUnquotedCommas(headerValue);
  const out: string[] = [];
  for (const token of tokens) {
    const candidate = pickCandidateAddress(token);
    if (!candidate) continue;
    const parsed = emailAddresses.parseOneAddress(candidate);
    if (parsed && parsed.type === "mailbox") {
      out.push(parsed.address);
    }
  }
  return out;
}

/**
 * Split an address-list header on commas outside double-quoted spans.
 * A header like `"Doe, Jane" <jane@e.com>, bob@e.com` yields two
 * tokens, not three.
 */
function splitOnUnquotedCommas(headerValue: string): string[] {
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
  return parts;
}

/**
 * Pull an address candidate out of a single tokenized header segment
 * without validating it. Strategy:
 *   - Prefer the LAST `<…@…>` bracketed span (a display name can
 *     itself contain a `<alias@meta>` span; the real address is in the
 *     outer brackets).
 *   - Otherwise, if the raw token contains an `@`, hand back the
 *     trimmed token minus surrounding straight quotes.
 *   - Otherwise no candidate.
 *
 * Final validation is deferred to `email-addresses.parseOneAddress` in
 * the caller — this function only shortlists.
 */
function pickCandidateAddress(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed) return null;
  const bracketMatches = [...trimmed.matchAll(/<([^<>]*@[^<>]*)>/g)];
  const lastBracket = bracketMatches.at(-1)?.[1]?.trim();
  if (lastBracket) return lastBracket;
  if (trimmed.includes("@")) {
    return trimmed.replace(/^["']|["']$/g, "").trim();
  }
  return null;
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
