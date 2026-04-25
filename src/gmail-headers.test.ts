import { describe, it, expect } from "vitest";
import type { gmail_v1 } from "googleapis";
import { makeHeaderGetter, extractHeaders } from "./gmail-headers.js";

const headers = (pairs: Array<[string, string]>): gmail_v1.Schema$MessagePartHeader[] =>
  pairs.map(([name, value]) => ({ name, value }));

describe("makeHeaderGetter", () => {
  it("returns the value for a header by exact-case name", () => {
    const get = makeHeaderGetter(headers([["Subject", "hello"]]));
    expect(get("Subject")).toBe("hello");
  });

  it("matches case-insensitively (Gmail varies between 'From' and 'from')", () => {
    const get = makeHeaderGetter(headers([["From", "alice@example.com"]]));
    expect(get("from")).toBe("alice@example.com");
    expect(get("FROM")).toBe("alice@example.com");
    expect(get("From")).toBe("alice@example.com");
  });

  it("returns the empty string for a missing header", () => {
    const get = makeHeaderGetter(headers([["From", "alice@example.com"]]));
    expect(get("Subject")).toBe("");
  });

  it("returns the empty string when the headers array is undefined", () => {
    const get = makeHeaderGetter(undefined);
    expect(get("From")).toBe("");
    expect(get("anything")).toBe("");
  });

  it("handles a header whose value is missing or empty", () => {
    const get = makeHeaderGetter([{ name: "X-Bizarre" }]);
    expect(get("X-Bizarre")).toBe("");
  });
});

describe("extractHeaders", () => {
  it("returns the canonical 5-field shape from a fully-populated payload", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      headers: headers([
        ["Subject", "Re: project update"],
        ["From", "Alice <alice@example.com>"],
        ["To", "bob@example.com"],
        ["Date", "Mon, 25 Apr 2026 10:00:00 +0000"],
        ["Message-ID", "<abc-123@mail.example.com>"],
      ]),
    };
    expect(extractHeaders(payload)).toEqual({
      subject: "Re: project update",
      from: "Alice <alice@example.com>",
      to: "bob@example.com",
      date: "Mon, 25 Apr 2026 10:00:00 +0000",
      rfcMessageId: "<abc-123@mail.example.com>",
    });
  });

  it("substitutes empty strings for missing headers (no null leak)", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      headers: headers([["Subject", "only subject"]]),
    };
    expect(extractHeaders(payload)).toEqual({
      subject: "only subject",
      from: "",
      to: "",
      date: "",
      rfcMessageId: "",
    });
  });

  it("returns five empty strings when the payload is undefined", () => {
    expect(extractHeaders(undefined)).toEqual({
      subject: "",
      from: "",
      to: "",
      date: "",
      rfcMessageId: "",
    });
  });

  it("matches Message-ID case-insensitively (gmail returns 'Message-Id' some days, 'Message-ID' others)", () => {
    const lower: gmail_v1.Schema$MessagePart = {
      headers: headers([["message-id", "<lower@x>"]]),
    };
    const mixed: gmail_v1.Schema$MessagePart = {
      headers: headers([["Message-Id", "<mixed@x>"]]),
    };
    const upper: gmail_v1.Schema$MessagePart = {
      headers: headers([["MESSAGE-ID", "<upper@x>"]]),
    };
    expect(extractHeaders(lower).rfcMessageId).toBe("<lower@x>");
    expect(extractHeaders(mixed).rfcMessageId).toBe("<mixed@x>");
    expect(extractHeaders(upper).rfcMessageId).toBe("<upper@x>");
  });
});
