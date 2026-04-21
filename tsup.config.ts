import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  dts: false,
  // Sourcemaps in dev (npm run dev / npm test); never in published artifacts
  // because they would expose the full TS source under dist/index.js.map.
  sourcemap: process.env.NODE_ENV !== "production",
  clean: true,
  shims: true,
  banner: { js: "#!/usr/bin/env node" },
});
