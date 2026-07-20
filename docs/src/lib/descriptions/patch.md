Edit a document with a single structured instruction — an **operation** applied to a **scope** of a **target** node (a heading, block reference, or frontmatter field). The whole instruction travels as a JSON request body.

> **Migrating from the header-driven format?** See [Deprecated: the 1.x header-driven format](#deprecated-the-1x-header-driven-format) at the end.

# The algebra

- **operation** — `replace`, `prepend`, `append`, or `delete`.
- **scope** (optional, default `content`):
  - `content` — the node's body. For a heading, that's its whole subtree *below* the heading line.
  - `marker` — the label only: a heading line, a block `^id`, or a frontmatter key. `replace` renames it.
  - `markerAndContent` — the marker *and* the body together: for a heading, its heading line plus everything beneath it. Unlike `content`, the heading line is inside the edited span, so a `replace` here rewrites the heading itself. `prepend`/`append` insert a *sibling* before/after it.
  - `parent` — a heading's place in the tree. Valid only with `replace`, and carries a `destination` (a **move**).
- **target** — for a heading, an array of heading texts from the top level down (`["Overview","Details"]`), or `null`/`[]` for the document root; for a block, the bare id without `^`; for a frontmatter field, the key.
- **payload** — carried in exactly one field, chosen by what it is:
  - `content` — a markdown/text string (heading & block bodies/labels, or a frontmatter key rename).
  - `value` — arbitrary JSON (frontmatter values).
  - `destination` — where a moved heading lands.

Not every combination is meaningful; invalid ones are rejected with a `400`.

**Relative heading levels.** Heading `#`-counts inside a `content` string are *relative* to the edited span, so you never count `#`s: under `content` scope a leading `#` becomes a direct child of the target; under `markerAndContent` (or a sibling insert) it lands at the target's own level. Nesting inside your content is preserved as you wrote it — replacing a `##` section with `# New\n\n## Child` yields `## New` and `### Child`. A level rebased past `######` (h6) is still written, but the response carries a `heading-depth-overflow` entry in the `MD-Patch-Warnings` header.

> **Note:** because the heading line is part of the `markerAndContent` span, a `replace` whose content has *no* heading removes it — the section is dissolved into a plain paragraph. Include a leading `#` (at any depth; it is rebased for you) to keep it a heading.

# How to Use & Examples

All of the below examples assume you have a document that looks like this:

```markdown
---
alpha: 1
beta: test
delta:
zeta: 1
yotta: 1
gamma:
- one
- two
---

# Heading 1

This is the content for heading one

Also references some [[#^484ef2]]

## Subheading 1:1
Content for Subheading 1:1

### Subsubheading 1:1:1

### Subsubheading 1:1:2

Testing how block references work for a table.[[#^2c7cfa]]
Some content for Subsubheading 1:1:2

More random text.

^2d9b4a

## Subheading 1:2

Content for Subheading 1:2.

some content with a block reference ^484ef2

## Subheading 1:3
| City         | Population |
| ------------ | ---------- |
| Seattle, WA  | 8          |
| Portland, OR | 4          |

^2c7cfa
```

## Append, prepend, or replace content below a heading

To append the content "Hello" below "Subsubheading 1:1:1" under "Heading 1":

```json
{
  "targetType": "heading",
  "target": ["Heading 1", "Subheading 1:1", "Subsubheading 1:1:1"],
  "operation": "append",
  "content": "Hello"
}
```

`prepend` and `replace` work the same way, with different results. Because `target` is an array, a heading whose text contains `::` needs no escaping.

> **Note:** the heading line itself is not part of the `content` scope. When you `replace` a heading's content, supply only the body — do not include the heading line, or it will be duplicated. To rename the heading, see below.

## Renaming a heading

Give the new text. That's all — no `#` characters, and nothing to look up:

```json
{
  "targetType": "heading",
  "target": ["Heading 1", "Subheading 1:1"],
  "operation": "replace",
  "scope": "marker",
  "content": "New Name"
}
```

`marker` scope addresses the label rather than the line, so the heading keeps whatever level it had and the body underneath is untouched. You never need to know the heading's depth to rename it.

> **Do not include `#` characters here.** They are not stripped — they become part of the heading text, so `"## New Name"` renames the heading to `## New Name` and renders as `## ## New Name`. (This is the reverse of the deprecated 1.x format, where the `#`s were required. If you are migrating, drop them.)

The same instruction shape renames a block id (`targetType: "block"`, new id without `^`) or a frontmatter key (`targetType: "frontmatter"`, new key name in `content`).

## Whitespace is spliced verbatim

Your `content` is inserted exactly as written at one edge of the target's span; the API adds no whitespace of its own. For a heading, that span begins immediately *after* the heading line and ends after the last line of its subtree. Given a document containing:

```markdown
# One

body of one
```

- `prepend` lands flush against the heading line → `# One\nX\n\nbody of one\n`
- `append` lands flush against the section's last line → `# One\n\nbody of one\nX\n`
- `replace` clears the whole span, blank line included → `# One\nX\n`

In all three cases **a leading `\n` in your content is what buys you a blank line before it**. Sending `"\nX\n"` instead gives `# One\n\nX\n\nbody of one\n`, `# One\n\nbody of one\n\nX\n`, and `# One\n\nX\n` respectively.

Note that this is a *leading* newline even for `append`: the gap you usually want is between the existing text and yours, and that edge comes first. Trailing newlines control the gap *after* your content, and are trimmed at the very end of a document — so padding the end of an `append` at the end of a file does nothing.

The case that most often surprises: prepending into a section whose heading is already followed by a blank line still yields `# One\nX`, with no gap. That blank line is part of the body, not of the boundary, so it is pushed below your text rather than kept above it.

## Append, prepend, or replace content of a block reference

To append "Hello" below the block referenced by `2d9b4a`:

```json
{ "targetType": "block", "target": "2d9b4a", "operation": "append", "content": "Hello" }
```

## Append, prepend, or replace table rows via a block reference

To add a new city/population pair to the table referenced by `2c7cfa`, pass the row(s) as a 2-D JSON array in `value`:

```json
{ "targetType": "block", "target": "2c7cfa", "operation": "append", "value": [["Chicago, IL", "16"]] }
```

`prepend` puts the new row first (right below the heading row); `replace` swaps all body rows for the ones you supply.

## Setting a frontmatter field

Frontmatter values are JSON, so they ride in `value` (not `content`). To set `alpha` to `2`:

```json
{ "targetType": "frontmatter", "target": "alpha", "operation": "replace", "value": 2 }
```

Add `"createTargetIfMissing": true` to create a field that might not exist yet. For `append`/`prepend`, `value` is merged into the existing value (list concat, dict merge, string concat).

## Adding and removing tags

Obsidian stores frontmatter tags in the `tags` field. To add `project/active`, merging into the list and creating it if absent:

```json
{ "targetType": "frontmatter", "target": "tags", "operation": "append", "value": ["project/active"], "createTargetIfMissing": true }
```

There is no direct "remove item" operation. To remove a tag, read the current list (GET, or `vault_read` in the MCP API), filter it client-side, and replace the whole field:

```json
{ "targetType": "frontmatter", "target": "tags", "operation": "replace", "value": ["remaining-tag-1", "remaining-tag-2"] }
```

## Moving a heading section

`scope: "parent"` with `operation: "replace"` re-parents (and re-levels) a section. To move "Details" under "Appendix" as its last child:

```json
{
  "targetType": "heading",
  "target": ["Overview", "Details"],
  "operation": "replace",
  "scope": "parent",
  "destination": { "parent": ["Appendix"], "place": "last" }
}
```

`place` may be `"first"`, `"last"`, `{ "before": <heading path> }`, or `{ "after": <heading path> }`. Use `"parent": null` to move to the document root.

## Deleting

`operation: "delete"` empties the `content` scope, removes the whole subtree (`markerAndContent`), or dissolves just the heading line (`marker`):

```json
{ "targetType": "heading", "target": ["Heading 1", "Subheading 1:2"], "operation": "delete", "scope": "markerAndContent" }
```

## Optimistic concurrency

Pass `ifMatch` with the `version` token from a document map (see below). If the file changed since, the patch fails with `412` and the file is untouched — refetch and retry.

## Identifying patch targets in a file

Issue a GET request to `/vault/{path}` with an `Accept` header of `application/vnd.olrapi.document-map+json` to get the headings, block references, and frontmatter fields present in the file (and its `version` token).

# Deprecated: the 1.x header-driven format

The earlier PATCH format spread the instruction across `Operation`, `Target-Type`, `Target`, `Target-Delimiter`, `Target-Scope`, `Create-Target-If-Missing`, `Reject-If-Content-Preexists`, and `Trim-Target-Whitespace` headers, with the payload in a `text/markdown` (or JSON-string) body. **It is deprecated and will be removed in 6.0.** Requests that use it still work, but every response carries a `Deprecation: true; sunset-version="6.0"` header.

The JSON-instruction format described above is the default. To use the deprecated format, send `Markdown-Patch-Version: 1`; the header also selects the 1.x document map (`::`-joined heading paths, no `version`) on GET. Without it (or with `Markdown-Patch-Version: 2`), the instruction format described above handles the request, and a non-object body is rejected with `400 InvalidPatchInstruction`. To upgrade, drop the header and move each 1.x header into the JSON body:

| 1.x header | Instruction field |
| --- | --- |
| `Operation: append` | `"operation": "append"` (now also `"delete"`) |
| `Target-Type: heading` | `"targetType": "heading"` |
| `Target: A::B` (+ `Target-Delimiter`) | `"target": ["A", "B"]` (a real array — no delimiter) |
| `Target-Scope: content` | `"scope": "content"` (adds `"parent"` for moves) |
| body (`text/markdown`) | `"content": "..."` |
| body (`application/json` value) | `"value": <json>` |
| `Create-Target-If-Missing: true` | `"createTargetIfMissing": true` |
| `Reject-If-Content-Preexists: true` | `"rejectIfContentPreexists": true` |
| `Trim-Target-Whitespace` | *(dropped; the engine owns boundary whitespace)* |
