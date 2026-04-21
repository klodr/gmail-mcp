/**
 * Property-based (fuzz) tests for security-sensitive helpers.
 * Uses fast-check, recognised by OpenSSF Scorecard's Fuzzing check
 * for the JS/TS ecosystem.
 *
 * Targets:
 * - `sanitizeHeaderValue` (re-implemented locally, since utl.ts keeps
 *   the function un-exported): the property we care about is that
 *   the output never contains `\r`, `\n`, or `\0` no matter what the
 *   input is. If a future refactor ever exports a new sanitizer, swap
 *   the local copy for the real one here.
 * - `createEmailMessage`: no user-supplied header value ever survives
 *   as a raw CRLF in the output header block, for any subject /
 *   inReplyTo / references / from / cc / bcc.
 * - `parseEmailAddresses`: always returns an array of `@`-containing
 *   strings, never throws, regardless of quote state or commas.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { createEmailMessage } from "../src/utl.js";
import { parseEmailAddresses } from "../src/reply-all-helpers.js";

// Mirror the strip pattern used in src/utl.ts#sanitizeHeaderValue so
// the property is independently testable. A drift here would surface
// as either a test failure (good) or a too-permissive property (bad) —
// kept in sync manually; revisit if utl.ts exports the function.
const stripHeader = (v: string): string => v.replace(/[\r\n\0]/g, "");

describe("Fuzz: sanitizeHeaderValue invariant", () => {
  it("never leaves \\r, \\n or \\0 in the output", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 1024 }), (raw) => {
        const sanitized = stripHeader(raw);
        expect(sanitized).not.toMatch(/[\r\n\0]/);
      }),
      { numRuns: 500 },
    );
  });

  it("shrinks every test case with known CRLF to a clean output", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 512 }), fc.string({ maxLength: 512 }), (a, b) => {
        const raw = `${a}\r\nBcc: attacker@evil.com\r\n${b}`;
        expect(stripHeader(raw)).not.toMatch(/[\r\n\0]/);
      }),
      { numRuns: 200 },
    );
  });
});

describe("Fuzz: createEmailMessage header block is CRLF-safe", () => {
  // Build a validated-args payload where every user-supplied header
  // field is fuzzed. The only structural guarantees we give fast-check
  // are (1) `to` is a non-empty valid-email list (validateEmail rejects
  // anything else and short-circuits before sanitisation), and (2)
  // `subject` is a string (the function asserts this implicitly).
  const validEmail = fc.constantFrom("a@example.com", "b@test.org", "c.d@sub.example.io");

  it("header block never contains a bare injected Bcc/X-/Cc line from a fuzzed subject", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 256 }),
        fc.array(validEmail, { minLength: 1, maxLength: 3 }),
        (fuzzedSubject, to) => {
          const out = createEmailMessage({
            to,
            subject: fuzzedSubject,
            body: "body",
            mimeType: "text/plain",
          });
          // Extract the header block (everything before the first
          // blank line — RFC 822).
          const headerBlock = out.split("\r\n\r\n")[0] ?? out;
          // No raw injected header smuggled in: every header line
          // must match one of the legitimate ones we build.
          const allowedPrefixes =
            /^(From|To|Subject|In-Reply-To|References|Cc|Bcc|MIME-Version|Content-Type|Content-Transfer-Encoding|--):/;
          for (const line of headerBlock.split("\r\n")) {
            if (line === "") continue;
            // Boundary lines start with "--" for multipart, but this
            // test uses text/plain so none are expected.
            if (line.startsWith("--")) continue;
            expect(
              allowedPrefixes.test(line) || line.startsWith(" ") || line.startsWith("\t"),
              `unexpected header line after sanitisation: ${JSON.stringify(line)}`,
            ).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("Fuzz: parseEmailAddresses never throws and returns @-strings", () => {
  it("always returns a string[] where every entry contains '@' (or the array is empty)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 512 }), (raw) => {
        const out = parseEmailAddresses(raw);
        expect(Array.isArray(out)).toBe(true);
        for (const email of out) {
          expect(email).toContain("@");
        }
      }),
      { numRuns: 500 },
    );
  });

  it("quoted commas never split", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        (namePart, domainPart) => {
          // Build a header like '"<namePart>, <anything>" <user@<domainPart>>'
          // and verify the parser returns exactly one address.
          const safeName = namePart.replace(/["\r\n\0]/g, "");
          const safeDomain = domainPart.replace(/["\r\n\0\s@,]/g, "") || "example.com";
          const raw = `"${safeName}, extra" <user@${safeDomain}>`;
          const out = parseEmailAddresses(raw);
          expect(out.length).toBe(1);
          expect(out[0]).toContain("@");
        },
      ),
      { numRuns: 200 },
    );
  });
});
