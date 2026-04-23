import { describe, it, expect } from "vitest";
import {
  SendEmailSchema,
  SearchEmailsSchema,
  BatchModifyEmailsSchema,
  BatchDeleteEmailsSchema,
  ModifyEmailSchema,
  CreateFilterSchema,
  CreateFilterFromTemplateSchema,
} from "./tools.js";

// These tests guard against the regressions reported as
// GongRzhe/Gmail-MCP-Server#95 and #96: some MCP clients (Claude Code
// SDK in particular) serialize tool arguments strictly as JSON, so an
// `array` field arrives as a JSON-stringified literal (`'["a","b"]'`)
// and a `number` field as a stringified digit (`"10"`). A bare
// `z.array(...)` / `z.number()` rejects those with "Expected array,
// received string" and the tool becomes unusable from that client.

describe("Schema coercion — JSON-stringified arrays are accepted", () => {
  it("SendEmailSchema.to accepts a stringified array", () => {
    const r = SendEmailSchema.parse({
      to: '["a@example.com","b@example.com"]',
      subject: "x",
      body: "y",
    });
    expect(r.to).toEqual(["a@example.com", "b@example.com"]);
  });

  it("ModifyEmailSchema.labelIds accepts a stringified array", () => {
    const r = ModifyEmailSchema.parse({
      messageId: "abc",
      labelIds: '["Label_1","Label_2"]',
    });
    expect(r.labelIds).toEqual(["Label_1", "Label_2"]);
  });

  it("BatchModifyEmailsSchema.messageIds enforces the 1000-item max on the decoded array", () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `id${i}`);
    const stringified = JSON.stringify(ids);
    expect(() => BatchModifyEmailsSchema.parse({ messageIds: stringified })).toThrow();
  });

  it("BatchDeleteEmailsSchema.messageIds accepts a stringified array under the cap", () => {
    const r = BatchDeleteEmailsSchema.parse({
      messageIds: '["id1","id2","id3"]',
    });
    expect(r.messageIds).toEqual(["id1", "id2", "id3"]);
  });

  it("native arrays still work (no regression)", () => {
    const r = SendEmailSchema.parse({
      to: ["a@example.com"],
      subject: "x",
      body: "y",
    });
    expect(r.to).toEqual(["a@example.com"]);
  });

  it("non-array-looking strings pass through and fail with the Zod 'expected array' error", () => {
    // A literal string like "a@example.com" is NOT a JSON array. We
    // leave it alone on purpose — the fallback error (Zod's structured
    // "expected: array") is more useful to the caller than "Unexpected
    // token f in JSON".
    expect(() => SendEmailSchema.parse({ to: "a@example.com", subject: "x", body: "y" })).toThrow(
      /"expected":\s*"array"/,
    );
  });

  it("array-looking but malformed JSON strings pass through on parse failure", () => {
    // Covers the `catch { return val; }` path in coerceArrayPreprocess:
    // the string starts with `[` so JSON.parse is attempted, it throws,
    // preprocess returns the original string, and z.array() surfaces
    // the cleaner "expected: array" error rather than a raw parse error.
    expect(() => SendEmailSchema.parse({ to: "[broken", subject: "x", body: "y" })).toThrow(
      /"expected":\s*"array"/,
    );
  });
});

describe("Schema coercion — JSON-stringified numbers are accepted", () => {
  it("SearchEmailsSchema.maxResults accepts a stringified integer", () => {
    const r = SearchEmailsSchema.parse({ query: "in:inbox", maxResults: "100" });
    expect(r.maxResults).toBe(100);
  });

  it("SearchEmailsSchema.maxResults enforces the range on the coerced value", () => {
    expect(() => SearchEmailsSchema.parse({ query: "x", maxResults: "501" })).toThrow();
    expect(() => SearchEmailsSchema.parse({ query: "x", maxResults: "0" })).toThrow();
  });

  it("BatchModifyEmailsSchema.batchSize accepts a stringified integer", () => {
    const r = BatchModifyEmailsSchema.parse({
      messageIds: ["abc"],
      batchSize: "25",
    });
    expect(r.batchSize).toBe(25);
  });

  it("native numbers still work (no regression)", () => {
    const r = SearchEmailsSchema.parse({ query: "x", maxResults: 10 });
    expect(r.maxResults).toBe(10);
  });
});

describe("Schema coercion — non-string, non-number inputs are rejected (Qodo #40)", () => {
  // `z.coerce.number()` is too permissive: it turns `true → 1`, `false → 0`,
  // `null → 0`, `[] → 0`, which silently swallows malformed JSON from a
  // loosely-typed caller. The `coerceInt` helper narrows coercion to the
  // string-encoded-integer case only; every other type falls through to
  // `z.number().int()` and is rejected.
  it("boolean true is rejected (does NOT silently become 1)", () => {
    expect(() =>
      SearchEmailsSchema.parse({ query: "x", maxResults: true as unknown as number }),
    ).toThrow(/"expected":\s*"number"/);
  });

  it("boolean false is rejected (does NOT silently become 0)", () => {
    expect(() =>
      SearchEmailsSchema.parse({ query: "x", maxResults: false as unknown as number }),
    ).toThrow(/"expected":\s*"number"/);
  });

  it("null is rejected (does NOT silently become 0)", () => {
    expect(() =>
      SearchEmailsSchema.parse({ query: "x", maxResults: null as unknown as number }),
    ).toThrow(/"expected":\s*"number"/);
  });

  it("empty array is rejected", () => {
    expect(() =>
      SearchEmailsSchema.parse({ query: "x", maxResults: [] as unknown as number }),
    ).toThrow();
  });

  it("empty string is rejected", () => {
    expect(() => SearchEmailsSchema.parse({ query: "x", maxResults: "" })).toThrow();
  });

  it("non-numeric string is rejected", () => {
    expect(() => SearchEmailsSchema.parse({ query: "x", maxResults: "abc" })).toThrow();
  });

  it("scientific-notation string is rejected", () => {
    // "1e3" parses to 1000 under Number(), but coerceIntPreprocess restricts
    // the accepted shape to /^-?\d+$/, so scientific forms are rejected.
    expect(() => SearchEmailsSchema.parse({ query: "x", maxResults: "1e3" })).toThrow();
  });

  it("hex string is rejected", () => {
    // Same rationale: "0xA" → 10 via Number(), but the decimal-only regex
    // blocks hex so an MCP client can't smuggle non-base-10 inputs.
    expect(() => SearchEmailsSchema.parse({ query: "x", maxResults: "0xA" })).toThrow();
  });
});

