Interact with this plugin's MCP server using the [Streamable HTTP transport](https://modelcontextprotocol.io/docs/concepts/transports#streamable-http).

Point any MCP-compatible client (Claude Code, Cursor, or any MCP SDK client that supports the Streamable HTTP transport) at this endpoint and pass your API key as a bearer token.

## Protocol revisions

The endpoint serves the `2026-07-28` revision and, alongside it, the sessionful revisions from `2024-10-07` through `2025-11-25`. Which one a request gets is decided per request, from the request itself — there are no sessions and the `Mcp-Session-Id` header is neither issued nor read.

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

**Sessionful revisions (`2024-10-07` through `2025-11-25`).** Clients that open with an `initialize` request are served the revision they negotiate, including sessions. The server returns a session ID in the `Mcp-Session-Id` response header; include it on every later request, use `GET /mcp/` with it to open the server-to-client notification stream, and `DELETE /mcp/` with it to end the session. A request naming a session that no longer exists is answered `404 Not Found`, which means the client should hand-shake again.

Sessions exist only on this path. They are what makes the `tools.listChanged` / `resources.listChanged` capabilities the handshake advertises true: when another plugin registers or removes an MCP tool, every live session is told over its notification stream. `2026-07-28` clients get the same news from a `subscriptions/listen` stream instead.

Requests with an unrecognized `MCP-Protocol-Version` value are rejected with `400 Bad Request`.

## Available tools

| Tool | Description |
|---|---|
| `vault_list` | List files and subdirectories inside a vault directory |
| `vault_read` | Read a text file's full content, frontmatter, tags, and stat; refuses anything that is not valid UTF-8 |
| `vault_read_binary` | Read an attachment: images as an image block, anything else as a signed download link or embedded bytes |
| `vault_get_download_url` | Mint a signed, expiring link to a file that works without the API key (only when signed URLs are enabled) |
| `vault_get_upload_url` | Mint a signed, single-use link for uploading a file over `PUT` (only when signed URLs are enabled) |
| `vault_write` | Create or overwrite a text file; refuses paths whose extension names a binary type |
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

### Binary files

`vault_read` and `vault_write` are text tools: they decode and encode UTF-8, which is lossy for anything that is not text. `vault_read` refuses a file whose bytes are not valid UTF-8, and `vault_write` and `vault_append` refuse a path whose extension names a binary type (image other than SVG, audio, video, font, PDF, archive), so the read-as-text-then-write-back mistake that destroys attachments is refused at both ends.

`vault_read_binary` reads attachments. A raster image is returned as an MCP `image` content block, downscaled to fit 1568px on its long side, with a text block giving its path, MIME type, size, and dimensions. An SVG is returned unchanged, as its source text in a `resource` block. An image still larger than 512 KiB once downscaled is returned as a `resource_link` instead, the same as any other oversized file -- or refused, with a pointer at the REST endpoint, when signed URLs are off and there is no link to give. Any other file is returned as a `resource_link` to a signed download URL when signed URLs are enabled, or embedded as base64 in a `resource` block when they are not and the file is under 512 KiB. `as: "bytes"` forces embedding; `as: "link"` forces a link.

The 512 KiB ceiling guards the renderer as well as the model's context: a tool result carrying roughly a megabyte or more of base64 crashes Obsidian's Electron renderer, taking this plugin's HTTP server down with it.

Clients vary in how much of a tool result they show. Some do not surface a `resource_link` to the person at all, and some render a text block's markdown as raw characters, so the tool descriptions tell the agent not to leave the person with nothing when the file is for them rather than for the agent.

The preferred route is for the agent to fetch the signed URL to scratch space and hand that local file to whatever its host uses to show a file. The picture then travels from the vault to the person's screen without its bytes passing through the agent's context -- no base64, no token cost for the pixels -- and it goes over `GET /vault/<path>`, which streams a large file happily, rather than through a tool result. Agents are told explicitly not to read the download back in, since that would pay exactly the cost the link exists to avoid. Where a host cannot do that, the fallback is to repeat the markdown link in the reply, which yields something clickable rather than a visible picture.

There is no upload tool that carries bytes through the model. Upload a file with `PUT /vault/{filename}` — with the API key, or with a signed upload URL from `vault_get_upload_url`.

### Signed URLs

On by default; can be turned off under Advanced settings, where the lifetime is also set (default 300 seconds). While enabled, `vault_get_download_url` and `vault_get_upload_url` are registered, and `vault_read_binary` links to non-image files instead of embedding them.

A signed URL authorizes a **whole-file** write to exactly the path it names. The signature covers the method, the normalized path, the expiry and a random per-link nonce (`n`), and nothing else — so a request that also carries `Target-Type`/`Target` headers, or whose path continues into `/heading`, `/block` or `/frontmatter`, is refused with `40102` rather than quietly becoming a targeted edit of a document the link never named. Targeted writes need the API key.

A `PUT` link's single use is claimed when the request is authorized, not when it finishes, so concurrent redemptions cannot all pass the check; a request that does not end in a 2xx gives the claim back, so a rejected or aborted attempt never spends the link.

A signed request whose path carries a backslash is refused. Verification treats `\` as a separator and dispatch does not, so the two layers would disagree about which file `a%5Cb` names; no legitimate link needs one, since the separator is normalized away before signing. With verbose logging on, `sig` and `n` are redacted from the logged URL: they are a bearer capability, and console output gets pasted into bug reports.

A signed URL is `GET` or `PUT /vault/{filename}?sig=…&exp=…&n=…`. The signature is an HMAC-SHA256 over the method, the normalized vault path, the expiry, and the random per-link nonce `n`, under a secret generated at plugin load and held only in memory; it stands in for the `Authorization` header on that one request. Download links can be used repeatedly until they expire and are served with `Content-Disposition: inline` (`download=1` asks for an attachment). Upload links are consumed by the first request that succeeds. Links do not survive an Obsidian restart.

## Available resources

| URI | Description |
|---|---|
| `obsidian://local-rest-api/openapi.yaml` | Full OpenAPI specification for this REST API |
