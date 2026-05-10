/**
 * MIME-tree walker depth-cap tests.
 *
 * The walkers in `mime-walkers.ts` are bounded by `MAX_MIME_DEPTH` to
 * defend against pathologically nested attacker-crafted messages.
 * These tests build a synthetic MIME tree of depth N+, run the walker,
 * and assert:
 *  - the walker returns without throwing (no stack overflow),
 *  - the walker emits a structured `mime_depth_exceeded` warning to
 *    stderr at the expected walker name,
 *  - parts beyond the cap are dropped (not silently mixed in).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { gmail_v1 as gmail_v1_types } from "googleapis";
import {
  MAX_MIME_DEPTH,
  collectAttachmentsForThread,
  extractAttachments,
  extractEmailContent,
} from "./mime-walkers.js";

type GmailMessagePart = gmail_v1_types.Schema$MessagePart;

/**
 * Build a left-leaning MIME tree where each level has a single child
 * with an attachment + a text/plain body data field. `levels` is the
 * total depth (root = 1).
 */
function buildLinearTree(levels: number, prefix = "lvl"): GmailMessagePart {
  const root: GmailMessagePart = {
    mimeType: "text/plain",
    body: { data: Buffer.from(`${prefix}-0`).toString("base64") },
  };
  let cur: GmailMessagePart = root;
  for (let i = 1; i < levels; i++) {
    const child: GmailMessagePart = {
      mimeType: "text/plain",
      body: {
        data: Buffer.from(`${prefix}-${i}`).toString("base64"),
        attachmentId: `att-${i}`,
        size: 10,
      },
      filename: `file-${i}.bin`,
    };
    cur.parts = [child];
    cur = child;
  }
  return root;
}

describe("MAX_MIME_DEPTH", () => {
  it("is exactly 32 (matches security review LOW recommendation)", () => {
    expect(MAX_MIME_DEPTH).toBe(32);
  });
});

describe("extractEmailContent depth cap", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  it("walks a tree up to MAX_MIME_DEPTH without warning", () => {
    const tree = buildLinearTree(MAX_MIME_DEPTH); // depth 0..31 (≤ cap)
    const out = extractEmailContent(tree);
    expect(out.text.length).toBeGreaterThan(0);
    // Must not have logged a depth-exceeded warning at or below cap
    const calls = errSpy.mock.calls.flat().join(" ");
    expect(calls).not.toContain("mime_depth_exceeded");
  });

  it("rejects parts beyond MAX_MIME_DEPTH with a structured warning", () => {
    const tree = buildLinearTree(MAX_MIME_DEPTH + 8);
    const out = extractEmailContent(tree);
    // Walker returned cleanly (no throw, no overflow) but the deep
    // tail was dropped; the shallow part data is still present.
    expect(out.text).toContain("lvl-0");
    // Structured warning observed
    const warnings = errSpy.mock.calls
      .flat()
      .filter((c): c is string => typeof c === "string")
      .filter((c) => c.includes("mime_depth_exceeded"));
    expect(warnings.length).toBeGreaterThan(0);
    const parsed = JSON.parse(warnings[0]) as Record<string, unknown>;
    expect(parsed.event).toBe("mime_depth_exceeded");
    expect(parsed.walker).toBe("extractEmailContent");
    expect(parsed.max).toBe(MAX_MIME_DEPTH);
  });

  it("survives an extremely deep tree (no stack overflow)", () => {
    // 5000 nested parts would blow V8 stack without the cap. The cap
    // bounds recursion at MAX_MIME_DEPTH, so this returns cleanly.
    const tree = buildLinearTree(5_000);
    expect(() => extractEmailContent(tree)).not.toThrow();
  });
});

describe("extractAttachments depth cap", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  it("walks a tree up to MAX_MIME_DEPTH without warning", () => {
    const tree = buildLinearTree(MAX_MIME_DEPTH);
    const atts = extractAttachments(tree);
    // depth 1..31 each carry an attachment; depth 0 (root) doesn't
    expect(atts.length).toBe(MAX_MIME_DEPTH - 1);
    const calls = errSpy.mock.calls.flat().join(" ");
    expect(calls).not.toContain("mime_depth_exceeded");
  });

  it("rejects parts beyond MAX_MIME_DEPTH with a structured warning", () => {
    const tree = buildLinearTree(MAX_MIME_DEPTH + 8);
    extractAttachments(tree);
    const warnings = errSpy.mock.calls
      .flat()
      .filter((c): c is string => typeof c === "string")
      .filter((c) => c.includes("mime_depth_exceeded"));
    expect(warnings.length).toBeGreaterThan(0);
    const parsed = JSON.parse(warnings[0]) as Record<string, unknown>;
    expect(parsed.walker).toBe("extractAttachments");
  });

  it("survives an extremely deep tree (no stack overflow)", () => {
    const tree = buildLinearTree(5_000);
    expect(() => extractAttachments(tree)).not.toThrow();
  });
});

