Allows you to modify the content relative to a heading, block reference, or frontmatter field in your document.

# How to Use & Examples

All of the below examples assume you have a document that looks like
this:

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

## Append, Prepend, or Replace Content Below a Heading

If you wanted to append the content "Hello" below "Subheading 1:1:1" under "Heading 1",
you could send a request with the following headers:

- `Operation`: `append`
- `Target-Type`: `heading`
- `Target`: `Heading 1::Subheading 1:1:1` (percent-encode any non-ASCII characters, e.g. `H%C3%A9llo` for `Héllo`)
- with the request body: `Hello`

The above would work just fine for `prepend` or `replace`, too, of course,
but with different results.

> **Note:** The heading line itself (`### Subsubheading 1:1:1`) is not part of the section content. When using `replace`, supply only the body text that should appear beneath the heading — do not include the heading line in the request body, or it will be duplicated.

## Blank Lines Are Not Synthesized

The API only preserves a blank-line separator at the target boundary if one already existed there before the patch — it never inserts a new one. If the boundary you're writing across had no blank line to begin with (a heading immediately followed by its body with no gap, or two headings with nothing between them), your content is spliced in exactly where you supplied it, with no separator added. That includes:

- `append`, `replace`, and `Create-Target-If-Missing` — your content can end up glued directly onto whatever follows it (e.g. the next heading), all on one line.
- `prepend` — your content can end up glued directly onto whatever precedes it.
- Renaming a heading with `Target-Scope: marker` — the new heading line can end up glued onto its own body paragraph if there was no blank line separating them originally.

If you need a blank line where you're inserting, include it yourself: end your content with `\n\n` for `append`/`replace`/rename operations that should be separated from what follows, or start it with `\n\n` for `prepend`.

## Append, Prepend, or Replace Content to a Block Reference

If you wanted to append the content "Hello" below the block referenced by
"2d9b4a" above ("More random text."), you could send the following headers:

- `Operation`: `append`
- `Target-Type`: `block`
- `Target`: `2d9b4a`
- with the request body: `Hello`

The above would work just fine for `prepend` or `replace`, too, of course,
but with different results.

## Append, Prepend, or Replace a Row or Rows to/in a Table Referenced by a Block Reference

If you wanted to add a new city ("Chicago, IL") and population ("16") pair to the table above
referenced by the block reference `2c7cfa`, you could send the following
headers:

- `Operation`: `append`
- `Target-Type`: `block`
- `Target`: `2c7cfa`
- `Content-Type`: `application/json`
- with the request body: `[["Chicago, IL", "16"]]`

The use of a `Content-Type` of `application/json` allows the API
to infer that member of your array represents rows and columns of your
to append to the referenced table.  You can of course just use a
`Content-Type` of `text/markdown`, but in such a case you'll have to
format your table row manually instead of letting the library figure
it out for you.

You also have the option of using `prepend` (in which case, your new
row would be the first -- right below the table heading) or `replace` (in which
case all rows except the table heading would be replaced by the new row(s)
you supplied).

## Setting a Frontmatter Field

If you wanted to set the frontmatter field `alpha` to `2`, you could
send the following headers:

- `Operation`: `replace`
- `Target-Type`: `frontmatter`
- `Target`: `beep`
- with the request body `2`

If you're setting a frontmatter field that might not already exist
you may want to use the `Create-Target-If-Missing` header so the
new frontmatter field is created and set to your specified value
if it doesn't already exist.

You may find using a `Content-Type` of `application/json` to be
particularly useful in the case of frontmatter since frontmatter
fields' values are JSON data, and the API can be smarter about
interpreting your `prepend` or `append` requests if you specify
your data as JSON (particularly when appending, for example,
list items).

## Adding and Removing Tags

Obsidian stores tags in two places: the `tags` frontmatter field and as
inline `#tag` syntax in the document body. You can manage frontmatter tags
with the PATCH API.

### Adding a tag

To add the tag `project/active` to a document's frontmatter `tags` list:

- `Operation`: `append`
- `Target-Type`: `frontmatter`
- `Target`: `tags`
- `Content-Type`: `application/json`
- `Create-Target-If-Missing`: `true`
- with the request body: `["project/active"]`

Passing an array as `application/json` tells the API to merge individual
items into the existing list rather than replace the whole field.
`Create-Target-If-Missing` ensures the `tags` key is created when the
document has no frontmatter tags yet.

### Removing a tag

There is no direct "remove item from list" operation. To remove a tag,
first read the current tags via GET (or `vault_read` in the MCP API),
filter out the unwanted tag client-side, then replace the entire field:

- `Operation`: `replace`
- `Target-Type`: `frontmatter`
- `Target`: `tags`
- `Content-Type`: `application/json`
- with the request body: `["remaining-tag-1", "remaining-tag-2"]`

## Identifying Patch Targets in a File

You can issue a GET request to `/vault/files/{path}` with an `Accept` header
of `application/vnd.olrapi.document-map+json` to get a JSON object
outlining what headings, block references, and frontmatter fields exist.
