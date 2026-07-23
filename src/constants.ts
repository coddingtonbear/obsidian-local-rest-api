import { ErrorCode, LocalRestApiSettings } from "./types";

export const CERT_NAME = "obsidian-local-rest-api.crt";

export const BUILT_IN_ROUTES = ["/", "/openapi.yaml", `/${CERT_NAME}`];

export const DEFAULT_SETTINGS: LocalRestApiSettings = {
  port: 27124,
  insecurePort: 27123,
  enableInsecureServer: false,
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
  [ErrorCode.PeriodDoesNotExist]: "Specified period does not exist.",
  [ErrorCode.PeriodIsNotEnabled]: "Specified period is not enabled.",
  [ErrorCode.PeriodicNoteDoesNotExist]:
    "Periodic note does not exist for the specified period.",
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
  [ErrorCode.ConflictingTargetSpecification]:
    "Conflicting target specifications: supply the target via URL path elements, via Target-Type/Target headers, or (for PATCH) as an 'application/vnd.olrapi.patch-instruction+json' instruction body — never more than one of these.",
  [ErrorCode.ErrorPreparingSimpleSearch]:
    "Error encountered while calling Obsidian `prepareSimpleSearch` API.",
  [ErrorCode.MissingDestinationHeader]:
    "Destination header is required for MOVE and COPY operations.",
  [ErrorCode.InvalidDestinationHeader]:
    "The 'Destination' header you provided could not be parsed.",
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
