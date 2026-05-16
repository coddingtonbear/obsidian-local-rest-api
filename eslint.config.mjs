import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default defineConfig([
  {
    ignores: ["dist/", "node_modules/", "main.js", "main.d.ts"],
  },

  ...obsidianmd.configs.recommended,

  // Main plugin source
  {
    files: ["src/**/*.ts"],
    ignores: ["src/integration/**"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./tsconfig.json" },
    },
    rules: {
      // This plugin deliberately uses Node.js built-ins (http, crypto, fs, etc.)
      // as an Obsidian plugin that embeds a REST API server.
      "obsidianmd/no-nodejs-modules": "off",

      // TypeScript already enforces identifier references; no-undef produces
      // false positives for ambient Obsidian types in declare-module blocks.
      "no-undef": "off",

      // Some CommonJS-only dependencies (json-logic-js, glob-to-regexp) cannot
      // be imported with ESM syntax; require() is the only option.
      "@typescript-eslint/no-require-imports": "off",

      // Suppress the strict no-unsafe-* family — the codebase uses `any` in
      // places where the Obsidian/Express APIs return untyped values, and
      // fixing them all is out of scope for this linting integration.
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",

      // Acronyms and brand names that must stay capitalised in UI text.
      "obsidianmd/ui/sentence-case": [
        "error",
        {
          acronyms: ["REST", "API", "MCP", "HTTPS", "HTTP", "URL", "JSON", "CSS", "HTML", "SSL", "TLS"],
          brands: ["Obsidian", "Claude"],
          allowAutoFix: true,
        },
      ],
    },
  },

  // Unit tests use tsconfig.test.json (which mocks out the obsidian package).
  {
    files: ["src/**/*.test.ts"],
    ignores: ["src/integration/**"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./tsconfig.test.json" },
      globals: { ...globals.node, ...globals.jest },
    },
    rules: {
      "obsidianmd/no-nodejs-modules": "off",
      // Tests run in Node.js via Jest, not a browser/Obsidian window context.
      "obsidianmd/prefer-window-timers": "off",
      // Jest legitimately passes unbound methods to expect() matchers.
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },

  // Integration tests use their own tsconfig and run in Node.js (not Obsidian),
  // so Obsidian-specific and type-aware rules should not apply.
  {
    files: ["src/integration/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./tsconfig.integration.json" },
      globals: { ...globals.node, ...globals.jest },
    },
    rules: {
      "obsidianmd/no-nodejs-modules": "off",
      "obsidianmd/prefer-window-timers": "off",
      "no-restricted-globals": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
]);
