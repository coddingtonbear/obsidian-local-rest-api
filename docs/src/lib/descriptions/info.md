The Obsidian Local REST API with MCP plugin gives you two ways to interact with your Obsidian vault programmatically:

- **REST API** — standard HTTP endpoints for reading and writing notes, searching vault contents, and more. Useful from scripts, applications, or any HTTP client.
- **MCP server** — exposes the same capabilities as structured tools for AI assistants (Claude, Cursor, and other MCP-compatible clients). See the `POST /mcp/` endpoint for connection details.

## Conditional writes

Every write to a file accepts an `If-Match` header, so two clients editing the same note cannot silently overwrite each other. Read the file, keep the `ETag` it answers with, and send it back as `If-Match` on the write: if the file has changed in between, the write fails with `412` and nothing is written. `If-None-Match: *` makes a `PUT` create-only. The document map's `version` and note JSON's `version` are the same token as the `ETag`, and every write that changes a file answers with its new one.

## Testing with this interface

Select any operation in the sidebar, then open the **Try It** tab to send a live request to your running Obsidian instance.

**Authentication** — all requests require a Bearer token. In the **Try It** panel, expand the **Security** section and paste the API key shown in Obsidian under **Settings → Local REST API with MCP**. Failed authentication is throttled: ten wrong keys from one source within a minute and further wrong keys are refused with `429` until the minute is up, so if you paste the wrong key, correct it rather than retrying. Requests with the correct key are never delayed.

**Certificate warning** — the plugin generates its own certificate authority on first run and serves a TLS certificate signed by it. Most browsers will block requests to an untrusted certificate, so you may need to download the certificate authority from `/obsidian-local-rest-api.crt` and add it as a trusted authority in your OS or browser settings before requests will go through. The steps vary by environment — search for "trust self-signed certificate" plus your OS or browser name if you're unsure. If that proves too cumbersome, you can enable the insecure HTTP server in your plugin settings instead and select "HTTP (insecure mode)" from the **Try It** section.
