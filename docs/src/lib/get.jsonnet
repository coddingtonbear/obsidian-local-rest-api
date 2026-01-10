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
        'application/vnd.olrapi.document-map+json': {
          schema: {
            type: 'object',
            properties: {
              headings: {
                type: 'array',
                items: {
                  type: 'string',
                },
                example: ['Heading 1', 'Heading 1::Subhead of Heading 1', 'Heading 2'],
              },
              blocks: {
                type: 'array',
                items: {
                  type: 'string',
                },
                example: ['^blockref1', '^anotherBlockRef'],
              },
              frontmatterFields: {
                type: 'array',
                items: {
                  type: 'string',
                },
                example: ['title', 'tags', 'dateCreated'],
              },
            },
          },
        },
      },
    },
    '404': {
      description: 'File does not exist',
    },
  },
}
