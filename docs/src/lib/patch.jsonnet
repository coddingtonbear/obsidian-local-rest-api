{
  parameters: [
    {
      name: 'Operation',
      'in': 'header',
      description: 'Patch operation to perform',
      required: true,
      schema: {
        type: 'string',
        enum: [
          'append',
          'prepend',
          'replace',
        ],
      },
    },
    {
      name: 'Target-Type',
      'in': 'header',
      description: 'Type of target to patch',
      required: true,
      schema: {
        type: 'string',
        enum: [
          'heading',
          'block',
          'frontmatter',
        ],
      },
    },
    {
      name: 'Target-Delimiter',
      'in': 'header',
      description: 'Delimiter to use for nested targets (i.e. Headings)',
      required: false,
      schema: {
        type: 'string',
        default: '::',
      },
    },
    {
      name: 'Target',
      'in': 'header',
      description: |||
        Target to patch; this value can be URL-Encoded and *must*
        be URL-Encoded if it includes non-ASCII characters.
      |||,
      required: true,
      schema: {
        type: 'string',
      },
    },
    {
      name: 'Create-Target-If-Missing',
      'in': 'header',
      description: 'If specified Target does not exist, create it?',
      required: false,
      schema: {
        type: 'string',
        enum: [
          'true',
          'false',
        ],
        default: 'false',
      },
    }
    {
      name: 'Apply-If-Content-Preexists',
      'in': 'header',
      description: 'If patch data already exists in Target, apply patch anyway?',
      required: false,
      schema: {
        type: 'string',
        enum: [
          'true',
          'false',
        ],
        default: 'false',
      },
    }
    {
      name: 'Trim-Target-Whitespace',
      'in': 'header',
      description: 'Trim whitespace from Target before applying patch?',
      required: false,
      schema: {
        type: 'string',
        enum: [
          'true',
          'false',
        ],
        default: 'false',
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
      'application/json': {
        schema: {
          type: 'string',
          example: "['one', 'two']",
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
  description: importstr 'descriptions/patch.md',
}
