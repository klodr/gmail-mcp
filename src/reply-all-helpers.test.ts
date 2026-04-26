import { describe, it, expect } from "vitest";
import {
  parseEmailAddresses,
  filterOutEmail,
  addRePrefix,
  addFwdPrefix,
  buildForwardQuotedBody,
  buildReferencesHeader,
  buildReplyAllRecipients,
} from "./reply-all-helpers.js";

describe("parseEmailAddresses", () => {
  it("extracts email from simple email address", () => {
    expect(parseEmailAddresses("user@example.com")).toEqual(["user@example.com"]);
  });

  it('extracts email from "Name <email>" format', () => {
    expect(parseEmailAddresses("John Doe <john@example.com>")).toEqual(["john@example.com"]);
  });

  it("handles multiple addresses separated by commas", () => {
    expect(parseEmailAddresses("alice@example.com, bob@example.com")).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);
  });

  it("handles mixed formats with multiple addresses", () => {
    expect(
      parseEmailAddresses(
        "Alice <alice@example.com>, bob@example.com, Carol Smith <carol@example.com>",
      ),
    ).toEqual(["alice@example.com", "bob@example.com", "carol@example.com"]);
  });

  it("handles empty string", () => {
    expect(parseEmailAddresses("")).toEqual([]);
  });

  it("handles whitespace around addresses", () => {
    expect(parseEmailAddresses("  user@example.com  ,  other@example.com  ")).toEqual([
      "user@example.com",
      "other@example.com",
    ]);
  });

  it("handles angle brackets with spaces", () => {
    expect(parseEmailAddresses("Name < email@example.com >")).toEqual(["email@example.com"]);
  });

  it("ignores entries without @ symbol", () => {
    expect(parseEmailAddresses("invalid, user@example.com")).toEqual(["user@example.com"]);
  });

  it("does not split on commas inside quoted display names", () => {
    // Regression: a naive split(",") would produce three garbage tokens
    // for '"Doe, John" <john@example.com>, jane@example.com'. The
    // quote-aware tokenizer must return two recipients.
    expect(parseEmailAddresses('"Doe, John" <john@example.com>, jane@example.com')).toEqual([
      "john@example.com",
      "jane@example.com",
    ]);
  });

  it("handles multiple quoted display names with commas", () => {
    expect(
      parseEmailAddresses(
        '"Smith, Alice" <alice@example.com>, "Jones, Bob" <bob@example.com>, "Brown, Carol" <carol@example.com>',
      ),
    ).toEqual(["alice@example.com", "bob@example.com", "carol@example.com"]);
  });

  it("handles escaped quotes inside quoted display names", () => {
    // Regression: backslash-escaped quotes inside a quoted display name
    // must not flip the in-quotes state — otherwise the comma after
    // "JD", would be mis-read as an address separator.
    expect(
      parseEmailAddresses('"Doe \\"JD\\", John" <john@example.com>, jane@example.com'),
    ).toEqual(["john@example.com", "jane@example.com"]);
  });

  it("flattens RFC 5322 group syntax into the member list", () => {
    // Regression: a prior version of this function split on unquoted
    // commas before handing anything to email-addresses, which
    // fragmented `group: alice@x, bob@x;` into two invalid tokens
    // (`group: alice@x` + ` bob@x;`), neither of which parses back as
    // a mailbox — the whole group silently dropped. The strict
    // parseAddressList pass handles groups correctly.
    expect(
      parseEmailAddresses("project-team: alice@example.com, bob@example.com, carol@example.com;"),
    ).toEqual(["alice@example.com", "bob@example.com", "carol@example.com"]);
  });

  it("handles a group alongside standalone mailboxes", () => {
    expect(
      parseEmailAddresses(
        "lead@example.com, team: dev1@example.com, dev2@example.com;, ops@example.com",
      ),
    ).toEqual(["lead@example.com", "dev1@example.com", "dev2@example.com", "ops@example.com"]);
  });
});

