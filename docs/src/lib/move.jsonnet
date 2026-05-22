{
  tags: [
    'Vault Files',
  ],
  summary: 'Move a file to a new location in your vault.\n',
  description: 'Moves a file from its current location to a new location specified in the Destination header. This operation preserves file history and updates internal links.\n',
  parameters: [
    {
      name: 'Destination',
      'in': 'header',
      description: 'The new path for the file, relative to your vault root. Path must not contain ".." or start with "/". If the path ends with a trailing slash, the source filename is preserved and the file is placed in that directory (e.g. "archive/" moves "notes/todo.md" to "archive/todo.md"). If the path contains non-ASCII characters (e.g. accented letters), percent-encode the value (e.g. `r%C3%A9sum%C3%A9.md` for `résumé.md`).\n',
      required: true,
      schema: {
        type: 'string',
        format: 'path',
      },
    },
    {
      name: 'Allow-Overwrite',
      'in': 'header',
      description: 'If "true", the move proceeds even when a file already exists at the destination. Defaults to "false", which returns a 409 if the destination exists.\n',
      required: false,
      schema: {
        type: 'string',
        enum: ['true', 'false'],
        default: 'false',
      },
    },
  ],
  responses: {
    '204': {
      description: 'File successfully moved.',
      headers: {
        'Content-Location': {
          description: 'The vault-relative path of the file at its new location (e.g. `archive/file.md`). Non-ASCII characters are percent-encoded.',
          schema: {
            type: 'string',
          },
        },
      },
    },
    '400': {
      description: 'Bad request - Missing Destination header, or path traversal attempt (path contains ".." or starts with "/").\n',
      content: {
        'application/json': {
          schema: {
            '$ref': '#/components/schemas/Error',
          },
        },
      },
    },
    '404': {
      description: 'Source file does not exist.',
      content: {
        'application/json': {
          schema: {
            '$ref': '#/components/schemas/Error',
          },
        },
      },
    },
    '405': {
      description: 'Your path references a directory instead of a file; this request method is valid only for files.\n',
      content: {
        'application/json': {
          schema: {
            '$ref': '#/components/schemas/Error',
          },
        },
      },
    },
    '409': {
      description: 'Destination file already exists.',
      content: {
        'application/json': {
          schema: {
            '$ref': '#/components/schemas/Error',
          },
        },
      },
    },
  },
}
