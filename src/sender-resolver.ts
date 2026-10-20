/**
 * Resolve the RFC 5322 `From:` value to use when the caller doesn't
 * specify one explicitly on send_email / draft_email / reply_all.
 *
 * Older versions fell back to the literal string `"me"`, which Gmail
 * accepts on the envelope side but renders as a bare email address in
 * the outgoing `From:` header — the recipient sees `bob@example.com`
 * instead of `Bob Smith <bob@example.com>`. Upstream tracks this as
 * GongRzhe/Gmail-MCP-Server#77.
 *
 * Ordered fallbacks (all best-effort, degrading gracefully):
 *   1. `users.settings.sendAs.list` → default entry → `"DisplayName <email>"`
 *      if displayName is present, bare email otherwise. Requires
 *      gmail.settings.basic OR gmail.modify OR gmail.readonly.
 *   2. `users.getProfile` → bare `emailAddress` (no display name).
 *      Requires gmail.readonly OR gmail.modify OR gmail.send.
 *   3. `"me"` literal — original behaviour for the no-scope case.
 *
 * The successful result is cached **per gmail client instance** in a
 * WeakMap, so two clients signed in to different accounts in the same
 * process never cross-contaminate (Qodo finding on PR #42). Today the
 * MCP only ever holds one client, but the multi-account work in the
 * roadmap will hold several and this keeps the resolver correct by
 * construction rather than by "we only ever call it with one client".
 * The `"me"` fallback is still NOT cached so a process that re-auths
 * that client to a broader scope picks up the display name on the next
 * send without a restart.
 */

import { parseEmailAddresses } from "./reply-all-helpers.js";

// Minimal subset of the gmail_v1 client surface we actually touch —
// keeps this module mockable in tests without pulling in the full
// googleapis type tree.
export interface SenderResolverGmailClient {
  users: {
    settings: {
      sendAs: {
        list: (params: { userId: string }) => Promise<{
          data: {
            sendAs?:
              | {
                  sendAsEmail?: string | null;
                  displayName?: string | null;
                  isDefault?: boolean | null;
                  isPrimary?: boolean | null;
                }[]
              | null;
          };
        }>;
      };
    };
    getProfile: (params: { userId: string }) => Promise<{
      data: { emailAddress?: string | null };
    }>;
  };
}

// WeakMap keyed by the gmail client instance so each client carries its
// own cached sender and two clients (e.g. different OAuth accounts in
// the same process) never cross-contaminate. Weak keys let GC reclaim
// an entry when the client goes out of scope — no long-lived leak even
// if a caller spins up many short-lived clients. `let` rather than
// `const` so `_resetDefaultSenderCache` can clear the whole map by
// replacing it (WeakMap has no `.clear()`).
let cache = new WeakMap<SenderResolverGmailClient, string>();

// In-flight dedup: concurrent cold-cache calls on the same client all
// return the SAME in-progress promise instead of each firing their own
// sendAs.list / getProfile round-trip. A second `let` so reset works.
let inFlight = new WeakMap<SenderResolverGmailClient, Promise<string>>();

export async function resolveDefaultSender(gmail: SenderResolverGmailClient): Promise<string> {
  const hit = cache.get(gmail);
  if (hit !== undefined) return hit;

  const pending = inFlight.get(gmail);
  if (pending) return pending;

  const task = (async (): Promise<string> => {
    try {
      const sendAsResp = await gmail.users.settings.sendAs.list({ userId: "me" });
      const entries = sendAsResp.data.sendAs ?? [];
      const primary =
        entries.find((s) => s.isDefault === true) ??
        entries.find((s) => s.isPrimary === true) ??
        entries[0];
      if (primary?.sendAsEmail) {
        const name = primary.displayName?.trim();
        const resolved = name ? `${name} <${primary.sendAsEmail}>` : primary.sendAsEmail;
        cache.set(gmail, resolved);
        return resolved;
      }
    } catch {
      // Scope doesn't grant settings.basic — fall through.
    }

    try {
      const profileResp = await gmail.users.getProfile({ userId: "me" });
      if (profileResp.data.emailAddress) {
        const resolved = profileResp.data.emailAddress;
        cache.set(gmail, resolved);
        return resolved;
      }
    } catch {
      // Fall through to "me".
    }

    // Don't cache — a process that re-auths this client to a broader
    // scope should pick up the display name on the next call without a
    // restart.
    return "me";
  })();

  inFlight.set(gmail, task);
  try {
    return await task;
  } finally {
    inFlight.delete(gmail);
  }
}

