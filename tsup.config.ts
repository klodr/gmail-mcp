import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  dts: false,
  // Sourcemaps are opt-in only (GMAIL_MCP_SOURCEMAP=true). Every other
  // invocation — including local `npm publish`, `npm run build`, CI, and
  // the release workflow — produces a map-less bundle, so a forgotten
  // NODE_ENV cannot accidentally ship TS sources under dist/index.js.map.
  sourcemap: process.env.GMAIL_MCP_SOURCEMAP === "true",
  clean: true,
  shims: true,
});
