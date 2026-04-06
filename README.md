# Local REST API for Obsidian

Give your scripts, browser extensions, and AI agents a direct line into your Obsidian vault via a secure, authenticated REST API.

**Interactive API docs:** https://coddingtonbear.github.io/obsidian-local-rest-api/

## What you can do

- **Read, create, update, or delete notes** — full CRUD on any file in your vault, including binary files
- **Surgically access parts of a note** — read, write, or patch a particular heading, block reference, or frontmatter field without touching the rest of the file.
- **Access the active file** — read or write whatever note is currently open in Obsidian
- **Work with periodic notes** — get or create daily, weekly, monthly, quarterly, and yearly notes
- **Search your vault** — simple full-text search, [Dataview DQL](https://blacksmithgu.github.io/obsidian-dataview/) queries, or [JsonLogic](https://jsonlogic.com/) expressions
- **List and execute commands** — trigger any Obsidian command as if you'd used the command palette
- **Query tags** — list all tags across your vault with usage counts
- **Open files in Obsidian** — tell Obsidian to open a specific note in its UI
- **Extend the API** — other plugins can register their own routes via the [API extension interface](https://github.com/coddingtonbear/obsidian-local-rest-api/wiki/Adding-your-own-API-Routes-via-an-Extension)

All requests are served over HTTPS with a self-signed certificate and gated behind API key authentication.

## Quick start

After installing and enabling the plugin, open **Settings → Local REST API** to find your API key and certificate. Then try:

```sh
# Check the server is running (no auth required)
curl -k https://127.0.0.1:27124/

# List files at the root of your vault
curl -k -H "Authorization: Bearer <your-api-key>" \
  https://127.0.0.1:27124/vault/

# Read a note
curl -k -H "Authorization: Bearer <your-api-key>" \
  https://127.0.0.1:27124/vault/path/to/note.md

# Read a specific heading (URL-embedded target)
curl -k -H "Authorization: Bearer <your-api-key>" \
  https://127.0.0.1:27124/vault/path/to/note.md/heading/My%20Section

# Append a line to a specific heading (PATCH with headers)
curl -k -X PATCH \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Operation: append" \
  -H "Target-Type: heading" \
  -H "Target: My Section" \
  -H "Content-Type: text/plain" \
  --data "New line of content" \
  https://127.0.0.1:27124/vault/path/to/note.md
```

To avoid certificate warnings, you can download and trust the certificate from `https://127.0.0.1:27124/obsidian-local-rest-api-certificate.crt`, or point your HTTP client at it directly.

## API overview

| Endpoint | Methods | Description |
|---|---|---|
| `/vault/{path}` | GET PUT PATCH POST DELETE | Read, write, or delete any file in your vault |
| `/active/` | GET PUT PATCH POST DELETE | Operate on the currently open file |
| `/periodic/{period}/` | GET PUT PATCH POST DELETE | Today's periodic note (`daily`, `weekly`, etc.) |
| `/periodic/{period}/{year}/{month}/{day}/` | GET PUT PATCH POST DELETE | Periodic note for a specific date |
| `/search/simple/` | POST | Full-text search across all notes |
| `/search/` | POST | Structured search via Dataview DQL or JsonLogic |
| `/commands/` | GET | List available Obsidian commands |
| `/commands/{commandId}/` | POST | Execute a command |
| `/tags/` | GET | List all tags with usage counts |
| `/open/{path}` | POST | Open a file in the Obsidian UI |
| `/` | GET | Server status and authentication check |

For full request/response details, see the [interactive docs](https://coddingtonbear.github.io/obsidian-local-rest-api/).

## Patching notes

The `PATCH` method is one of the most useful features of this API. It lets you make targeted edits without rewriting entire files.

Specify a **target** (a heading, block reference, or frontmatter key) and an **operation** (`append`, `prepend`, or `replace`), and the plugin will apply the change precisely:

```sh
# Replace the value of a frontmatter field
curl -k -X PATCH \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Operation: replace" \
  -H "Target-Type: frontmatter" \
  -H "Target: status" \
  -H "Content-Type: application/json" \
  --data '"done"' \
  https://127.0.0.1:27124/vault/path/to/note.md
```

See the [interactive docs](https://coddingtonbear.github.io/obsidian-local-rest-api/) for the full list of request headers and options.

## Targeting specific sections

You can read or write a specific part of a note — a heading, block reference, or frontmatter field — without fetching or replacing the whole file. This works on GET, PUT, POST, and PATCH requests.

There are two ways to specify the target:

**Headers** — add `Target-Type` and `Target` to any request:

```sh
# Read the content under a specific heading
curl -k -H "Authorization: Bearer <your-api-key>" \
  -H "Target-Type: heading" \
  -H "Target: My Section" \
  https://127.0.0.1:27124/vault/path/to/note.md

# Read a frontmatter field
curl -k -H "Authorization: Bearer <your-api-key>" \
  -H "Target-Type: frontmatter" \
  -H "Target: status" \
  https://127.0.0.1:27124/vault/path/to/note.md
```

**URL path segments** (GET, PUT, and POST only) — append `/<target-type>/<target>` after the filename:

```sh
# Read a specific heading
curl -k -H "Authorization: Bearer <your-api-key>" \
  https://127.0.0.1:27124/vault/path/to/note.md/heading/My%20Section

# Read a nested heading (levels separated by ::)
curl -k -H "Authorization: Bearer <your-api-key>" \
  https://127.0.0.1:27124/vault/path/to/note.md/heading/Work/Meetings

# Read a frontmatter field
curl -k -H "Authorization: Bearer <your-api-key>" \
  https://127.0.0.1:27124/vault/path/to/note.md/frontmatter/status

# Replace the content of a heading via PUT
curl -k -X PUT \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: text/plain" \
  --data "Updated content" \
  https://127.0.0.1:27124/vault/path/to/note.md/heading/My%20Section

# Append to a heading via POST
curl -k -X POST \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: text/plain" \
  --data "Appended content" \
  https://127.0.0.1:27124/vault/path/to/note.md/heading/My%20Section
```

Supported target types: `heading`, `block`, `frontmatter`. Supplying both URL-embedded targets and the equivalent headers on the same request returns `422 Unprocessable Entity`.

## Searching

`POST /search/simple/?query=your+terms` runs Obsidian's built-in fuzzy search and returns matching filenames with scored context snippets.

`POST /search/` supports two richer formats depending on the `Content-Type` header:

- `application/vnd.olrapi.dataview.dql+txt` — run a [Dataview TABLE query](https://blacksmithgu.github.io/obsidian-dataview/) and get back matching files with field values
- `application/vnd.olrapi.jsonlogic+json` — evaluate a [JsonLogic](https://jsonlogic.com/) expression against each note's metadata (frontmatter, tags, path, content)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). If you want to add functionality without modifying core, consider building an [API extension](https://github.com/coddingtonbear/obsidian-local-rest-api/wiki/Adding-your-own-API-Routes-via-an-Extension) instead — extensions can be developed and released independently.

## Credits

Inspired by [Vinzent03](https://github.com/Vinzent03)'s [advanced-uri plugin](https://github.com/Vinzent03/obsidian-advanced-uri), with the goal of expanding automation options beyond the constraints of custom URL schemes.
