import { ErrorCode, LocalRestApiSettings } from "./types";

export const CERT_NAME = "obsidian-local-rest-api.crt";

export const DEFAULT_SETTINGS: LocalRestApiSettings = {
  port: 27124,
};

export const ERROR_CODE_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.ApiKeyAuthorizationRequired]:
    "Authorization required.  Find your API Key in the 'Local REST API' section of your Obsidian settings.",
  [ErrorCode.InvalidContentInsertionPositionValue]:
    "Invalid 'Content-Insertion-Position' header value.",
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
  [ErrorCode.TextOrByteContentEncodingRequired]:
    "Incoming content did not come with a bytes or text content encoding.  Be sure to set a Content-type header matching application/* or text/*.",
};
