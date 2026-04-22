import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["dist/**", "node_modules/**"],
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
