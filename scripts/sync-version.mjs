// Propagate package.json's `version` into the other places that need it:
// server.json (top-level + matching package entry) and the hard-coded
// version string in the MCP `Server(...)` constructor in src/index.ts.
// Run automatically by `npm version`.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const v = pkg.version;

// 1. server.json
const serverJsonPath = join(root, "server.json");
const server = JSON.parse(readFileSync(serverJsonPath, "utf8"));
server.version = v;
for (const p of server.packages ?? []) {
  if (p.identifier === pkg.name) p.version = v;
}
writeFileSync(serverJsonPath, JSON.stringify(server, null, 2) + "\n");

// 2. src/index.ts — the MCP Server({ name, version }) literal
const tsPath = join(root, "src", "index.ts");
const ts = readFileSync(tsPath, "utf8");
const re = /(name: "gmail",\s*\n\s*version: )"[^"]*"/;
if (!re.test(ts)) {
  console.error("sync-version: did not find the Server({ name, version }) literal in src/index.ts");
  process.exit(1);
}
const updatedTs = ts.replace(re, `$1"${v}"`);
writeFileSync(tsPath, updatedTs);

console.log(`Synced version → ${v} (server.json, src/index.ts)`);
