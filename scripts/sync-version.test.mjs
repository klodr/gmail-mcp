// Unit tests for `scripts/sync-version.mjs`. Drive `syncVersion()`
// against a tempdir-rooted fixture (package.json + server.json +
// src/server.ts) so the real repo files are never touched.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncVersion } from "./sync-version.mjs";

let scratch;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "sync-version-test-"));
  mkdirSync(join(scratch, "src"), { recursive: true });
});

afterEach(() => {
  // Guard against `mkdtempSync` failing in beforeEach: if scratch
  // is still undefined, calling `rmSync(undefined, ...)` throws
  // TypeError (force: true covers ENOENT, not invalid path types)
  // and that throw masks the original setup failure that vitest
  // would otherwise surface to the test report.
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/**
 * Hydrate a minimal repo-shape fixture under `scratch`.
 * Returns the version string written to package.json so the test
 * can assert the propagation downstream.
 */
function writeFixture({
  pkgVersion = "9.9.9",
  pkgName = "@klodr/gmail-mcp",
  serverPackages = [{ identifier: "@klodr/gmail-mcp", version: "0.0.0" }],
  tsContent = 'export const VERSION = "0.0.0";\n',
} = {}) {
  writeFileSync(
    join(scratch, "package.json"),
    JSON.stringify({ name: pkgName, version: pkgVersion }, null, 2),
  );
  writeFileSync(
    join(scratch, "server.json"),
    JSON.stringify({ version: "0.0.0", packages: serverPackages }, null, 2),
  );
  writeFileSync(join(scratch, "src", "server.ts"), tsContent);
  // Honour the docblock contract — return the version we wrote so
  // tests can assert propagation downstream without re-deriving it.
  return pkgVersion;
}

describe("syncVersion", () => {
  it("propagates package.json#version to server.json (top-level + matching package)", () => {
    writeFixture({ pkgVersion: "1.2.3" });
    const v = syncVersion(scratch);
    expect(v).toBe("1.2.3");
    const server = JSON.parse(readFileSync(join(scratch, "server.json"), "utf8"));
    expect(server.version).toBe("1.2.3");
    expect(server.packages[0].version).toBe("1.2.3");
  });

  it("only updates server.json#packages entries whose identifier matches pkg.name", () => {
    // Regression-trap: an unrelated package entry under server.json
    // (e.g., a Docker image companion) MUST NOT have its version
    // bumped just because the npm package's version moved.
    writeFixture({
      pkgVersion: "2.0.0",
      pkgName: "@klodr/gmail-mcp",
      serverPackages: [
        { identifier: "@klodr/gmail-mcp", version: "0.0.0" },
        { identifier: "@klodr/gmail-mcp-docker", version: "0.5.0" },
      ],
    });
    syncVersion(scratch);
    const server = JSON.parse(readFileSync(join(scratch, "server.json"), "utf8"));
    expect(server.packages[0].version).toBe("2.0.0");
    expect(server.packages[1].version).toBe("0.5.0"); // untouched
  });

  it("tolerates server.json with no `packages` array (top-level only)", () => {
    writeFixture({ pkgVersion: "0.31.0", serverPackages: undefined });
    // Manually overwrite server.json to drop the packages key so the
    // `?? []` branch is exercised.
    writeFileSync(join(scratch, "server.json"), JSON.stringify({ version: "0.0.0" }, null, 2));
    expect(() => syncVersion(scratch)).not.toThrow();
    const server = JSON.parse(readFileSync(join(scratch, "server.json"), "utf8"));
    expect(server.version).toBe("0.31.0");
  });

  it("rewrites the VERSION constant in src/server.ts in-place", () => {
    writeFixture({
      pkgVersion: "0.30.5",
      tsContent:
        '// header\nexport const VERSION = "0.30.0";\n\n// other code below\nconst FOO = "bar";\n',
    });
    syncVersion(scratch);
    const ts = readFileSync(join(scratch, "src", "server.ts"), "utf8");
    expect(ts).toContain('export const VERSION = "0.30.5";');
    // Surrounding lines must be untouched.
    expect(ts).toContain("// header");
    expect(ts).toContain('const FOO = "bar";');
    // The old version literal must be GONE (no double assignment).
    expect(ts).not.toContain('VERSION = "0.30.0"');
  });

  it("throws a descriptive error when VERSION constant cannot be located", () => {
    // Pin the regex-not-matched branch — without this, a refactor
    // that renames the constant (e.g. `MCP_VERSION` instead of
    // `VERSION`) would silently leave src/server.ts on the old
    // version string and the package would publish with mismatched
    // metadata.
    writeFixture({
      pkgVersion: "1.0.0",
      tsContent: 'export const NOT_VERSION = "0.0.0";\n',
    });
    expect(() => syncVersion(scratch)).toThrow(
      /did not find the VERSION constant in src\/server\.ts/,
    );
  });

  it("returns the version string for the caller (CLI uses it in the success log)", () => {
    writeFixture({ pkgVersion: "0.42.0" });
    const v = syncVersion(scratch);
    expect(v).toBe("0.42.0");
  });

  it.each([
    ["missing version field", JSON.stringify({ name: "@klodr/gmail-mcp" })],
    ["empty version string", JSON.stringify({ name: "@klodr/gmail-mcp", version: "" })],
    ["non-string version", JSON.stringify({ name: "@klodr/gmail-mcp", version: 42 })],
  ])("throws when package.json#version is invalid (%s)", (_label, pkgJson) => {
    // Pin the up-front version validator. Without it, an absent or
    // non-string `version` would silently get propagated as
    // `undefined` into server.json and as `"undefined"` into the
    // VERSION literal in src/server.ts — a malformed release on
    // npm. Fail fast at boot instead.
    writeFixture();
    writeFileSync(join(scratch, "package.json"), pkgJson);
    expect(() => syncVersion(scratch)).toThrow(/package\.json#version/);
  });

  it.each([
    ["missing name field", JSON.stringify({ version: "1.0.0" })],
    ["empty name string", JSON.stringify({ name: "", version: "1.0.0" })],
    ["non-string name", JSON.stringify({ name: 123, version: "1.0.0" })],
  ])("throws when package.json#name is invalid (%s)", (_label, pkgJson) => {
    // Symmetric pin for the `name` field. The script uses pkg.name
    // to match `server.json#packages[].identifier` — if it's
    // undefined, no entry would match and the per-package version
    // bump would silently no-op while the top-level still moves.
    writeFixture();
    writeFileSync(join(scratch, "package.json"), pkgJson);
    expect(() => syncVersion(scratch)).toThrow(/package\.json#name/);
  });

  it.each([
    ["JSON null", "null"],
    ["JSON primitive string", '"x"'],
    ["JSON primitive number", "42"],
    ["JSON primitive boolean", "true"],
    ["JSON top-level array", "[]"],
  ])("throws when package.json parses to a non-object value (%s)", (_label, raw) => {
    // The shape validator rejects every non-object JSON parse:
    // `null` (typeof === "object" needs the explicit `!value`
    // guard), primitives (string/number/boolean), and top-level
    // arrays (rejected because `package.json` is contractually an
    // object, not a list — array indexing into `.version` /
    // `.name` would silently produce undefined and the downstream
    // string check would mis-attribute the failure).
    writeFixture();
    writeFileSync(join(scratch, "package.json"), raw);
    expect(() => syncVersion(scratch)).toThrow(/did not parse to an object/);
  });
});
