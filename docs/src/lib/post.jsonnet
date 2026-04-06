local T = import 'targeting.params.jsonnet';

{
  parameters: [
    T.createTargetIfMissing,
    T.applyIfContentPreexists,
    T.trimTargetWhitespace,
    T.targetType,
    T.target,
    T.targetDelimiter,
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
