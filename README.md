# Local REST API with MCP

Give your scripts, browser extensions, and AI agents a direct line into your Obsidian vault via a secure, authenticated REST API.

**Interactive API docs:** https://coddingtonbear.github.io/obsidian-local-rest-api/

## What you can do

Access your vault through the **REST API** or the **built-in [MCP server](https://modelcontextprotocol.io/)** — both interfaces expose the same core capabilities, so scripts, browser extensions, and AI agents all speak the same language.

- **Read, create, update, or delete notes** — full CRUD on any file in your vault, including binary files
- **Surgically patch specific sections** — target a heading, block reference, or frontmatter key and append, prepend, replace, delete, or move just that section without touching the rest of the file
- **Search your vault** — simple full-text search or structured [JsonLogic](https://jsonlogic.com/) queries against note metadata (frontmatter, tags, path, content)
- **Access the active file** — read or write whatever note is currently open in Obsidian
- **Work with periodic notes** — get or create daily, weekly, monthly, quarterly, and yearly notes
- **List and execute commands** — trigger any Obsidian command as if you'd used the command palette
- **Query tags** — list all tags across your vault with usage counts
- **Open files in Obsidian** — tell Obsidian to open a specific note in its UI
- **Extend the API** — other plugins can register their own routes via the [API extension interface](https://github.com/coddingtonbear/obsidian-local-rest-api/wiki/Adding-your-own-API-Routes-via-an-Extension)

All requests are served over HTTPS with a self-signed certificate and gated behind API key authentication.

## Quick start

After installing and enabling the plugin, open **Settings → Local REST API** to find your API key and certificate.

### REST API

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

# Append a line to a specific heading (PATCH with a JSON instruction)
curl -k -X PATCH \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  --data '{"targetType":"heading","target":["My Section"],"operation":"append","content":"New line of content"}' \
  https://127.0.0.1:27124/vault/path/to/note.md
```

To avoid certificate warnings, you can download and trust the certificate from `https://127.0.0.1:27124/obsidian-local-rest-api.crt`, or point your HTTP client at it directly.

### MCP clients

The MCP server runs at `https://127.0.0.1:27124/mcp/` and requires that you provide your bearer token for authentication via an `Authorization` header (i.e. `Authorization: Bearer <your-api-key>`). Because the plugin uses a self-signed certificate, you may need to either trust the certificate in your OS/client, or use the plain HTTP endpoint at `http://127.0.0.1:27123/mcp/` (enable it under **Settings → Local REST API → Enable HTTP server**).

#### Claude Code

Claude Code has native HTTP MCP support. The quickest way to add the server is via the CLI:

```sh
claude mcp add --transport http obsidian https://127.0.0.1:27124/mcp/ \
  --header "Authorization: Bearer <your-api-key>"
```

Or add it manually to `.mcp.json` in your project root (project-scoped) or configure it user-wide via `claude mcp add --scope user`:

```json
{
  "mcpServers": {
    "obsidian": {
      "type": "http",
      "url": "https://127.0.0.1:27124/mcp/",
      "headers": {
        "Authorization": "Bearer <your-api-key>"
      }
    }
  }
}
```

#### Claude Desktop

Claude Desktop does not natively support remote HTTP MCP servers, but you can bridge it with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) (requires Node.js). Add the following to `claude_desktop_config.json`:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": [
        "mcp-remote@latest",
        "https://127.0.0.1:27124/mcp/",
        "--header",
        "Authorization: Bearer <your-api-key>"
      ]
    }
  }
}
```

Restart Claude Desktop after saving the file.

#### Cursor

Cursor supports the Streamable HTTP MCP transport. Add the following to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project-specific):

```json
{
  "mcpServers": {
    "obsidian": {
      "url": "https://127.0.0.1:27124/mcp/",
      "headers": {
        "Authorization": "Bearer <your-api-key>"
      }
    }
  }
}
```

#### Other clients

Any MCP client that supports the Streamable HTTP transport can connect to `https://127.0.0.1:27124/mcp/` with an `Authorization: Bearer <your-api-key>` header. Consult your client's documentation for the exact configuration format.

## API overview

| Endpoint | Methods | Description |
|---|---|---|
| `/vault/{path}` | GET PUT PATCH POST DELETE | Read, write, or delete any file in your vault |
| `/active/` | GET PUT PATCH POST DELETE | Operate on the currently open file |
| `/periodic/{period}/` | GET PUT PATCH POST DELETE | Today's periodic note (`daily`, `weekly`, etc.) |
| `/periodic/{period}/{year}/{month}/{day}/` | GET PUT PATCH POST DELETE | Periodic note for a specific date |
| `/search/simple/` | POST | Full-text search across all notes |
| `/search/` | POST | Structured search via JsonLogic |
| `/commands/` | GET | List available Obsidian commands |
| `/commands/{commandId}/` | POST | Execute a command |
| `/tags/` | GET | List all tags with usage counts |
| `/open/{path}` | POST | Open a file in the Obsidian UI |
| `/` | GET | Server status and authentication check |
| `/mcp/` | GET POST | MCP (Model Context Protocol) server — connect AI agents directly to your vault |

