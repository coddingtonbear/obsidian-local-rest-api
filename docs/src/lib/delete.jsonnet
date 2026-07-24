{
  parameters: [
    {
      name: 'permanent',
      'in': 'query',
      description: 'If "true", the file is permanently deleted instead of being moved to trash. Defaults to "false", which moves the file to trash following the user\'s Obsidian "Deleted files" preference (either the ".trash" folder or the system trash).\n',
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
      description: 'Success',
    },
    '404': {
      description: 'File does not exist.',
      content: {
        'application/json': {
          schema: {
            '$ref': '#/components/schemas/Error',
          },
        },
      },
    },
    '405': {
      description: 'Your path references a directory instead of a file; this request method is valid only for updating files.\n',
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
