# Targeting a Sub-part of your Document

You can operate on a specific section of a note instead of the whole file by embedding a target in the URL path, immediately after the note identifier. The first segment after the note is the target type, and the remaining segments address the target:

- `.../heading/My%20Section` targets the section beneath the `My Section` heading — the body content below the heading line.
- For a nested heading, add one path segment per level: `.../heading/My%20Section/Subsection` targets `Subsection` under `My Section`. Because each level is its own segment, a heading whose text contains `::` (or any other delimiter) needs no escaping.
- `.../block/abc123` targets the block with reference ID `abc123`.
- `.../frontmatter/fieldName` targets the `fieldName` frontmatter field.

Percent-encode any segment that contains non-ASCII characters or a literal `/` (e.g. `H%C3%A9llo` for `Héllo`).

`GET` returns just the addressed section. `PUT` replaces it and `POST` appends to it, with heading levels normalized and separator whitespace managed for you. To rename, move, or delete a heading, or to edit with a specific scope, use `PATCH` — its JSON instruction format is the full-featured way to edit a sub-part of a document. See its documentation.

## Deprecated: header-based targeting

Earlier releases addressed a sub-part with `Target-Type`, `Target`, and `Target-Delimiter` request headers (plus `Target-Scope` and `Trim-Target-Whitespace`) rather than URL path segments. **That form is deprecated and will be removed in 6.0.** It is only processed when you also send `Markdown-Patch-Version: 1`, and responses served that way carry a `Deprecation: true; sunset-version="6.0"` header. Without that header a request that supplies those targeting headers is rejected with `400 HeaderTargetingRequiresVersion1` — reach the sub-part with URL path segments instead. Supplying both URL-path targeting and the header form in one request fails with `422 ConflictingTargetSpecification`.
