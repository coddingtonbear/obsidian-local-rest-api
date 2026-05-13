# Agent Instructions

## Commit Process

### Commit cadence

Commit frequently in small, self-contained increments. Each commit must leave the repository in a working state — no broken builds, no failing unit tests. A commit that fixes a bug, a commit that adds a test, and a commit that updates documentation are all valid atomic units. Do not batch unrelated changes into a single commit.

### Running tests before committing

Run the unit test suite before every commit:

```
npm test
```

Integration tests require a live Obsidian instance with the plugin's insecure HTTP server enabled and `OBSIDIAN_API_KEY` set. Run them when Obsidian is available, and always run them before pushing changes that touch endpoint behavior:

```
npm run test:integration
```

### Commit message format

Use [Conventional Commits](https://www.conventionalcommits.org/) format:

```
Short imperative description

Longer description of what this work is, why these changes were made, and any decisions, trade-offs, and known limitations that may be useful to future readers.
```

## Keeping REST, MCP, and Documentation in Sync

This project has several parallel representations of each API capability that must be kept consistent. When any one changes, the others must be updated in the same commit.

| Layer | Files |
|---|---|
| REST API implementation | `src/requestHandler.ts` |
| MCP tool definitions | `src/mcpHandler.ts` |
| OpenAPI docs (source) | `docs/src/openapi.jsonnet`, `docs/src/lib/descriptions/*.md` |
| OpenAPI docs (compiled) | `docs/openapi.yaml` |
| Unit tests | `src/requestHandler.test.ts`, `src/mcpHandler.test.ts` |
| Integration tests | `src/integration/*.test.ts` |

### When changing a REST endpoint

Any of the following changes requires updates across multiple layers:

- **New parameter** — add it to the route handler in `src/requestHandler.ts`, add the corresponding Zod field to the matching `mcpServer.tool()` call in `src/mcpHandler.ts`, document it in the relevant Jsonnet source under `docs/src/`, and add test coverage in both the relevant unit test file and the relevant `src/integration/*.test.ts` file.
- **Removed or renamed parameter** — mirror the removal/rename across all layers.
- **Changed behavior or response format** — update the OpenAPI description in `docs/src/lib/descriptions/` and the MCP tool description string in `src/mcpHandler.ts` so both REST and MCP clients receive accurate documentation.
- **New endpoint entirely** — all layers need additions: route handler, MCP tool, Jsonnet operation block, regenerated `docs/openapi.yaml`, and test coverage in both the unit and integration test files.

### Regenerating the compiled OpenAPI spec

`docs/openapi.yaml` is generated from the Jsonnet source and must be regenerated after any change to `docs/src/`:

```
npm run build-docs
```

Stage the resulting `docs/openapi.yaml` alongside any Jsonnet changes. `src/mcpHandler.ts` imports this file directly, so a stale compiled spec means MCP clients receive outdated API documentation.

### Checklist

Before marking any endpoint-related change complete:

- [ ] `src/requestHandler.ts` implements the behavior
- [ ] `src/mcpHandler.ts` exposes matching parameters and an accurate description
- [ ] `docs/src/` Jsonnet/Markdown reflects the change
- [ ] `docs/openapi.yaml` has been regenerated (`npm run build-docs`)
- [ ] Unit tests in `src/requestHandler.test.ts` and/or `src/mcpHandler.test.ts` cover the changed behavior
- [ ] Integration tests in `src/integration/` cover the changed behavior


## Release Process

Releases are performed on the `main` branch after all feature branches have been merged.

### Steps

1. Ensure you are on `main` with all intended changes merged.

   Before proceeding, read the current version from `package.json`. Ask the user whether this is a **major**, **minor**, or **patch** bump and calculate the new version number from their answer — do not ask them to supply the version number directly.

2. Delete `package-lock.json` and regenerate it:
   ```
   rm package-lock.json
   npm i
   ```

3. Edit the `version` field in `package.json` to the new version number.

4. Run the version script to update `manifest.json` and `versions.json` (this also stages those two files automatically):
   ```
   npm run version
   ```

5. Stage the remaining changed files (`package.json` and `package-lock.json`):
   ```
   git add package.json package-lock.json
   ```

6. Create a commit named:
   ```
   Release X.Y.Z
   ```

7. Before creating the tag, draft the full tag message and present it to the user for review. Incorporate any requested changes before proceeding. Then create the annotated tag named exactly after the new version number (e.g. `3.4.7`):
   ```
   git tag -a 3.4.7
   ```

   **Tag message format:**

   ```
   Release X.Y.Z

   - Adds/Fixes/Updates/Removes [description of change]. (#issue if applicable; Thanks @contributor if applicable.)
   - Adds/Fixes/Updates/Removes [description of change].
   ```

   - Subject line is `Release X.Y.Z`, optionally followed by ` -- Short description` for especially notable releases.
   - Body is one or more bullet points summarizing user-visible changes.
   - Each bullet starts with a verb (`Adds`, `Fixes`, `Updates`, `Removes`).
   - Reference GitHub issues and PR numbers where relevant (e.g. `(#140)`).
   - Credit external contributors where relevant (e.g. `Thanks @username!`). GitHub handles are not present in commit messages — look them up via `gh pr view <number>` for any PR-sourced changes.
   - Sub-bullets may be used for multi-part changes.
   - For re-releases (e.g. fixing a botched release), add a short prose paragraph before or after the bullets explaining what changed from the prior release attempt and that the underlying content is otherwise identical.
