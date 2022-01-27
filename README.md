# Local REST API for Obsidian

## Endpoints

### Vault Files: `/vault/{pathToFile}`

#### `GET`

Returns the content of the file at the specified path in your open vault if the specified file 

#### `PUT`

Updates content of the file at the specified path with the content of your request body.

#### `PATCH`

Inserts the content of your request body into the file at the specified path under the heading specified in your request's `Heading` header.

There are a handful of headings you can use for controlling exactly where your content is inserted:

* `Heading`: **Required** Name of the heading at which you would like your content inserted.  Can be restricted to matching heading names having specified parents by separating headings with `::` (e.g. "Some Section::Overview" to target the heading named "Overview" below "Some Section"), otherwise accepts the first matching heading name.
* `Content-Insertion-Position`: *Default: 'end'* Controls where content is inserted under the specified heading.  If set to 'beginning', content will be inserted immediately after the specified heading.  If set to 'end', content will be inserted immediately before the next heading.
* `Heading-Boundary`: *Default: `::`* Instead of using `::` as the heading delimiter, you can specify your own delimiter.  This is useful if `::` happens to appear within your headings.

#### `DELETE`

Deletes the file at the specified path.

### Vault Directories: `/vault/{pathToDirectory}`

#### `GET`

Returns a directory listing in the following format:

```json
{
  "files": [
    "fileOne.md",
    "fileTwo.md",
    "someDirectory/",
  ]
}
```

#### `POST`

Creates a new file in the specified directory having a name matching the current timestamp in the following format `YYYYMMDDTHHmmss.md` using your request's body.


### Periodic Notes: `/periodic/{daily|weekly|monthly|quarterly|yearly}/`

#### `GET`

Redirects to the current periodic note for the specified period.

#### `POST`

Creates a new periodic note for the specified period.
