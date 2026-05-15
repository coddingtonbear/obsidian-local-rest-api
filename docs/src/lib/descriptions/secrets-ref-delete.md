Remove a stored secret from Obsidian's `app.secretStorage`.

Idempotent: returns 204 even if the ref did not exist. Useful for cleanup of
test secrets and rotation flows where you delete the old ref before writing
the new one.
