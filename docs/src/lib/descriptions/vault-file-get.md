Returns the content of the file at the specified path in your vault should the file exist.

Binary files are served as raw bytes, with a `Content-Type` derived from the file extension, so this endpoint reads attachments — images, PDFs, audio — as well as notes. There is no size limit on the response.
