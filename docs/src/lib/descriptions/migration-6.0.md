# Migrating from 5.x to 6.x

Version 6.0 of this plugin changes one thing about the shape of a note's metadata: the three link fields can now be `null`.

# Am I affected?

You are affected if you read `links`, `backlinks`, or `unresolvedLinks` from any of:

- `GET /vault/{filename}` or `GET /active/` with `Accept: application/vnd.olrapi.note+json`;
- `POST /search/` with a JsonLogic query that reads those fields, or that returns one of them as its result;
- the `file` object carried by an event stream (`/events/...`);
- the MCP tools `vault_read`, `search_query`, and `events_get_listener_url`.

You are **not** affected if you only read `content`, `frontmatter`, `tags`, `stat`, or `path`.

# What changed

In 5.x those three fields were always arrays, and were served as soon as the requested note's own metadata was available. But all three describe the **vault-wide** link graph: which of `links` and `unresolvedLinks` a wikilink lands in depends on whether its *target* has been indexed, and a backlink exists only once the file that holds it has been. While Obsidian is still indexing the vault after startup, the arrays could be partial -- a link reported as unresolved only because its target had not been parsed yet, a backlink missing because the linking note had not been. Nothing in the response said so, and an empty list could not be told from an incomplete one ([issue 327](https://github.com/coddingtonbear/obsidian-local-rest-api/issues/327)).

In 6.x, until Obsidian's startup indexing has finished, all three fields are `null` -- together, never an array beside a `null`:

| | 5.x | 6.x |
|---|---|---|
| Startup indexing finished | arrays | arrays |
| Startup indexing still running | arrays, possibly partial | `null`, all three |

`null` means "not known yet"; `[]` means "known to be none".

Expect `null` for a few seconds after Obsidian or the plugin starts: until Obsidian announces that its first vault-wide resolution pass has finished, or -- for a plugin enabled into a vault that was already indexed -- until the vault has been quiet for a few seconds after the layout is up. Readiness is a one-way latch: once the fields are arrays they stay arrays until Obsidian restarts, which restarts the plugin too.

`GET /` now reports the same fact as `linkIndexReady` (on authenticated requests), so a client can wait for `true` before a bulk query rather than discovering `null` in the results.

## A deliberate compromise

After startup the three fields are **eventually consistent** with the vault, not guaranteed settled. Obsidian re-resolves the link graph after every change, and a read that lands in the milliseconds between a change and the end of that pass sees the graph as it was -- exactly as a read of `frontmatter` or `tags` already can. The plugin does not take the fields back to `null` during that window.

This matches the semantics of Obsidian's own (undocumented) `metadataCache.initialized`, which is a one-way flag for "startup indexing has finished" and never re-enters the partial state. The stricter alternative, nulling the fields after every change until the next pass finished, was considered and rejected: it would have made every write-then-read and every streamed `vault` or `metadataCache` event payload carry `null`, and it still could not promise a settled graph across a rename that cascades over many notes, since each note is its own change-then-resolve cycle.

A client that needs a settled graph *after a change* -- a link-repair tool verifying its own rename, say -- should subscribe to `metadataCache` `resolved` in the event stream, which marks the end of each resolution pass, and read after it, or simply re-read a moment later.

# What to change

**Reading a note.** Treat `null` as "ask again": re-read the note, or poll `GET /` until `linkIndexReady` is `true` and then re-read. A client that only ever reads whole arrays and does not care about the startup window can coalesce: `body.links ?? []`.

**JsonLogic searches.** `{"var": "backlinks"}` yields `null` for a note read before startup indexing has finished, so `{"in": ["x", {"var": "backlinks"}]}` is `false` for it and a query that returns `{"var": "unresolvedLinks"}` returns `null` rows. Check `linkIndexReady` on `GET /` first when the search is meant to be exhaustive -- a "find broken links" query run during startup would otherwise report fewer, or more, than there are.

**Event streams.** A streamed `file` carries `null` link fields only during startup. After that every event's `file` carries arrays, current as of the event; for a `vault` or `metadataCache` `changed` event that is the graph *before* Obsidian has re-resolved the change it announces. Subscribe to `metadataCache` `resolved` to be told when the pass has finished.

**MCP agents.** `vault_read` and `search_query` return `null` link fields in the same case. The tool descriptions say so; an agent asked to find broken links should treat `null` as "not yet" rather than "none".