describe("FilePathSchema — attachment path hardening (CR #40 outside-diff)", () => {
  // The attachment jail in src/utl.ts does the load-bearing realpath check,
  // but FilePathSchema rejects the degenerate shapes at the Zod layer so
  // downstream filename logs can't carry CRLF/NUL injection.
  it("accepts a normal absolute path", () => {
    const r = SendEmailSchema.parse({
      to: ["a@example.com"],
      subject: "x",
      body: "y",
      attachments: ["/Users/me/GmailAttachments/file.pdf"],
    });
    expect(r.attachments).toEqual(["/Users/me/GmailAttachments/file.pdf"]);
  });

  it("rejects an empty string path", () => {
    expect(() =>
      SendEmailSchema.parse({ to: ["a@example.com"], subject: "x", body: "y", attachments: [""] }),
    ).toThrow();
  });

  it("rejects a path containing a NUL byte", () => {
    expect(() =>
      SendEmailSchema.parse({
        to: ["a@example.com"],
        subject: "x",
        body: "y",
        attachments: ["/tmp/evil\x00.pdf"],
      }),
    ).toThrow(/NUL or newline/);
  });

  it("rejects a path containing CR", () => {
    expect(() =>
      SendEmailSchema.parse({
        to: ["a@example.com"],
        subject: "x",
        body: "y",
        attachments: ["/tmp/inject\rHeader: value.pdf"],
      }),
    ).toThrow(/NUL or newline/);
  });

  it("rejects a path containing LF", () => {
    expect(() =>
      SendEmailSchema.parse({
        to: ["a@example.com"],
        subject: "x",
        body: "y",
        attachments: ["/tmp/inject\nHeader: value.pdf"],
      }),
    ).toThrow(/NUL or newline/);
  });

  it("rejects an absurdly long path (>4096 chars)", () => {
    const longPath = "/tmp/" + "a".repeat(4100);
    expect(() =>
      SendEmailSchema.parse({
        to: ["a@example.com"],
        subject: "x",
        body: "y",
        attachments: [longPath],
      }),
    ).toThrow();
  });
});

describe("CreateFilterSchema / CreateFilterFromTemplateSchema — byte-size coercion (Qodo #40)", () => {
  // Qodo flagged that size / sizeInBytes were changed from z.coerce.number() to
  // coerceInt() without direct test coverage. These tests pin the new
  // behaviour: stringified integer bytes coerce, floats / non-numeric
  // rejected, native integers pass through.
  it("CreateFilterSchema.criteria.size accepts a stringified integer", () => {
    const r = CreateFilterSchema.parse({
      criteria: { size: "10485760" },
      action: {},
    });
    expect(r.criteria.size).toBe(10485760);
  });

  it("CreateFilterSchema.criteria.size accepts a native integer", () => {
    const r = CreateFilterSchema.parse({
      criteria: { size: 5242880 },
      action: {},
    });
    expect(r.criteria.size).toBe(5242880);
  });

  it("CreateFilterSchema.criteria.size rejects a float (byte counts are integers)", () => {
    expect(() =>
      CreateFilterSchema.parse({
        criteria: { size: 1024.5 },
        action: {},
      }),
    ).toThrow();
  });

  it("CreateFilterFromTemplateSchema.parameters.sizeInBytes accepts stringified int", () => {
    const r = CreateFilterFromTemplateSchema.parse({
      template: "largeEmails",
      parameters: { sizeInBytes: "5242880" },
    });
    expect(r.parameters.sizeInBytes).toBe(5242880);
  });

  it("CreateFilterFromTemplateSchema.parameters.sizeInBytes rejects a float", () => {
    expect(() =>
      CreateFilterFromTemplateSchema.parse({
        template: "largeEmails",
        parameters: { sizeInBytes: 1024.5 },
      }),
    ).toThrow();
  });

  it("CreateFilterSchema.criteria.size rejects a negative value (bytes cannot be negative)", () => {
    expect(() =>
      CreateFilterSchema.parse({
        criteria: { size: -1 },
        action: {},
      }),
    ).toThrow();
  });

  it("CreateFilterFromTemplateSchema.parameters.sizeInBytes rejects a negative value", () => {
    expect(() =>
      CreateFilterFromTemplateSchema.parse({
        template: "largeEmails",
        parameters: { sizeInBytes: -1 },
      }),
    ).toThrow();
  });
});