describe("collectAttachmentsForThread depth cap", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  it("uses the caller-supplied walker label in the warning payload", () => {
    const tree = buildLinearTree(MAX_MIME_DEPTH + 8);
    collectAttachmentsForThread(tree, "get_thread.processAttachmentParts");
    const warnings = errSpy.mock.calls
      .flat()
      .filter((c): c is string => typeof c === "string")
      .filter((c) => c.includes("mime_depth_exceeded"));
    expect(warnings.length).toBeGreaterThan(0);
    const parsed = JSON.parse(warnings[0]) as Record<string, unknown>;
    expect(parsed.walker).toBe("get_thread.processAttachmentParts");
  });

  it("survives an extremely deep tree (no stack overflow)", () => {
    const tree = buildLinearTree(5_000);
    expect(() =>
      collectAttachmentsForThread(tree, "list_inbox_threads.processAttachmentParts"),
    ).not.toThrow();
  });
});

describe("extractEmailContent — text/html branch + ignored mimeTypes", () => {
  it("decodes a top-level text/html body", () => {
    // Hits the `else if (messagePart.mimeType === 'text/html')` arm.
    const part = {
      mimeType: "text/html",
      body: { data: Buffer.from("<p>hello</p>", "utf8").toString("base64") },
    };
    const out = extractEmailContent(part);
    expect(out.html).toBe("<p>hello</p>");
    expect(out.text).toBe("");
  });

  it("returns empty content when the mimeType is neither text/plain nor text/html", () => {
    // Both `if` arms fall through silently — the body's bytes get
    // decoded but neither textContent nor htmlContent collects them.
    const part = {
      mimeType: "application/octet-stream",
      body: { data: Buffer.from("ignored", "utf8").toString("base64") },
    };
    const out = extractEmailContent(part);
    expect(out.text).toBe("");
    expect(out.html).toBe("");
  });

  it("returns empty content when the body has no data field", () => {
    // Skips the entire `if (messagePart.body && messagePart.body.data)`
    // block via the right-hand falsy.
    const out = extractEmailContent({ mimeType: "text/plain", body: {} });
    expect(out.text).toBe("");
    expect(out.html).toBe("");
  });

  it("aggregates text + html from nested parts (depth-1 recursion)", () => {
    const root = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: Buffer.from("PLAIN", "utf8").toString("base64") } },
        {
          mimeType: "text/html",
          body: { data: Buffer.from("<b>HTML</b>", "utf8").toString("base64") },
        },
      ],
    };
    const out = extractEmailContent(root);
    expect(out.text).toBe("PLAIN");
    expect(out.html).toBe("<b>HTML</b>");
  });
});

describe("extractAttachments — fallback defaults (filename / mimeType / size)", () => {
  it("uses 'attachment-{id}' when filename is missing", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [{ body: { attachmentId: "att-X", size: 1024 } }],
    };
    const out = extractAttachments(payload);
    expect(out).toHaveLength(1);
    expect(out[0]?.filename).toBe("attachment-att-X");
    expect(out[0]?.mimeType).toBe("application/octet-stream");
    expect(out[0]?.size).toBe(1024);
  });

  it("uses size=0 when the body's size field is missing", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          filename: "doc.pdf",
          mimeType: "application/pdf",
          body: { attachmentId: "att-Y" },
        },
      ],
    };
    const out = extractAttachments(payload);
    expect(out[0]?.size).toBe(0);
  });

  it("returns [] when the payload has no attachment-bearing parts", () => {
    expect(extractAttachments({ mimeType: "text/plain", body: { data: "abc" } })).toEqual([]);
  });
});

describe("collectAttachmentsForThread — fallback defaults (parallels extractAttachments)", () => {
  it("uses 'attachment-{id}' / application/octet-stream / size=0 fallbacks", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [{ body: { attachmentId: "att-Z" } }],
    };
    const out = collectAttachmentsForThread(payload, "test.walker");
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      id: "att-Z",
      filename: "attachment-att-Z",
      mimeType: "application/octet-stream",
      size: 0,
    });
  });

  it("preserves explicit filename/mimeType/size when provided", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          filename: "report.csv",
          mimeType: "text/csv",
          body: { attachmentId: "att-K", size: 2048 },
        },
      ],
    };
    const out = collectAttachmentsForThread(payload, "test.walker");
    expect(out[0]).toEqual({
      id: "att-K",
      filename: "report.csv",
      mimeType: "text/csv",
      size: 2048,
    });
  });
});
