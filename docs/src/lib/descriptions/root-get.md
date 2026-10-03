Returns basic details about the server as well as your authentication status.

This is the only API request that does *not* require authentication. An authenticated request additionally receives `certificateInfo`, `apiExtensions`, and `state`.

## State

`state` carries observations, by namespace, that a client reads to decide whether to proceed. The server attaches no verdict: it reports what it has heard and when, and the client applies its own tolerance.

`state.metadataCache` is the plugin's own namespace. It answers the question issue #327 raised: a note's `links`, `backlinks`, and `unresolvedLinks` come from Obsidian's vault-wide link graph, and while Obsidian is still indexing after startup they can be incomplete with no sign in the note itself. Obsidian gives no documented signal for the end of that indexing, so instead of a `ready` flag the plugin reports when it started listening, when it last heard the cache's `resolved` event, and when it last heard any indexing activity. Indexing in progress looks like recent activity; done looks like silence. A client that would rather not poll can watch the `metadataCache` event stream, where `resolve` fires per file and `resolved` on each drain.

Every other key of `state` is an extension plugin's id, holding whatever that extension publishes through the extension API's `addState`, or `null` when its state could not be read within the budget set in the plugin's advanced settings. An extension that documents its state has it listed under `state` in this specification, served from `/openapi.yaml`.

The same document is available to MCP clients as the `obsidian://local-rest-api/status` resource.
