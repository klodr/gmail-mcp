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
 * The successful result is cached per process. The `"me"` fallback is
 * NOT cached so a process that re-auths to a broader scope picks up
 * the display name on the next send without a restart.
 */

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

let cached: string | null = null;

export async function resolveDefaultSender(gmail: SenderResolverGmailClient): Promise<string> {
  if (cached !== null) return cached;

  try {
    const sendAsResp = await gmail.users.settings.sendAs.list({ userId: "me" });
    const entries = sendAsResp.data.sendAs ?? [];
    const primary =
      entries.find((s) => s.isDefault === true) ??
      entries.find((s) => s.isPrimary === true) ??
      entries[0];
    if (primary?.sendAsEmail) {
      const name = primary.displayName?.trim();
      cached = name ? `${name} <${primary.sendAsEmail}>` : primary.sendAsEmail;
      return cached;
    }
  } catch {
    // Scope doesn't grant settings.basic — fall through.
  }

  try {
    const profileResp = await gmail.users.getProfile({ userId: "me" });
    if (profileResp.data.emailAddress) {
      cached = profileResp.data.emailAddress;
      return cached;
    }
  } catch {
    // Fall through to "me".
  }

  // Don't cache — a process that re-auths to a broader scope should
  // pick up the display name on the next call without a restart.
  return "me";
}

/** Test-only: reset the cache between cases. */
export function _resetDefaultSenderCache(): void {
  cached = null;
}
