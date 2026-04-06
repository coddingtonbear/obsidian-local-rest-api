{
  parameters: [
    {
      name: 'Target-Type',
      'in': 'header',
      description: |||
        Type of section to retrieve. When specified, only the content of the
        matching section is returned instead of the full file. Must be used
        together with the `Target` header.

        - `heading`: returns the markdown content of the section under the
          specified heading (use `Target-Delimiter` to specify nested headings).
        - `block`: returns the markdown content of the specified block reference.
        - `frontmatter`: returns the value of the specified frontmatter field
          as JSON.
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
      name: 'Target',
      'in': 'header',
      description: |||
        The section to retrieve; required when `Target-Type` is specified.
        This value can be URL-Encoded and *must* be URL-Encoded if it
        includes non-ASCII characters.
      |||,
      required: false,
      schema: {
        type: 'string',
      },
    },
  ],
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
        'application/json': {
          description: 'Returned when `Target-Type` is `frontmatter`; the JSON value of the specified frontmatter field.',
          schema: {},
        },
      },
    },
    '404': {
      description: 'File or target section does not exist',
    },
  },
}
