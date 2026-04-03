# Selecting Sub-parts of your Document

You can retrieve a specific section of the note by providing the `Target-Type` and `Target` headers:

- Set `Target-Type` to `heading`, `block`, or `frontmatter`.
- Set `Target` to the name of the heading, block reference, or frontmatter field to retrieve.
- For nested headings, use the `Target-Delimiter` header (default `::`) to separate levels.

When `Target-Type` is `frontmatter`, the response is `application/json`. Otherwise the section content is returned as `text/markdown`.

# Retrieving Document Metadata

## Metadata

If you specify the header `Accept: application/vnd.olrapi.note+json`, will return a JSON representation of your note including parsed tag and frontmatter data as well as filesystem metadata.

## Document Map

If you specify the header `Accept: application/vnd.olrapi.document-map+json`, will return a JSON object outlining what PATCH targets exist. See "responses" below for details.
