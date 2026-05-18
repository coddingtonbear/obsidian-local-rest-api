{
  name: 'filename',
  'in': 'path',
  description: 'Path to the relevant file (relative to your vault root).\n Optionally, you may include a reference to target a sub-part of the document; see "Targeting a Sub-part of your Document" for details.',
  required: true,
  schema: {
    type: 'string',
    format: 'path',
  },
}
