import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { toolDefinitions } from "../src/tools.js";
import {
  _DEFAULT_BUCKET_LIMITS,
  _TOOL_BUCKET,
  LOCAL_WRITE_TOOLS,
  WRITE_TOOLS,
} from "../src/rate-limit.js";

// The dry-run gate and the rate limiter both key off `WRITE_TOOLS`.
// These checks fail as soon as a tool is added (or re-annotated)
// without deciding which side of the write/read line it sits on.
describe("write-tool coherence across tool definitions, rate limit and dry-run", () => {
  const names = toolDefinitions.map((t) => t.name);

  it("every non-read-only Gmail tool is rate-limited (and thus dry-run'd)", () => {
    const missing = toolDefinitions
      .filter((t) => t.annotations.readOnlyHint !== true && !LOCAL_WRITE_TOOLS.has(t.name))
      .map((t) => t.name)
      .filter((name) => !(name in _TOOL_BUCKET));
    expect(missing).toEqual([]);
  });

  it("no read-only tool and no local-only download tool is rate-limited", () => {
    const unexpected = toolDefinitions
      .filter((t) => t.annotations.readOnlyHint === true || LOCAL_WRITE_TOOLS.has(t.name))
      .map((t) => t.name)
      .filter((name) => name in _TOOL_BUCKET);
    expect(unexpected).toEqual([]);
  });

  it("LOCAL_WRITE_TOOLS are declared as writes, but not destructive", () => {
    for (const name of LOCAL_WRITE_TOOLS) {
      const tool = toolDefinitions.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.annotations.readOnlyHint, name).toBe(false);
      expect(tool!.annotations.destructiveHint, name).toBe(false);
    }
  });

  it("every bucketed tool exists and every bucket has default limits", () => {
    for (const [name, bucket] of Object.entries(_TOOL_BUCKET)) {
      expect(names, name).toContain(name);
      expect(_DEFAULT_BUCKET_LIMITS[bucket], bucket).toBeDefined();
    }
  });

  it("WRITE_TOOLS is exactly the set of rate-limited tools", () => {
    expect([...WRITE_TOOLS].sort()).toEqual(Object.keys(_TOOL_BUCKET).sort());
  });

  it("outbound tools share the 'send' bucket", () => {
    for (const name of [
      "send_email",
      "reply_all",
      "reply_to_email",
      "forward_email",
      "send_draft",
    ]) {
      expect(_TOOL_BUCKET[name], name).toBe("send");
    }
  });

  it("the README dry-run list matches WRITE_TOOLS", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const row = readme.split("\n").find((line) => line.startsWith("| Dry-run |"));
    expect(row).toBeDefined();
    const listed = [...row!.matchAll(/`([a-z_]+)`/g)]
      .map((m) => m[1]!)
      .filter((name) => names.includes(name));
    expect([...new Set(listed)].sort()).toEqual([...WRITE_TOOLS].sort());
  });
});
