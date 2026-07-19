local T = import 'targeting.params.jsonnet';

{
  parameters: [
    T.markdownPatchVersion,
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
        'application/vnd.olrapi.note+json': {
          schema: {
            '$ref': '#/components/schemas/NoteJson',
          },
        },
        'application/vnd.olrapi.document-map+json': {
          schema: {
            description: |||
              The document map. This is the 2.0 shape (the default). To receive the
              deprecated 1.x shape — heading paths as `::`-joined strings, block ids
              prefixed with `^`, and no `version` — send `Markdown-Patch-Version: 1`.
            |||,
            type: 'object',
            properties: {
              version: {
                type: 'string',
                description: 'Content-hash token for the file; pass it back as a PATCH `ifMatch` to make an edit conditional on the file being unchanged.',
                example: 'a1b2c3',
              },
              headings: {
                type: 'array',
                description: 'One entry per heading, in document order. Each entry is the path of heading texts from the top level down to that heading; pass one straight back as a PATCH or read heading target. A `null` element marks a skipped level.',
                items: {
                  type: 'array',
                  items: {
                    type: ['string', 'null'],
                  },
                },
                example: [['Heading 1'], ['Heading 1', 'Subhead of Heading 1'], ['Heading 2']],
              },
              blocks: {
                type: 'array',
                description: 'Block reference ids, bare (no leading `^`), in document order.',
                items: {
                  type: 'string',
                },
                example: ['blockref1', 'anotherBlockRef'],
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
      description: 'The `Markdown-Patch-Version` header was invalid (not `1` or `2`).',
    },
    '404': {
      description: 'File or target section does not exist',
    },
  },
}
