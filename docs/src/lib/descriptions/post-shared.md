## Targeting a Sub-part of the Document

You can append to a specific section instead of the end of the file by supplying `Target-Type` and `Target` headers (or by embedding the target in the URL path — see the GET endpoint for details on URL-path targeting).

- Set `Target-Type` to `heading`, `block`, or `frontmatter`.
- Set `Target` to the heading name, block reference ID, or frontmatter field name. Percent-encode any non-ASCII characters (e.g. `H%C3%A9llo` for `Héllo`).
- For nested headings, use `Target-Delimiter` (default `::`) to separate levels, e.g. `Heading 1::Subheading`.

When a target is specified the content is appended within that section and the full updated file content is returned with a `200` status. Without a target, the content is appended to the end of the file and a `204` status is returned.

If you need `prepend` or `replace` operations, use `PATCH` instead.
