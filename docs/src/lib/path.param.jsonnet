{
  name: 'filename',
  'in': 'path',
  description: 'Path to the relevant file (relative to your vault root).\n Optionally, you may include a reference to a sub-part of the document to return; see "Targeting a Sub-part of your Document" for details.',
  required: true,
  schema: {
    type: 'string',
    format: 'path',
  },
}
