# Retrieving Document Metadata

## Metadata

If you specify the header `Accept: application/vnd.olrapi.note+json`, will return a JSON representation of your note including parsed tag and frontmatter data as well as filesystem metadata.

## Document Map

If you specify the header `Accept: application/vnd.olrapi.document-map+json`, will return a JSON object outlining what PATCH targets exist. See "responses" below for details.

## Rendered HTML

If you specify the header `Accept: text/html`, will return the note rendered to HTML using Obsidian's own Markdown renderer — the same rendering used in Obsidian's preview mode, including embeds, callouts, and other Obsidian-flavored Markdown extensions. `Target-Type`/`Target` are ignored; the whole note is always rendered.
