Registers a subscription to one Obsidian event and returns the URL of a [Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html) stream that delivers each matching occurrence as it happens.

Streaming is two steps because a browser's `EventSource` can only make `GET` requests, and a `GET` has no body to carry a filter. So the filter is registered here, and the stream is opened with `GET /events/{emitter}/{event}/{subscriptionId}/`, using the returned `url`.

#### Events

`{emitter}` and `{event}` are Obsidian's own names. Only these can be streamed:

| Emitter | Events |
|---|---|
| `vault` | `create`, `modify`, `delete`, `rename` |
| `metadataCache` | `changed`, `deleted`, `resolve`, `resolved` |
| `workspace` | `file-open`, `active-leaf-change`, `layout-change` |

Plugins extending this server can add their own events, with their plugin id as `{emitter}`. The payload of an extension's event is whatever that extension's serializer returns, plus `emitter` and `event`. Anything else gets a `404` whose `supportedEvents` field lists everything currently available. Some events are left out on purpose. `quick-preview` and `editor-change` fire on every keystroke and carry the note's text, `editor-paste` and `editor-drop` carry clipboard and drag data, and the menu and window events carry UI objects. `/events/` and `/events/{emitter}/` return `400`, because Obsidian has no way to listen for every event at once.

To react to a note's frontmatter changing, use `metadataCache` `changed` rather than `vault` `modify`. `modify` fires before Obsidian has re-read the file's metadata, so its frontmatter can be stale.

#### What each event carries

Every message's `event:` field is the event name. Its `data:` is a JSON object:

- `emitter`, `event`: what fired.
- `path`: the file or folder the event is about, or `null`.
- `file`: that file's NoteJson (the same shape `/search/` evaluates), or `null` for a folder, a deleted file, or an event with no file. `content` is included only when the filter reads `file.content`: a `var`, `missing`, or `missing_some` path naming it. A string that merely says "content", such as a path compared against it, doesn't count.
- `isFolder` (`vault` events): whether `path` names a folder.
- `oldPath` (`vault` `rename`): the path before the rename.
- `previous` (`metadataCache` `deleted`): the `frontmatter` and `tags` the file had.
- `viewType` (`workspace` `active-leaf-change`): the type of the newly active view.

Obsidian passes some events more than this, such as `changed`'s full note text or `active-leaf-change`'s live view. None of it is sent.

The `id:` of each message is `<epoch>-<counter>`. The epoch changes whenever the plugin reloads. A client that reconnects and sees a new epoch, or a gap in the counter, has missed events. Nothing is replayed, so search to catch up.

#### The filter

The request body is an optional JsonLogic expression, evaluated against the `data` object above. It supports the same extra `glob` and `regexp` operators as `/search/`. Only events for which it is truthy are sent. With no body, or `{}`, every occurrence is sent. A filter JsonLogic can't evaluate, or one whose `regexp` pattern won't compile, is refused with `400`.

#### The stream URL

When signed URLs are enabled, `url` is signed and opens the stream without an `Authorization` header, so it can be handed to an `EventSource`, `curl -N`, or another process. Otherwise it needs the API key like any other request. The URL expires after `ttl` seconds (default: the signed-URL lifetime in settings). A stream opened before then stays open. A reconnect after that is refused, and the client needs a new subscription. Subscriptions are held in memory, so a plugin reload ends them all.

Anyone holding a signed stream URL sees the path and metadata of every event its filter matches, and note content if the filter reads `file.content`, for as long as the stream stays open. The filter is part of the subscription, so the URL can't be used to widen it.

At most 16 streams may be open at once, and at most 256 subscriptions may exist. Beyond that, requests get `503`.