For full request/response details, see the [interactive docs](https://coddingtonbear.github.io/obsidian-local-rest-api/).

## Patching notes

The `PATCH` method is one of the most useful features of this API. It lets you make targeted edits without rewriting entire files.

Send a JSON **instruction**: an **operation** (`replace`, `prepend`, `append`, or `delete`) applied to a **scope** (`content`, `marker`, `markerAndContent`, or `parent`) of a **target** — a heading (addressed as an array of heading texts from the top level down), a block reference, or a frontmatter key. The payload rides in `content` (a string), `value` (JSON, for frontmatter values), or `destination` (a heading move):

```sh
# Replace the value of a frontmatter field
curl -k -X PATCH \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  --data '{"targetType":"frontmatter","target":"status","operation":"replace","value":"done"}' \
  https://127.0.0.1:27124/vault/path/to/note.md
```

Heading levels inside a `content` string are relative to the target (a leading `#` becomes a direct child). Advisory warnings (e.g. a heading rebased past level 6) come back as percent-encoded JSON in the `Markdown-Patch-Warnings` response header — decode with `decodeURIComponent` before parsing. Pass `ifMatch` (the `version` from a document map) for optimistic concurrency.

> **Note:** Whitespace is spliced verbatim — your content goes in exactly as written at the edge of the target's span, and the API adds none of its own. A leading `\n` in your content is what produces a blank line before it, for `append` as much as for `prepend`. Without one your text ends up flush against whatever it lands next to, even where the document already looked well-spaced. See the [interactive docs](https://coddingtonbear.github.io/obsidian-local-rest-api/) for worked examples.

### Raw-content mode

If your client *templates* markdown into the request body (Shortcuts, Tasker, curl from a template), JSON-escaping that content into an instruction is fragile. Raw-content mode moves the instruction's fields out of the body — target in the URL (or in `Target-Type`/`Target` headers with an explicit `Markdown-Patch-Version: 2`), operation and options in headers — and the body is the raw payload, spliced verbatim:

```sh
# Append a templated line under a heading — no JSON escaping anywhere
curl -k -X PATCH \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Operation: append" \
  -H "Content-Type: text/markdown" \
  --data "- $TEMPLATED_CONTENT" \
  https://127.0.0.1:27124/vault/notes/daily.md/heading/Log
```

A `text/*` body is the `content` carrier, an `application/json` body the `value` carrier, and no body at all carries nothing (a `delete`, or a move via a `Destination` header). `Target-Scope`, `Create-Target-If-Missing`, `Reject-If-Content-Preexists`, and `If-Match` headers round out the instruction. See the [interactive docs](https://coddingtonbear.github.io/obsidian-local-rest-api/) for the header encodings and the full details.

> **Already using the older header-driven PATCH format?** It spread the instruction across request headers instead of a JSON body, and is **deprecated and will be removed in 6.0**. It still works — send `Markdown-Patch-Version: 1` to opt back into it (the same header also selects the legacy `::`-joined document map on GET), and responses served by it carry a `Deprecation: true; sunset-version="6.0"` header. To upgrade, drop that header and move each header into the JSON body; the [interactive docs](https://coddingtonbear.github.io/obsidian-local-rest-api/) have the field-by-field mapping table.

See the [interactive docs](https://coddingtonbear.github.io/obsidian-local-rest-api/) for the full instruction schema and options.

## Targeting specific sections

You can read or write a specific part of a note — a heading, block reference, or frontmatter field — without fetching or replacing the whole file. This works on GET, PUT, POST, and PATCH requests (for PATCH this is [raw-content mode](#raw-content-mode) — add an `Operation` header).

**Append `/<target-type>/<target>` after the filename.** Each nested heading level is its own path segment, so a heading whose text contains `::` needs no escaping:

```sh
# Read the content under a specific heading
curl -k -H "Authorization: Bearer <your-api-key>" \
  https://127.0.0.1:27124/vault/path/to/note.md/heading/My%20Section

# Read a nested heading (one path segment per level)
curl -k -H "Authorization: Bearer <your-api-key>" \
  https://127.0.0.1:27124/vault/path/to/note.md/heading/Work/Meetings

# Read a frontmatter field
curl -k -H "Authorization: Bearer <your-api-key>" \
  https://127.0.0.1:27124/vault/path/to/note.md/frontmatter/status

# Replace the content of a heading via PUT (heading levels are normalized for you)
curl -k -X PUT \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: text/markdown" \
  --data "Updated content" \
  https://127.0.0.1:27124/vault/path/to/note.md/heading/My%20Section

# Append to a heading via POST
curl -k -X POST \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: text/markdown" \
  --data "Appended content" \
  https://127.0.0.1:27124/vault/path/to/note.md/heading/My%20Section
```

Supported target types: `heading`, `block`, `frontmatter`.

> **Deprecated: header-based targeting.** Earlier releases targeted a section with `Target-Type`, `Target`, and `Target-Delimiter` headers (plus `Target-Scope`/`Trim-Target-Whitespace`). That form is **deprecated and will be removed in 6.0**; it is only processed when you also send `Markdown-Patch-Version: 1` (responses then carry a `Deprecation` header). Without it, supplying those targeting headers is rejected with `400`. Supplying both URL-path targeting and the header form on one request returns `422 Unprocessable Entity`.

## Searching

`POST /search/simple/?query=your+terms` runs Obsidian's built-in fuzzy search and returns matching filenames with scored context snippets.

`POST /search/` accepts a [JsonLogic](https://jsonlogic.com/) expression (content type `application/vnd.olrapi.jsonlogic+json`) and evaluates it against each note's metadata (frontmatter, tags, path, content).

## MCP (Model Context Protocol)

> [!NOTE]
> Several third-party MCP servers for Obsidian exist, but they are no longer necessary — this plugin ships a built-in MCP server that runs inside Obsidian and has direct access to your vault's live metadata, active file, periodic notes, and command palette. If you are currently using a third-party server, switching to this one is likely to give you better results.

The plugin includes a built-in MCP server at `/mcp/` so AI agents and MCP-compatible clients can interact with your vault without hand-crafting HTTP requests.

**Transport:** Streamable HTTP — API key authentication required.

### Connecting a client

Connect your MCP client to `https://127.0.0.1:27124/mcp/`. Authentication uses a bearer token — find your API key under **Settings → Local REST API**, then pass it as:

```
Authorization: Bearer <your-api-key>
```

The exact config syntax varies by client; see the [Quick start](#mcp-clients) examples above or consult your client's documentation for Streamable HTTP remote MCP servers.

> [!WARNING]
> To connect to the MCP server securely, your client must trust the plugin's self-signed certificate. You can download and trust it from `https://127.0.0.1:27124/obsidian-local-rest-api.crt`, or configure your client to skip TLS verification for `127.0.0.1`.
>
> If trusting a self-signed certificate is not possible in your environment, you can connect insecurely using `http://127.0.0.1:27123/mcp/`
> instead of `https://127.0.0.1:27124/mcp/` if you have enabled the HTTP endpoint under **Settings → Local REST API → Enable HTTP server**.

### Available tools

| Tool | Description |
|---|---|
| `vault_list` | List files and subdirectories inside a vault directory |
| `vault_read` | Read a file's content, frontmatter, tags, and stat |
| `vault_write` | Create or overwrite a vault file |
| `vault_append` | Append content to the end of a vault file |
| `vault_patch` | Patch a specific heading, block reference, or frontmatter field |
| `vault_delete` | Delete a vault file |
| `vault_move` | Move (rename) a vault file to a new path |
| `vault_get_document_map` | List the headings, block references, and frontmatter fields in a file |
| `active_file_get_path` | Return the vault path of the file currently open in Obsidian |
| `periodic_note_get_path` | Return the vault path of the current periodic note (`daily`, `weekly`, `monthly`, `quarterly`, `yearly`) |
| `search_query` | Search using a [JsonLogic](https://jsonlogic.com/) query against note metadata |
| `search_simple` | Full-text search using Obsidian's built-in search |
| `tag_list` | List all tags across the vault with usage counts |
| `command_list` | List all registered Obsidian commands |
| `command_execute` | Execute an Obsidian command by ID |
| `open_file` | Open a file in the Obsidian UI |

### Available resources

| URI | Description |
|---|---|
| `obsidian://local-rest-api/openapi.yaml` | Full OpenAPI specification for this REST API |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). If you want to add functionality without modifying core, consider building an [API extension](https://github.com/coddingtonbear/obsidian-local-rest-api/wiki/Adding-your-own-API-Routes-via-an-Extension) instead — extensions can be developed and released independently.

## Credits

Inspired by [Vinzent03](https://github.com/Vinzent03)'s [advanced-uri plugin](https://github.com/Vinzent03/obsidian-advanced-uri), with the goal of expanding automation options beyond the constraints of custom URL schemes.
