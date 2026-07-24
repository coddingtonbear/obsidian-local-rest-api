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
      `Deprecation: true; sunset-version="6.0"` header. Any value other than `1` or `2`
      returns `400 InvalidPatchVersionHeader`.

      One place an *explicit* `2` matters: PATCH's raw-content mode with header-based
      targeting. Because `Target-Type`/`Target` headers on a PATCH are ambiguous between
      the 1.x format and raw-content mode, a PATCH carrying them without this header is
      rejected with `400 PatchHeaderTargetingRequiresExplicitVersion` — send `1` for the
      deprecated engine or `2` for raw-content mode. On GET/PUT/POST, supplying those
      targeting headers without `1` is rejected with `400 HeaderTargetingRequiresVersion1`
      (use URL path elements instead), and PATCH URL-element targeting likewise needs no
      version header.
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
  // --- PATCH raw-content-mode headers -------------------------------------
  // These parameterize PATCH's raw-content mode (markdown-patch 2.0): the
  // instruction's fields ride in headers/URL elements and the raw payload is
  // the request body. Header-based targeting additionally requires an
  // explicit `Markdown-Patch-Version: 2`.
  patchTargetType: {
    name: 'Target-Type',
    'in': 'header',
    description: |||
      Raw-content mode: the type of node the instruction targets (`heading`,
      `block`, or `frontmatter`). Must be used together with the `Target`
      header and an explicit `Markdown-Patch-Version: 2`; alternatively, put
      the target in the URL path (`.../heading/A/B`) and omit both headers.
      Supplying both is rejected with `422 ConflictingTargetSpecification`.
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
  patchTarget: {
    name: 'Target',
    'in': 'header',
    description: |||
      Raw-content mode: the node the instruction targets. The encoding is
      type-dependent, mirroring the instruction's `target` field. For a
      `heading`, the value is JSON — an array of heading texts from the top
      level down, or `null` for the document root — then percent-encoded:
      `["A","B"]` is sent as `%5B%22A%22%2C%22B%22%5D`. For a `block` or
      `frontmatter` target, the value is the plain id/key, percent-encoded if
      it contains non-ASCII characters. A heading value that does not decode
      to JSON (e.g. a bare 1.x-style `A::B` path) is rejected with
      `400 InvalidTargetHeader`.
    |||,
    required: false,
    schema: {
      type: 'string',
    },
  },
  patchOperation: {
    name: 'Operation',
    'in': 'header',
    description: |||
      Raw-content mode: the instruction's operation. Required whenever the
      target rides in the URL path or the `Target-Type`/`Target` headers.
    |||,
    required: false,
    schema: {
      type: 'string',
      enum: [
        'replace',
        'prepend',
        'append',
        'delete',
      ],
    },
  },
  patchTargetScope: {
    name: 'Target-Scope',
    'in': 'header',
    description: |||
      Raw-content mode: the instruction's `scope` — `content` (default),
      `marker`, `markerAndContent`, or `parent` (a move; carries its
      destination in the `Destination` header). See the instruction-body
      documentation for what each scope addresses.
    |||,
    required: false,
    schema: {
      type: 'string',
      enum: [
        'content',
        'marker',
        'markerAndContent',
        'parent',
      ],
      default: 'content',
    },
  },
  patchWithin: {
    name: 'Within',
    'in': 'header',
    description: |||
      Raw-content mode: the instruction's `within` — a single integer (e.g.
      `-1`) refining a heading target to one of the section's direct-body
      top-level blocks (0-based document order, negative counting from the
      end; isolated `^id` lines are not counted). With the default `content`
      scope the body is spliced literally into that block — an `append`
      *continues* it — and a bodiless `delete` removes it; with
      `Target-Scope: markerAndContent`, `prepend`/`append` insert the body as
      a new block beside it. Heading targets only; cannot be combined with
      `Create-Target-If-Missing`.
    |||,
    required: false,
    schema: {
      type: 'string',
    },
  },
  patchDestination: {
    name: 'Destination',
    'in': 'header',
    description: |||
      Raw-content mode: where a moved heading lands (`Target-Scope: parent`).
      The instruction's `destination` object as JSON, then percent-encoded:
      `{"parent":["Appendix"],"place":"last"}` is sent as
      `%7B%22parent%22%3A%5B%22Appendix%22%5D%2C%22place%22%3A%22last%22%7D`.
      A move carries no body.
    |||,
    required: false,
    schema: {
      type: 'string',
    },
  },
  ifMatch: {
    name: 'If-Match',
    'in': 'header',
    description: |||
      Raw-content mode: the instruction's `ifMatch` optimistic-concurrency
      token — the `version` from a document map, bare or wrapped in one pair
      of double quotes (RFC 9110 ETag style). A mismatch fails with `412` and
      leaves the file untouched.
    |||,
    required: false,
    schema: {
      type: 'string',
    },
  },
  readTargetScope: {
    name: 'Target-Scope',
    'in': 'header',
    description: |||
      For a URL-path-targeted read: which part of the target to return
      (default `content`), mirroring PATCH's scopes with a round-trip
      guarantee — what a scope returns is exactly what a `replace` at that
      scope consumes.

      - `content` (default): the node's body — a heading's body with its
        levels made relative to the target, a block's text, a frontmatter
        value.
      - `marker`: the label — a heading's raw text (no `#`s, and without the
        duplicate-marker suffix its map key may carry), a block's bare id, a
        frontmatter key.
      - `markerAndContent`: the whole node — a heading's subtree with its own
        line as `# Title` (levels relative to its parent), a block's full
        span including its `^id`, or a frontmatter entry as a `{key: value}`
        JSON object.

      `parent` places a section but carries no readable value, and returns
      `400 InvalidTargetScopeHeader`. Only meaningful when the URL path
      addresses a sub-part of the note.
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
  targetScope: {
    name: 'Target-Scope',
    'in': 'header',
    description: |||
      Controls which part of the target the operation acts on. Only applicable to
      `heading` and `block` targets. Combining a `Target-Scope` other than `content`
      with `Target-Type: frontmatter` returns a 400 error, since a frontmatter field
      has no marker/content distinction.

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
