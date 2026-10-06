// HTTP conditional requests (RFC 9110 §13): the `ETag` a read or write answers
// with, and the `If-Match` / `If-None-Match` headers every vault write accepts.
//
// Mixed into operations in openapi.jsonnet with `+`, after the operation's own
// fields, so `parameters+:` and `responses+:` extend rather than replace them.

local ErrorBody = {
  'application/json': {
    schema: { '$ref': '#/components/schemas/Error' },
  },
};

local ifMatch = {
  name: 'If-Match',
  'in': 'header',
  description: |||
    Write only if the file is still the version you read. Send the `ETag` from
    a `GET` of the file (or from a previous write), or the `version` from its
    document map or note JSON -- they are the same token. A comma-separated
    list matches if any entry does, and `*` matches any file that exists.

    If the file has changed since, or does not exist, the request fails with
    `412` (error code `41200`) and nothing is written; read the file again and
    redo the edit against what is there now. Tags are compared strongly: a
    weak `W/"…"` tag never matches. The tag may be sent quoted, as RFC 9110
    writes it, or bare. A value that is neither `*` nor an entity-tag list is
    refused with `400` (error code `40024`).

    Writes made through this API are queued per file, so two requests that
    hold the same tag cannot both pass the check: the first to arrive writes,
    and the second fails with `412`.
  |||,
  required: false,
  schema: { type: 'string', example: '"a1b2c3"' },
};

local ifNoneMatch = {
  name: 'If-None-Match',
  'in': 'header',
  description: |||
    `*` writes only if nothing exists at the path yet -- a create that will
    not overwrite. A list of entity tags instead fails the write if the file is
    currently at any of those versions. A failed precondition is `412` (error
    code `41200`) and nothing is written; a malformed value is `400` (error
    code `40024`).
  |||,
  required: false,
  schema: { type: 'string', example: '*' },
};

local etagHeader(description) = {
  ETag: {
    description: description,
    schema: { type: 'string', example: '"a1b2c3"' },
  },
};

local preconditionFailed = {
  description: 'Precondition Failed: an `If-Match` or `If-None-Match` header did not hold against the file as it is now -- it has changed since the version `If-Match` named, no longer exists, or (under `If-None-Match: *`) already exists. Nothing was written. The message names the file\'s current version.',
  content: ErrorBody,
};

{
  // For writes. `etagCodes` are the success codes whose response carries the
  // file's new version (writes that change content); `preconditions` are the
  // headers the operation documents.
  Write(etagCodes, preconditions=[ifMatch, ifNoneMatch]):: {
    parameters+: preconditions,
    responses+: {
      // An operation that documents its own 412 (PATCH, whose instruction
      // carries an `ifMatch` of its own) keeps its wording.
      '412': if '412' in super then super['412'] else preconditionFailed,
    } + {
      [c]+: {
        headers+: etagHeader("The file's version after this write, as a strong entity tag: send it as `If-Match` on your next write to make that one conditional too, without reading the file again."),
      }
      for c in etagCodes
    },
  },

  // For reads: the success codes whose response carries the file's version.
  Read(codes):: {
    responses+: {
      [c]+: {
        headers+: etagHeader("The file's version, as a strong entity tag -- the same token as the document map's `version` and note JSON's `version`. Send it as `If-Match` on a write to make that write fail, rather than overwrite a change made in between, if the file has changed. Sent with the file itself, a section of it, and the document map, all of which depend only on the file's bytes; a matching `If-None-Match` on those reads is answered `304 Not Modified`. Not sent as this token with `Accept: text/html` or note JSON, which also depend on other files (embeds, backlinks) -- read note JSON's `version` field instead."),
      }
      for c in codes
    },
  },

  ifMatch: ifMatch,
  ifNoneMatch: ifNoneMatch,
}
