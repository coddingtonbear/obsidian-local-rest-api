Establishes a Server-Sent Events (SSE) stream for the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/).

Point any MCP-compatible client (Claude Desktop, Cursor, or any MCP SDK client) at this endpoint with your API key as the bearer token. On connection the server emits an `endpoint` SSE event containing the POST URL including the session ID; the client then sends JSON-RPC 2.0 messages to `POST /mcp/?sessionId=<id>`.

## Available tools

| Tool | Description |
|---|---|
| `vault_list` | List files and subdirectories inside a vault directory |
| `vault_read` | Read a file's full content, frontmatter, tags, and stat |
| `vault_write` | Create or overwrite a vault file |
| `vault_append` | Append content to the end of a vault file |
| `vault_patch` | Patch a specific heading, block reference, or frontmatter field |
| `vault_delete` | Delete a vault file |
| `active_file_read` | Read the file currently open in Obsidian |
| `active_file_write` | Overwrite the file currently open in Obsidian |
| `active_file_append` | Append content to the file currently open in Obsidian |
| `periodic_note_read` | Read the current periodic note (daily, weekly, monthly, quarterly, yearly) |
| `periodic_note_write` | Write (or create) the current periodic note |
| `periodic_note_append` | Append content to the current periodic note |
| `search_query` | Search using a JsonLogic query evaluated against each note's metadata |
| `search_simple` | Full-text search using Obsidian's built-in search |
| `tags_list` | List all tags across the vault with usage counts |
| `commands_list` | List all registered Obsidian commands |
| `command_execute` | Execute an Obsidian command by ID |
| `open_file` | Open a file in the Obsidian UI |

## Available resources

| URI | Description |
|---|---|
| `obsidian://local-rest-api/openapi.yaml` | Full OpenAPI specification for this REST API |
