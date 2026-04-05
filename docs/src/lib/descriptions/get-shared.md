When `Target-Type` is `frontmatter`, the response is `application/json`. Otherwise the section content is returned as `text/markdown`.

# Retrieving Document Metadata

## Metadata

If you specify the header `Accept: application/vnd.olrapi.note+json`, will return a JSON representation of your note including parsed tag and frontmatter data as well as filesystem metadata.

## Document Map

If you specify the header `Accept: application/vnd.olrapi.document-map+json`, will return a JSON object outlining what PATCH targets exist. See "responses" below for details.
