Read the value of a single secret from Obsidian's `app.secretStorage`.

**Security:** anyone holding the Local REST API key can read any secret in
secretStorage through this endpoint, regardless of which plugin originally
stored it. Treat your API key with the same care as a master password.

Returns 404 when the ref does not exist.
