# Targeting a Sub-part of your Document

You can operate on a specific section of a note instead of the whole file by providing `Target-Type` and `Target` headers:

- Set `Target-Type` to `heading`, `block`, or `frontmatter`. When `Target-Type` is `heading`, the operation applies to the body content *beneath* that heading line — the heading line itself (`## My Section`) is not part of the section and should not appear in the patched content.
- Set `Target` to the name of the heading, block reference, or frontmatter field. If the target contains non-ASCII characters (e.g. accented letters), percent-encode the value (e.g. `H%C3%A9llo` for `Héllo`).
- For nested headings, use the `Target-Delimiter` header (default `::`) to separate levels.

You can also embed the target type and target directly in the URL path after the note identifier instead of using headers. The segment immediately following the note identifier is the target type, and the remaining segments form the target:

- `.../heading/My%20Section` is equivalent to supplying `Target-Type: heading` and `Target: My%20Section`.
- For nested headings, add additional path segments: `.../heading/My%20Section/Subsection` is equivalent to `Target: My%20Section::Subsection`.
- `.../frontmatter/fieldName` targets the `fieldName` frontmatter field.
- `.../block/abc123` targets the block with reference ID `abc123`.

Do not combine URL-embedded targeting with `Target-Type`, `Target`, or `Target-Delimiter` headers in the same request. If both are provided, the request fails with `422 ConflictingTargetSpecification`.

## Target-Scope

For `heading` and `block` targets, the optional `Target-Scope` header controls which portion of the target the operation acts on:

- `content` (default): the operation applies to the content region — the area beneath the heading line or at the block, leaving the heading/block-ID token unchanged.
- `marker`: the operation applies only to the heading line or block-ID token itself, leaving the content unchanged. Useful for renaming a heading in-place with a `replace` operation without touching the section content.
- `markerAndContent`: the operation applies to the full range covering both the heading/block-ID token and its content, allowing them to be replaced or repositioned together.

### Renaming a heading

**Prefer `PATCH` for this.** Its JSON instruction format renames a heading from just the new text — `{"targetType": "heading", "target": ["Heading 1", "Subheading"], "operation": "replace", "scope": "marker", "content": "New Name"}` — with no `#` characters and no need to know the heading's depth. See the `PATCH` documentation.

On the header-driven verbs below, the rules are different and stricter. Here the `marker` and `markerAndContent` scopes address the heading *line*, `#` characters included, so a replacement must carry the same number of leading `#`s as the original or the heading is silently demoted to a plain paragraph:

```
# Rename "## Subheading" to "## New Name" (note the leading "##")
curl -k -X PUT \
  https://127.0.0.1:27124/vault/path/to/note.md \
  -H "Authorization: Bearer $OBSIDIAN_API_KEY" \
  -H "Target-Type: heading" \
  -H "Target: Heading 1::Subheading" \
  -H "Target-Scope: marker" \
  -H "Content-Type: text/markdown" \
  --data "## New Name"
```

The depth isn't shown directly anywhere: the document map lists heading paths, not raw markdown, so infer it from the path length — `["Heading 1", "Subheading"]` is 2 deep, hence `##`.

Omitting the `#`s is valid, and is how you deliberately demote a heading to plain text — just make sure that is the intent.

> **Migrating to `PATCH`?** These two rules are exact opposites. `PATCH` does not strip `#` characters; it takes them as part of the label, so a carried-over `"## New Name"` renames the heading to the literal text `## New Name`. Drop the `#`s when you move.
