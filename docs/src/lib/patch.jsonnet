{
  // The 2.0 PATCH takes no header parameters — the whole instruction is the
  // JSON body. Each path adds only its own path parameter via `super.parameters`.
  parameters: [],
  requestBody: {
    description: 'A single patch instruction (the markdown-patch 2.0 format).',
    required: true,
    content: {
      'application/json': {
        schema: {
          '$ref': '#/components/schemas/PatchInstruction',
        },
        examples: {
          appendUnderHeading: {
            summary: 'Append text below a heading',
            value: {
              targetType: 'heading',
              target: ['Heading 1', 'Subheading 1:1:1'],
              operation: 'append',
              content: 'Hello',
            },
          },
          appendTableRow: {
            summary: 'Append a row to a table addressed by a block reference',
            value: {
              targetType: 'block',
              target: '2c7cfa',
              operation: 'append',
              value: [['Chicago, IL', '16']],
            },
          },
          setFrontmatter: {
            summary: 'Set a frontmatter field to a JSON value',
            value: {
              targetType: 'frontmatter',
              target: 'alpha',
              operation: 'replace',
              value: 2,
            },
          },
          addTag: {
            summary: 'Add a tag (merge into the tags list, creating it if absent)',
            value: {
              targetType: 'frontmatter',
              target: 'tags',
              operation: 'append',
              value: ['project/active'],
              createTargetIfMissing: true,
            },
          },
          moveSection: {
            summary: 'Move a heading section under a new parent',
            value: {
              targetType: 'heading',
              target: ['Overview', 'Details'],
              operation: 'replace',
              scope: 'parent',
              destination: { parent: ['Appendix'], place: 'last' },
            },
          },
        },
      },
    },
  },
  responses: {
    '200': {
      description: 'Success. The body is the patched document. Any advisory warnings (e.g. a heading rebased past level 6) are JSON-encoded in the `MD-Patch-Warnings` response header.',
      headers: {
        'MD-Patch-Warnings': {
          description: 'Present only when the patch produced warnings: a JSON array of `{ code, message }` objects.',
          schema: {
            type: 'string',
          },
        },
      },
    },
    '400': {
      description: 'Bad Request; the instruction was malformed or the operation×scope×targetType combination is not part of the algebra. See response message for details.',
      content: {
        'application/json': {
          schema: {
            '$ref': '#/components/schemas/Error',
          },
        },
      },
    },
    '404': {
      description: 'The file, or the addressed target within it, does not exist (and `createTargetIfMissing` was not set).',
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
    '409': {
      description: '`rejectIfContentPreexists` was set and the content already appears in the target span.',
      content: {
        'application/json': {
          schema: {
            '$ref': '#/components/schemas/Error',
          },
        },
      },
    },
    '412': {
      description: 'Precondition Failed: the `ifMatch` token did not match the current document version; the file was not modified.',
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
