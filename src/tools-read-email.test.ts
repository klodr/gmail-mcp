import { describe, it, expect } from "vitest";
import { ReadEmailSchema } from "./tools.js";

// The handler itself lives inside the 1300-line switch in src/index.ts
// and isn't unit-testable without mocking googleapis. These tests pin
// the *schema* invariants (defaults, bounds, coercion) — if anyone
// quietly loosens the cap or flips the default, the schema test fails
// immediately.

describe("ReadEmailSchema — truncation knobs (upstream GongRzhe#33)", () => {
  it("defaults maxBodyLength to 104448 (102 KB — Gmail clip threshold)", () => {
    const r = ReadEmailSchema.parse({ messageId: "abc123" });
    expect(r.maxBodyLength).toBe(102 * 1024);
  });

  it("defaults format to 'full' and includeAttachments to true", () => {
    const r = ReadEmailSchema.parse({ messageId: "abc123" });
    expect(r.format).toBe("full");
    expect(r.includeAttachments).toBe(true);
  });

  it("accepts format=summary / headers_only / full", () => {
    for (const f of ["summary", "headers_only", "full"] as const) {
      expect(ReadEmailSchema.parse({ messageId: "abc", format: f }).format).toBe(f);
    }
  });

  it("rejects unknown format values", () => {
    expect(() => ReadEmailSchema.parse({ messageId: "abc", format: "brief" })).toThrow();
  });

  it("maxBodyLength=0 is allowed (caller opts out of truncation)", () => {
    const r = ReadEmailSchema.parse({ messageId: "abc", maxBodyLength: 0 });
    expect(r.maxBodyLength).toBe(0);
  });

  it("maxBodyLength coerces from string (strict-JSON MCP clients)", () => {
    const r = ReadEmailSchema.parse({ messageId: "abc", maxBodyLength: "50000" });
    expect(r.maxBodyLength).toBe(50000);
  });

  it("rejects maxBodyLength above the 1 MB ceiling", () => {
    expect(() => ReadEmailSchema.parse({ messageId: "abc", maxBodyLength: 2_000_000 })).toThrow();
  });

  it("rejects negative maxBodyLength", () => {
    expect(() => ReadEmailSchema.parse({ messageId: "abc", maxBodyLength: -1 })).toThrow();
  });

  it("rejects non-integer maxBodyLength", () => {
    expect(() => ReadEmailSchema.parse({ messageId: "abc", maxBodyLength: 1234.5 })).toThrow();
  });
});
