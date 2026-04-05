{
  parameters: [
    {
      name: 'Target-Type',
      'in': 'header',
      description: |||
        Type of section to append to. When specified, content is appended within
        the matching section instead of at the end of the file. Must be used
        together with the `Target` header.

        - `heading`: appends content below the specified heading.
        - `block`: appends content after the specified block reference.
        - `frontmatter`: appends to the value of the specified frontmatter field.
      |||,
      required: false,
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
      name: 'Target',
      'in': 'header',
      description: |||
        The section to append to; required when `Target-Type` is specified.
        This value can be URL-Encoded and *must* be URL-Encoded if it
        includes non-ASCII characters.
      |||,
      required: false,
      schema: {
        type: 'string',
      },
    },
    {
      name: 'Target-Delimiter',
      'in': 'header',
      description: 'Delimiter used when specifying nested heading targets (e.g. "Heading 1::Subheading"). Defaults to "::".',
      required: false,
      schema: {
        type: 'string',
        default: '::',
      },
    },
    {
      name: 'Create-Target-If-Missing',
      'in': 'header',
      description: 'If the specified Target does not exist, create it?',
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
    },
    {
      name: 'Trim-Target-Whitespace',
      'in': 'header',
      description: 'Trim whitespace from Target content before applying patch?',
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
    description: 'Content you would like to append.',
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
      description: 'Success; targeted section updated. The full updated file content is returned.',
      content: {
        'text/markdown': {
          schema: {
            type: 'string',
          },
        },
      },
    },
    '204': {
      description: 'Success; content appended to end of file.',
    },
    '400': {
      description: 'Bad Request',
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