describe("filterOutEmail", () => {
  it("filters out matching email", () => {
    const emails = ["alice@example.com", "bob@example.com", "carol@example.com"];
    expect(filterOutEmail(emails, "bob@example.com")).toEqual([
      "alice@example.com",
      "carol@example.com",
    ]);
  });

  it("is case insensitive", () => {
    const emails = ["Alice@Example.com", "bob@example.com"];
    expect(filterOutEmail(emails, "alice@example.com")).toEqual(["bob@example.com"]);
  });

  it("returns all emails if none match", () => {
    const emails = ["alice@example.com", "bob@example.com"];
    expect(filterOutEmail(emails, "carol@example.com")).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);
  });

  it("handles empty array", () => {
    expect(filterOutEmail([], "user@example.com")).toEqual([]);
  });

  it("handles empty filter email", () => {
    const emails = ["alice@example.com"];
    expect(filterOutEmail(emails, "")).toEqual(["alice@example.com"]);
  });
});

describe("addRePrefix", () => {
  it("adds Re: prefix to subject without it", () => {
    expect(addRePrefix("Hello")).toBe("Re: Hello");
  });

  it("does not add Re: prefix if already present (lowercase)", () => {
    expect(addRePrefix("re: Hello")).toBe("re: Hello");
  });

  it("does not add Re: prefix if already present (uppercase)", () => {
    expect(addRePrefix("Re: Hello")).toBe("Re: Hello");
  });

  it("does not add Re: prefix if already present (mixed case)", () => {
    expect(addRePrefix("RE: Hello")).toBe("RE: Hello");
  });

  it("handles empty subject", () => {
    expect(addRePrefix("")).toBe("Re: ");
  });

  it("adds prefix when subject starts with similar but not Re:", () => {
    expect(addRePrefix("Regarding: Hello")).toBe("Re: Regarding: Hello");
  });
});

describe("buildReferencesHeader", () => {
  it("returns message ID when no original references", () => {
    expect(buildReferencesHeader("", "<msg123@example.com>")).toBe("<msg123@example.com>");
  });

  it("appends message ID to existing references", () => {
    expect(buildReferencesHeader("<ref1@example.com>", "<msg123@example.com>")).toBe(
      "<ref1@example.com> <msg123@example.com>",
    );
  });

  it("returns empty string when both are empty", () => {
    expect(buildReferencesHeader("", "")).toBe("");
  });

  it("returns original references when message ID is empty", () => {
    expect(buildReferencesHeader("<ref1@example.com>", "")).toBe("<ref1@example.com>");
  });

  it("handles multiple existing references", () => {
    expect(
      buildReferencesHeader("<ref1@example.com> <ref2@example.com>", "<msg123@example.com>"),
    ).toBe("<ref1@example.com> <ref2@example.com> <msg123@example.com>");
  });
});

describe("buildReplyAllRecipients", () => {
  const myEmail = "me@example.com";

  it("puts original sender in To field", () => {
    const result = buildReplyAllRecipients("sender@example.com", "me@example.com", "", myEmail);
    expect(result.to).toEqual(["sender@example.com"]);
  });

  it("puts original To and CC in CC field", () => {
    const result = buildReplyAllRecipients(
      "sender@example.com",
      "recipient1@example.com, recipient2@example.com",
      "cc1@example.com",
      myEmail,
    );
    expect(result.cc).toEqual([
      "recipient1@example.com",
      "recipient2@example.com",
      "cc1@example.com",
    ]);
  });

  it("excludes authenticated user from CC", () => {
    const result = buildReplyAllRecipients(
      "sender@example.com",
      "me@example.com, other@example.com",
      "me@example.com, another@example.com",
      myEmail,
    );
    expect(result.cc).toEqual(["other@example.com", "another@example.com"]);
    expect(result.cc).not.toContain("me@example.com");
  });

  it("excludes authenticated user from To when sender is self", () => {
    const result = buildReplyAllRecipients("me@example.com", "recipient@example.com", "", myEmail);
    expect(result.to).toEqual([]);
  });

  it("handles Name <email> format in From", () => {
    const result = buildReplyAllRecipients(
      "John Doe <john@example.com>",
      "me@example.com",
      "",
      myEmail,
    );
    expect(result.to).toEqual(["john@example.com"]);
  });

  it("handles complex scenario with mixed formats", () => {
    const result = buildReplyAllRecipients(
      "Alice <alice@example.com>",
      "Me <me@example.com>, Bob <bob@example.com>",
      "Carol <carol@example.com>, me@example.com",
      myEmail,
    );
    expect(result.to).toEqual(["alice@example.com"]);
    expect(result.cc).toEqual(["bob@example.com", "carol@example.com"]);
  });

  it("handles empty CC header", () => {
    const result = buildReplyAllRecipients(
      "sender@example.com",
      "recipient@example.com",
      "",
      myEmail,
    );
    expect(result.cc).toEqual(["recipient@example.com"]);
  });

  it("is case insensitive when excluding authenticated user", () => {
    const result = buildReplyAllRecipients(
      "sender@example.com",
      "ME@EXAMPLE.COM, other@example.com",
      "",
      myEmail,
    );
    expect(result.cc).toEqual(["other@example.com"]);
  });
});

