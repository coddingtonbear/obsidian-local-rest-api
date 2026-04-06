// Shared targeting parameter definitions, imported by get/put/post/patch.jsonnet.
// PATCH overrides `required` on targetType and target (they are required there).
{
  targetType: {
    name: 'Target-Type',
    'in': 'header',
    description: |||
      Type of sub-document section to target. When specified, the operation
      applies only to the matching section rather than the whole file. Must
      be used together with the `Target` header.

      - `heading`: a markdown heading section.
      - `block`: a block reference.
      - `frontmatter`: a frontmatter field.
    |||,
    required: false,
    schema: {
      type: 'string',
      enum: [
        'heading',
        'block',
        'frontmatter',
      ],
    },
  },
  target: {
    name: 'Target',
    'in': 'header',
    description: |||
      The section to target; required when `Target-Type` is specified.
      This value can be URL-Encoded and *must* be URL-Encoded if it
      includes non-ASCII characters.
    |||,
    required: false,
    schema: {
      type: 'string',
    },
  },
  targetDelimiter: {
    name: 'Target-Delimiter',
    'in': 'header',
    description: 'Delimiter used when specifying nested heading targets (e.g. "Heading 1::Subheading"). Defaults to "::".',
    required: false,
    schema: {
      type: 'string',
      default: '::',
    },
  },
  createTargetIfMissing: {
    name: 'Create-Target-If-Missing',
    'in': 'header',
    description: 'If the specified Target does not exist, create it?',
    required: false,
    schema: {
      type: 'string',
      enum: [
        'true',
        'false',
      ],
      default: 'false',
    },
  },
  applyIfContentPreexists: {
    name: 'Apply-If-Content-Preexists',
    'in': 'header',
    description: 'If patch data already exists in Target, apply patch anyway?',
    required: false,
    schema: {
      type: 'string',
      enum: [
        'true',
        'false',
      ],
      default: 'false',
    },
  },
  trimTargetWhitespace: {
    name: 'Trim-Target-Whitespace',
    'in': 'header',
    description: 'Trim whitespace from Target content before applying the operation?',
    required: false,
    schema: {
      type: 'string',
      enum: [
        'true',
        'false',
      ],
      default: 'false',
    },
  },
}
