/**
 * Test plan for download_email tool (PR #13)
 *
 * 1. Verify download_email with each format (json, eml, txt, html)
 * 2. Verify scope filtering works (tool visible with gmail.readonly)
 * 3. Verify directory creation when savePath doesn't exist
 * 4. Verify existing tools still work after extractHeaders refactor
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  gmailMessageToJson,
  emailToTxt,
  emailToHtml,
  EXPORTED_HTML_CSP,
  BLOCK_REMOTE_CONTENT_CSP,
  ENV_EXPORT_REMOTE_IMAGES,
  remoteImagesAllowed,
  parseEmailAddress,
  parseEmailAddresses,
} from "../src/email-export.js";
import { getToolByName, DownloadEmailSchema } from "../src/tools.js";
import { hasScope } from "../src/scopes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Shared mock data
const mockHeaders = [
  { name: "From", value: "Alice <alice@example.com>" },
  { name: "To", value: "Bob <bob@example.com>, Carol <carol@example.com>" },
  { name: "Cc", value: "dave@example.com" },
  { name: "Subject", value: "Test Email Subject" },
  { name: "Date", value: "Fri, 13 Mar 2026 10:00:00 +0000" },
  { name: "Message-ID", value: "<msg123@example.com>" },
  { name: "In-Reply-To", value: "<prev@example.com>" },
  { name: "References", value: "<orig@example.com> <prev@example.com>" },
];

const mockMessage = {
  id: "msg_abc123",
  threadId: "thread_xyz",
  labelIds: ["INBOX", "UNREAD"],
  snippet: "This is a test email...",
  payload: { headers: mockHeaders },
};

const mockContent = {
  text: "Hello, this is the plain text body.",
  html: "<html><body><p>Hello, this is the <b>HTML</b> body.</p></body></html>",
};

const mockAttachments = [
  { id: "att1", filename: "report.pdf", mimeType: "application/pdf", size: 102400 },
  { id: "att2", filename: "photo.jpg", mimeType: "image/jpeg", size: 204800 },
];

// ─────────────────────────────────────────────
// 1. Format tests (json, txt, html)
// ─────────────────────────────────────────────
describe("download_email formats", () => {
  describe("JSON format", () => {
    it("produces valid structured JSON with all fields", () => {
      const json = gmailMessageToJson(mockMessage, mockContent, mockAttachments);

      expect(json.messageId).toBe("msg_abc123");
      expect(json.threadId).toBe("thread_xyz");
      expect(json.subject).toBe("Test Email Subject");
      expect(json.from.email).toBe("alice@example.com");
      expect(json.from.name).toBe("Alice");
      expect(json.to).toHaveLength(2);
      expect(json.to[0].email).toBe("bob@example.com");
      expect(json.cc).toHaveLength(1);
      expect(json.cc[0].email).toBe("dave@example.com");
      expect(json.labels).toEqual(["INBOX", "UNREAD"]);
      expect(json.snippet).toBe("This is a test email...");
      expect(json.body.plain).toBe(mockContent.text);
      expect(json.body.html).toBe(mockContent.html);
      expect(json.attachments).toHaveLength(2);
      expect(json.attachments[0].filename).toBe("report.pdf");
      expect(json.headers["Message-ID"]).toBe("<msg123@example.com>");
      expect(json.headers["In-Reply-To"]).toBe("<prev@example.com>");
      expect(json.headers["References"]).toBe("<orig@example.com> <prev@example.com>");
    });

    it("converts date to ISO format", () => {
      const json = gmailMessageToJson(mockMessage, mockContent, []);
      expect(json.date).toBe("2026-03-13T10:00:00.000Z");
    });

    it("handles missing headers gracefully", () => {
      const emptyMessage = { id: "x", threadId: "t", payload: { headers: [] } };
      const json = gmailMessageToJson(emptyMessage, { text: "", html: "" }, []);
      expect(json.subject).toBe("");
      expect(json.from.email).toBe("");
      expect(json.to).toEqual([]);
    });

    it("serializes to valid JSON string", () => {
      const json = gmailMessageToJson(mockMessage, mockContent, mockAttachments);
      const str = JSON.stringify(json, null, 2);
      expect(() => JSON.parse(str)).not.toThrow();
    });
  });

  describe("TXT format", () => {
    it("produces headers and body in plain text", () => {
      const txt = emailToTxt(mockMessage, mockContent, mockAttachments);

      expect(txt).toContain("From: Alice <alice@example.com>");
      expect(txt).toContain("To: Bob <bob@example.com>, Carol <carol@example.com>");
      expect(txt).toContain("CC: dave@example.com");
      expect(txt).toContain("Subject: Test Email Subject");
      expect(txt).toContain("Date: Fri, 13 Mar 2026 10:00:00 +0000");
      expect(txt).toContain("Hello, this is the plain text body.");
      expect(txt).toContain("Attachments: report.pdf, photo.jpg");
    });

    it("omits CC line when empty", () => {
      const noCcHeaders = mockHeaders.filter((h) => h.name !== "Cc");
      const msg = { ...mockMessage, payload: { headers: noCcHeaders } };
      const txt = emailToTxt(msg, mockContent, []);
      expect(txt).not.toContain("CC:");
    });

    it("shows placeholder when no text content", () => {
      const txt = emailToTxt(mockMessage, { text: "", html: "<p>HTML only</p>" }, []);
      expect(txt).toContain("[No plain text content]");
    });

    it("omits attachment section when no attachments", () => {
      const txt = emailToTxt(mockMessage, mockContent, []);
      expect(txt).not.toContain("Attachments:");
    });
  });

  describe("HTML format", () => {
    // Default policy: the base CSP plus the remote-image block.
    const DEFAULT_POLICY = `${EXPORTED_HTML_CSP}; ${BLOCK_REMOTE_CONTENT_CSP}`;

    it("returns raw HTML content", () => {
      const html = emailToHtml(mockContent);
      expect(html).toContain("<b>HTML</b>");
      expect(html).toContain(`content="${DEFAULT_POLICY}"`);
    });

    it("blocks remote images by default and lets them through on request", () => {
      const html = '<p>x</p><img src="https://tracker.example.invalid/p.gif">';
      expect(emailToHtml({ text: "", html })).toContain("img-src data: cid:");
      // A tracking stylesheet is blocked too, inline <style> is not.
      const styled = emailToHtml({
        text: "",
        html: "<style>@import url(https://tracker.example.invalid/open.css); p{color:red}</style><p>x</p>",
      });
      expect(styled).toContain("style-src 'unsafe-inline' data:");
      expect(styled).toContain("<style>@import");
      const allowed = emailToHtml({ text: "", html }, true);
      expect(allowed).toContain(`content="${EXPORTED_HTML_CSP}"`);
      expect(allowed).not.toContain("img-src");
    });

    it("reads the remote-image default from GMAIL_MCP_EXPORT_REMOTE_IMAGES", () => {
      const saved = process.env[ENV_EXPORT_REMOTE_IMAGES];
      try {
        delete process.env[ENV_EXPORT_REMOTE_IMAGES];
        expect(remoteImagesAllowed()).toBe(false);
        process.env[ENV_EXPORT_REMOTE_IMAGES] = "true";
        expect(remoteImagesAllowed()).toBe(true);
        // An explicit per-call value wins over the environment.
        expect(remoteImagesAllowed(false)).toBe(false);
      } finally {
        if (saved === undefined) delete process.env[ENV_EXPORT_REMOTE_IMAGES];
        else process.env[ENV_EXPORT_REMOTE_IMAGES] = saved;
      }
    });

    it("throws when no HTML content available", () => {
      expect(() => emailToHtml({ text: "plain only", html: "" })).toThrow(
        "This email has no HTML content",
      );
    });

    const CSP_TAG = 'http-equiv="Content-Security-Policy"';

    it("puts the CSP first in the real <head>, before any sender markup", () => {
      const out = emailToHtml({
        text: "",
        html: "<html><head><title>t</title><script>x()</script></head><body><header>h</header></body></html>",
      });
      expect(out.startsWith(`<html><head><meta charset="utf-8"><meta ${CSP_TAG}`)).toBe(true);
      expect(out.indexOf(CSP_TAG)).toBeLessThan(out.indexOf("<script>"));
      expect(out).toContain("<header>h</header>");
      expect(out.match(/Content-Security-Policy/g)).toHaveLength(1);
    });

    it("is not fooled by a <head> hidden in a comment", () => {
      const out = emailToHtml({
        text: "",
        html: "<!-- <head> --><html><head><script>x()</script></head><body>b</body></html>",
      });
      // The CSP precedes the comment, so it sits in the head the browser builds.
      expect(out.indexOf(CSP_TAG)).toBeLessThan(out.indexOf("<!--"));
    });

    it("keeps a leading doctype first so the rendering mode does not change", () => {
      const out = emailToHtml({ text: "", html: "<!DOCTYPE html>\n<html><body>x</body></html>" });
      expect(out.startsWith("<!DOCTYPE html><html><head>")).toBe(true);
      expect(out.match(/<!DOCTYPE/gi)).toHaveLength(1);
    });

    it("wraps a bare fragment without adding a doctype (quirks mode kept)", () => {
      const out = emailToHtml({ text: "", html: "<p>Bonjour</p>" });
      expect(out.startsWith("<html><head>")).toBe(true);
      expect(out).toContain(`content="${DEFAULT_POLICY}"`);
      expect(out).toContain("<body><p>Bonjour</p></body>");
    });

    it("blocks frames, whose document would run its own scripts", () => {
      expect(EXPORTED_HTML_CSP).toContain("frame-src 'none'");
      const out = emailToHtml({
        text: "",
        html: '<p>x</p><iframe src="frame.html"></iframe>',
      });
      expect(out.indexOf(`content="${DEFAULT_POLICY}"`)).toBeLessThan(out.indexOf("<iframe"));
    });

    it("keeps styles allowed and leaves images to the separate remote-image switch", () => {
      expect(EXPORTED_HTML_CSP).not.toMatch(/default-src|img-src|style-src/);
      expect(EXPORTED_HTML_CSP).toContain("script-src 'none'");
      expect(BLOCK_REMOTE_CONTENT_CSP).toContain("img-src data: cid:");
      // Inline styles keep the rendering; remote stylesheets / fonts do not load.
      expect(BLOCK_REMOTE_CONTENT_CSP).toContain("style-src 'unsafe-inline' data:");
      expect(BLOCK_REMOTE_CONTENT_CSP).toContain("font-src data:");
      expect(BLOCK_REMOTE_CONTENT_CSP).toContain("media-src data:");
    });

    it("blocks fetches without a directive of their own (manifest, prefetch) through default-src", () => {
      const html =
        '<link rel="manifest" href="https://tracker.example.invalid/m.json">' +
        '<link rel="prefetch" href="https://tracker.example.invalid/p">';
      const out = emailToHtml({ text: "", html });
      expect(BLOCK_REMOTE_CONTENT_CSP).toContain("default-src 'none'");
      expect(out.indexOf("default-src 'none'")).toBeLessThan(out.indexOf('rel="manifest"'));
      // Opting in to remote content lifts the fallback too.
      expect(emailToHtml({ text: "", html }, true)).not.toContain("default-src");
    });

    it.each([
      '<meta http-equiv="refresh" content="0;url=https://phish.example.invalid/">',
      "<META HTTP-EQUIV=Refresh CONTENT=0;URL=https://phish.example.invalid/>",
      "<meta/http-equiv='refresh' content='0;url=https://phish.example.invalid/'>",
      '<meta content="0;url=https://phish.example.invalid/?a>b" http-equiv="refresh">',
    ])("neutralizes a sender's meta refresh, remote content blocked or not: %s", (tag) => {
      for (const allow of [false, true]) {
        const out = emailToHtml({ text: "", html: `<p>x</p>${tag}` }, allow);
        // Only the exporter's own CSP <meta> keeps an http-equiv attribute.
        expect(out.match(/(?<![\w-])http-equiv/gi)).toHaveLength(1);
        expect(out).toContain("data-removed-http-equiv");
        expect(out).toContain("<p>x</p>");
      }
    });
  });
});

// ─────────────────────────────────────────────
// 2. Scope filtering
// ─────────────────────────────────────────────
describe("download_email scope filtering", () => {
  it("is registered in toolDefinitions", () => {
    const tool = getToolByName("download_email");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("download_email");
  });

  it("is visible with gmail.readonly scope", () => {
    const tool = getToolByName("download_email")!;
    expect(hasScope(["gmail.readonly"], tool.scopes)).toBe(true);
  });

  it("is visible with gmail.modify scope", () => {
    const tool = getToolByName("download_email")!;
    expect(hasScope(["gmail.modify"], tool.scopes)).toBe(true);
  });

  it("is NOT visible with only gmail.send scope", () => {
    const tool = getToolByName("download_email")!;
    expect(hasScope(["gmail.send"], tool.scopes)).toBe(false);
  });

  it("is NOT visible with only gmail.compose scope", () => {
    const tool = getToolByName("download_email")!;
    expect(hasScope(["gmail.compose"], tool.scopes)).toBe(false);
  });

  it("works with full URL scope format", () => {
    const tool = getToolByName("download_email")!;
    expect(hasScope(["https://www.googleapis.com/auth/gmail.readonly"], tool.scopes)).toBe(true);
  });
});

// ─────────────────────────────────────────────
// 3. Schema validation
// ─────────────────────────────────────────────
describe("DownloadEmailSchema", () => {
  it("accepts valid input with all fields", () => {
    const result = DownloadEmailSchema.parse({
      messageId: "msg123",
      savePath: "/tmp/emails",
      format: "json",
    });
    expect(result.messageId).toBe("msg123");
    expect(result.savePath).toBe("/tmp/emails");
    expect(result.format).toBe("json");
  });

  it("defaults format to json", () => {
    const result = DownloadEmailSchema.parse({
      messageId: "msg123",
      savePath: "/tmp/emails",
    });
    expect(result.format).toBe("json");
  });

  it("accepts all valid formats", () => {
    for (const fmt of ["json", "eml", "txt", "html"]) {
      const result = DownloadEmailSchema.parse({
        messageId: "msg123",
        savePath: "/tmp",
        format: fmt,
      });
      expect(result.format).toBe(fmt);
    }
  });

  it("rejects invalid format", () => {
    expect(() =>
      DownloadEmailSchema.parse({
        messageId: "msg123",
        savePath: "/tmp",
        format: "xml",
      }),
    ).toThrow();
  });

  it("requires messageId", () => {
    expect(() => DownloadEmailSchema.parse({ savePath: "/tmp" })).toThrow();
  });

  it("requires savePath", () => {
    expect(() => DownloadEmailSchema.parse({ messageId: "msg123" })).toThrow();
  });
});

// ─────────────────────────────────────────────
// 4. extractHeaders refactor verification
// ─────────────────────────────────────────────
describe("extractHeaders refactor - source verification", () => {
  // `extractHeaders` was moved from src/index.ts into src/gmail-headers.ts
  // (PR #1) and the read_email / download_email handlers were extracted
  // from the legacy dispatcher into src/tools/messages.ts +
  // src/tools/downloads.ts (PR #5 + PR #6); the legacy dispatcher itself
  // was deleted by PR #7. The grep targets follow the moves.
  const srcDir = path.resolve(__dirname, "..", "src");
  const headersSource = fs.readFileSync(path.join(srcDir, "gmail-headers.ts"), "utf-8");
  const messagesSource = fs.readFileSync(path.join(srcDir, "tools", "messages.ts"), "utf-8");
  const downloadsSource = fs.readFileSync(path.join(srcDir, "tools", "downloads.ts"), "utf-8");

  it("extractHeaders function exists and returns rfcMessageId", () => {
    expect(headersSource).toContain("function extractHeaders");
    expect(headersSource).toContain("rfcMessageId");
    expect(headersSource).toContain('getHeader("message-id")');
  });

  it("read_email uses extractHeaders (not inline header extraction)", () => {
    expect(messagesSource).toContain(
      "const { subject, from, to, cc, bcc, date, rfcMessageId } = extractHeaders(",
    );
  });

  it("download_email uses extractHeaders", () => {
    expect(downloadsSource).toContain("const { subject, from, date } = extractHeaders(");
  });

  it("read_email still outputs Message-ID in response", () => {
    expect(messagesSource).toContain("Message-ID: ${rfcMessageId}");
  });
});

// ─────────────────────────────────────────────
// Email address parsing (email-export.ts)
// ─────────────────────────────────────────────
describe("email-export parseEmailAddress", () => {
  it('parses "Name" <email> format', () => {
    const result = parseEmailAddress('"John Doe" <john@example.com>');
    expect(result.name).toBe("John Doe");
    expect(result.email).toBe("john@example.com");
  });

  it("parses Name <email> without quotes", () => {
    const result = parseEmailAddress("Alice <alice@example.com>");
    expect(result.name).toBe("Alice");
    expect(result.email).toBe("alice@example.com");
  });

  it("parses bare email", () => {
    const result = parseEmailAddress("user@example.com");
    expect(result.name).toBe("");
    expect(result.email).toBe("user@example.com");
  });

  it("handles empty string", () => {
    const result = parseEmailAddress("");
    expect(result.email).toBe("");
  });
});

describe("email-export parseEmailAddresses", () => {
  it("splits comma-separated addresses", () => {
    const results = parseEmailAddresses("a@test.com, b@test.com");
    expect(results).toHaveLength(2);
    expect(results[0].email).toBe("a@test.com");
    expect(results[1].email).toBe("b@test.com");
  });

  it("handles undefined", () => {
    expect(parseEmailAddresses(undefined)).toEqual([]);
  });
});
