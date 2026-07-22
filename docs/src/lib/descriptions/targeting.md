# Targeting a Sub-part of your Document

You can operate on a specific section of a note instead of the whole file by embedding a target in the URL path, immediately after the note identifier. The first segment after the note is the target type, and the remaining segments address the target:

- `.../heading/My%20Section` targets the section beneath the `My Section` heading — the body content below the heading line.
- For a nested heading, add one path segment per level: `.../heading/My%20Section/Subsection` targets `Subsection` under `My Section`. Because each level is its own segment, a heading whose text contains `::` (or any other delimiter) needs no escaping.
- `.../block/abc123` targets the block with reference ID `abc123`.
- `.../frontmatter/fieldName` targets the `fieldName` frontmatter field.

Percent-encode any segment that contains non-ASCII characters or a literal `/` (e.g. `H%C3%A9llo` for `Héllo`).

If a document has a duplicate sibling heading (the same text repeated under the same parent) or a duplicate block reference ID, only the first occurrence is addressable by its plain text/id. Each later occurrence gets its own address with a non-printable marker suffix appended by the server — fetch the document map (`Accept: application/vnd.olrapi.document-map+json`) and copy that occurrence's key verbatim; don't try to type or reconstruct the marker yourself.

`GET` returns just the addressed section. `PUT` replaces it and `POST` appends to it, with heading levels normalized and separator whitespace managed for you. `PATCH` also accepts a URL target — its raw-content mode — with the operation and other instruction fields in headers (`Operation`, `Target-Scope`, …) and the raw payload as the body. For the full instruction algebra (renames, moves, deletes, typed frontmatter values), see the PATCH documentation.

On `PUT` and `POST`, the `Content-Type` of your request body selects how the payload is interpreted, and not every target accepts both:

- A `text/markdown` body is literal markdown. Valid for `heading` and `block` targets. On a `frontmatter` target it is stored as the field's plain string value.
- An `application/json` body is structured data. On a `block` target that addresses a table, it is a 2-D array of row cells (`[["Chicago", "16"]]`). On a `frontmatter` target it is the field's typed value (a list, dictionary, number, or string). A `heading` target has no structured form — its body is markdown text — so a JSON body there is rejected with `400 InvalidPatchInstruction` rather than being stringified into your note.

## Deprecated: header-based targeting

Earlier releases addressed a sub-part with `Target-Type`, `Target`, and `Target-Delimiter` request headers (plus `Target-Scope` and `Trim-Target-Whitespace`) rather than URL path segments. **That form is deprecated and will be removed in 6.0.** It is only processed when you also send `Markdown-Patch-Version: 1`, and responses served that way carry a `Deprecation: true; sunset-version="6.0"` header. On GET/PUT/POST, supplying those targeting headers without that version is rejected with `400 HeaderTargetingRequiresVersion1` — reach the sub-part with URL path segments instead. (On PATCH, `Target-Type`/`Target` headers also have a *non-deprecated* meaning under an explicit `Markdown-Patch-Version: 2` — raw-content mode, with a different `Target` encoding; see the PATCH documentation.) Supplying both URL-path targeting and the header form in one request fails with `422 ConflictingTargetSpecification`.