/** Test-only: reset the cache + inFlight between cases. */
export function _resetDefaultSenderCache(): void {
  cache = new WeakMap();
  inFlight = new WeakMap();
  aliasCache = new WeakMap();
}

// ---------------------------------------------------------------------
// Conversation-aware sender
//
// A reply has to leave from the address the conversation already uses,
// not from the account's default send-as address: a mailbox that holds
// several aliases (a personal one and a company one, say) otherwise
// answers a personal thread from the company address, and the
// correspondent sees a stranger reply. This mirrors what the Gmail web
// UI does. The same resolver checks an explicit `from` against the
// configured aliases, because Gmail silently rewrites an unknown
// `From:` to the default address instead of rejecting the send.
// ---------------------------------------------------------------------

/** One configured send-as address of the account. */
export interface SendAsAlias {
  email: string;
  displayName: string;
  /** Gmail's default send-as address (`isDefault`, else `isPrimary`). */
  isDefault?: boolean;
}

/** The headers of one message that tell which alias it involved. */
export interface ConversationHeaders {
  from: string;
  to: string;
  cc: string;
  deliveredTo: string;
}

interface ThreadMessageMetadata {
  labelIds?: string[] | null;
  payload?: {
    headers?: { name?: string | null; value?: string | null }[] | null;
  } | null;
}

export interface ConversationSenderGmailClient {
  users: SenderResolverGmailClient["users"] & {
    threads: {
      get: (params: {
        userId: string;
        id: string;
        format: string;
        metadataHeaders: string[];
      }) => Promise<{ data: { messages?: ThreadMessageMetadata[] | null } }>;
    };
  };
}

/**
 * List the account's usable send-as addresses, best-effort: an empty
 * list when the token lacks a settings-capable scope, in which case the
 * callers keep the pre-existing behaviour (default sender, `from`
 * passed through unchecked). Aliases still awaiting verification are
 * left out, Gmail refuses to send from them.
 */
export async function listSendAsAliases(gmail: SenderResolverGmailClient): Promise<SendAsAlias[]> {
  const hit = aliasCache.get(gmail);
  if (hit !== undefined) return hit;
  try {
    const response = await gmail.users.settings.sendAs.list({ userId: "me" });
    const entries = (response.data.sendAs ?? []) as {
      sendAsEmail?: string | null;
      displayName?: string | null;
      isDefault?: boolean | null;
      isPrimary?: boolean | null;
      verificationStatus?: string | null;
    }[];
    const usable = entries.filter(
      (entry) => Boolean(entry.sendAsEmail) && entry.verificationStatus !== "pending",
    );
    const defaultEntry =
      usable.find((entry) => entry.isDefault === true) ??
      usable.find((entry) => entry.isPrimary === true) ??
      usable[0];
    const aliases = usable.map((entry) => ({
      email: entry.sendAsEmail ?? "",
      displayName: entry.displayName?.trim() ?? "",
      isDefault: entry === defaultEntry,
    }));
    // Same policy as the default-sender cache: keep a real answer for
    // the client's lifetime, never an empty one, so a re-auth to a
    // broader scope is picked up without a restart.
    if (aliases.length > 0) aliasCache.set(gmail, aliases);
    return aliases;
  } catch {
    return [];
  }
}

// Per-client cache of the send-as list, reset with the default-sender
// cache by `_resetDefaultSenderCache`.
let aliasCache = new WeakMap<SenderResolverGmailClient, SendAsAlias[]>();

function formatAlias(alias: SendAsAlias): string {
  return alias.displayName ? `${alias.displayName} <${alias.email}>` : alias.email;
}

/**
 * Pick the alias a conversation already uses, or `undefined` when no
 * header names one. Order:
 *   1. the source message was sent by one of our aliases (a reply to
 *      our own message) → that alias;
 *   2. an alias the source was addressed to, in `To:`, then `Cc:` order;
 *   3. the most recent earlier message we sent in the thread → its
 *      alias (`history` is newest first);
 *   4. an alias in the source's `Delivered-To:` — the weakest signal, as
 *      it can name the default address of a thread run from another
 *      alias.
 */
