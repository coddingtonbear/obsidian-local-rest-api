# Migrating from 1.x to 2.x

Version 5.0 of this plugin upgraded its markdown-editing engine ([markdown-patch](https://github.com/coddingtonbear/markdown-patch)) from 1.x to 2.x, and the 2.x conventions are now the **default** for PATCH requests, sub-document targeting, and the document map.

> **Version numbers, disambiguated:** "1.x" and "2.x" in this guide refer to the *markdown-patch format*, selected per-request with the `Markdown-Patch-Version` header. The *plugin* switched defaults in its 5.0 release and will remove the 1.x format entirely in 6.0.

The 1.x format still works — send `Markdown-Patch-Version: 1` — but it is **deprecated and will be removed in plugin 6.0**. Every response served the 1.x way carries a `Deprecation: true; sunset-version="6.0"` header so you can spot lingering legacy traffic in your client logs.

# Am I affected?

You are affected if you:

- send **PATCH** requests that spread the instruction across `Operation`, `Target-Type`, `Target`, `Target-Delimiter`, `Target-Scope`, `Create-Target-If-Missing`, `Reject-If-Content-Preexists`, or `Trim-Target-Whitespace` headers;
- target a heading, block, or frontmatter field on **GET, PUT, or POST** using `Target-Type` / `Target` / `Target-Delimiter` headers;
- consume the **document map** (`Accept: application/vnd.olrapi.document-map+json`);
- parse the **`MD-Patch-Warnings`** response header;
- use the **MCP tools** `vault_patch`, `vault_read` (with a heading target), or `vault_get_document_map`.

You are **not** affected if you only read and write whole files, search, or use the active-file endpoints without section targeting.

# Nothing fails silently

Old-style requests sent without a version header are rejected loudly rather than reinterpreted:

| Legacy request shape (no version header) | Result |
| --- | --- |
| GET/PUT/POST with `Target-Type`/`Target` headers | `400 HeaderTargetingRequiresVersion1` |
| PATCH with `Target-Type`/`Target` headers | `400 PatchHeaderTargetingRequiresExplicitVersion` |
| PATCH with a non-object body and no targeting | `400 InvalidPatchInstruction` |
| Any `Markdown-Patch-Version` other than `1` or `2` | `400 InvalidPatchVersionHeader` |

(The PATCH header case is ambiguous by design: `Target-Type`/`Target` on a PATCH mean the deprecated 1.x format under version `1`, but [raw-content mode](#raw-content-mode-the-low-effort-migration) under an explicit version `2` — so the server refuses to guess.)

**The stopgap:** add `Markdown-Patch-Version: 1` to every affected request and everything behaves exactly as before — including the `::`-joined document map on GET. That buys you until plugin 6.0, no other changes required.

# Migrating PATCH requests

The 2.x PATCH carries the whole instruction as one JSON body instead of scattering it across headers.

**Before (1.x):**

```sh
curl -k -X PATCH \
  -H "Authorization: Bearer $API_KEY" \
  -H "Operation: append" \
  -H "Target-Type: heading" \
  -H "Target: Heading 1::Subheading 1:1" \
  -H "Content-Type: text/markdown" \
  --data "Hello" \
  "https://127.0.0.1:27124/vault/note.md"
```

**After (2.x):**

```sh
curl -k -X PATCH \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"targetType": "heading", "target": ["Heading 1", "Subheading 1:1"], "operation": "append", "content": "Hello"}' \
  "https://127.0.0.1:27124/vault/note.md"
```

Field-by-field:

| 1.x header | 2.x instruction field |
| --- | --- |
| `Operation: append` | `"operation": "append"` (now also `"delete"`) |
| `Target-Type: heading` | `"targetType": "heading"` |
| `Target: A::B` (+ `Target-Delimiter`) | `"target": ["A", "B"]` — a real array, no delimiter |
| `Target-Scope: content` | `"scope": "content"` (adds `"parent"` for moves) |
| body (`text/markdown`) | `"content": "..."` |
| body (`application/json` value) | `"value": <json>` |
| `Create-Target-If-Missing: true` | `"createTargetIfMissing": true` |
| `Reject-If-Content-Preexists: true` | `"rejectIfContentPreexists": true` |
| `Trim-Target-Whitespace` | *(dropped — see below)* |

Things that changed meaning along the way:

- **Heading targets are arrays.** `"target": ["A", "B"]` replaces `A::B`. A heading whose text contains `::` (or any other would-be delimiter) needs no escaping, and `Target-Delimiter` is gone. For a block, `target` is the bare id without `^`; for frontmatter, the key name.
- **Renaming a heading no longer takes `#` characters.** Under 1.x you supplied the full heading line (`## New Name`); under 2.x, `scope: "marker"` with `"content": "New Name"` renames the heading while preserving its level. The `#`s are *not* stripped anymore — if you keep sending them, they become literal text in the heading. If you are migrating, drop them.
- **Frontmatter values are typed JSON.** Send them in `"value"` (a list, dict, number, or string), not as a serialized string body.

See the PATCH operation documentation for the full instruction algebra — scopes, moves (`scope: "parent"` with a `destination`), deletes, and table-row writes.

## Raw-content mode: the low-effort migration

If your client *templates* markdown into the request body (Shortcuts, Tasker, curl from a shell variable), JSON-escaping that content is fragile. Raw-content mode keeps the 1.x posture — instruction outside the body, raw payload in it — but moves the target into URL path elements:

```sh
curl -k -X PATCH \
  -H "Authorization: Bearer $API_KEY" \
  -H "Operation: append" \
  -H "Content-Type: text/markdown" \
  --data "- $TEMPLATED_CONTENT" \
  "https://127.0.0.1:27124/vault/note.md/heading/Heading%201/Subheading%201:1"
```

For many 1.x clients this migration is just "delete the `Target-Type`/`Target`/`Target-Delimiter` headers and append the target to the URL, one path segment per heading level." `Operation`, `Target-Scope` (all four scopes), `Create-Target-If-Missing`, and `Reject-If-Content-Preexists` headers all still work here; `Target-Delimiter` and `Trim-Target-Whitespace` are rejected. A `text/*` body carries `content`, an `application/json` body carries `value`, and no body carries nothing (a `delete`, or a move via a `Destination` header).

Header-based targeting (`Target-Type`/`Target` instead of URL elements) also exists in raw-content mode, but requires an explicit `Markdown-Patch-Version: 2` and encodes a heading `Target` as percent-encoded JSON — see the PATCH operation documentation.

# Migrating targeted GET/PUT/POST requests

Header-based targeting on reads and writes is deprecated wholesale; the URL is the target now.

**Before (1.x):**

```sh
curl -k -H "Authorization: Bearer $API_KEY" \
  -H "Target-Type: heading" \
  -H "Target: Heading 1::Subheading 1:1" \
  "https://127.0.0.1:27124/vault/note.md"
```

**After (2.x):**

```sh
curl -k -H "Authorization: Bearer $API_KEY" \
  "https://127.0.0.1:27124/vault/note.md/heading/Heading%201/Subheading%201:1"
```

Each nested heading level is its own path segment. Percent-encode any segment containing non-ASCII characters or a literal `/` (`TODO%2FDONE` for a heading named `TODO/DONE` — each segment is decoded individually, so an encoded slash stays inside its segment). `block` and `frontmatter` targets work the same way: `.../block/abc123`, `.../frontmatter/fieldName`.

Sending both URL-path targeting and the header form in one request fails with `422 ConflictingTargetSpecification`.

# The document map changed shape

`GET /vault/{path}` with `Accept: application/vnd.olrapi.document-map+json` now returns the 2.0 map.

**Before (1.x):**

```json
{
  "headings": ["Heading 1", "Heading 1::Subheading 1:1", "Heading 2"],
  "blocks": ["484ef2"],
  "frontmatterFields": ["alpha", "beta"]
}
```

**After (2.x):**

```json
{
  "headings": {
    "Heading 1": { "Subheading 1:1": {} },
    "Heading 2": {}
  },
  "blocks": ["484ef2"],
  "frontmatterFields": ["alpha", "beta"],
  "version": "3f9a1c"
}
```

- **`headings` is a nested tree**, not a flat list of `::`-joined paths. Each key maps to its child headings; a path through the tree is exactly the array you send as a heading `target`.
- **`version` is new**: a content-hash token. Pass it back as `ifMatch` in a PATCH instruction (or an `If-Match` header in raw-content mode) for optimistic concurrency — if the file changed in between, the patch fails with `412` and the file is untouched.
- **Duplicates are now addressable.** If a heading has a duplicate sibling (same text, same parent) or a block id repeats, the first occurrence keeps its plain key and each later occurrence's key carries a non-printable marker suffix. Copy that key verbatim from the map into your `target` — don't try to type or reconstruct the marker.

Sending `Markdown-Patch-Version: 1` still returns the old flat map (with the `Deprecation` header) until plugin 6.0.

# Behavior changes to watch for

- **Whitespace is library-owned.** The 2.x engine reduces your `content` to trimmed, canonical form (leading and trailing blank lines are meaningless) and itself supplies the blank line wherever inserted content faces body text, so a naive `append` or `prepend` always lands as its own block and can never merge into an existing paragraph; `Trim-Target-Whitespace` is gone because there is nothing left for it to fix. If your 1.x client added `\n` padding to manage spacing, it is now ignored — and a `content`-scope `append` can no longer continue an existing list or paragraph (use a `^id` block target for inline edits).
- **Heading levels in `content` are relative.** A leading `#` becomes a direct child of the target regardless of the target's own depth — you never count `#`s. A level rebased past h6 still writes, but adds a `heading-depth-overflow` warning.
- **The warnings header was renamed** from `MD-Patch-Warnings` to `Markdown-Patch-Warnings`, and its JSON value is now percent-encoded so warnings can embed non-ASCII document text. Run it through `decodeURIComponent` before parsing.
- **URL targets on `/active/` PATCH now work.** Previously a suffix like `/active/heading/Log` was silently ignored on PATCH and the whole file was patched; it now targets the addressed section, matching PUT/POST.
- **Cleaner error mapping.** Unparseable frontmatter YAML is a `400`, a frontmatter key collision is a `409`, a mismatched table row or a cell containing a line break is a `400`, and an `ifMatch`/`If-Match` mismatch is a `412` — cases that previously surfaced as generic errors or `500`s.

# MCP tool changes

The MCP tools moved to 2.x with no version escape hatch:

- **`vault_patch`** accepts only the 2.0 JSON instruction shape described above.
- **`vault_read`** requires a heading target to be an array of heading texts; a bare `"A::B"` string is rejected rather than split on `::`.
- **`vault_get_document_map`** returns the nested-tree map with the `version` token.

# What's new that you couldn't do before

Migrating unlocks more than parity:

- `operation: "delete"` — remove a section, its body, or just its heading line, without a read-modify-write.
- `scope: "parent"` — move a heading section elsewhere in the tree, with levels rebased for you.
- Optimistic concurrency via `version`/`ifMatch` (`412` on conflict).
- Table-row writes: pass a 2-D JSON array in `value` to a block target that addresses a table; cell content is escaped for you.
- Duplicate headings and repeated block ids are individually addressable via the document map.
- Headings containing `::` or `/` are targetable with no escaping gymnastics.

# Timeline

| Plugin version | markdown-patch 1.x format | markdown-patch 2.x format |
| --- | --- | --- |
| < 5.0 | default | — |
| 5.0 | deprecated; opt in with `Markdown-Patch-Version: 1` (responses carry `Deprecation: true; sunset-version="6.0"`) | **default** |
| 6.0 | **removed** | default |
