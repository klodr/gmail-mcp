import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["dist/**", "node_modules/**"],
    // `default` keeps vitest's standard human-readable console output;
    // `junit` emits a `test-results.junit.xml` that Codecov's Test
    // Analytics dashboard consumes (flaky-test detection, slowest-test
    // report, per-test failure history). The XML is gitignored and
    // absent from `package.json#files`, so it never ships to npm.
    reporters: ["default", ["junit", { outputFile: "test-results.junit.xml" }]],
    coverage: {
      // Include every source file so untested ones show as 0% rather
      // than being silently omitted from the report. v8 coverage
      // otherwise hides files that no test imports, which makes it
      // easy to think we have better coverage than we do.
      include: ["src/**/*.ts", "scripts/**/*.mjs"],
      // `src/index.ts` is the stdio CLI entry point — 7 lines that
      // call `runServer({ argv, env })` and forward the rejection
      // to `process.exit(1)`. Testing it requires booting a real
      // `StdioServerTransport`, which deadlocks the test runner
      // waiting for the next stdio frame. The orchestration the
      // shim wraps lives in `runtime.ts` and is covered there.
      // Mirrors the `klodr/faxdrop-mcp` and `klodr/mercury-invoicing-mcp`
      // pattern.
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.d.ts",
        "src/index.ts",
        // Vitest's `include` for tests is separate from coverage
        // `include`; this `exclude` ensures the tempdir-driven
        // sync-version.test.mjs (executable via `node` directly) is
        // not measured as if it were source.
        "scripts/**/*.test.mjs",
        // `prod-readonly-test.mjs` is a top-level smoke test that
        // spawns `dist/index.js` and walks a real Gmail token —
        // mocking it in vitest would defeat its purpose. It runs
        // pre-release against a sandbox token, not in the unit
        // test suite.
        "scripts/prod-readonly-test.mjs",
      ],
    },
  },
});
