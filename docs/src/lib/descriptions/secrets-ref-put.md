Store a secret under the given ref in Obsidian's `app.secretStorage`.

The body can be either:
- A JSON object `{"value": "the secret"}`
- A raw string body (with `Content-Type: text/plain`)

Idempotent: writing the same ref+value twice is a no-op from the caller's
perspective.

Obsidian enforces a strict ref format: lowercase letters, digits, hyphens,
max 64 characters. Invalid refs surface as HTTP 500 with an error message
from Obsidian's own validator.
