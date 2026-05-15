Inspect the runtime API surface of Obsidian's `app.secretStorage`.

Returns the list of methods available in the running Obsidian build and three
boolean hints summarizing which capabilities are supported (list, set, get).
Use this endpoint before integrating with `/secrets/` to confirm the methods
your script depends on actually exist in the user's version of Obsidian.

This endpoint exists because `app.secretStorage` is an internal Obsidian API
whose shape has evolved across versions and is not officially documented.
