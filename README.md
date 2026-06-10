# Local REST API with MCP

Give your scripts, browser extensions, and AI agents a direct line into your Obsidian vault via a secure, authenticated REST API.

**Interactive API docs:** https://coddingtonbear.github.io/obsidian-local-rest-api/

## What you can do

Access your vault through the **REST API** or the **built-in [MCP server](https://modelcontextprotocol.io/)** — both interfaces expose the same core capabilities, so scripts, browser extensions, and AI agents all speak the same language.

- **Read, create, update, or delete notes** — full CRUD on any file in your vault, including binary files
- **Surgically patch specific sections** — target a heading, block reference, or frontmatter key and append, prepend, or replace just that section without touching the rest of the file
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

### Google Antigravity - Desktop App & agy (Antigravity CLI tool)
Antigravity Desktop  & agy utilizes strict camelCase validation rules for configuration maps and relies on the base URL to identify streaming parameters. Add the following layout block directly inside your global configuration file at `~/.gemini/config/mcp_config.json`. Check the property keys as they may vary from Claude.

- **macOS:** `~/.gemini/config/mcp_config.json`

```json
{
  "mcpServers": {
    "obsidian": {
      "serverUrl": "http://127.0.0.1:27123/mcp/",
      "headers": {
        "Authorization": "Bearer <your-api-key>"
      }
    }
  }
}

Restart desktop app or terminal.

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
