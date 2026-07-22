local T = import 'targeting.params.jsonnet';

{
  parameters: [
    T.markdownPatchVersion,
    T.createTargetIfMissing,
    T.rejectIfContentPreexists,
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
      description: 'Success; content appended to the targeted section (via URL path elements). The full updated file content is returned. Any advisory warnings (e.g. a heading rebased past level 6) are JSON-encoded, then percent-encoded, in the `Markdown-Patch-Warnings` response header.',
      headers: {
        'Markdown-Patch-Warnings': {
          description: 'Present only when the write produced warnings: a percent-encoded JSON array of `{ code, message }` objects. Decode with `decodeURIComponent` before parsing as JSON.',
          schema: {
            type: 'string',
          },
        },
      },
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
    '409': {
      description: '`Reject-If-Content-Preexists` was set and the content already appears in the targeted section.',
      content: {
        'application/json': {
          schema: {
            '$ref': '#/components/schemas/Error',
          },
        },
      },
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
