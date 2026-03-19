# Agent Instructions

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
