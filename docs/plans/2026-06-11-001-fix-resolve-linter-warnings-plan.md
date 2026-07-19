---
title: "fix: Resolve linter report warnings"
type: fix
status: active
date: 2026-06-11
---

# fix: Resolve linter report warnings

## Summary

Seventeen linter warnings across five source files fall into six distinct categories. Fourteen warnings are genuine code or config issues, addressed by six requirements (R1–R6); three warnings (the direct filesystem access warning) are intentionally left alone. The fixes are non-behavioral: no public API, MCP tool, or runtime logic changes.

## Problem Frame

A linter audit surfaced warnings that fall into three buckets:

- **False-positive config gap** — `@typescript-eslint/no-redundant-type-constituents` fires on valid types (`http.Server`, `TFile`, `Buffer`, etc.) because the ESLint parser has no `parserOptions.project`, so it lacks type information and misclassifies unresolved symbols as "error types that act as any."
- **Code-quality warnings** — `require()` imports instead of ESM, unhandled `.catch()` return values, and a redundant type assertion.
- **Wrong-context warnings** — Obsidian-specific rules (`fetch`, `window.setTimeout`) fire on integration test files that run in Node.js, not inside the Obsidian plugin.

## Requirements

**ESLint config**

- R1. `parserOptions.project` must be set in `.eslintrc` to cover all three tsconfig files so type-aware rules have accurate type information.
- R2. Integration test files in `src/integration/` must be exempted from Obsidian-specific globals rules (`no-restricted-globals` and `obsidianmd/prefer-window-timers`) via an `overrides` block.

**vaultOperations.ts imports**

- R3. The `require("json-logic-js")` call must be replaced with an ESM `import`. Because `json-logic-js` ships no type declarations, a minimal ambient module declaration must be created so TypeScript resolves the import cleanly.
- R4. The `require("glob-to-regexp")` call must be replaced with an ESM `import`. `@types/glob-to-regexp` is already installed; the `export =` declaration is compatible with `esModuleInterop: true`.

**requestHandler.ts code quality**

- R5. The three `.catch(next)` expressions in `requestHandler.ts` that return unhandled promises must be prefixed with `void`.
- R6. The redundant `as ReturnType<typeof res.send>` assertion on the `originalSend.apply(...)` call must be removed.

## Key Technical Decisions

- **Three-tsconfig `parserOptions.project` array** — The base `tsconfig.json` excludes test files; `tsconfig.test.json` and `tsconfig.integration.json` already exist to cover them. Passing all three as an array gives the linter full type coverage without modifying any tsconfig's include/exclude logic. A single `tsconfig.json` entry would leave test files unresolvable and likely produce `TSCONFIG_INCLUDES_NOT_SUPPORTED` warnings.

- **Ambient declaration file for `json-logic-js`** — No `@types/json-logic-js` exists. Creating `src/types/json-logic-js.d.ts` with a `declare module` block is cleaner than a per-import `@ts-expect-error` or keeping `require()`. The type shape is already spelled out inline in the existing `require()` cast; the declaration file just moves it to its canonical location.

- **Directory-level overrides block for integration tests** — A single `overrides` entry in `.eslintrc` targeting `src/integration/**` covers all current and future integration test files without per-line comments, and keeps the rationale in one place.

- **`void` prefix, not `.catch(() => {})` wrappers** — The `.catch(next)` pattern is correct Express error-forwarding idiom. The only issue is the unhandled return value of `.catch()` itself. Prefixing with `void` signals intent explicitly without changing control flow.

- **Direct filesystem access warning skipped** — The `obsidianmd` plugin flags this warning but the usage in `vaultOperations.ts` is intentional (Node.js path construction within the adapter layer). No suppression comment is added to avoid drawing attention to a non-issue.

---

## Implementation Units

### U1. Fix requestHandler.ts code-quality warnings

**Goal:** Remove the four warnings in `requestHandler.ts` without touching any behavior.

**Requirements:** R5, R6

**Dependencies:** none

**Files:**
- `src/requestHandler.ts`