describe("addFwdPrefix", () => {
  it("adds Fwd: prefix to subject without it", () => {
    expect(addFwdPrefix("Hello")).toBe("Fwd: Hello");
  });

  it("does not add Fwd: prefix if already present (lowercase)", () => {
    expect(addFwdPrefix("fwd: Hello")).toBe("fwd: Hello");
  });

  it("does not add Fwd: prefix if already present (uppercase)", () => {
    expect(addFwdPrefix("Fwd: Hello")).toBe("Fwd: Hello");
  });

  it("treats Fw: as already-forwarded (Outlook variant)", () => {
    expect(addFwdPrefix("Fw: Hello")).toBe("Fw: Hello");
  });

  it("treats fw: (lowercase) as already-forwarded", () => {
    expect(addFwdPrefix("fw: Hello")).toBe("fw: Hello");
  });

  it("handles empty subject", () => {
    expect(addFwdPrefix("")).toBe("Fwd: ");
  });

  it("does not strip a Re: prefix when prepending Fwd:", () => {
    // A reply that the user then forwards keeps both prefixes — same
    // behaviour as Gmail's UI. Pinning the no-strip contract guards
    // against a regression that strips Re: thinking it should be
    // exclusive with Fwd:.
    expect(addFwdPrefix("Re: Hello")).toBe("Fwd: Re: Hello");
  });
});

describe("buildForwardQuotedBody", () => {
  const headers = {
    from: "Alice <alice@example.com>",
    date: "Fri, 25 Apr 2026 10:00:00 +0000",
    subject: "Original subject",
    to: "bob@example.com",
  };

  it("formats header block + original text without preface", () => {
    const out = buildForwardQuotedBody(headers, "Original body content");
    expect(out).toContain("---------- Forwarded message ---------");
    expect(out).toContain("From: Alice <alice@example.com>");
    expect(out).toContain("Date: Fri, 25 Apr 2026 10:00:00 +0000");
    expect(out).toContain("Subject: Original subject");
    expect(out).toContain("To: bob@example.com");
    expect(out).toContain("Original body content");
    // No leading preface — the separator is the first non-empty line.
    expect(out.startsWith("---------- Forwarded message ---------")).toBe(true);
  });

  it("prepends preface separated by a blank line when supplied", () => {
    const out = buildForwardQuotedBody(headers, "Body", "FYI — see below");
    expect(out.startsWith("FYI — see below\n\n---------- Forwarded message ---------")).toBe(true);
  });

  it("treats empty preface like absent (no leading blank-line gap)", () => {
    const out = buildForwardQuotedBody(headers, "Body", "");
    expect(out.startsWith("---------- Forwarded message ---------")).toBe(true);
  });

  it("preserves multi-line original text body verbatim", () => {
    const original = "Line 1\nLine 2\nLine 3";
    const out = buildForwardQuotedBody(headers, original);
    expect(out).toContain("Line 1\nLine 2\nLine 3");
  });

  it("renders an empty body when source had no extractable text", () => {
    const out = buildForwardQuotedBody(headers, "");
    // The header block + blank line + empty body — no crash, just an
    // empty trailer. Pin so a regression that adds a `||` fallback
    // doesn't sneak default text into the forward.
    expect(out.endsWith("To: bob@example.com\n\n")).toBe(true);
  });
});
