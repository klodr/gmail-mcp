// ESLint v10 flat config.
// Type-aware rules: requires `parserOptions.projectService: true` (TS 5+).

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

const __dirname = import.meta.dirname;

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "coverage/",
      "node_modules/",
      "src/**/*.test.ts",
      "src/evals/",
      "scripts/",
      "*.mjs",
      "*.config.*",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // High-value additions over `recommendedTypeChecked`:
      "eqeqeq": ["error", "always"],
      "no-console": ["warn", { allow: ["error", "warn"] }],
      // The recommendedTypeChecked preset already enables:
      // - @typescript-eslint/no-floating-promises
      // - @typescript-eslint/await-thenable
      // - @typescript-eslint/no-misused-promises
      // - @typescript-eslint/no-unsafe-* (relaxed below where needed)

      // Relax for our codebase:
      "@typescript-eslint/no-unsafe-assignment": "off", // too noisy with JSON.parse outputs
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/restrict-template-expressions": "off",

      // Honour the conventional `_`-prefix to mark intentionally
      // unused destructured fields (e.g. when stripping read-only
      // keys from a Mercury response before re-POSTing it).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
);
