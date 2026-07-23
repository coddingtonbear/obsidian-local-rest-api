local T = import 'targeting.params.jsonnet';

{
  // A PATCH is served in one of two modes: instruction mode (the whole
  // instruction is the JSON body) or raw-content mode (the instruction's
  // fields ride in URL path elements/headers and the body is the raw
  // payload). Markdown-Patch-Version: 1 opts into the deprecated 1.x
  // header-driven format documented below. Each path adds its own path
  // parameter via `super.parameters`.
  parameters: [
    T.markdownPatchVersion,
    T.patchTargetType,
    T.patchTarget,
    T.patchOperation,
    T.patchTargetScope,
    T.patchDestination,
    T.ifMatch,
    T.createTargetIfMissing,
    T.rejectIfContentPreexists,
  ],
  requestBody: {
    description: |||
      Instruction mode: a single patch instruction as JSON (`application/json`, or
      `application/vnd.olrapi.patch-instruction+json` to declare it explicitly).
      Raw-content mode: the raw payload — a `text/markdown` body is the instruction's
      `content` carrier, an `application/json` body its `value` carrier, and no body at
      all carries nothing (a delete, or a move via the `Destination` header). An empty
      raw-mode body never clears content: a `replace` without a payload is rejected as a
      missing carrier, so an accidentally-empty template cannot wipe a section (use an
      instruction body with `"content": ""` to clear deliberately).
    |||,
    required: false,
    content: {
      'text/markdown': {
        schema: {
          type: 'string',
          example: '- A raw markdown line: no JSON escaping needed.\n',
        },
      },
      'application/vnd.olrapi.patch-instruction+json': {
        schema: {
          '$ref': '#/components/schemas/PatchInstruction',
        },
      },
      'application/json': {
        schema: {
          '$ref': '#/components/schemas/PatchInstruction',
        },
        examples: {
          appendUnderHeading: {
            summary: 'Append text below a heading',
            value: {
              targetType: 'heading',
              target: ['Heading 1', 'Subheading 1:1:1'],
              operation: 'append',
              content: 'Hello',
            },
          },
          continueList: {
            summary: 'Continue an existing list in place (within: positional block edit)',
            value: {
              targetType: 'heading',
              target: ['Log'],
              within: -1,
              operation: 'append',
              content: '\n- new item',
            },
          },
          appendToBlock: {
            summary: 'Append text to a block addressed by its reference id',
            value: {
              targetType: 'block',
              target: '2c7cfa',
              operation: 'append',
              content: 'More detail for this block.',
            },
          },
          setFrontmatter: {
            summary: 'Set a frontmatter field to a JSON value',
            value: {
              targetType: 'frontmatter',
              target: 'alpha',
              operation: 'replace',
              value: 2,
            },
          },
          addTag: {
            summary: 'Add a tag (merge into the tags list, creating it if absent)',
            value: {
              targetType: 'frontmatter',
              target: 'tags',
              operation: 'append',
              value: ['project/active'],
              createTargetIfMissing: true,
            },
          },
          moveSection: {
            summary: 'Move a heading section under a new parent',
            value: {
              targetType: 'heading',
              target: ['Overview', 'Details'],
              operation: 'replace',
              scope: 'parent',
              destination: { parent: ['Appendix'], place: 'last' },
            },
          },
        },
      },
    },
  },
  responses: {
    '200': {
      description: 'Success. The body is the patched document. Any advisory warnings (e.g. a heading rebased past level 6) are JSON-encoded, then percent-encoded, in the `Markdown-Patch-Warnings` response header.',
      headers: {
        'Markdown-Patch-Warnings': {
          description: 'Present only when the patch produced warnings: a percent-encoded JSON array of `{ code, message }` objects (percent-encoded because a warning message embeds document text verbatim, which may contain non-ASCII characters that are not valid in a raw header value). Decode with `decodeURIComponent` before parsing as JSON.',
          schema: {
            type: 'string',
          },
        },
      },
    },
    '400': {
      description: 'Bad Request; the instruction was malformed, the operation×scope×targetType combination is not part of the algebra, the `Markdown-Patch-Version` header was invalid, an instruction-mode request had a non-object body, or a raw-content-mode header could not be decoded (a heading `Target` that is not percent-encoded JSON, a malformed `Destination`, an unsupported body content type). Header-based targeting without an explicit `Markdown-Patch-Version` returns `PatchHeaderTargetingRequiresExplicitVersion` here. See response message for details.',
      content: {
        'application/json': {
          schema: {
            '$ref': '#/components/schemas/Error',
          },
        },
      },
    },
    '404': {
      description: 'The file, or the addressed target within it, does not exist (and `createTargetIfMissing` was not set).',
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
    '409': {
      description: '`rejectIfContentPreexists` was set and the content already appears in the target span.',
      content: {
        'application/json': {
          schema: {
            '$ref': '#/components/schemas/Error',
          },
        },
      },
    },
    '412': {
      description: 'Precondition Failed: the `ifMatch` token did not match the current document version; the file was not modified.',
      content: {
        'application/json': {
          schema: {
            '$ref': '#/components/schemas/Error',
          },
        },
      },
    },
    '422': {
      description: 'Conflicting target specifications: more than one of URL path elements, `Target-Type`/`Target` headers, and an `application/vnd.olrapi.patch-instruction+json` instruction body was supplied.',
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
