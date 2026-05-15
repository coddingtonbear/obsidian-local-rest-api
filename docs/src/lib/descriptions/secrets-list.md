List the ref ids currently stored in Obsidian's `app.secretStorage`.

Values are NEVER returned by this endpoint — use `GET /secrets/{ref}/` to read
a specific value. The list typically includes refs written by other plugins
(for example, the Copilot plugin stores model API keys here) plus any refs
you write yourself via `PUT /secrets/{ref}/`.

Obsidian enforces a strict ref format: lowercase letters, digits, hyphens,
max 64 characters.
