local T = import 'targeting.params.jsonnet';

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
    T.targetType { required: true },
    T.target { required: true },
    T.targetDelimiter,
    T.createTargetIfMissing,
    T.applyIfContentPreexists,
    T.trimTargetWhitespace,
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
