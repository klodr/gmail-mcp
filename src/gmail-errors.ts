/**
 * Shared error helpers for Gmail API callers.
 *
 * The googleapis client throws a GaxiosError whose HTTP status lives at
 * `error.response.status`. Most of our call sites want to branch on that
 * status (404, 400) and also have a plain `.message` to surface. We wrap
 * the raw error in a view that exposes a `.code` property set to the HTTP
 * status without mutating the original — callers upstream may still want
 * to inspect the untouched error.
 */

import type { GaxiosError } from "gaxios";

export interface GmailApiErrorView {
  readonly code?: number;
  readonly message: string;
  /** The original error, preserved for `{ cause: err }` forwarding. */
  readonly original: unknown;
}

/**
 * Extract a stable { code, message } view from whatever the googleapis
 * client threw, without mutating the underlying object.
 */
export function asGmailApiError(err: unknown): GmailApiErrorView {
  if (err instanceof Error) {
    const maybe = err as unknown as GaxiosError;
    const explicitCode = (err as { code?: unknown }).code;
    const code =
      typeof explicitCode === "number"
        ? explicitCode
        : typeof maybe.response?.status === "number"
          ? maybe.response.status
          : undefined;
    return { code, message: err.message, original: err };
  }
  return { code: undefined, message: String(err), original: err };
}

/**
 * Structured payload surfaced when Google rejects the stored refresh
 * token. Clients/agents can branch on `code === "INVALID_GRANT"`
 * instead of regex-matching free-form error text. Contract defined in
 * docs/ROADMAP.md "Graceful invalid_grant handling".
 */
export interface InvalidGrantPayload {
  readonly code: "INVALID_GRANT";
  readonly message: string;
  readonly recovery_action: string;
  readonly credential_path: string;
}

/**
 * google-auth-library rejects the stored refresh token with an
 * `invalid_grant` surfaced in one of three places depending on the
 * call path: a top-level `.message` ("invalid_grant: …"), a nested
 * `.response.data.error` ("invalid_grant"), or a nested
 * `.response.data.error_description`. We match any of them without
 * regex — a substring check is enough and avoids brittle format
 * assumptions across google-auth-library versions.
 *
 * Trigger conditions per Google docs:
 *   - User revoked consent in the Google account's security page.
 *   - Refresh token expired (6 months of inactivity on external apps).
 *   - Token was reissued elsewhere (each new issuance invalidates
 *     siblings beyond the 50-token cap).
 *   - OAuth app was disabled / deleted / published-unpublished.
 */
export function isInvalidGrantError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const needle = "invalid_grant";
  if (err.message.toLowerCase().includes(needle)) return true;
  const data = (err as unknown as GaxiosError).response?.data as
    | { error?: unknown; error_description?: unknown }
    | undefined;
  if (typeof data?.error === "string" && data.error.toLowerCase().includes(needle)) {
    return true;
  }
  if (
    typeof data?.error_description === "string" &&
    data.error_description.toLowerCase().includes(needle)
  ) {
    return true;
  }
  return false;
}

/**
 * Build the structured payload clients expect on an `invalid_grant`
 * response. `credentialPath` is surfaced verbatim so the operator
 * knows exactly which file holds the now-dead token.
 */
export function buildInvalidGrantPayload(credentialPath: string): InvalidGrantPayload {
  return {
    code: "INVALID_GRANT",
    message:
      "The Gmail refresh token was rejected by Google. It was likely revoked by the user, " +
      "expired after 6 months of inactivity, or reissued elsewhere.",
    recovery_action: "Re-run `npx @klodr/gmail-mcp auth` to reauthorise.",
    credential_path: credentialPath,
  };
}
