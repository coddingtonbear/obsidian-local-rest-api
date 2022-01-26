# REST API for Obsidian


## Endpoints

### `/vault/PATH/TO/FILE.md`

#### `GET`

Returns the content of the file at the specified path in your open vault if the specified file 

#### `PUT`

Updates content of the file at the specified path with the content of your request body.

#### `PATCH`

Inserts the content of your request body into the file at the specified path under the heading specified in your request's `Heading` header.

There are a handful of headings you can use for controlling exactly where your content is inserted:

* `Heading`: **Required** Name of the heading at which you would like your content inserted.  Can be restricted to matching heading names having specified parents by separating headings with `::` (e.g. "Some Section::Overview" to target the heading named "Overview" below "Some Section"), otherwise accepts the first matching heading name.
* `Heading-Insert`: *Default: Unset* If set, insert content immediately below the heading you specify using `Heading`, otherwise inserts content immediately before the next heading.
* `Heading-Boundary`: *Default: `::`* Instead of using `::` as the heading delimiter, you can specify your own delimiter.  This is useful if `::` happens to appear within your headings.

### `/vault/PATH/TO/DIRECTORY/`

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
