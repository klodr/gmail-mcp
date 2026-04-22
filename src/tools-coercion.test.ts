import { describe, it, expect } from "vitest";
import {
  SendEmailSchema,
  SearchEmailsSchema,
  BatchModifyEmailsSchema,
  BatchDeleteEmailsSchema,
  ModifyEmailSchema,
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
