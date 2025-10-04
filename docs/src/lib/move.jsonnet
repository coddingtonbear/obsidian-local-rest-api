{
  tags: [
    'Vault Files',
  ],
  summary: 'Move a file to a new location in your vault.\n',
  description: 'Moves a file from its current location to a new location specified in the Destination header. This operation preserves file history and updates internal links. The destination path must be provided in the Destination header following WebDAV conventions.\n',
  parameters: [
    {
      name: 'Destination',
      'in': 'header',
      description: 'The new path for the file (relative to your vault root). Path must not contain ".." or start with "/" for security reasons.\n',
      required: true,
      schema: {
        type: 'string',
        format: 'path',
      },
    },
  ],
  responses: {
    '201': {
      description: 'File successfully moved',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              message: {
                type: 'string',
                example: 'File successfully moved',
              },
              oldPath: {
                type: 'string',
                example: 'folder/file.md',
              },
              newPath: {
                type: 'string',
                example: 'another-folder/file.md',
              },
            },
          },
        },
      },
    },
    '400': {
      description: 'Bad request - Missing Destination header, invalid destination path, or path traversal attempt.\n',
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
