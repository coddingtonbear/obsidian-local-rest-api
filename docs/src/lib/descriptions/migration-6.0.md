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

In 5.x those three fields were always arrays, and were served as soon as the requested note's own metadata was available. But all three describe the **vault-wide** link graph: which of `links` and `unresolvedLinks` a wikilink lands in depends on whether its *target* has been indexed, and a backlink exists only once the file that holds it has been. Obsidian resolves that graph in a vault-wide pass after it loads and again after every change, and during that pass the arrays could be partial -- a link reported as unresolved only because its target had not been parsed yet, a backlink missing because the linking note had not been. Nothing in the response said so, and an empty list could not be told from an incomplete one ([issue 327](https://github.com/coddingtonbear/obsidian-local-rest-api/issues/327)).

In 6.x, whenever that pass may be incomplete, all three fields are `null` -- together, never an array beside a `null`:

| | 5.x | 6.x |
|---|---|---|
| Resolution settled | arrays | arrays |
| Resolution may be incomplete | arrays, possibly partial | `null`, all three |

`null` means "not known yet"; `[]` means "known to be none".

Expect `null`:

- for a few seconds after Obsidian or the plugin starts, until Obsidian announces that its first resolution pass has finished (or, for a plugin enabled into an already-indexed vault, until the vault has been quiet for a few seconds);
- briefly after any change to the vault, including a write your own client just made, until the next pass finishes.

`GET /` now reports the same fact as `linkIndexReady` (on authenticated requests), so a client can wait for `true` before a bulk query rather than discovering `null` in the results.

# What to change

**Reading a note.** Treat `null` as "ask again": re-read the note, or poll `GET /` until `linkIndexReady` is `true` and then re-read. A client that only ever reads whole arrays and does not care about the warming window can coalesce: `body.links ?? []`.

**JsonLogic searches.** `{"var": "backlinks"}` yields `null` for an unsettled note, so `{"in": ["x", {"var": "backlinks"}]}` is `false` for it and a query that returns `{"var": "unresolvedLinks"}` returns `null` rows. Check `linkIndexReady` on `GET /` first when the search is meant to be exhaustive -- a "find broken links" query run while resolution is incomplete would otherwise report fewer, or more, than there are.

**Event streams.** A `vault` event (`create`, `modify`, `delete`, `rename`) is itself the change that starts a resolution pass, so its `file` always carries `null` link fields. Subscribe to `metadataCache` `resolved` to be told when the pass has finished, then read what you need.

**MCP agents.** `vault_read` and `search_query` return `null` link fields in the same cases. The tool descriptions say so; an agent asked to find broken links should treat `null` as "not yet" rather than "none".
