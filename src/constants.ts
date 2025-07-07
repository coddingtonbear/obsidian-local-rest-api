import { ErrorCode, LocalRestApiSettings } from "./types";

export const CERT_NAME = "obsidian-local-rest-api.crt";

export const DEFAULT_SETTINGS: LocalRestApiSettings = {
  port: 27124,
  insecurePort: 27123,
  enableInsecureServer: false,
};

export const ERROR_CODE_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.ApiKeyAuthorizationRequired]:
    "Authorization required.  Find your API Key in the 'Local REST API' section of your Obsidian settings.",
  [ErrorCode.ContentTypeSpecificationRequired]:
    "Content-Type header required; this API accepts data in multiple content-types and you must indicate the content-type of your request body via the Content-Type header.",
  [ErrorCode.InvalidContentInsertionPositionValue]:
    "Invalid 'Content-Insertion-Position' header value.",
  [ErrorCode.InvalidContentForContentType]:
    "Your request body could not be processed as the content-type specified in your Content-Type header.",
  [ErrorCode.InvalidHeadingHeader]:
    "No heading in specified file could be found matching the heading specified in 'Heading' header.",
  [ErrorCode.MissingHeadingHeader]:
    "'Heading' header is required for identifying where to insert content.",
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
  [ErrorCode.MissingTargetTypeHeader]: "Target-Type header required. Options: 'heading' (insert at heading), 'block' (modify block content), 'frontmatter' (update metadata), 'file' (rename/move), 'directory' (move), 'tag' (add/remove).",
  [ErrorCode.InvalidTargetTypeHeader]:
    "Invalid Target-Type header. Valid options: 'heading' (insert at heading), 'block' (modify block content), 'frontmatter' (update metadata), 'file' (rename/move), 'directory' (move), 'tag' (add/remove).",
  [ErrorCode.MissingTargetHeader]: "Target header required. This should be the heading name, block ID (without ^), frontmatter field name, tag name, or path depending on your Target-Type.",
  [ErrorCode.MissingOperation]: "Operation header required. Options: 'append' (add after), 'prepend' (add before), 'replace' (replace content), 'rename' (file only), 'move' (file/directory), 'add'/'remove' (tags only).",
  [ErrorCode.InvalidOperation]:
    "Invalid Operation header. Valid options: 'append' (add after), 'prepend' (add before), 'replace' (replace content), 'rename' (file only), 'move' (file/directory), 'add'/'remove' (tags only).",
  [ErrorCode.PatchFailed]:
    "The patch you provided could not be applied to the target content.",
};

export enum ContentTypes {
  json = "application/json",
  markdown = "text/markdown",
  olrapiNoteJson = "application/vnd.olrapi.note+json",
  jsonLogic = "application/vnd.olrapi.jsonlogic+json",
  dataviewDql = "application/vnd.olrapi.dataview.dql+txt",
}

export const DefaultBearerTokenHeaderName = "Authorization";
export const DefaultBindingHost = "127.0.0.1";

export const LicenseUrl =
  "https://raw.githubusercontent.com/coddingtonbear/obsidian-local-rest-api/main/LICENSE";

export const MaximumRequestSize = "1024mb";
