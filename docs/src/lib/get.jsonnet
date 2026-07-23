local T = import 'targeting.params.jsonnet';

{
  parameters: [
    T.targetType,
    T.target,
    T.targetDelimiter,
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
        'text/html': {
          description: 'Returned when `Accept: text/html` is specified. The note (or, if `Target-Type`/`Target` are specified with `heading` or `block`, just that section) rendered to HTML via Obsidian\'s Markdown renderer (embeds, callouts, etc. included). `Target-Type: frontmatter` is not supported for this Accept type and returns a 400 error.\n',
          schema: {
            type: 'string',
            example: '<h1>This is my document</h1>\n<p>something else here</p>\n',
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
    '400': {
      description: 'The `Target-Type`/`Target` headers were invalid, or `Target-Type: frontmatter` was combined with `Accept: text/html` (frontmatter has no HTML rendering).\n',
      content: {
        'application/json': {
          schema: {
            '$ref': '#/components/schemas/Error',
          },
        },
      },
    },
    '404': {
      description: 'File or target section does not exist',
    },
  },
}
