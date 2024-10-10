{
  parameters: [],
  responses: {
    '200': {
      description: 'Success',
      content: {
        'text/markdown': {
          schema: {
            type: 'string',
            example: '# This is my document\n\nsomething else here\n',
          },
        },
        'application/vnd.olrapi.note+json': {
          schema: {
            '$ref': '#/components/schemas/NoteJson',
          },
        },
      },
    },
    '404': {
      description: 'File does not exist',
    },
  },
}
