import { ErrorCode, LocalRestApiSettings } from "./types";

export const CERT_NAME = "obsidian-local-rest-api.crt";

export const BUILT_IN_ROUTES = ["/", "/openapi.yaml", `/${CERT_NAME}`];

/**
 * The MCP protocol revision served by the `/mcp/` endpoint's sessionless leg.
 *
 * The SDK's `SUPPORTED_PROTOCOL_VERSIONS` lists only the sessionful revisions
 * (2024-10-07 through 2025-11-25) and exports no constant for this one, so it is named
 * here: the `MCP-Protocol-Version` header filter accepts both sets.
 */
export const MCP_SESSIONLESS_PROTOCOL_VERSION = "2026-07-28";

export const DEFAULT_SETTINGS: LocalRestApiSettings = {
  port: 27124,
  insecurePort: 27123,
  enableInsecureServer: false,
  enableSignedUrls: true,
};

export const ERROR_CODE_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.InvalidFrontmatter]:
    "Document frontmatter could not be parsed.",
  [ErrorCode.ApiKeyAuthorizationRequired]:
    "Authorization required.  Find your API Key in the 'Local REST API with MCP' section of your Obsidian settings.",
  [ErrorCode.ContentTypeSpecificationRequired]:
    "Content-Type header required; this API accepts data in multiple content-types and you must indicate the content-type of your request body via the Content-Type header.",
  [ErrorCode.InvalidContentType]:
    "Unknown or invalid Content-Type specified in Content-Type header.",
  [ErrorCode.InvalidContentForContentType]:
    "Your request body could not be processed as the content-type specified in your Content-Type header.",
  [ErrorCode.RequestMethodValidOnlyForFiles]:
    "Request method is valid only for file paths, not directories.",
  [ErrorCode.TextContentEncodingRequired]:
    "Incoming content must be text data and have an appropriate text/* Content-type header set (e.g. text/markdown).",
  [ErrorCode.InvalidFilterQuery]:
    "The query you provided could not be processed.",
  [ErrorCode.MissingTargetTypeHeader]: "No 'Target-Type' header was provided.",
  // A target type or scope can arrive by header *or* by URL path element, so
  // these read neutrally; the call site appends where the bad value came from
  // and which values are valid there (the two patch formats accept different
  // scopes). getResponseMessage prepends this text to any custom message, so a
  // call site that restates what is already here produces a doubled response.
  [ErrorCode.InvalidTargetTypeHeader]:
    "The target type you specified was invalid. Valid target types are 'heading', 'block', and 'frontmatter'.",
  [ErrorCode.MissingTargetHeader]: "No 'Target' header was provided.",
  [ErrorCode.InvalidTargetScopeHeader]:
    "The target scope you specified was invalid.",
  [ErrorCode.MissingOperation]: "No 'Operation' header was provided.",
  [ErrorCode.InvalidOperation]:
    "The 'Operation' header you provided was invalid.",
  [ErrorCode.InvalidTargetHeader]: "The 'Target' header you provided was invalid.",
  [ErrorCode.InvalidPatchVersionHeader]:
    "The 'Markdown-Patch-Version' header you provided was invalid. Valid values are '1' (the deprecated header-driven format) and '2' (the default JSON-instruction format).",
  [ErrorCode.HeaderTargetingRequiresVersion1]:
    "Header-based targeting (Target-Type/Target and the related Target-Scope/Target-Delimiter/Trim-Target-Whitespace headers) is deprecated and only processed when you also send 'Markdown-Patch-Version: 1'. Without it, reach a sub-part of a document with path-element targeting instead (e.g. /vault/note.md/heading/My%20Heading).",
  [ErrorCode.PatchHeaderTargetingRequiresExplicitVersion]:
    "Header-based PATCH targeting is ambiguous between the two patch formats, so it requires an explicit 'Markdown-Patch-Version' header: send '1' for the deprecated 1.x header-driven format, or '2' for raw-content mode (instruction fields in headers — heading Targets as percent-encoded JSON arrays — with the raw payload as the request body). The 1.x-only Target-Delimiter and Trim-Target-Whitespace headers are never processed under version 2.",
  [ErrorCode.PatchFailed]:
    "The patch you provided could not be applied to the target content.",
  [ErrorCode.InvalidPatchInstruction]:
    "The patch instruction you provided was malformed or outside the supported algebra.",
  [ErrorCode.InvalidSearch]: "The search query you provided is not valid.",
  [ErrorCode.SignedUrlIsWholeFileOnly]:
    "A signed URL authorizes a whole-file write to exactly the path it names. This request targets part of a document instead -- through URL path elements such as /heading/, or through Target-Type/Target headers -- and the signature covers neither, so the link would not be doing what it was issued for. Use the API key for a targeted write, or request a signed URL for the file itself.",
  [ErrorCode.ConflictingTargetSpecification]:
    "Conflicting target specifications: supply the target via URL path elements, via Target-Type/Target headers, or (for PATCH) as an 'application/vnd.olrapi.patch-instruction+json' instruction body — never more than one of these.",
  [ErrorCode.ErrorPreparingSimpleSearch]:
    "Error encountered while calling Obsidian `prepareSimpleSearch` API.",
  [ErrorCode.MissingDestinationHeader]:
    "Destination header is required for MOVE and COPY operations.",
  [ErrorCode.InvalidDestinationHeader]:
    "The 'Destination' header you provided could not be parsed.",
  [ErrorCode.InvalidWithinHeader]:
    "The 'Within' header must be a single integer, e.g. 0 or -1.",
  [ErrorCode.PathTraversalNotAllowed]:
    "Path traversal is not allowed. Paths must be relative and within the vault.",
  [ErrorCode.DestinationAlreadyExists]:
    "Destination file already exists.",
  [ErrorCode.FileOperationFailed]:
    "File operation failed. Check the error message for details.",
};

