Interact with this plugin's MCP server using the [Streamable HTTP transport](https://modelcontextprotocol.io/docs/concepts/transports#streamable-http).

Point any MCP-compatible client (Claude Code, Cursor, or any MCP SDK client that supports the Streamable HTTP transport) at this endpoint and pass your API key as a bearer token. Send an `initialize` request via `POST /mcp/` to start a session; the server returns a session ID in the `Mcp-Session-Id` response header. Include that header on all subsequent requests.

Include the `MCP-Protocol-Version` header on all requests after initialization, set to the protocol version negotiated during the `initialize` exchange (e.g. `2025-06-18`). Requests with an unrecognized version value are rejected with `400 Bad Request`.

## Available tools

| Tool | Description |
|---|---|
| `vault_list` | List files and subdirectories inside a vault directory |
| `vault_read` | Read a file's full content, frontmatter, tags, and stat |
| `vault_write` | Create or overwrite a vault file |
| `vault_append` | Append content to the end of a vault file |
| `vault_patch` | Patch a specific heading, block reference, or frontmatter field |
| `vault_delete` | Delete a vault file |
| `vault_get_document_map` | List the headings, block references, and frontmatter fields in a file |
| `active_file_get_path` | Return the vault path of the file currently open in Obsidian |
| `periodic_note_get_path` | Return the vault path of the current periodic note (daily, weekly, monthly, quarterly, yearly) |
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
