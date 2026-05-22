import { ErrorCode, LocalRestApiSettings } from "./types";

export const CERT_NAME = "obsidian-local-rest-api.crt";

export const BUILT_IN_ROUTES = ["/", "/openapi.yaml", `/${CERT_NAME}`];

export const DEFAULT_SETTINGS: LocalRestApiSettings = {
  port: 27124,
  insecurePort: 27123,
  enableInsecureServer: false,
};

export const ERROR_CODE_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.ApiKeyAuthorizationRequired]:
    "Authorization required.  Find your API Key in the 'Local REST API & MCP Server' section of your Obsidian settings.",
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
  [ErrorCode.InvalidTargetTypeHeader]:
    "The 'Target-Type' header you provided was invalid.",
  [ErrorCode.MissingTargetHeader]: "No 'Target' header was provided.",
  [ErrorCode.InvalidTargetScopeHeader]:
    "The 'Target-Scope' header you provided was invalid. Valid values are 'content', 'marker', and 'markerAndContent'.",
  [ErrorCode.MissingOperation]: "No 'Operation' header was provided.",
  [ErrorCode.InvalidOperation]:
    "The 'Operation' header you provided was invalid.",
  [ErrorCode.InvalidTargetHeader]: "The 'Target' header you provided was invalid.",
  [ErrorCode.PatchFailed]:
    "The patch you provided could not be applied to the target content.",
  [ErrorCode.InvalidSearch]: "The search query you provided is not valid.",
  [ErrorCode.ConflictingTargetSpecification]:
    "Target type/target specified in both URL path and request headers. Use one or the other.",
  [ErrorCode.ErrorPreparingSimpleSearch]:
    "Error encountered while calling Obsidian `prepareSimpleSearch` API.",
  [ErrorCode.MissingDestinationHeader]:
    "Destination header is required for MOVE operations.",
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
  olrapiNoteJson = "application/vnd.olrapi.note+json",
  olrapiDocumentMap = "application/vnd.olrapi.document-map+json",
  jsonLogic = "application/vnd.olrapi.jsonlogic+json",
}

export const DefaultBearerTokenHeaderName = "Authorization";
export const DefaultBindingHost = "127.0.0.1";

export const LicenseUrl =
  "https://raw.githubusercontent.com/coddingtonbear/obsidian-local-rest-api/main/LICENSE";

export const MaximumRequestSize = "1024mb";
