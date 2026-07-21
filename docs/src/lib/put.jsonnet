local T = import 'targeting.params.jsonnet';

{
  tags: [
    'Active File',
  ],
  summary: 'Update the content of the active file open in Obsidian.\n',
  parameters: [
    T.markdownPatchVersion,
    T.rejectIfContentPreexists,
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
      description: 'Success; targeted section replaced (via URL path elements). The full updated file content is returned. Any advisory warnings (e.g. a heading rebased past level 6) are JSON-encoded in the `MD-Patch-Warnings` response header.',
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
