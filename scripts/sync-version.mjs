// Propagate package.json's `version` into the other places that need it:
// server.json (top-level + matching package entry) and the `VERSION`
// constant in src/server.ts (the McpServer factory). Run automatically
// by `npm version`. Pre-v0.30.0 this targeted src/index.ts where the
// legacy `new Server({ name, version })` literal lived.
//
// Exports `syncVersion(rootDir)` so the unit test in
// `scripts/sync-version.test.mjs` can drive it against a tempdir-rooted
// fixture without mutating the real repo. The CLI entrypoint at the
// bottom calls `syncVersion(process.cwd-derived root)` when the file is
// executed directly via `node scripts/sync-version.mjs`.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Sync the version field from `<root>/package.json` to:
 *   - `<root>/server.json` top-level `version`
 *   - every entry of `<root>/server.json#packages[]` whose
 *     `identifier` equals `<root>/package.json#name`
 *   - the `export const VERSION = "..."` literal in `<root>/src/server.ts`
 *
 * Throws a descriptive Error if the `VERSION` constant cannot be
 * located in `src/server.ts` — the CLI entrypoint catches and
 * `process.exit(1)`s on that throw, the unit test asserts on it.
 *
 * @param {string} rootDir - Absolute path to the repo root.
 * @returns {string} The propagated version.
 */
export function syncVersion(rootDir) {
  const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
  // Validate the parsed shape up-front: a package.json missing
  // `name` or `version` (or with non-string values) would
  // otherwise silently propagate `undefined` into server.json and
  // src/server.ts. Fail fast instead — the script is run by
  // `npm version`, so a bad package.json at this point is a
  // definite operator error worth surfacing loudly.
  if (!pkg || typeof pkg !== "object") {
    throw new Error("sync-version: package.json did not parse to an object");
  }
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error("sync-version: package.json#version must be a non-empty string");
  }
  if (typeof pkg.name !== "string" || pkg.name.length === 0) {
    throw new Error("sync-version: package.json#name must be a non-empty string");
  }
  const v = pkg.version;

  // 1. server.json
  const serverJsonPath = join(rootDir, "server.json");
  const server = JSON.parse(readFileSync(serverJsonPath, "utf8"));
  server.version = v;
  for (const p of server.packages ?? []) {
    if (p.identifier === pkg.name) p.version = v;
  }
  writeFileSync(serverJsonPath, JSON.stringify(server, null, 2) + "\n");

  // 2. src/server.ts — the exported `VERSION` constant (mirrors mercury / faxdrop)
  const tsPath = join(rootDir, "src", "server.ts");
  const ts = readFileSync(tsPath, "utf8");
  const re = /(export const VERSION = )"[^"]*"/;
  if (!re.test(ts)) {
    throw new Error("sync-version: did not find the VERSION constant in src/server.ts");
  }
  const updatedTs = ts.replace(re, `$1"${v}"`);
  writeFileSync(tsPath, updatedTs);

  return v;
}

// CLI entrypoint: only run when executed directly (`node scripts/sync-version.mjs`).
// `import.meta.url` is `file:///abs/path` and `process.argv[1]` is the
// raw absolute path, so converting via fileURLToPath gives a stable
// equality check that works on both POSIX and Windows.
/* v8 ignore start -- CLI wrapper (`syncVersion` itself is fully
   covered by sync-version.test.mjs); spawning the script as a
   child process from the test runner just to cover seven lines of
   "is this the main module" plumbing + a console.log + a
   process.exit is not worth the complexity. */
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const v = syncVersion(root);
    console.log(`Synced version → ${v} (server.json, src/server.ts)`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
/* v8 ignore stop */
