Returns the content of the file at the specified path in your vault should the file exist.

Binary files are served as raw bytes, with a `Content-Type` derived from the file extension, so this endpoint reads attachments — images, PDFs, audio — as well as notes. There is no size limit on the response.

A signed download URL (`?sig=…&exp=…&n=…`, from the MCP `vault_get_download_url` tool) authenticates the request in place of the `Authorization` header while signed URLs are enabled in the plugin settings. Such a request is served `inline` rather than as an attachment unless `download=1` is also given.
