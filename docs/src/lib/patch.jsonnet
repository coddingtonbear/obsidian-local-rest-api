{
  parameters: [
    {
      name: 'Heading',
      'in': 'header',
      description: 'Name of heading relative to which you would like your content inserted.  May be a sequence of nested headers delimited by "::".\n',
      required: true,
      schema: {
        type: 'string',
      },
    },
    {
      name: 'Content-Insertion-Position',
      'in': 'header',
      description: 'Position at which you would like your content inserted; valid options are "end" or "beginning".\n',
      schema: {
        type: 'string',
        enum: [
          'end',
          'beginning',
        ],
        default: 'end',
      },
    },
    {
      name: 'Content-Insertion-Ignore-Newline',
      'in': 'header',
      description: 'Insert content before any newlines at end of header block.\n',
      schema: {
        type: 'string',
        enum: [
          true,
          false,
        ],
        default: false,
      },
    },
    {
      name: 'Heading-Boundary',
      'in': 'header',
      description: 'Set the nested header delimiter to a different value. This is useful if "::" exists in one of the headers you are attempting to use.\n',
      schema: {
        type: 'string',
        default: '::',
      },
    },
  ],
  requestBody: {
    description: 'Content you would like to insert.',
    required: true,
    content: {
      'text/markdown': {
        schema: {
          type: 'string',
          example: '# This is my document\n\nsomething else here\n',
        },
      },
    },
  },
  responses: {
    '200': {
      description: 'Success',
    },
    '400': {
      description: 'Bad Request; see response message for details.',
      content: {
        'application/json': {
          schema: {
            '$ref': '#/components/schemas/Error',
          },
        },
      },
    },
    '404': {
      description: 'Does not exist',
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