export function pickConversationAlias(
  aliases: readonly SendAsAlias[],
  source: ConversationHeaders | undefined,
  history: readonly ConversationHeaders[] = [],
): SendAsAlias | undefined {
  const byEmail = new Map(aliases.map((alias) => [alias.email.toLowerCase(), alias]));
  const firstAlias = (header: string): SendAsAlias | undefined => {
    for (const address of parseEmailAddresses(header)) {
      const alias = byEmail.get(address.toLowerCase());
      if (alias) return alias;
    }
    return undefined;
  };
  if (source) {
    const picked = firstAlias(source.from) ?? firstAlias(source.to) ?? firstAlias(source.cc);
    if (picked) return picked;
  }
  for (const message of history) {
    const picked = firstAlias(message.from);
    if (picked) return picked;
  }
  return source ? firstAlias(source.deliveredTo) : undefined;
}

/** Read the four sender-relevant headers off a Gmail header list. */
export function conversationHeadersOf(
  headers: readonly { name?: string | null; value?: string | null }[],
): ConversationHeaders {
  const get = (name: string): string =>
    headers.find((header) => header.name?.toLowerCase() === name)?.value ?? "";
  return { from: get("from"), to: get("to"), cc: get("cc"), deliveredTo: get("delivered-to") };
}

async function threadHistory(
  gmail: ConversationSenderGmailClient,
  threadId: string,
): Promise<ConversationHeaders[]> {
  try {
    const response = await gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "metadata",
      metadataHeaders: ["From", "To", "Cc", "Delivered-To"],
    });
    return (response.data.messages ?? [])
      .filter((message) => !(message.labelIds ?? []).includes("DRAFT"))
      .map((message) => conversationHeadersOf(message.payload?.headers ?? []))
      .toReversed();
  } catch {
    return [];
  }
}

/**
 * Resolve the `From:` of an outgoing message.
 *
 * - An explicit `from` must name one of the account's send-as aliases
 *   (checked when the alias list is readable); a bare address gains the
 *   alias display name.
 * - Otherwise, inside a conversation (`source` message and/or
 *   `threadId`), the alias the conversation already uses
 *   (`pickConversationAlias`); the thread is only fetched when the
 *   source message's `From:`, `To:` and `Cc:` name no alias.
 * - Otherwise the account default (`resolveDefaultSender`).
 *
 * `aliases` lets a caller that already listed them skip a second
 * `sendAs.list` round-trip.
 */
export async function resolveSender(
  gmail: ConversationSenderGmailClient,
  options: { from?: string; source?: ConversationHeaders; threadId?: string },
  aliases?: readonly SendAsAlias[],
): Promise<string> {
  const known = aliases ?? (await listSendAsAliases(gmail));
  const explicit = options.from?.trim() ?? "";

  if (explicit !== "") {
    if (known.length === 0) return explicit;
    const addresses = parseEmailAddresses(explicit);
    if (addresses.length !== 1) {
      throw new Error(`"from" must name exactly one address, got "${explicit}"`);
    }
    const wanted = (addresses[0] ?? "").toLowerCase();
    const alias = known.find((entry) => entry.email.toLowerCase() === wanted);
    if (!alias) {
      throw new Error(
        `"${addresses[0] ?? explicit}" is not a send-as address of this Gmail account (configured: ${known
          .map((entry) => entry.email)
          .join(", ")})`,
      );
    }
    return explicit.includes("<") ? explicit : formatAlias(alias);
  }

  // With a single alias there is nothing to choose, and the thread is
  // not worth a round-trip.
  if (known.length > 1 && (options.source || options.threadId)) {
    // `Delivered-To:` is left out of this first pass: it must not win
    // over an alias the thread already used.
    const addressed = options.source
      ? pickConversationAlias(known, { ...options.source, deliveredTo: "" })
      : undefined;
    const history =
      !addressed && options.threadId ? await threadHistory(gmail, options.threadId) : [];
    const picked = addressed ?? pickConversationAlias(known, options.source ?? history[0], history);
    if (picked) return formatAlias(picked);
  }

  const fallback = known.find((alias) => alias.isDefault === true) ?? known[0];
  if (fallback) return formatAlias(fallback);
  return resolveDefaultSender(gmail);
}
