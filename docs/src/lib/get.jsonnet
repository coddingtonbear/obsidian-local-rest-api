local T = import 'targeting.params.jsonnet';

{
  parameters: [
    T.markdownPatchVersion,
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
            description: |||
              The document map. To receive the deprecated 1.x shape — heading paths as
              `::`-joined strings, block ids prefixed with `^`, and no `version` —
              send `Markdown-Patch-Version: 1`.
            |||,
            type: 'object',
            properties: {
              version: {
                type: 'string',
                description: 'Content-hash token for the file; pass it back as a PATCH `ifMatch` to make an edit conditional on the file being unchanged.',
                example: 'a1b2c3',
              },
              headings: {
                '$ref': '#/components/schemas/HeadingTree',
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
          description: 'Returned when the URL path targets a frontmatter field (`.../frontmatter/fieldName`); the JSON value of that field.',
          schema: {},
        },
      },
    },
    '400': {
      description: 'The `Markdown-Patch-Version` header was invalid (not `1` or `2`), the deprecated `Target-Type`/`Target` headers were invalid, or a frontmatter target was combined with `Accept: text/html` (frontmatter has no HTML rendering).\n',
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
