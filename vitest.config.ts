import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `test/**/*.test.ts` is the unit suite; `scripts/**/*.test.mjs`
    // is the tempdir-driven smoke for `sync-version.mjs` (it shells out
    // to `node` directly via execSync in fixtures). Both are needed for
    // accurate coverage rollup — without the `.mjs` entry, vitest skips
    // `sync-version.mjs` and reports it as 0%.
    include: ["test/**/*.test.ts", "scripts/**/*.test.mjs"],
    exclude: ["dist/**", "node_modules/**"],
    // `default` keeps vitest's standard human-readable console output;
    // `junit` emits a `test-results.junit.xml` that Codecov's Test
    // Analytics dashboard consumes (flaky-test detection, slowest-test
    // report, per-test failure history). The XML is gitignored and
    // absent from `package.json#files`, so it never ships to npm.
    reporters: ["default", ["junit", { outputFile: "test-results.junit.xml" }]],
    coverage: {
      provider: "v8",
      // `lcov` for codecov-action's primary upload; `json` (v8 native)
      // carries the full branch + statement detail that codecov needs
      // to compute indirect-changes accurately — without it, codecov
      // sees only the lcov rollup and reports phantom regressions on
      // files the PR doesn't touch (it has no branch-level diff to
      // compare against, so it falls back to a coarser delta).
      // `text` keeps the human-readable per-file summary in CI logs.
      reporter: ["text", "lcov", "json"],
      // Include every source file so untested ones show as 0% rather
      // than being silently omitted from the report. v8 coverage
      // otherwise hides files that no test imports, which makes it
      // easy to think we have better coverage than we do.
      include: ["src/**/*.ts", "scripts/**/*.mjs"],
      // `src/index.ts` is the stdio CLI entry point — a thin shim that
      // boots `StdioServerTransport`. Testing it requires booting a real
      // transport, which deadlocks the test runner waiting for the next
      // stdio frame. The orchestration the shim wraps lives in
      // `runtime.ts` and is covered there.
      exclude: [
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
