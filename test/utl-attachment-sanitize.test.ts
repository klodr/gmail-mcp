import { describe, expect, it } from "vitest";
import { sanitizeAttachmentFilename, toSafeAttachmentFilename } from "../src/utl.js";

describe("sanitizeAttachmentFilename", () => {
  it("passes through a safe filename unchanged", () => {
    expect(sanitizeAttachmentFilename("report.pdf")).toBe("report.pdf");
    expect(sanitizeAttachmentFilename("Q4 Summary (final) - v2.docx")).toBe(
      "Q4 Summary (final) - v2.docx",
    );
  });

  it("replaces POSIX path separators with underscore (after leading-dot strip)", () => {
    expect(sanitizeAttachmentFilename("../etc/passwd")).toBe("_etc_passwd");
  });

  it("replaces Windows backslashes (which path.basename would leave)", () => {
    // Leading `..` stripped first, then `\` → `_`; the `..` after the
    // first backslash keeps its dots because they are no longer leading.
    expect(sanitizeAttachmentFilename("..\\..\\etc\\passwd")).toBe("_.._etc_passwd");
  });

  it("strips NUL bytes and control chars", () => {
    const hostile = "evil\u0000name\u001fhere";
    expect(sanitizeAttachmentFilename(hostile)).toBe("evil_name_here");
  });

  it("strips DEL and C1 control chars", () => {
    const hostile = "a\u007fb\u0085c";
    expect(sanitizeAttachmentFilename(hostile)).toBe("a_b_c");
  });

  it("replaces Windows-reserved chars", () => {
    expect(sanitizeAttachmentFilename('name:*?"<>|.txt')).toBe("name_______.txt");
  });

  it("strips leading dots so the result cannot become '.', '..', '...'", () => {
    expect(sanitizeAttachmentFilename(".")).toBe("attachment");
    expect(sanitizeAttachmentFilename("..")).toBe("attachment");
    expect(sanitizeAttachmentFilename("...")).toBe("attachment");
    expect(sanitizeAttachmentFilename("...hidden.txt")).toBe("hidden.txt");
  });

  it("falls back to 'attachment' when the input is empty or all-separator", () => {
    expect(sanitizeAttachmentFilename("")).toBe("attachment");
    expect(sanitizeAttachmentFilename("///")).toBe("attachment");
    expect(sanitizeAttachmentFilename("\\\\\\")).toBe("attachment");
  });

  it("is idempotent — second pass produces the same string", () => {
    const once = sanitizeAttachmentFilename("..\\a/b:c*?.txt");
    const twice = sanitizeAttachmentFilename(once);
    expect(twice).toBe(once);
  });
});

describe("toSafeAttachmentFilename", () => {
  it("keeps a safe original filename unchanged (spaces and accents included)", () => {
    expect(toSafeAttachmentFilename("world elite.pdf", "fallback.bin")).toBe("world elite.pdf");
    expect(toSafeAttachmentFilename("résumé.pdf", "fallback.bin")).toBe("résumé.pdf");
  });

  it("sanitizes a hostile name into a leaf that stays inside the jail", () => {
    expect(toSafeAttachmentFilename("../../etc/passwd", "fallback.bin")).toBe("_.._etc_passwd");
    expect(toSafeAttachmentFilename("..\\..\\evil.exe", "fallback.bin")).toBe("_.._evil.exe");
  });

  it("falls back when the MIME part carries no filename", () => {
    expect(toSafeAttachmentFilename("", "attachment-3")).toBe("attachment-3");
    expect(toSafeAttachmentFilename(undefined, "attachment-3")).toBe("attachment-3");
    expect(toSafeAttachmentFilename(null, "attachment-3")).toBe("attachment-3");
  });

  it("runs the fallback through the same sanitizer", () => {
    expect(toSafeAttachmentFilename("", "../x/y.zip")).toBe("_x_y.zip");
  });
});
