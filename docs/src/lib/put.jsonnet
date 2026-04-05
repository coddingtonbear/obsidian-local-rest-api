{
  tags: [
    'Active File',
  ],
  summary: 'Update the content of the active file open in Obsidian.\n',
  parameters: [
    {
      name: 'Target-Type',
      'in': 'header',
      description: |||
        Type of section to replace. When specified, only the matching section is
        replaced instead of the full file. Must be used together with the
        `Target` header. The section is created if it does not exist.

        - `heading`: replaces the content under the specified heading.
        - `block`: replaces the specified block reference.
        - `frontmatter`: replaces the value of the specified frontmatter field.
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
        The section to replace; required when `Target-Type` is specified.
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
    description: 'Content of the file you would like to upload.',
    required: true,
    content: {
      'text/markdown': {
        schema: {
          type: 'string',
          example: '# This is my document\n\nsomething else here\n',
        },
      },
      '*/*': {
        schema: {
          type: 'string',
        },
      },
    },
  },
  responses: {
    '200': {
      description: 'Success; targeted section replaced. The full updated file content is returned.',
      content: {
        'text/markdown': {
          schema: {
            type: 'string',
          },
        },
      },
    },
    '204': {
      description: 'Success; entire file replaced.',
    },
    '400': {
      description: "Incoming file could not be processed.  Make sure you have specified a reasonable file name, and make sure you have set a reasonable 'Content-Type' header; if you are uploading a note, 'text/markdown' is likely the right choice.\n",
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
