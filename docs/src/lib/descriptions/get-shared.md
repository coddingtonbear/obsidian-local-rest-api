# Selecting Sub-parts of your Document

You can retrieve a specific section of the note by providing the `Target-Type` and `Target` headers:

- Set `Target-Type` to `heading`, `block`, or `frontmatter`.
- Set `Target` to the name of the heading, block reference, or frontmatter field to retrieve. If the target contains non-ASCII characters (e.g. accented letters), percent-encode the value (e.g. `H%C3%A9llo` for `Héllo`).
- For nested headings, use the `Target-Delimiter` header (default `::`) to separate levels.

When `Target-Type` is `frontmatter`, the response is `application/json`. Otherwise the section content is returned as `text/markdown`.

For vault file routes, you can also embed the target type and target directly in the URL path after the filename instead of using headers. The segment immediately following the filename is the target type, and the remaining segments form the target:

- `/vault/notes/daily.md/heading/My%20Section` is equivalent to requesting `/vault/notes/daily.md` with `Target-Type: heading` and `Target: My%20Section`.
- For nested headings, add additional path segments: `/vault/notes/daily.md/heading/My%20Section/Subsection` is equivalent to `Target: My%20Section::Subsection`.
- `/vault/notes/daily.md/frontmatter/tags` retrieves the `tags` frontmatter field.
- `/vault/notes/daily.md/block/abc123` retrieves the block with reference ID `abc123`.

When URL-embedded values are present they take priority over the corresponding headers.

# Retrieving Document Metadata

## Metadata

If you specify the header `Accept: application/vnd.olrapi.note+json`, will return a JSON representation of your note including parsed tag and frontmatter data as well as filesystem metadata.

## Document Map

If you specify the header `Accept: application/vnd.olrapi.document-map+json`, will return a JSON object outlining what PATCH targets exist. See "responses" below for details.