**Approach:** Add `void` in front of each of the three `.catch(next)` calls (the `handle()` helper's inner return and the two `api.use()` error handler registrations). Remove `as ReturnType<typeof res.send>` from the `originalSend.apply(...)` return — TypeScript already infers this type; the assertion is a no-op.

**Test scenarios:**
- Running `npm run lint src/requestHandler.ts` reports zero violations for the affected lines.
- Running `npm test` passes with no regressions (confirms no behavioral change).

**Verification:** `npm run lint src/requestHandler.ts` exits clean; `npm test` green.

---

### U2. Convert require() imports to ESM in vaultOperations.ts

**Goal:** Eliminate the two `require()` style imports by replacing them with ESM `import` statements, providing proper type declarations for `json-logic-js`.

**Requirements:** R3, R4

**Dependencies:** none

**Files:**
- `src/vaultOperations.ts`
- `src/types/json-logic-js.d.ts` *(new)*

**Approach:**

For `glob-to-regexp`: replace `const WildcardRegexp = require("glob-to-regexp") as (pattern: string) => RegExp` with `import globToRegexp from "glob-to-regexp"`. The `@types/glob-to-regexp` package uses `export =` syntax; `esModuleInterop: true` already in the tsconfig makes the default import work. Update the usage variable name accordingly throughout the file.

For `json-logic-js`: create `src/types/json-logic-js.d.ts` with a `declare module "json-logic-js"` block that exports the `apply` and `add_operation` functions — the type shape is already spelled out in the existing inline cast and just needs to move to the declaration file. Then replace the `require()` call with `import jsonLogic from "json-logic-js"`.

**Test scenarios:**
- `npm run lint src/vaultOperations.ts` reports zero `@typescript-eslint/no-require-imports` violations.
- `npm run typecheck` succeeds — TypeScript resolves both imports without errors.
- `npm test` passes — confirms no behavioral change from the import refactor.

**Verification:** `npm run lint src/vaultOperations.ts` and `npm run typecheck` both exit clean; `npm test` green.

---

### U3. Fix .eslintrc configuration

**Goal:** Give the ESLint parser accurate type information (resolving the "error type acts as any" false positives) and exempt integration test files from Obsidian-specific globals rules.

**Requirements:** R1, R2

**Dependencies:** U1, U2 — apply config changes after code fixes so the first full lint run comes up clean.

**Files:**
- `.eslintrc`

**Approach:**

Add `"project": ["./tsconfig.json", "./tsconfig.test.json", "./tsconfig.integration.json"]` to the existing `parserOptions` block. All three tsconfig files already exist; this array ensures every `.ts` file in the repo is covered by at least one project, eliminating the missing-type-info false positives.

Add an `overrides` array with one entry: `files: ["src/integration/**"]` disabling `"no-restricted-globals"` (which the obsidianmd plugin uses to flag `fetch`) and `"obsidianmd/prefer-window-timers"` (which flags bare `setTimeout`). The rationale: integration tests run under Jest in Node.js and legitimately use native `fetch` and `setTimeout`.

**Risk note:** Adding `parserOptions.project` enables full type-checked linting. While `plugin:@typescript-eslint/recommended` doesn't include type-checked rules, the `obsidianmd` plugin's recommended config may. If new violations appear on the first lint run after this unit, address them in a follow-up commit rather than expanding this unit's scope.

**Test scenarios:**
- `npm run lint` on the full `src/` directory exits with zero violations.
- `npm run lint src/integration/client.ts` produces no `no-restricted-globals` or `prefer-window-timers` warnings.
- The six "error type acts as any" warnings (for `Server`, `TFile`, `CachedMetadata`, `Buffer`, `Certificate`) no longer appear.

**Verification:** `npm run lint` exits clean across the whole `src/` directory.

---

## Scope Boundaries

- **Direct filesystem access warning** — intentionally not addressed; the `obsidianmd` plugin flags this but the code is deliberate Node.js adapter usage.
- **Any new violations surfaced by `parserOptions.project`** — deferred to follow-up work if they appear; they are not part of this linter report and expanding scope mid-fix introduces risk.
- **Adding missing types for other untyped packages** — only `json-logic-js` is in scope; other packages are not flagged in this report.
