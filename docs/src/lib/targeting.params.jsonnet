// Shared targeting parameter definitions, imported by get/put/post/patch.jsonnet.
// PATCH overrides `required` on targetType and target (they are required there).
{
  markdownPatchVersion: {
    name: 'Markdown-Patch-Version',
    'in': 'header',
    description: |||
      Selects which markdown-patch format governs this request. The 2.0 format is
      the default: for PATCH the whole instruction is the JSON request body, and
      the document map returns heading addresses as arrays plus a `version` token.
      Set to `1` to opt back into the deprecated 1.x header-driven PATCH format and
      the 1.x `::`-joined document map. Responses served by the 1.x format carry a
      `Deprecation: true; sunset-version="6.0"` header. Any value other than `1` or
      `2` returns `400 InvalidPatchVersionHeader`.
    |||,
    required: false,
    schema: {
      type: 'string',
      enum: [
        '1',
        '2',
      ],
      default: '2',
    },
  },
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
  rejectIfContentPreexists: {
    name: 'Reject-If-Content-Preexists',
    'in': 'header',
    description: 'If patch data already exists in Target, reject the patch?',
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
  targetScope: {
    name: 'Target-Scope',
    'in': 'header',
    description: |||
      Controls which part of the target the operation acts on. Only applicable to
      `heading` and `block` targets; ignored for `frontmatter`.

      - `content` (default): the operation applies to the content region only — the area
        below the heading line or at the block, leaving the heading/block-ID token unchanged.
      - `marker`: the operation applies only to the heading line or block-ID token itself,
        leaving the content unchanged.
      - `markerAndContent`: the operation applies to the full range covering both the
        heading/block-ID token and its content, allowing them to be replaced or repositioned
        together.

      For heading targets, the marker is the literal heading line *including* its leading
      `#` characters (e.g. `## Subheading`) — it is not just the heading text. To rename a
      heading with `marker` or `markerAndContent` and a `replace` operation, the new content
      must include that same number of `#` characters, or the heading will be demoted to a
      plain paragraph. The heading's depth equals the number of `Target-Delimiter`-separated
      segments in `Target` — e.g. a `Target` of `Heading 1::Subheading` has 2 segments, so its
      marker is `## Subheading`. (Omitting the `#` characters is valid too, if the intent is to
      remove the heading and demote it to plain text.)
    |||,
    required: false,
    schema: {
      type: 'string',
      enum: [
        'content',
        'marker',
        'markerAndContent',
      ],
      default: 'content',
    },
  },
}
