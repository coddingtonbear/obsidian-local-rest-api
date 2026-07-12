{
  tags: [
    'Vault Files',
  ],
  summary: 'Branch (duplicate) a file to a new location in your vault.\n',
  description: 'Duplicates a file into an independent copy. The copy shares no history with the source and the source is left unchanged. If the Destination header is omitted, a non-colliding "(branch)" sibling name is generated automatically (e.g. "notes/Plan.md" becomes "notes/Plan (branch).md").\n',
  parameters: [
    {
      name: 'Destination',
      'in': 'header',
      description: 'Optional. The path for the new copy, relative to your vault root. The path must not escape the vault root; absolute paths (starting with `/`) are rejected. If the path ends with a trailing slash, the source filename is preserved and the copy is placed in that directory. If omitted, a "(branch)" sibling is auto-named next to the source. Percent-encode non-ASCII characters.\n',
      required: false,
      schema: {
        type: 'string',
        format: 'path',
      },
    },
    {
      name: 'Allow-Overwrite',
      'in': 'header',
      description: 'If "true", the copy proceeds even when a file already exists at the destination. Defaults to "false", which returns a 409 if the destination exists.\n',
      required: false,
      schema: {
        type: 'string',
        enum: ['true', 'false'],
        default: 'false',
      },
    },
  ],
  responses: {
    '201': {
      description: 'File successfully branched.',
      headers: {
        'Content-Location': {
          description: 'The vault-relative path of the newly created copy (e.g. `notes/Plan (branch).md`). Non-ASCII characters are percent-encoded.',
          schema: {
            type: 'string',
          },
        },
      },
    },
    '400': {
      description: 'Bad request - malformed percent-encoding, or path escapes the vault root (e.g. starts with "/").\n',
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
