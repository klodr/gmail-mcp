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
