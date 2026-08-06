Interact with this plugin's MCP server using the [Streamable HTTP transport](https://modelcontextprotocol.io/docs/concepts/transports#streamable-http).

Point any MCP-compatible client (Claude Code, Cursor, or any MCP SDK client that supports the Streamable HTTP transport) at this endpoint and pass your API key as a bearer token.

## Protocol revisions

The endpoint serves the `2026-07-28` revision and, alongside it, the legacy revisions from `2024-10-07` through `2025-11-25`. Which one a request gets is decided per request, from the request itself — there are no sessions and the `Mcp-Session-Id` header is neither issued nor read.

**`2026-07-28` (recommended).** Every request stands alone: there is no `initialize` handshake, and each request carries its own protocol version and client identity in `params._meta`:

```json
{
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { "name": "my-client", "version": "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {}
}
```

Requests must also carry the standard headers — `MCP-Protocol-Version`, `Mcp-Method`, and (where the body names one) `Mcp-Name` — and each must agree with the body; a disagreement is answered with `400 Bad Request` and JSON-RPC error `-32020`. A protocol version the server does not serve is answered with `-32022`, and a malformed `_meta` envelope with `-32602`.

Call `server/discover` to learn the supported revisions, capabilities, and server identity in one request. Results carry `resultType`, and the cacheable ones (`server/discover`, `tools/list`, `resources/list`, `resources/templates/list`, `resources/read`) also carry the `ttlMs` and `cacheScope` freshness hints.

**Legacy revisions.** Clients that open with an `initialize` request are served the revision they negotiate, exactly as before. Serving is stateless, so no session ID is returned and none is expected on later requests. The `GET` stream and `DELETE` session-termination operations of those revisions are answered with `405 Method Not Allowed`; MCP SDK clients treat that as "no server-initiated stream" and carry on.

Requests with an unrecognized `MCP-Protocol-Version` value are rejected with `400 Bad Request`.

## Available tools

| Tool | Description |
|---|---|
| `vault_list` | List files and subdirectories inside a vault directory |
| `vault_read` | Read a file's full content, frontmatter, tags, and stat |
| `vault_write` | Create or overwrite a vault file |
| `vault_append` | Append content to the end of a vault file |
| `vault_patch` | Patch a specific heading, block reference, or frontmatter field |
| `vault_delete` | Delete a vault file (moves to trash by default) |
| `vault_move` | Move (rename) a vault file to a new path |
| `vault_copy` | Copy a vault file to a new path |
| `vault_get_document_map` | List the headings, block references, and frontmatter fields in a file |
| `active_file_get_path` | Return the vault path of the file currently open in Obsidian |
| `search_query` | Search using a JsonLogic query evaluated against each note's metadata |
| `search_simple` | Full-text search using Obsidian's built-in search |
| `tag_list` | List all tags across the vault with usage counts |
| `command_list` | List all registered Obsidian commands |
| `command_execute` | Execute an Obsidian command by ID |
| `open_file` | Open a file in the Obsidian UI |

## Available resources

| URI | Description |
|---|---|
| `obsidian://local-rest-api/openapi.yaml` | Full OpenAPI specification for this REST API |
