# Targeting a Sub-part of your Document

You can operate on a specific section of a note instead of the whole file by providing `Target-Type` and `Target` headers:

- Set `Target-Type` to `heading`, `block`, or `frontmatter`.
- Set `Target` to the name of the heading, block reference, or frontmatter field. If the target contains non-ASCII characters (e.g. accented letters), percent-encode the value (e.g. `H%C3%A9llo` for `Héllo`).
- For nested headings, use the `Target-Delimiter` header (default `::`) to separate levels.

You can also embed the target type and target directly in the URL path after the note identifier instead of using headers. The segment immediately following the note identifier is the target type, and the remaining segments form the target:

- `.../heading/My%20Section` is equivalent to supplying `Target-Type: heading` and `Target: My%20Section`.
- For nested headings, add additional path segments: `.../heading/My%20Section/Subsection` is equivalent to `Target: My%20Section::Subsection`.
- `.../frontmatter/fieldName` targets the `fieldName` frontmatter field.
- `.../block/abc123` targets the block with reference ID `abc123`.

When URL-embedded values are present they take priority over the corresponding headers.
