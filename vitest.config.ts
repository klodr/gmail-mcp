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
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
    },
  },
});
