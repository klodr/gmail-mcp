/**
 * Tests for email threading header fixes (issue #66)
 *
 * Verifies:
 * 1. createEmailMessage uses separate `references` field when provided
 * 2. createEmailMessage falls back to `inReplyTo` for References when no `references` field
 * 3. No References/In-Reply-To headers on new emails
 * 4. Source verification: createEmailWithNodemailer uses references field
 * 5. Source verification: handleEmailAction auto-resolves threading headers
 * 6. Source verification: read_email returns Message-ID
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createEmailMessage,
  createEmailWithNodemailer,
  pickBody,
  pickBodyAnnotated,
  HTML_FALLBACK_NOTE,
} from "./utl.js";

// Resolve src directory
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = __dirname;

// Helper: extract a header value from a raw MIME message string
function getHeader(raw: string, headerName: string): string | null {
  const regex = new RegExp(`^${headerName}:\\s*(.+)$`, "mi");
  const match = raw.match(regex);
  return match ? match[1].trim() : null;
}

describe("Email threading headers", () => {
  it("uses separate references field when provided", () => {
    const args = {
      to: ["test@example.com"],
      subject: "Re: Thread test",
      body: "Reply body",
      inReplyTo: "<msg3@example.com>",
      references: "<msg1@example.com> <msg2@example.com> <msg3@example.com>",
    };
    const raw = createEmailMessage(args);

    expect(getHeader(raw, "References")).toBe(
      "<msg1@example.com> <msg2@example.com> <msg3@example.com>",
    );
    expect(getHeader(raw, "In-Reply-To")).toBe("<msg3@example.com>");
  });

  it("falls back to inReplyTo when references is absent", () => {
    const args = {
      to: ["test@example.com"],
      subject: "Re: Fallback test",
      body: "Reply body",
      inReplyTo: "<single@example.com>",
    };
    const raw = createEmailMessage(args);

    expect(getHeader(raw, "References")).toBe("<single@example.com>");
  });

  it("has no threading headers on new emails", () => {
    const args = {
      to: ["test@example.com"],
      subject: "New email",
      body: "Fresh email body",
    };
    const raw = createEmailMessage(args);

    expect(getHeader(raw, "References")).toBeNull();
    expect(getHeader(raw, "In-Reply-To")).toBeNull();
  });
});

describe("Source verification", () => {
  it("createEmailWithNodemailer uses references field with inReplyTo fallback", () => {
    const source = fs.readFileSync(path.join(srcDir, "utl.ts"), "utf-8");
    // Guard both the fallback expression AND that the resulting
    // header value is passed through sanitizeHeaderValue — otherwise
    // a refactor that drops the sanitize call silently reopens the
    // CRLF-injection vector on the attachment path.
    expect(source).toContain("validatedArgs.references || validatedArgs.inReplyTo");
    expect(source).toMatch(
      /sanitizeHeaderValue\(\s*(?:ref|validatedArgs\.references\s*\|\|\s*validatedArgs\.inReplyTo)/,
    );
  });

  it("handleEmailAction auto-resolves threading headers", () => {
    const source = fs.readFileSync(path.join(srcDir, "index.ts"), "utf-8");
    expect(source).toContain("validatedArgs.threadId && !validatedArgs.inReplyTo");
    expect(source).toContain("gmail.users.threads.get");
    expect(source).toContain("validatedArgs.inReplyTo = lastMessageId");
    expect(source).toContain('validatedArgs.references = allMessageIds.join(" ")');
  });

  it("read_email returns Message-ID", () => {
    const source = fs.readFileSync(path.join(srcDir, "index.ts"), "utf-8");
    expect(source).toContain("message-id");
    expect(source).toContain("rfcMessageId");
    expect(source).toContain("Message-ID: ${rfcMessageId}");
  });
});

describe("createEmailMessage — content-type paths", () => {
  it("escalates to multipart/alternative when htmlBody is present with non-plain mimeType", () => {
    const raw = createEmailMessage({
      to: ["test@example.com"],
      subject: "Mixed",
      body: "plain fallback",
      htmlBody: "<p>hi</p>",
      mimeType: "text/html",
    });

    expect(raw).toContain("Content-Type: multipart/alternative");
    expect(raw).toContain("Content-Type: text/plain");
    expect(raw).toContain("Content-Type: text/html");
    expect(raw).toContain("plain fallback");
    expect(raw).toContain("<p>hi</p>");
  });

  it("emits an html-only body when mimeType is text/html without htmlBody", () => {
    // Passing htmlBody with mimeType=text/html escalates to multipart/alternative
    // (see the escalation branch in createEmailMessage). The html-only path is
    // reached when body itself is HTML and mimeType is explicitly text/html.
    const raw = createEmailMessage({
      to: ["test@example.com"],
      subject: "Html only",
      body: "<strong>body is html</strong>",
      mimeType: "text/html",
    });

    expect(raw).toContain("Content-Type: text/html; charset=UTF-8");
    expect(raw).toContain("<strong>body is html</strong>");
    expect(raw).not.toContain("multipart/");
  });
});

describe("createEmailWithNodemailer — recipient validation", () => {
  it("rejects an invalid recipient address before composing", async () => {
    await expect(
      createEmailWithNodemailer({
        to: ["not-an-email"],
        subject: "x",
        body: "x",
      }),
    ).rejects.toThrow(/Recipient email address is invalid/);
  });
});

describe("pickBody — HTML fallback heuristic (upstream GongRzhe#87)", () => {
  it("picks text when both parts exist and text is substantive", () => {
    const text =
      "Hi,\n\nThis is a real plain-text message with paragraphs and detail.\n\nBest,\nBob";
    const html = "<html><body><p>Same message, HTML wrapped.</p></body></html>";
    expect(pickBody(text, html)).toEqual({ body: text, source: "text" });
  });

  it("picks html when only html is provided", () => {
    expect(pickBody("", "<p>hello</p>")).toEqual({ body: "<p>hello</p>", source: "html" });
  });

  it("picks text when only text is provided", () => {
    expect(pickBody("hello", "")).toEqual({ body: "hello", source: "text" });
  });

  it("returns an empty-source marker when neither is provided", () => {
    expect(pickBody("", "")).toEqual({ body: "", source: "empty" });
  });

  it("falls back to html when text is a 'view in browser' placeholder stub", () => {
    const text = "View this email in your browser";
    const html =
      "<html><body>The real content of the newsletter, with full story, links, images, etc.</body></html>";
    expect(pickBody(text, html)).toEqual({ body: html, source: "html" });
  });

  it("falls back to html when text matches 'having trouble viewing' pattern", () => {
    const text = "Having trouble reading this email? Click here.";
    const html = "<div>Full body goes here</div>";
    expect(pickBody(text, html).source).toBe("html");
  });

  it("falls back to html when text is very short and html is 3× longer", () => {
    const text = "Hi there, see below.";
    const html =
      "<p>Hi there,</p><p>The actual much longer message lives here in the HTML part, with all the relevant paragraphs the sender meant to include. Plenty of words to trigger the length heuristic.</p>";
    expect(pickBody(text, html).source).toBe("html");
  });

  it("keeps text when it's short but html is not substantially longer (nothing to gain)", () => {
    const text = "Hi there!";
    const html = "<p>Hi there!</p>";
    expect(pickBody(text, html).source).toBe("text");
  });

  it("does not flag a long text containing a placeholder-like phrase as a stub", () => {
    // A text > 500 chars containing the phrase is almost certainly a
    // legitimate body referring to browser view in passing, not a stub.
    const text =
      "Hello,\n\n".padEnd(600, "x") +
      " view this email in your browser if links do not work properly.";
    const html = "<p>html body</p>";
    expect(pickBody(text, html).source).toBe("text");
  });
});

describe("pickBodyAnnotated — HTML fallback marker (Qodo #41)", () => {
  // The three reading surfaces (read_email, get_thread, get_inbox_with_threads)
  // must all prepend the same marker when pickBody falls back to the HTML
  // part, so a consumer LLM sees a consistent annotation regardless of
  // which reader returned the body.
  it("prepends HTML_FALLBACK_NOTE when source is html", () => {
    const { body, source } = pickBodyAnnotated("", "<p>html body</p>");
    expect(source).toBe("html");
    expect(body.startsWith(HTML_FALLBACK_NOTE)).toBe(true);
    expect(body.endsWith("<p>html body</p>")).toBe(true);
  });

  it("returns the plain-text body unchanged when source is text", () => {
    const { body, source } = pickBodyAnnotated("hello world", "<p>hello</p>");
    expect(source).toBe("text");
    expect(body).toBe("hello world");
    expect(body.startsWith(HTML_FALLBACK_NOTE)).toBe(false);
  });

  it("returns an empty body (no marker) when both parts are empty", () => {
    const { body, source } = pickBodyAnnotated("", "");
    expect(source).toBe("empty");
    expect(body).toBe("");
  });

  it("falls back with marker on a placeholder-stub plain-text part", () => {
    const text = "View this email in your browser";
    const html = "<p>the real content, much longer</p>".repeat(10);
    const { body, source } = pickBodyAnnotated(text, html);
    expect(source).toBe("html");
    expect(body.startsWith(HTML_FALLBACK_NOTE)).toBe(true);
  });
});
