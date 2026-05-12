import { describe, expect, it } from "vitest";
import { pullToolMeta } from "../src/tools/_shared.js";

describe("pullToolMeta", () => {
  it("returns description / scopes / annotations for a registered tool", () => {
    // `read_email` is registered in src/tools.ts with gmail.readonly scope.
    const meta = pullToolMeta("read_email");
    expect(meta.description).toBeTruthy();
    expect(Array.isArray(meta.scopes)).toBe(true);
    expect(meta.scopes).toContain("gmail.readonly");
    expect(meta.annotations).toBeDefined();
  });

  it("throws on an unknown tool name (programming error, fail loud)", () => {
    expect(() => pullToolMeta("this_tool_does_not_exist_anywhere")).toThrow(
      /Tool definition missing/,
    );
  });
});
