local T = import 'targeting.params.jsonnet';

{
  tags: [
    'Active File',
  ],
  summary: 'Update the content of the active file open in Obsidian.\n',
  parameters: [
    T.targetType,
    T.target,
    T.targetDelimiter,
    T.applyIfContentPreexists,
    T.trimTargetWhitespace,
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
