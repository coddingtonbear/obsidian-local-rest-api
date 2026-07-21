// Shared targeting parameter definitions, imported by get/put/post/patch.jsonnet.
// PATCH overrides `required` on targetType and target (they are required there).
{
  markdownPatchVersion: {
    name: 'Markdown-Patch-Version',
    'in': 'header',
    description: |||
      Selects which markdown-patch format governs this request. You do not normally
      need to send this header. By default (2.0), a PATCH carries its whole instruction
      in the JSON request body, the document map returns a nested heading tree plus a
      `version` token, and a sub-part of a document is targeted with URL path elements
      (e.g. `.../heading/My%20Section`). Set it to `1` to opt into the deprecated 1.x
      behavior: the header-driven PATCH format, header-based targeting
      (`Target-Type`/`Target`/`Target-Delimiter`/`Target-Scope`) on GET/PUT/POST, and
      the `::`-joined document map. Responses served by 1.x carry a
      `Deprecation: true; sunset-version="6.0"` header; supplying those targeting headers
      without this set to `1` is rejected with `400 HeaderTargetingRequiresVersion1`. Any
      value other than `1` or `2` returns `400 InvalidPatchVersionHeader`.
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

      For `heading` targets, `marker` addresses the heading line itself and
      `markerAndContent` addresses that line together with the body beneath it. For
      structured heading edits with the level preserved for you, use PATCH's JSON
      instruction format; see the PATCH documentation for the exact `replace` behavior at
      each scope.
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
