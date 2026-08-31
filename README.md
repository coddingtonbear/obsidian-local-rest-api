# Local REST API with MCP

Give your scripts, browser extensions, and AI agents a direct line into your Obsidian vault via a secure, authenticated REST API.

- **Interactive API docs:** https://coddingtonbear.github.io/obsidian-local-rest-api/
- **Obsidian Community page:** https://community.obsidian.md/plugins/obsidian-local-rest-api/

<!-- toc -->

- [What you can do](#what-you-can-do)
- [Quick start](#quick-start)
  * [REST API](#rest-api)
  * [MCP clients](#mcp-clients)
    + [Claude Code](#claude-code)
    + [Claude Desktop](#claude-desktop)
    + [Cursor](#cursor)
    + [Other clients](#other-clients)
- [API overview](#api-overview)
  * [Browser clients and response headers](#browser-clients-and-response-headers)
- [Patching notes](#patching-notes)
  * [Raw-content mode](#raw-content-mode)
- [Targeting specific sections](#targeting-specific-sections)
- [Searching](#searching)
- [MCP (Model Context Protocol)](#mcp-model-context-protocol)
  * [Protocol revisions](#protocol-revisions)
  * [Connecting a client](#connecting-a-client)
  * [Available tools](#available-tools)
  * [Binary files and attachments](#binary-files-and-attachments)
  * [Available resources](#available-resources)
- [API Extensions](#api-extensions)
  * [Typed extension API](#typed-extension-api)
  * [Known extensions](#known-extensions)
- [Contributing](#contributing)
- [Credits](#credits)

<!-- tocstop -->

## What you can do

Access your vault through the **REST API** or the **built-in [MCP server](https://modelcontextprotocol.io/)** — both interfaces expose the same core capabilities, so scripts, browser extensions, and AI agents all speak the same language.

- **Read, create, update, or delete notes** — full CRUD on any file in your vault, including binary files
- **Surgically patch specific sections** — target a heading, block reference, or frontmatter key and append, prepend, replace, delete, or move just that section without touching the rest of the file
- **Search your vault** — simple full-text search or structured [JsonLogic](https://jsonlogic.com/) queries against note metadata (frontmatter, tags, path, content)
- **Access the active file** — read or write whatever note is currently open in Obsidian
- **List and execute commands** — trigger any Obsidian command as if you'd used the command palette
- **Query tags** — list all tags across your vault with usage counts
- **Open files in Obsidian** — tell Obsidian to open a specific note in its UI
- **Extend the API** — other plugins can register their own routes via the [API extension interface](https://github.com/coddingtonbear/obsidian-local-rest-api/wiki/Adding-your-own-API-Routes-via-an-Extension)

All requests are served over HTTPS with a locally generated certificate and gated behind API key authentication.

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

To avoid certificate warnings, you can download the plugin's certificate authority from `https://127.0.0.1:27124/obsidian-local-rest-api.crt` and trust it in your OS or browser, or point your HTTP client at it directly (for example `curl --cacert obsidian-local-rest-api.crt ...`). The plugin generates its own certificate authority on first run and serves a server certificate signed by it, so the download is a CA certificate rather than the server certificate itself. That CA is name-constrained: it can only vouch for `127.0.0.1`, `localhost`, your configured binding host, and the hostnames you list under **Subject alternative names**, so trusting it does not let it (or anyone who obtains its key) impersonate other sites.

### MCP clients

The MCP server runs at `https://127.0.0.1:27124/mcp/` and requires that you provide your bearer token for authentication via an `Authorization` header (i.e. `Authorization: Bearer <your-api-key>`). Because the plugin uses a locally generated certificate authority, you may need to either trust that certificate in your OS/client, or use the plain HTTP endpoint at `http://127.0.0.1:27123/mcp/` (enable it under **Settings → Local REST API → Enable HTTP server**).

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
| `/search/simple/` | POST | Full-text search across all notes |
| `/search/` | POST | Structured search via JsonLogic |
| `/commands/` | GET | List available Obsidian commands |
| `/commands/{commandId}/` | POST | Execute a command |
| `/tags/` | GET | List all tags with usage counts |
| `/open/{path}` | POST | Open a file in the Obsidian UI |
| `/` | GET | Server status and authentication check |
| `/mcp/` | GET POST | MCP (Model Context Protocol) server — connect AI agents directly to your vault |

For full request/response details, see the [interactive docs](https://coddingtonbear.github.io/obsidian-local-rest-api/).

### Browser clients and response headers

Several endpoints answer in a response header rather than in the body: `Content-Location` tells you where a write actually landed, `Markdown-Patch-Warnings` reports what a `PATCH` had to work around, `Deprecation` warns that a format is sunsetting, and `Mcp-Session-Id` carries the session for a sessionful MCP connection.

Browsers hide response headers from JavaScript unless the server opts them in, so the API sends `Access-Control-Expose-Headers: *` and all of them are readable with `response.headers.get(...)`. Safari honours the wildcard from 15.4 onward; older browsers see only the [CORS-safelisted headers](https://developer.mozilla.org/en-US/docs/Glossary/CORS-safelisted_response_header). Requests made with `credentials: "include"` are not supported — the API authenticates with a bearer token and sends `Access-Control-Allow-Origin: *`, which browsers reject for credentialed requests.

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

> **Note:** Whitespace is library-owned — your content is reduced to trimmed, canonical form (leading and trailing blank lines are meaningless), and the API itself supplies the blank line wherever inserted content faces body text, so an `append` or `prepend` always lands as its own block and never merges into an existing paragraph. Heading lines, existing blank lines, and each document's spacing style are preserved as-is. See the [interactive docs](https://coddingtonbear.github.io/obsidian-local-rest-api/) for worked examples.

To *continue* an existing block instead of starting a new one — say, extending a list — add `within` to a heading instruction: an index selecting one of the section's top-level body blocks (0-based in document order, negative counting from the end, so `-1` is the last block). A `within` edit splices literally, so you own the joint:

```sh
# Add an item to the last list under "Log" (the leading \n continues the block)
curl -k -X PATCH \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  --data '{"targetType":"heading","target":["Log"],"within":-1,"operation":"append","content":"\n- new item"}' \
  https://127.0.0.1:27124/vault/path/to/note.md
```

With `markerAndContent` scope, `prepend`/`append` instead insert a *new* block beside the indexed one. Indices are positional, so read the document map first and pair the edit with `ifMatch`.

### Raw-content mode

If your client *templates* markdown into the request body (Shortcuts, Tasker, curl from a template), JSON-escaping that content into an instruction is fragile. Raw-content mode moves the instruction's fields out of the body — target in the URL (or in `Target-Type`/`Target` headers with an explicit `Markdown-Patch-Version: 2`), operation and options in headers — and the body is the raw payload, no JSON escaping required:

```sh
# Append a templated line under a heading — no JSON escaping anywhere
curl -k -X PATCH \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Operation: append" \
  -H "Content-Type: text/markdown" \
  --data "- $TEMPLATED_CONTENT" \
  https://127.0.0.1:27124/vault/notes/daily.md/heading/Log
```

A `text/*` body is the `content` carrier, an `application/json` body the `value` carrier, and no body at all carries nothing (a `delete`, or a move via a `Destination` header). `Target-Scope`, `Within` (the instruction's `within` index as a plain integer, e.g. `-1`), `Create-Target-If-Missing`, `Reject-If-Content-Preexists`, and `If-Match` headers round out the instruction. See the [interactive docs](https://coddingtonbear.github.io/obsidian-local-rest-api/) for the header encodings and the full details.

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

On a GET, a `Target-Scope` header selects which part of the target comes back, mirroring the PATCH scopes: `content` (the default), `marker` (the label — a heading's raw text, a block's bare id, a frontmatter key), or `markerAndContent` (the whole node, in exactly the shape a PATCH `replace` at that scope consumes — a heading subtree reads back with its own line as `# Title`, levels relative to its parent):

```sh
# Read a whole section — heading line included — ready to edit and write back
curl -k -H "Authorization: Bearer <your-api-key>" \
  -H "Target-Scope: markerAndContent" \
  https://127.0.0.1:27124/vault/path/to/note.md/heading/My%20Section
```

> **Deprecated: header-based targeting.** Earlier releases targeted a section with `Target-Type`, `Target`, and `Target-Delimiter` headers (plus `Target-Scope`/`Trim-Target-Whitespace`). That form is **deprecated and will be removed in 6.0**; it is only processed when you also send `Markdown-Patch-Version: 1` (responses then carry a `Deprecation` header). Without it, supplying those targeting headers is rejected with `400`. Supplying both URL-path targeting and the header form on one request returns `422 Unprocessable Entity`.

## Searching

`POST /search/simple/?query=your+terms` runs Obsidian's built-in fuzzy search and returns matching filenames with scored context snippets.

`POST /search/` accepts a [JsonLogic](https://jsonlogic.com/) expression (content type `application/vnd.olrapi.jsonlogic+json`) and evaluates it against each note's metadata (frontmatter, tags, path, content).

## MCP (Model Context Protocol)

> [!NOTE]
> Several third-party MCP servers for Obsidian exist, but they are no longer necessary — this plugin ships a built-in MCP server that runs inside Obsidian and has direct access to your vault's live metadata, active file, and command palette. If you are currently using a third-party server, switching to this one is likely to give you better results.

The plugin includes a built-in MCP server at `/mcp/` so AI agents and MCP-compatible clients can interact with your vault without hand-crafting HTTP requests.

**Transport:** Streamable HTTP — API key authentication required.

### Protocol revisions

The endpoint serves the `2026-07-28` revision plus the sessionful revisions from `2024-10-07` through `2025-11-25`, choosing per request, so clients on either can share it.

The `2026-07-28` revision is stateless: there is no `initialize` handshake and no session, so the plugin neither issues nor reads the `Mcp-Session-Id` header. Each request carries its own protocol version and client identity in `params._meta`, repeats them in the `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` headers, and is answered on its own. Clients can call `server/discover` to learn the supported revisions and capabilities up front.

Clients that open with an `initialize` request are served the sessionful revision they negotiate: the handshake returns an `Mcp-Session-Id`, `GET /mcp/` opens that session's notification stream, and `DELETE /mcp/` ends it. Sessions exist only on this path, and they are what keeps the handshake's `listChanged` capabilities honest: when another plugin registers or removes an MCP tool, every live session is notified, while `2026-07-28` clients hear about it on a `subscriptions/listen` stream.

### Connecting a client

Connect your MCP client to `https://127.0.0.1:27124/mcp/`. Authentication uses a bearer token — find your API key under **Settings → Local REST API**, then pass it as:

```
Authorization: Bearer <your-api-key>
```

The exact config syntax varies by client; see the [Quick start](#mcp-clients) examples above or consult your client's documentation for Streamable HTTP remote MCP servers.

> [!WARNING]
> To connect to the MCP server securely, your client must trust the plugin's locally generated certificate authority. You can download and trust it from `https://127.0.0.1:27124/obsidian-local-rest-api.crt`, or configure your client to skip TLS verification for `127.0.0.1`.
>
> If trusting a locally generated certificate is not possible in your environment, you can connect insecurely using `http://127.0.0.1:27123/mcp/`
> instead of `https://127.0.0.1:27124/mcp/` if you have enabled the HTTP endpoint under **Settings → Local REST API → Enable HTTP server**.

### Available tools

| Tool | Description |
|---|---|
| `vault_list` | List files and subdirectories inside a vault directory |
| `vault_read` | Read a text file's content, frontmatter, tags, and stat; refuses anything that is not valid UTF-8 |
| `vault_read_binary` | Read a file as raw bytes, base64-encoded, for attachments `vault_read` would corrupt |
| `vault_write` | Create or overwrite a vault file |
| `vault_write_binary` | Create or overwrite a vault file from base64-encoded raw bytes |
| `vault_append` | Append content to the end of a vault file |
| `vault_patch` | Patch a specific heading, block reference, or frontmatter field |
| `vault_delete` | Delete a vault file (moves to trash by default) |
| `vault_move` | Move (rename) a vault file to a new path |
| `vault_copy` | Copy a vault file to a new path |
| `vault_get_document_map` | List the headings, block references, and frontmatter fields in a file |
| `active_file_get_path` | Return the vault path of the file currently open in Obsidian |
| `search_query` | Search using a [JsonLogic](https://jsonlogic.com/) query against note metadata |
| `search_simple` | Full-text search using Obsidian's built-in search |
| `tag_list` | List all tags across the vault with usage counts |
| `command_list` | List all registered Obsidian commands |
| `command_execute` | Execute an Obsidian command by ID |
| `open_file` | Open a file in the Obsidian UI |

### Binary files and attachments

The REST API has always handled binary content: `GET /vault/<path>` returns raw bytes with a `Content-Type` derived from the file extension, and `PUT /vault/<path>` accepts a body of any content type and stores it byte-for-byte. Neither has a practical size limit.

MCP tools are a different story, because a tool's arguments and results pass through the model. `vault_read` and `vault_write` are text tools — they decode and encode UTF-8, which is lossy for anything that is not text — so reading an attachment with `vault_read` and writing the result back destroys the file. `vault_read_binary` and `vault_write_binary` exist for those files, and carry the bytes base64-encoded.

`vault_write_binary` refuses a payload it cannot decode cleanly rather than writing the bytes it managed to salvage.

Because base64 costs roughly 0.35-0.45 tokens per byte of context, both binary tools refuse files over 1 MiB. That ceiling is a context guard, not a storage limit — move larger attachments over the REST endpoints above.

### Available resources

| URI | Description |
|---|---|
| `obsidian://local-rest-api/openapi.yaml` | Full OpenAPI specification for this REST API |

## API Extensions

Other plugins can register their own authenticated routes, public routes, and MCP tools against this plugin's server. See [Adding your own API Routes via an Extension](https://github.com/coddingtonbear/obsidian-local-rest-api/wiki/Adding-your-own-API-Routes-via-an-Extension) for a walkthrough.

### Typed extension API

Install this package as a development dependency to get `getAPI` and the types for everything it returns:

```
npm install --save-dev obsidian-local-rest-api
```

This package declares `obsidian`, `zod`, and `@types/express` as peer dependencies, because its types refer to all three — `addRoute` returns express's `IRoute`, and `addMcpTool` takes zod schemas. npm installs peers for you; if you pin them yourself, keep them resolvable. Without them, TypeScript quietly widens those positions to `any` instead of reporting an error, so a project that suppresses the missing-types diagnostic gets no warning that it has lost type checking exactly where it matters most.

```ts
import { getAPI, type LocalRestApiPublicApi } from "obsidian-local-rest-api";

const api: LocalRestApiPublicApi | undefined = getAPI(this.app, this.manifest, 2);
```

The package entry point is a small standalone module — it resolves the *running* host plugin out of Obsidian's plugin registry rather than pulling the plugin bundle into your build. Passing an extension API version (`2` above) makes `getAPI` throw `ApiVersionUnsupportedError` when the installed host is older than the surface you need; omit it to accept whatever is installed and feature-detect yourself. `getAPI` returns `undefined` when the plugin isn't installed or hasn't loaded yet.

`publicApi.d.ts` is generated from [`src/publicApi.ts`](src/publicApi.ts), which the implementation is compile-time-checked against, so the published types cannot drift from what the plugin actually offers.

### Known extensions

- [Periodic Notes](https://github.com/coddingtonbear/obsidian-local-rest-api-periodic-notes): Adds support for periodic notes

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). If you want to add functionality without modifying core, consider building an [API extension](https://github.com/coddingtonbear/obsidian-local-rest-api/wiki/Adding-your-own-API-Routes-via-an-Extension) instead — extensions can be developed and released independently.

## Credits

Inspired by [Vinzent03](https://github.com/Vinzent03)'s [advanced-uri plugin](https://github.com/Vinzent03/obsidian-advanced-uri), with the goal of expanding automation options beyond the constraints of custom URL schemes.
