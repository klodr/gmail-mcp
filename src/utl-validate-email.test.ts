/**
 * `validateEmail` consistency with `email-addresses.parseOneAddress`.
 *
 * The previous regex (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`) accepted a
 * handful of shapes that the rest of the codebase rejected via
 * `email-addresses.parseOneAddress` (used by reply-all-helpers and
 * email-export). These tests pin the new behaviour: validateEmail
 * now delegates to parseOneAddress, so all email shape checks share
 * a single source of truth.
 */

import { describe, it, expect } from "vitest";
import emailAddresses from "email-addresses";
import { validateEmail } from "./utl.js";

describe("validateEmail (parseOneAddress-backed)", () => {
  describe("agrees with email-addresses on valid shapes", () => {
    const validCases = [
      "user@example.com",
      "u.s.e.r@example.com",
      "user@x.y",
      "tag+filter@example.com",
      "first.last@sub.example.co.uk",
    ];
    for (const c of validCases) {
      it(`accepts "${c}"`, () => {
        expect(validateEmail(c)).toBe(true);
        expect(emailAddresses.parseOneAddress(c)).not.toBeNull();
      });
    }
  });

  describe("agrees with email-addresses on invalid shapes (no drift)", () => {
    // Each of these was previously accepted by the local regex but
    // rejected by parseOneAddress. After the fix they must be rejected
    // by validateEmail too.
    const invalidCases = [
      "trailing.dot.@example.com",
      ".leading-dot@example.com",
      "double..dot@example.com",
      "user@.x.com",
    ];
    for (const c of invalidCases) {
      it(`rejects "${c}" (was a regex/parser drift before fix)`, () => {
        expect(validateEmail(c)).toBe(false);
        // Cross-check: parseOneAddress also rejects it — that's the
        // contract this fix enforces.
        expect(emailAddresses.parseOneAddress(c)).toBeNull();
      });
    }
  });

  describe("trivially invalid", () => {
    const trivial = ["", "no-at-sign", "@example.com", "user@", "a b@c.d"];
    for (const c of trivial) {
      it(`rejects ${JSON.stringify(c)}`, () => {
        expect(validateEmail(c)).toBe(false);
      });
    }
  });

  it("source: validateEmail uses parseOneAddress (single source of truth)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, "utl.ts"), "utf-8");
    // Guard the import + the body of validateEmail. A future refactor
    // that goes back to a regex would silently reopen the drift.
    expect(source).toContain('import emailAddresses from "email-addresses";');
    expect(source).toMatch(/validateEmail[\s\S]{0,400}emailAddresses\.parseOneAddress/);
  });
});