export enum ContentTypes {
  json = "application/json",
  markdown = "text/markdown",
  html = "text/html",
  olrapiNoteJson = "application/vnd.olrapi.note+json",
  olrapiDocumentMap = "application/vnd.olrapi.document-map+json",
  olrapiPatchInstruction = "application/vnd.olrapi.patch-instruction+json",
  jsonLogic = "application/vnd.olrapi.jsonlogic+json",
}

export const DefaultBearerTokenHeaderName = "Authorization";
export const DefaultBindingHost = "127.0.0.1";

export const LicenseUrl =
  "https://raw.githubusercontent.com/coddingtonbear/obsidian-local-rest-api/main/LICENSE";

export const MaximumRequestSize = "1024mb";

// Ceiling on the bytes an MCP *result* will carry -- `vault_read_binary`, whether it
// embeds them itself or falls back through `embeddedBytesResult`. There is no longer a
// binary tool that takes bytes as an argument: `vault_write_binary` was replaced by
// `vault_get_upload_url`, which hands back a URL to PUT the file to, precisely so bytes
// travel over HTTP instead of through the model. Two separate reasons for the cap, and
// the second one is the binding constraint:
//
// 1. A context guard. base64 in a result passes through the model's context at roughly
//    0.35-0.45 tokens per byte, so a file a REST client would not think twice about is
//    a five-figure token bill for an agent.
//
// 2. Renderer stability. A tool result carrying roughly a megabyte or more of base64
//    kills Obsidian's Electron renderer outright -- the process dies, taking this
//    plugin's HTTP listener with it, and the window goes blank. It is not specific to
//    images: a 979KB file reproduced it through `embeddedBytesResult` with no image
//    decoding involved at all. 512KiB was verified safe by hand against a 512899-byte
//    file (a 683865-char base64 payload); 979295 bytes crashed reproducibly. The cap is
//    deliberately set well under the observed failure point rather than next to it,
//    because the true threshold has not been bisected and may move with Obsidian's own
//    renderer memory use.
//
//    It is the base64 specifically, not the size of the response. `vault_read` was made
//    to return a 6MB text block and the renderer did not blink -- five times the payload
//    that kills it as base64. So this ceiling belongs on the tools that embed bytes, and
//    the text tools need no equivalent; an oversized *note* is a context problem, not a
//    stability one.
//
// Anything larger belongs on `GET`/`PUT /vault/<path>`, which carry raw bytes and are
// bounded only by `MaximumRequestSize` above, or on a signed URL.
export const MaximumMcpBinaryBytes = 512 * 1024;
