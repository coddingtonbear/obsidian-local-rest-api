import {
  apiVersion,
  App,
  PluginManifest,
  TFile,
} from "obsidian";
import { posix } from "path";
import forge from "node-forge";

import express from "express";
import http from "http";
import cors from "cors";
import mime from "mime-types";
import responseTime from "response-time";
import queryString from "query-string";
import {
  FrontmatterParseError,
  getDocumentMap,
  PatchFailed,
  PatchOperation,
} from "markdown-patch";
import {
  ContentPreexistsError,
  InvalidCellError,
  InvalidCellContentError,
  InvalidInstructionError,
  PreconditionFailedError,
  TargetNotFoundError,
  FrontmatterParseError as FrontmatterParseErrorV2,
  FrontmatterKeyCollisionError,
  ReservedDuplicateMarkerError,
  InstructionInputSchema,
  readTarget,
} from "markdown-patch-2";
import type {
  InstructionInput,
  PublicMap,
  ReadTarget,
} from "markdown-patch-2";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

import {
  CannedResponse,
  DocumentMapObject,
  ErrorCode,
  ErrorResponseDescriptor,
  FileMetadataObject,
  LocalRestApiSettings,
  PeriodicNoteInterface,
  SearchJsonResponseItem,
} from "./types";
import {
  getCertificateIsUptoStandards,
  getCertificateValidityDays,
} from "./utils";
import {
  CERT_NAME,
  ContentTypes,
  ERROR_CODE_MESSAGES,
  MaximumRequestSize,
} from "./constants";
import {
  isContentType,
  isPatchOperation,
  isPatchTargetScope,
  isPatchTargetType,
  isV2Operation,
  isV2Scope,
  isV2TargetType,
} from "./typeGuards";
import LocalRestApiPublicApi from "./api";
import {
  CommandNotFoundError,
  DestinationAlreadyExistsError,
  FileNotFoundError,
  VaultOperations,
} from "./vaultOperations";
import { McpHandler } from "./mcpHandler";

// Import openapi.yaml as a string
import openapiYaml from "../docs/openapi.yaml";

/** The header that selects which markdown-patch format a request speaks. */
export const MARKDOWN_PATCH_VERSION_HEADER = "Markdown-Patch-Version";

/** The `sunset-version` advertised for the deprecated 1.x format (RFC 8594). */
export const MARKDOWN_PATCH_V1_SUNSET = "6.0";

/**
 * Resolve which markdown-patch engine a request selects via the
 * {@link MARKDOWN_PATCH_VERSION_HEADER} header. The 2.0 format is the default:
 * an absent header or an explicit `"2"` selects it; `"1"` opts back into the
 * deprecated header-driven format; any other value is invalid (`null`).
 */
export function resolvePatchVersion(
  req: express.Request,
): 1 | 2 | null {
  const raw = req.get(MARKDOWN_PATCH_VERSION_HEADER);
  if (raw === undefined || raw === "2") return 2;
  if (raw === "1") return 1;
  return null;
}

export default class RequestHandler {
  app: App;
  api: express.Express;
  manifest: PluginManifest;
  settings: LocalRestApiSettings;

  apiExtensionRouter: express.Router;
  publicApiExtensionRouter: express.Router;
  apiExtensions: Map<string, { manifest: PluginManifest; api: LocalRestApiPublicApi }> = new Map();

  operations: VaultOperations;
  mcpHandler: McpHandler;

  constructor(
    app: App,
    manifest: PluginManifest,
    settings: LocalRestApiSettings,
  ) {
    this.app = app;
    this.manifest = manifest;
    this.api = express();
    this.settings = settings;

    this.apiExtensionRouter = express.Router();
    this.publicApiExtensionRouter = express.Router();
    this.operations = new VaultOperations(this.app);
    this.mcpHandler = new McpHandler(this.operations, this.settings);

    this.api.set("json spaces", 2);
  }

  registerApiExtension(manifest: PluginManifest): LocalRestApiPublicApi {
    const existing = this.apiExtensions.get(manifest.id);
    if (existing) {
      return existing.api;
    }

    const router = express.Router();
    const publicRouter = express.Router();
    this.apiExtensionRouter.use(router);
    this.publicApiExtensionRouter.use(publicRouter);
    const removeRouter = (parent: express.Router, child: express.Router) => {
      const idx = parent.stack.findIndex((layer: { handle?: unknown }) => layer.handle === child);
      if (idx !== -1) {
        parent.stack.splice(idx, 1);
      }
    };
    const api = new LocalRestApiPublicApi(router, publicRouter, this.mcpHandler, () => {
      if (this.apiExtensions.delete(manifest.id)) {
        removeRouter(this.apiExtensionRouter, router);
        removeRouter(this.publicApiExtensionRouter, publicRouter);
      }
    });
    this.apiExtensions.set(manifest.id, { manifest, api });

    return api;
  }

  requestIsAuthenticated(req: express.Request): boolean {
    const authorizationHeader = req.get(
      this.settings.authorizationHeaderName ?? "Authorization",
    );
    if (authorizationHeader === `Bearer ${this.settings.apiKey}`) {
      return true;
    }

    return false;
  }

  async authenticationMiddleware(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): Promise<void> {
    const authenticationExemptRoutes: string[] = [
      "/",
      `/${CERT_NAME}`,
      "/openapi.yaml",
    ];

    if (
      !authenticationExemptRoutes.includes(req.path) &&
      !this.requestIsAuthenticated(req)
    ) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.ApiKeyAuthorizationRequired,
      });
      return;
    }

    next();
  }

  async getDocumentMapObject(file: TFile): Promise<DocumentMapObject> {
    return this.operations.getDocumentMapObject(file);
  }

  async getDocumentMapV2Object(file: TFile): Promise<PublicMap> {
    return this.operations.getDocumentMapV2Object(file);
  }

  async getFileMetadataObject(file: TFile): Promise<FileMetadataObject> {
    return this.operations.getFileMetadataObject(file);
  }

  getResponseMessage({
    statusCode = 400,
    message,
    errorCode,
  }: ErrorResponseDescriptor): string {
    const errorMessages: string[] = [];
    if (errorCode) {
      errorMessages.push(ERROR_CODE_MESSAGES[errorCode]);
    } else {
      errorMessages.push(http.STATUS_CODES[statusCode] ?? "Unknown Error");
    }
    if (message) {
      errorMessages.push(message);
    }

    return errorMessages.join("\n");
  }

  getStatusCode({ statusCode, errorCode }: ErrorResponseDescriptor): number {
    if (statusCode) {
      return statusCode;
    } else if (errorCode) {
      return Math.floor(errorCode / 100);
    }
    throw new Error("Either statusCode or errorCode must be provided");
  }

  returnCannedResponse(
    res: express.Response,
    { statusCode, message, errorCode }: ErrorResponseDescriptor,
  ): void {
    if (!statusCode && !errorCode) {
      throw new Error("Either statusCode or errorCode must be provided");
    }
    const response: CannedResponse = {
      message: this.getResponseMessage({ statusCode, message, errorCode }),
      errorCode: errorCode ?? (statusCode ?? -1) * 100,
    };

    res.status(this.getStatusCode({ statusCode, errorCode })).json(response);
  }

  root(req: express.Request, res: express.Response): void {
    let certificate: forge.pki.Certificate | undefined;
    try {
      if (this.settings.crypto?.cert) {
        certificate = forge.pki.certificateFromPem(this.settings.crypto.cert);
      }
    } catch {
      // This is fine, we just won't include that in the output
    }

    res.status(200).json({
      status: "OK",
      manifest: this.manifest,
      versions: {
        obsidian: apiVersion,
        self: this.manifest.version,
      },
      service: "Obsidian Local REST API",
      authenticated: this.requestIsAuthenticated(req),
      certificateInfo:
        this.requestIsAuthenticated(req) && certificate
          ? {
            validityDays: getCertificateValidityDays(certificate),
            regenerateRecommended:
              !getCertificateIsUptoStandards(certificate),
          }
          : undefined,
      apiExtensions: this.requestIsAuthenticated(req)
        ? [...this.apiExtensions.values()].map(({ manifest, api }) => ({
          ...manifest,
          routes: api.getRoutes(),
          mcpTools: api.getMcpTools(),
        }))
        : undefined,
    });
  }

  /** The vault path from the request, split into decoded segments.
   *
   *  `req.path` is the raw, still-encoded path, so it is split on its *real*
   *  slashes and each segment is decoded individually. A `%2F` therefore stays a
   *  literal `/` inside the one segment it belongs to (e.g. a heading named
   *  "A/B") instead of re-forming a path boundary the way a decode-then-split
   *  would. Returns null (and sends a 400) on malformed encoding or a path that
   *  escapes the vault root. */
  private extractVaultPath(
    req: express.Request,
    res: express.Response,
  ): string[] | null {
    const rawRemainder = req.path.slice(req.path.indexOf("/", 1) + 1);
    let segments: string[];
    try {
      segments = rawRemainder.split("/").map((s) => decodeURIComponent(s));
    } catch {
      this.returnCannedResponse(res, { errorCode: ErrorCode.PathTraversalNotAllowed });
      return null;
    }
    // Traversal guard: resolve the decoded path against the synthetic vault root
    // and reject anything that escapes it. Applied to the joined form so an
    // encoded `..%2F..%2F…` — which arrives as a single segment — is still
    // caught after decoding.
    const syntheticRoot = "/vault";
    const resolved = posix.resolve(syntheticRoot, segments.join("/"));
    if (resolved !== syntheticRoot && !resolved.startsWith(syntheticRoot + "/")) {
      this.returnCannedResponse(res, { errorCode: ErrorCode.PathTraversalNotAllowed });
      return null;
    }
    return segments;
  }

  /** Join decoded segments into a whole-file path, or null when a segment holds
   *  a literal `/` (a decoded `%2F`). A file or folder name can never contain a
   *  slash, so such a segment can only belong to a target address — this is what
   *  stops `folder%2Fnote.md` (one segment "folder/note.md") from resolving as a
   *  file. A trailing empty segment (a trailing slash) is preserved so the
   *  whole-file handlers still reject a directory path. */
  private wholeFilePath(segments: string[]): string | null {
    if (segments.some((segment) => segment.includes("/"))) return null;
    return segments.join("/");
  }

  /** The wildcard suffix of an `/active/*` or `/periodic/…/*` route, split into
   *  decoded segments. Express decodes the `req.params[0]` wildcard capture
   *  before the handler runs — collapsing a `%2F` to a boundary — so the raw
   *  suffix is recovered from `req.path` (still encoded) and each segment decoded
   *  individually, mirroring {@link extractVaultPath}. The static prefix length
   *  comes from the matched route pattern. Returns null (and sends a 400) on
   *  malformed encoding. */
  private rawSuffixSegments(
    req: express.Request,
    res: express.Response,
  ): string[] | null {
    const route = req.route as { path?: string } | undefined;
    const routePath = route?.path ?? "";
    // The pattern ends in the `*` wildcard; every earlier segment is static
    // prefix. Dropping that many leading segments of the raw path leaves the
    // still-encoded suffix.
    const prefixLength = routePath.split("/").length - 1;
    const rawSegments = req.path
      .split("/")
      .slice(prefixLength)
      .filter((segment) => segment.length > 0);
    try {
      return rawSegments.map((segment) => decodeURIComponent(segment));
    } catch {
      this.returnCannedResponse(res, { errorCode: ErrorCode.PathTraversalNotAllowed });
      return null;
    }
  }

  async _vaultGet(
    segments: string[],
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    // A whole-file or directory match only applies when the path can name one:
    // a segment holding a literal "/" (a decoded %2F) never can, so such a path
    // is a target address only (see wholeFilePath). Step 1: normalize trailing
    // slash off the whole-file path.
    const wholeFilePath = this.wholeFilePath(segments);
    const normalizedPath =
      wholeFilePath === null
        ? null
        : wholeFilePath.endsWith("/")
          ? wholeFilePath.slice(0, -1)
          : wholeFilePath;

    // Step 2: Exact file match (fast path)
    let filePath = normalizedPath ?? "";
    let urlTargetType: string | undefined;
    let urlTarget: string | undefined;
    let urlTargetSegments: string[] | undefined;

    let exactStat = null;
    if (normalizedPath !== null) {
      try {
        exactStat = normalizedPath
          ? await this.app.vault.adapter.stat(normalizedPath)
          : null;
      } catch {
        // ENOTDIR: a path segment is a file, not a directory — treat as no match.
      }
    }

    if (!exactStat || exactStat.type !== "file") {
      // Step 3: Directory listing check (only when the path can be a directory).
      if (normalizedPath !== null) {
        const prefix = normalizedPath ? normalizedPath + "/" : "";
        const hasChildren = this.app.vault
          .getFiles()
          .some((f) => f.path.startsWith(prefix));

        if (!normalizedPath || hasChildren) {
          const files = await this.operations.listVaultDirectory(normalizedPath);

          if (files.length === 0 && normalizedPath) {
            this.returnCannedResponse(res, { statusCode: 404 });
            return;
          }

          res.json({ files: files });
          return;
        }
      }

      // Steps 4-5: Walk backward to find file + target (404 if nothing found)
      const resolved = await this._resolvePathAndTarget(segments);
      if (!resolved?.targetType) {
        this.returnCannedResponse(res, { statusCode: 404 });
        return;
      }
      filePath = resolved.filePath;
      urlTargetType = resolved.targetType;
      urlTarget = resolved.target;
      urlTargetSegments = resolved.targetSegments;
    }

    const content = await this.app.vault.adapter.readBinary(filePath);
    const mimeType = mime.lookup(filePath);

    res.set({
      "Content-Disposition": `attachment; filename="${encodeURI(
        filePath,
      ).replace(",", "%2C")}"`,
      "Content-Type":
        `${mimeType}` +
        (mimeType == ContentTypes.markdown ? "; charset=utf-8" : ""),
    });

    if ((req.headers.accept as ContentTypes) === ContentTypes.olrapiNoteJson) {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) {
        this.returnCannedResponse(res, { statusCode: 404 });
        return;
      }
      res.setHeader("Content-Type", ContentTypes.olrapiNoteJson);
      res.send(
        JSON.stringify(await this.getFileMetadataObject(file), null, 2),
      );
      return;
    } else if ((req.headers.accept as ContentTypes) === ContentTypes.olrapiDocumentMap) {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) {
        this.returnCannedResponse(res, { statusCode: 404 });
        return;
      }
      // The document map defaults to the 2.0 shape (array heading addresses plus
      // the `version` token); Markdown-Patch-Version: 1 returns the deprecated
      // 1.x shape (`::`-joined heading paths, no version).
      const version = resolvePatchVersion(req);
      if (version === null) {
        this.returnCannedResponse(res, { errorCode: ErrorCode.InvalidPatchVersionHeader });
        return;
      }
      res.setHeader("Content-Type", ContentTypes.olrapiDocumentMap);
      let mapJson: string;
      try {
        mapJson =
          version === 1
            ? JSON.stringify(await this.getDocumentMapObject(file), null, 2)
            : JSON.stringify(await this.getDocumentMapV2Object(file), null, 2);
      } catch (e) {
        if (e instanceof FrontmatterParseError || e instanceof FrontmatterParseErrorV2) {
          this.returnCannedResponse(res, {
            errorCode: ErrorCode.InvalidFrontmatter,
            message: e.message,
          });
          return;
        }
        if (e instanceof ReservedDuplicateMarkerError) {
          this.returnCannedResponse(res, {
            errorCode: ErrorCode.PatchFailed,
            message: e.message,
          });
          return;
        }
        throw e;
      }
      if (version === 1) {
        res.setHeader("Deprecation", `true; sunset-version="${MARKDOWN_PATCH_V1_SUNSET}"`);
      }
      res.send(mapJson);
      return;
    }

    if (urlTargetType !== undefined && (req.get("Target-Type") || req.get("Target"))) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.ConflictingTargetSpecification,
      });
      return;
    }

    const isHeaderTargeting = urlTargetType === undefined;
    const targetType = urlTargetType ?? req.get("Target-Type");
    if (targetType) {
      if (!["heading", "block", "frontmatter"].includes(targetType)) {
        this.returnCannedResponse(res, {
          errorCode: ErrorCode.InvalidTargetTypeHeader,
          message: isHeaderTargeting
            ? "It was supplied in the 'Target-Type' header."
            : `It was supplied as the URL path element '${targetType}', immediately after the note.`,
        });
        return;
      }

      const version = resolvePatchVersion(req);
      if (version === null) {
        this.returnCannedResponse(res, { errorCode: ErrorCode.InvalidPatchVersionHeader });
        return;
      }

      // Header-based targeting is a deprecated 1.x feature: it is only processed
      // under Markdown-Patch-Version: 1 (which carries the sunset advisory). Under
      // the default (2.0), reach a sub-part with URL path elements instead.
      if (isHeaderTargeting && version !== 1) {
        this.returnCannedResponse(res, {
          errorCode: ErrorCode.HeaderTargetingRequiresVersion1,
        });
        return;
      }

      let rawTarget = "";
      try {
        rawTarget =
          urlTargetType !== undefined
            ? urlTarget ?? ""
            : decodeURIComponent(req.get("Target") ?? "");
      } catch {
        this.returnCannedResponse(res, {
          errorCode: ErrorCode.InvalidTargetHeader,
        });
        return;
      }
      if (!rawTarget) {
        this.returnCannedResponse(res, {
          errorCode: ErrorCode.MissingTargetHeader,
        });
        return;
      }

      const fileContent = Buffer.from(content).toString("utf-8");
      const targetDelimiter = req.get("Target-Delimiter") || "::";

      if (version === 2) {
        // v2 targeting is always path-based (header targeting is rejected above),
        // so a heading is addressed array-natively via its URL path segments — no
        // delimiter split that a heading containing `::` would otherwise break.
        const address: ReadTarget =
          targetType === "heading"
            ? { targetType: "heading", target: urlTargetSegments ?? rawTarget.split(targetDelimiter) }
            : targetType === "block"
              ? { targetType: "block", target: rawTarget }
              : { targetType: "frontmatter", target: rawTarget };
        let result;
        try {
          result = readTarget(fileContent, address);
        } catch (e) {
          if (e instanceof TargetNotFoundError) {
            this.returnCannedResponse(res, { statusCode: 404 });
            return;
          }
          if (e instanceof FrontmatterParseErrorV2) {
            this.returnCannedResponse(res, {
              errorCode: ErrorCode.InvalidFrontmatter,
              message: e.message,
            });
            return;
          }
          if (e instanceof ReservedDuplicateMarkerError) {
            this.returnCannedResponse(res, {
              errorCode: ErrorCode.PatchFailed,
              message: e.message,
            });
            return;
          }
          throw e;
        }
        if (result.kind === "frontmatter") {
          res.setHeader("Content-Type", ContentTypes.json);
          res.json(result.value);
        } else {
          res.setHeader("Content-Type", ContentTypes.markdown + "; charset=utf-8");
          res.send(result.content);
        }
        return;
      }

      // version === 1: deprecated 1.x header-driven extraction.
      res.setHeader("Deprecation", `true; sunset-version="${MARKDOWN_PATCH_V1_SUNSET}"`);
      const documentMap = getDocumentMap(fileContent);

      if (targetType === "frontmatter") {
        const value: unknown = documentMap.frontmatter[rawTarget];
        if (value === undefined) {
          this.returnCannedResponse(res, { statusCode: 404 });
          return;
        }
        res.setHeader("Content-Type", ContentTypes.json);
        res.json(value);
        return;
      }

      const mapKey =
        targetType === "heading"
          ? rawTarget
            .split(targetDelimiter)
            .join("\u001f")
          : rawTarget;

      const entry =
        targetType === "heading"
          ? documentMap.heading[mapKey]
          : documentMap.block[mapKey];

      if (!entry) {
        this.returnCannedResponse(res, { statusCode: 404 });
        return;
      }

      const sectionContent = fileContent.substring(
        entry.content.start,
        entry.content.end,
      );
      res.setHeader("Content-Type", ContentTypes.markdown + "; charset=utf-8");
      res.send(sectionContent);
      return;
    }

    res.send(Buffer.from(content));
  }

  async vaultGet(req: express.Request, res: express.Response): Promise<void> {
    const segments = this.extractVaultPath(req, res);
    if (segments === null) return;
    return this._vaultGet(segments, req, res);
  }

  /** Resolves a raw path (possibly containing a URL-embedded target) into a
   *  file path and optional target type + target string.  Returns null when no
   *  vault file can be found at any prefix of the path. */
  async _resolvePathAndTarget(segments: string[]): Promise<{
    filePath: string;
    targetType?: string;
    target?: string;
    targetSegments?: string[];
  } | null> {
    return this.operations.resolvePathAndTarget(segments);
  }

  /** Reads Target-Type / Target headers, validates them, and returns the
   *  decoded values.  If either header is invalid or missing when the other is
   *  present, an error response is sent and null is returned.  Returns
   *  undefined (without touching the response) when neither header is present. */
  _getHeaderTarget(
    req: express.Request,
    res: express.Response,
  ): { targetType: string; target: string } | null | undefined {
    const rawTargetType = req.get("Target-Type");
    const rawTarget = req.get("Target");

    if (!rawTargetType && !rawTarget) {
      return undefined;
    }

    if (!rawTargetType) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.MissingTargetTypeHeader,
      });
      return null;
    }
    if (!["heading", "block", "frontmatter"].includes(rawTargetType)) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.InvalidTargetTypeHeader,
      });
      return null;
    }

    let target = "";
    try {
      target = decodeURIComponent(rawTarget ?? "");
    } catch {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.InvalidTargetHeader,
      });
      return null;
    }
    if (!target) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.MissingTargetHeader,
      });
      return null;
    }

    return { targetType: rawTargetType, target };
  }

  /** Parse the Target-Type/Target headers for a raw-content-mode PATCH.
   *
   *  Unlike the deprecated 1.x `_getHeaderTarget` (delimiter-joined strings),
   *  the encoding here is type-dependent, mirroring the 2.0 instruction's
   *  target shapes: a heading Target is percent-encoded JSON (an array of
   *  heading texts, or `null` for the document root), while block and
   *  frontmatter Targets are plain percent-encoded strings. Returns null when
   *  an error response has already been sent. */
  _getPatchHeaderTarget(
    req: express.Request,
    res: express.Response,
  ): { targetType: string; target: string[] | string | null } | null {
    const rawTargetType = req.get("Target-Type");
    const rawTarget = req.get("Target");

    if (!rawTargetType) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.MissingTargetTypeHeader,
      });
      return null;
    }
    if (!isV2TargetType(rawTargetType)) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.InvalidTargetTypeHeader,
      });
      return null;
    }
    if (!rawTarget) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.MissingTargetHeader,
      });
      return null;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(rawTarget);
    } catch {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.InvalidTargetHeader,
        message: "The 'Target' header could not be percent-decoded.",
      });
      return null;
    }

    if (rawTargetType === "heading") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(decoded);
      } catch {
        parsed = undefined;
      }
      const isHeadingAddress =
        parsed === null ||
        (Array.isArray(parsed) &&
          parsed.every((segment) => typeof segment === "string"));
      if (parsed === undefined || !isHeadingAddress) {
        this.returnCannedResponse(res, {
          errorCode: ErrorCode.InvalidTargetHeader,
          message:
            "A heading 'Target' header must be percent-encoded JSON: an array of heading texts (e.g. %5B%22A%22%2C%22B%22%5D) or null for the document root.",
        });
        return null;
      }
      return { targetType: rawTargetType, target: parsed as string[] | null };
    }

    if (!decoded) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.MissingTargetHeader,
      });
      return null;
    }
    return { targetType: rawTargetType, target: decoded };
  }

  async _vaultPut(
    filepath: string,
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    if (!filepath || filepath.endsWith("/")) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.RequestMethodValidOnlyForFiles,
      });
      return;
    }
    await this.operations.writeFileContent(filepath, req.body as string | Buffer);
    this.returnCannedResponse(res, { statusCode: 204 });
    return;
  }

  async vaultPut(req: express.Request, res: express.Response): Promise<void> {
    const segments = this.extractVaultPath(req, res);
    if (segments === null) return;
    const resolved = await this._resolvePathAndTarget(segments);
    if (resolved === null) {
      if (
        segments.some((s) => ["heading", "block", "frontmatter"].includes(s))
      ) {
        this.returnCannedResponse(res, { statusCode: 404 });
        return;
      }
    } else if (resolved.targetType) {
      if (req.get("Target-Type") || req.get("Target")) {
        this.returnCannedResponse(res, {
          errorCode: ErrorCode.ConflictingTargetSpecification,
        });
        return;
      }
      return this._vaultPatchTargeted(
        resolved.filePath,
        resolved.targetType,
        resolved.target ?? "",
        "replace",
        req,
        res,
        { createTargetIfMissing: true, source: "path", targetSegments: resolved.targetSegments },
      );
    }
    // No URL target resolved: the request addresses a whole file. A segment
    // holding a literal "/" cannot name one (see wholeFilePath), so it 404s.
    const filePath = this.wholeFilePath(segments);
    if (filePath === null) {
      this.returnCannedResponse(res, { statusCode: 404 });
      return;
    }
    const headerTarget = this._getHeaderTarget(req, res);
    if (headerTarget !== undefined) {
      if (!headerTarget) return; // error already sent
      return this._vaultPatchTargeted(
        filePath,
        headerTarget.targetType,
        headerTarget.target,
        "replace",
        req,
        res,
        { createTargetIfMissing: true, source: "header" },
      );
    }
    return this._vaultPut(filePath, req, res);
  }

  async _vaultPatch(
    path: string,
    req: express.Request,
    res: express.Response,
    urlTarget?: { targetType: string; target?: string; targetSegments?: string[] },
  ): Promise<void> {
    if (!path || path.endsWith("/")) {
      this.returnCannedResponse(res, { errorCode: ErrorCode.RequestMethodValidOnlyForFiles });
      return;
    }

    // Select the engine by the Markdown-Patch-Version header. The 2.0 format is
    // the default: its whole instruction is the JSON request body, so any
    // request that does not opt into 1.x is routed there. `Markdown-Patch-Version: 1`
    // opts back into the deprecated header-driven format below.
    const version = resolvePatchVersion(req);
    if (version === null) {
      this.returnCannedResponse(res, { errorCode: ErrorCode.InvalidPatchVersionHeader });
      return;
    }

    // Three targeting signals exist: URL path elements, Target-Type/Target
    // headers, and the explicit instruction-body content type. They are
    // mutually exclusive — a request supplying more than one is ambiguous
    // about which specification governs, so it is rejected rather than have
    // one silently win.
    const headerTargeting = !!(req.get("Target-Type") || req.get("Target"));
    const baseContentType = (req.get("Content-Type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const isInstructionBody =
      baseContentType === (ContentTypes.olrapiPatchInstruction as string);
    if (
      (urlTarget && headerTargeting) ||
      (isInstructionBody && (urlTarget || headerTargeting))
    ) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.ConflictingTargetSpecification,
      });
      return;
    }

    if (version === 2) {
      if (urlTarget) {
        return this._vaultPatchRawContent(
          path,
          {
            targetType: urlTarget.targetType,
            target:
              urlTarget.targetType === "heading"
                ? urlTarget.targetSegments ?? [urlTarget.target ?? ""]
                : urlTarget.target ?? "",
          },
          req,
          res,
        );
      }
      if (headerTargeting) {
        // Header-based targeting is ambiguous between the 1.x and 2.0 header
        // formats, so a request must *explicitly* pick a side: absent-version
        // requests (which default to 2.0 everywhere else) fail loudly here
        // rather than have an un-upgraded 1.x client's headers silently
        // reinterpreted under 2.0 semantics.
        if (req.get(MARKDOWN_PATCH_VERSION_HEADER) !== "2") {
          this.returnCannedResponse(res, {
            errorCode: ErrorCode.PatchHeaderTargetingRequiresExplicitVersion,
          });
          return;
        }
        const parsed = this._getPatchHeaderTarget(req, res);
        if (!parsed) return;
        return this._vaultPatchRawContent(path, parsed, req, res);
      }
      const body: unknown = req.body;
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        this.returnCannedResponse(res, {
          errorCode: ErrorCode.InvalidPatchInstruction,
          message:
            "A PATCH expects a JSON instruction object as the request body (send Content-Type: application/json or application/vnd.olrapi.patch-instruction+json). For raw-content mode, target via URL path elements or Target-Type/Target headers with 'Markdown-Patch-Version: 2'. To use the deprecated 1.x header-driven format, set the 'Markdown-Patch-Version: 1' header.",
        });
        return;
      }
      return this._vaultPatchMdp2(path, body as Record<string, unknown>, res);
    }

    // version === 1 with a URL-element target: URL targeting is purely a 2.0
    // feature — before it existed, this path was simply an unresolvable file
    // and 404'd, so an explicit error is clearer than silently keeping that.
    if (urlTarget) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.InvalidPatchVersionHeader,
        message:
          "URL path-element targeting is a markdown-patch 2.0 feature; drop the 'Markdown-Patch-Version: 1' header, or use the deprecated 1.x Target-Type/Target headers instead.",
      });
      return;
    }

    // Past this point the request is served by the deprecated 1.x header-driven
    // format. Advertise the deprecation and planned removal (RFC 8594) on every
    // 1.x response — success or error — so clients are nudged toward the JSON
    // instruction body handled above.
    res.setHeader("Deprecation", `true; sunset-version="${MARKDOWN_PATCH_V1_SUNSET}"`);

    const operation = req.get("Operation");
    const targetType = req.get("Target-Type");
    const rawTarget = decodeURIComponent(req.get("Target") ?? "");
    const contentType = req.get("Content-Type");
    const createTargetIfMissing = req.get("Create-Target-If-Missing") == "true";
    const rejectIfContentPreexists =
      req.get("Reject-If-Content-Preexists") == "true";
    const trimTargetWhitespace = req.get("Trim-Target-Whitespace") == "true";
    const targetDelimiter = req.get("Target-Delimiter") || "::";
    const rawTargetScope = req.get("Target-Scope");
    const targetScope = rawTargetScope || undefined;

    if (!targetType) {
      this.returnCannedResponse(res, { errorCode: ErrorCode.MissingTargetTypeHeader });
      return;
    }
    if (!isPatchTargetType(targetType)) {
      this.returnCannedResponse(res, { errorCode: ErrorCode.InvalidTargetTypeHeader });
      return;
    }
    if (!operation) {
      this.returnCannedResponse(res, { errorCode: ErrorCode.MissingOperation });
      return;
    }
    if (!isPatchOperation(operation)) {
      this.returnCannedResponse(res, { errorCode: ErrorCode.InvalidOperation });
      return;
    }
    if (targetScope && !isPatchTargetScope(targetScope)) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.InvalidTargetScopeHeader,
        message: "Valid values are 'content', 'marker', and 'markerAndContent'.",
      });
      return;
    }
    if (!isContentType(contentType)) {
      this.returnCannedResponse(res, { errorCode: ErrorCode.InvalidContentType });
      return;
    }

    try {
      const patched = await this.operations.patchFileSection(
        path, targetType, rawTarget, operation, req.body, contentType,
        { createTargetIfMissing, rejectIfContentPreexists, trimTargetWhitespace, targetDelimiter, targetScope },
      );
      res.status(200).send(patched);
    } catch (e) {
      if (e instanceof FileNotFoundError) {
        this.returnCannedResponse(res, { statusCode: 404 });
      } else if (e instanceof PatchFailed) {
        this.returnCannedResponse(res, { errorCode: ErrorCode.PatchFailed, message: e.reason });
      } else if (e instanceof FrontmatterParseError) {
        this.returnCannedResponse(res, { errorCode: ErrorCode.InvalidFrontmatter, message: e.message });
      } else {
        this.returnCannedResponse(res, { statusCode: 500, message: (e as Error).message });
      }
    }
  }

  async vaultPatch(req: express.Request, res: express.Response): Promise<void> {
    const segments = this.extractVaultPath(req, res);
    if (segments === null) return;
    const resolved = await this._resolvePathAndTarget(segments);
    if (resolved === null) {
      if (
        segments.some((s) => ["heading", "block", "frontmatter"].includes(s))
      ) {
        this.returnCannedResponse(res, { statusCode: 404 });
        return;
      }
    } else if (resolved.targetType) {
      return this._vaultPatch(resolved.filePath, req, res, {
        targetType: resolved.targetType,
        target: resolved.target,
        targetSegments: resolved.targetSegments,
      });
    }
    const filePath = this.wholeFilePath(segments);
    if (filePath === null) {
      this.returnCannedResponse(res, { statusCode: 404 });
      return;
    }
    return this._vaultPatch(filePath, req, res);
  }

  /** The markdown-patch 2.0 PATCH path. ("Mdp2" = markdown-patch 2.0, not the
   *  removed API version 2.0 heading-based PATCH.) `_vaultPatch` routes here
   *  when a request omits the Target-Type header and carries an object body: the
   *  whole instruction is that JSON body (an `InstructionInput`), and the URL
   *  supplies only the file. On success the patched document is returned as the
   *  body, with any advisory warnings JSON- then percent-encoded into the
   *  `Markdown-Patch-Warnings` response header. */
  async _vaultPatchMdp2(
    path: string,
    candidate: Record<string, unknown>,
    res: express.Response,
  ): Promise<void> {
    // Validate the whole instruction up front, against the same schema the
    // engine validates with, so malformed input gets a clean 400 before the
    // vault is touched. Reporting it as InvalidPatchInstruction with the
    // schema's own field-path messages keeps the error pointed at the field the
    // caller actually wrote: the 4005x codes name request *headers*, which a
    // JSON instruction body does not have. Fields that reached here from
    // headers (raw-content mode) were already validated by the caller, which
    // owns the header-flavored wording for them.
    const parsed = InstructionInputSchema.safeParse(candidate);
    if (!parsed.success) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.InvalidPatchInstruction,
        message: parsed.error.issues
          .map((issue) =>
            issue.path.length
              ? `${issue.path.join(".")}: ${issue.message}`
              : issue.message,
          )
          .join("; "),
      });
      return;
    }

    return this._respondMdp2(path, candidate as unknown as InstructionInput, res);
  }

  /** Assemble a 2.0 instruction for a raw-content-mode PATCH: the target comes
   *  from URL path elements or the Target-Type/Target headers (already parsed
   *  by the caller), the remaining instruction fields from headers, and the
   *  payload carrier from the raw request body — `text/*` is `content`,
   *  `application/json` is `value`, and an empty body carries nothing (a
   *  delete, or a move whose `destination` rides in the Destination header).
   *  This exists so templating-oriented clients can splice unescaped markdown
   *  into the body instead of JSON-escaping it into an instruction document.
   *  The assembled candidate funnels through `_vaultPatchMdp2`, so validation
   *  and error mapping are identical to the JSON-instruction mode. */
  async _vaultPatchRawContent(
    path: string,
    target: { targetType: string; target: string[] | string | null },
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    // These headers only mean something to the deprecated 1.x engine
    // (delimiter-joined targets, 1.x whitespace trimming). Silently ignoring
    // them for an un-upgraded 1.x client would change what its request does,
    // so they fail loudly toward the version choice instead.
    if (req.get("Target-Delimiter") || req.get("Trim-Target-Whitespace")) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.PatchHeaderTargetingRequiresExplicitVersion,
      });
      return;
    }

    const operation = req.get("Operation");
    if (!operation) {
      this.returnCannedResponse(res, { errorCode: ErrorCode.MissingOperation });
      return;
    }
    if (!isV2Operation(operation)) {
      this.returnCannedResponse(res, { errorCode: ErrorCode.InvalidOperation });
      return;
    }

    const scope = req.get("Target-Scope");
    if (scope !== undefined && !isV2Scope(scope)) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.InvalidTargetScopeHeader,
        message:
          "Valid values are 'content', 'marker', 'markerAndContent', and 'parent'.",
      });
      return;
    }

    let destination: unknown;
    const rawDestination = req.get("Destination");
    if (rawDestination !== undefined) {
      try {
        destination = JSON.parse(decodeURIComponent(rawDestination)) as unknown;
      } catch {
        this.returnCannedResponse(res, {
          errorCode: ErrorCode.InvalidDestinationHeader,
          message:
            "The 'Destination' header must be percent-encoded JSON, e.g. %7B%22parent%22%3A%5B%22Appendix%22%5D%2C%22place%22%3A%22last%22%7D.",
        });
        return;
      }
    }

    // Standard If-Match carries a quoted ETag (RFC 9110); the engine's token
    // is bare — accept either by stripping one pair of surrounding quotes.
    const rawIfMatch = req.get("If-Match");
    const ifMatch =
      rawIfMatch !== undefined &&
      rawIfMatch.length >= 2 &&
      rawIfMatch.startsWith('"') &&
      rawIfMatch.endsWith('"')
        ? rawIfMatch.slice(1, -1)
        : rawIfMatch;

    const candidate: Record<string, unknown> = {
      targetType: target.targetType,
      target: target.target,
      operation,
    };
    if (scope !== undefined) candidate.scope = scope;
    if (destination !== undefined) candidate.destination = destination;
    if (ifMatch !== undefined) candidate.ifMatch = ifMatch;
    if (req.get("Create-Target-If-Missing") === "true") {
      candidate.createTargetIfMissing = true;
    }
    if (req.get("Reject-If-Content-Preexists") === "true") {
      candidate.rejectIfContentPreexists = true;
    }

    // A bodiless request still reaches the parsers, which leave `{}` (or an
    // empty string/Buffer) behind — so emptiness is judged from the request
    // framing headers first, never from the parsed value alone. An empty body
    // deliberately maps to *no* carrier: a replace with an accidentally-empty
    // template must fail loudly (missing carrier) rather than clear a section.
    const contentLength = req.get("Content-Length");
    const hasBodyBytes =
      (contentLength !== undefined && contentLength !== "0") ||
      req.get("Transfer-Encoding") !== undefined;
    const body: unknown = req.body;
    const bodyIsEmpty =
      !hasBodyBytes ||
      body === undefined ||
      (typeof body === "string" && body.length === 0) ||
      (Buffer.isBuffer(body) && body.length === 0);

    if (!bodyIsEmpty) {
      const baseContentType = (req.get("Content-Type") ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (baseContentType.startsWith("text/") && typeof body === "string") {
        candidate.content = body;
      } else if (baseContentType === (ContentTypes.json as string)) {
        candidate.value = body;
      } else {
        this.returnCannedResponse(res, {
          errorCode: ErrorCode.InvalidContentType,
          message:
            "A raw-content-mode PATCH accepts a text/* body (the `content` carrier), an application/json body (the `value` carrier), or no body at all (a delete, or a move via the Destination header).",
        });
        return;
      }
    }

    return this._vaultPatchMdp2(path, candidate, res);
  }

  /** Apply a single markdown-patch 2.0 instruction and write the standard 2.0
   *  response: the patched document as the body, any advisory warnings
   *  (percent-encoded JSON) in the `Markdown-Patch-Warnings` header, and the engine's
   *  typed failures mapped to HTTP status codes. Shared by the JSON-body PATCH
   *  endpoint and the path-element targeted GET/PUT/POST writes. */
  async _respondMdp2(
    filePath: string,
    instruction: InstructionInput,
    res: express.Response,
  ): Promise<void> {
    try {
      const result = await this.operations.patchFileSectionMdp2(
        filePath,
        instruction,
      );
      if (result.warnings.length > 0) {
        // Percent-encoded, like Target/Destination on the request side: a
        // warning message embeds document text verbatim (e.g. a heading
        // containing an emoji or accented letter), and HTTP header values must
        // be Latin1 — Node throws on anything outside it. json+percent-encode
        // rather than reject, so a legitimate warning never turns a successful
        // patch into a reported failure.
        res.setHeader(
          "Markdown-Patch-Warnings",
          encodeURIComponent(JSON.stringify(result.warnings)),
        );
      }
      res.setHeader("Content-Type", ContentTypes.markdown + "; charset=utf-8");
      res.status(200).send(result.document);
    } catch (e) {
      if (e instanceof FileNotFoundError) {
        this.returnCannedResponse(res, { statusCode: 404 });
      } else if (e instanceof PreconditionFailedError) {
        this.returnCannedResponse(res, { statusCode: 412, message: e.message });
      } else if (e instanceof TargetNotFoundError) {
        this.returnCannedResponse(res, { statusCode: 404, message: e.message });
      } else if (
        e instanceof ContentPreexistsError ||
        e instanceof FrontmatterKeyCollisionError
      ) {
        this.returnCannedResponse(res, { statusCode: 409, message: e.message });
      } else if (
        e instanceof InvalidCellError ||
        e instanceof InvalidInstructionError ||
        e instanceof InvalidCellContentError
      ) {
        this.returnCannedResponse(res, {
          errorCode: ErrorCode.InvalidPatchInstruction,
          message: e.message,
        });
      } else if (e instanceof FrontmatterParseErrorV2) {
        this.returnCannedResponse(res, {
          errorCode: ErrorCode.InvalidFrontmatter,
          message: e.message,
        });
      } else {
        // Any other failure to compute the patch is a client error against the
        // supplied instruction, mirroring the coarse PatchFailed semantics of
        // the 1.x endpoint rather than reporting a server fault.
        this.returnCannedResponse(res, {
          errorCode: ErrorCode.PatchFailed,
          message: (e as Error).message,
        });
      }
    }
  }

  /** Apply a targeted PUT/POST write to a sub-part of a document.
   *
   *  `source` records how the target was addressed:
   *  - `"path"` — URL path elements (`.../heading/A/B`). The going-forward 2.0
   *    way: routed through the 2.0 engine (heading levels normalized, engine owns
   *    boundary whitespace), addressed array-natively via `targetSegments`.
   *  - `"header"` — the deprecated `Target-Type`/`Target` headers. Only processed
   *    when the caller opts into 1.x with `Markdown-Patch-Version: 1`; otherwise
   *    rejected so a header-targeted write never silently clobbers the whole file.
   *
   *  Every 1.x request (either source under `Markdown-Patch-Version: 1`) carries
   *  the sunset `Deprecation` advisory. */
  async _vaultPatchTargeted(
    filePath: string,
    targetType: string,
    target: string,
    operation: PatchOperation,
    req: express.Request,
    res: express.Response,
    extraOpts: {
      source: "path" | "header";
      createTargetIfMissing?: boolean;
      targetSegments?: string[];
    },
  ): Promise<void> {
    const version = resolvePatchVersion(req);
    if (version === null) {
      this.returnCannedResponse(res, { errorCode: ErrorCode.InvalidPatchVersionHeader });
      return;
    }

    if (extraOpts.source === "header" && version !== 1) {
      this.returnCannedResponse(res, { errorCode: ErrorCode.HeaderTargetingRequiresVersion1 });
      return;
    }

    const contentType = req.get("Content-Type");
    if (!isContentType(contentType)) {
      this.returnCannedResponse(res, { errorCode: ErrorCode.InvalidContentType });
      return;
    }
    const createTargetIfMissing =
      extraOpts.createTargetIfMissing ??
      req.get("Create-Target-If-Missing") == "true";
    const rejectIfContentPreexists =
      req.get("Reject-If-Content-Preexists") == "true";

    if (version === 1) {
      res.setHeader("Deprecation", `true; sunset-version="${MARKDOWN_PATCH_V1_SUNSET}"`);

      const trimTargetWhitespace = req.get("Trim-Target-Whitespace") == "true";
      const targetDelimiter = req.get("Target-Delimiter") || "::";
      const rawTargetScope = req.get("Target-Scope");
      const targetScope = rawTargetScope || undefined;

      if (!isPatchTargetType(targetType)) {
        this.returnCannedResponse(res, { errorCode: ErrorCode.InvalidTargetTypeHeader });
        return;
      }
      if (targetScope && !isPatchTargetScope(targetScope)) {
        this.returnCannedResponse(res, {
          errorCode: ErrorCode.InvalidTargetScopeHeader,
          message:
            "Valid values are 'content', 'marker', and 'markerAndContent'.",
        });
        return;
      }
      if (!target) {
        this.returnCannedResponse(res, { errorCode: ErrorCode.MissingTargetHeader });
        return;
      }

      try {
        const patched = await this.operations.patchFileSection(
          filePath, targetType, target, operation, req.body, contentType,
          { createTargetIfMissing, rejectIfContentPreexists, trimTargetWhitespace, targetDelimiter, targetScope },
        );
        res.status(200).send(patched);
      } catch (e) {
        if (e instanceof FileNotFoundError) {
          this.returnCannedResponse(res, { statusCode: 404 });
        } else if (e instanceof PatchFailed) {
          this.returnCannedResponse(res, { errorCode: ErrorCode.PatchFailed, message: (e).reason });
        } else if (e instanceof FrontmatterParseError) {
          this.returnCannedResponse(res, { errorCode: ErrorCode.InvalidFrontmatter, message: e.message });
        } else {
          this.returnCannedResponse(res, { statusCode: 500, message: (e as Error).message });
        }
      }
      return;
    }

    // Reaching here means version === 2 and source === "path" (header-sourced
    // requests under version 2 were already rejected above). Target-Scope,
    // Target-Delimiter, and Trim-Target-Whitespace only mean something for the
    // deprecated header-driven target — path-element targeting already carries
    // an unambiguous address and always writes content scope. Silently ignoring
    // these headers rather than rejecting them would be a data-loss hazard for
    // an un-upgraded 1.x client: e.g. a `Target-Scope: marker` heading rename
    // would instead replace the section's entire body.
    if (
      req.get("Target-Scope") ||
      req.get("Target-Delimiter") ||
      req.get("Trim-Target-Whitespace")
    ) {
      this.returnCannedResponse(res, { errorCode: ErrorCode.HeaderTargetingRequiresVersion1 });
      return;
    }

    // version === 2 with path-element targeting → the 2.0 engine.
    if (!isV2TargetType(targetType)) {
      this.returnCannedResponse(res, { errorCode: ErrorCode.InvalidTargetTypeHeader });
      return;
    }
    if (!target) {
      this.returnCannedResponse(res, { errorCode: ErrorCode.MissingTargetHeader });
      return;
    }

    // `operation` is only ever "replace" (PUT) or "append" (POST) from the call
    // sites; both are valid 2.0 content-scope operations. A single cast bridges
    // the 1.x operation union to the 2.0 discriminated instruction union, which
    // TypeScript cannot narrow from a union-typed variable.
    // The payload carrier follows what the body *is*, never a coercion of it: a
    // string body is literal text (`content`), and a parsed JSON body is
    // structured data (`value`). Whether that carrier is legal for the target is
    // the engine's call — it accepts `value` as table rows on a block and as the
    // value of a frontmatter key, and rejects it on a heading, whose content
    // cell takes markdown text only. String()-coercing instead would splice
    // "[object Object]" or "x,y" into the document and report success.
    //
    // Frontmatter is the one target whose payload is *always* a value: a
    // `text/markdown` body there is the plain string to store, not markdown to
    // splice, so it uses `value` regardless of the body's runtime type.
    const isStructuredBody = typeof req.body !== "string";
    const instruction = (
      targetType === "frontmatter"
        ? {
            targetType: "frontmatter",
            target,
            operation,
            scope: "content",
            value: req.body as unknown,
            createTargetIfMissing,
            rejectIfContentPreexists,
          }
        : isStructuredBody
          ? {
              targetType,
              target:
                targetType === "heading"
                  ? extraOpts.targetSegments ?? [target]
                  : target,
              operation,
              scope: "content",
              value: req.body as unknown,
              createTargetIfMissing,
              rejectIfContentPreexists,
            }
          : {
              targetType,
              target:
                targetType === "heading"
                  ? extraOpts.targetSegments ?? [target]
                  : target,
              operation,
              scope: "content",
              content: req.body as string,
              createTargetIfMissing,
              rejectIfContentPreexists,
            }
    ) as InstructionInput;

    return this._respondMdp2(filePath, instruction, res);
  }

  async _vaultPost(
    filepath: string,
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    if (!filepath || filepath.endsWith("/")) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.RequestMethodValidOnlyForFiles,
      });
      return;
    }
    if (typeof req.body != "string") {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.TextContentEncodingRequired,
      });
      return;
    }
    await this.operations.appendFileContent(filepath, req.body);
    this.returnCannedResponse(res, { statusCode: 204 });
    return;
  }

  async vaultPost(req: express.Request, res: express.Response): Promise<void> {
    const segments = this.extractVaultPath(req, res);
    if (segments === null) return;
    const resolved = await this._resolvePathAndTarget(segments);
    if (resolved === null) {
      if (
        segments.some((s) => ["heading", "block", "frontmatter"].includes(s))
      ) {
        this.returnCannedResponse(res, { statusCode: 404 });
        return;
      }
    } else if (resolved.targetType) {
      if (req.get("Target-Type") || req.get("Target")) {
        this.returnCannedResponse(res, {
          errorCode: ErrorCode.ConflictingTargetSpecification,
        });
        return;
      }
      return this._vaultPatchTargeted(
        resolved.filePath,
        resolved.targetType,
        resolved.target ?? "",
        "append",
        req,
        res,
        { source: "path", targetSegments: resolved.targetSegments },
      );
    }
    const filePath = this.wholeFilePath(segments);
    if (filePath === null) {
      this.returnCannedResponse(res, { statusCode: 404 });
      return;
    }
    const headerTarget = this._getHeaderTarget(req, res);
    if (headerTarget !== undefined) {
      if (!headerTarget) return; // error already sent
      return this._vaultPatchTargeted(
        filePath,
        headerTarget.targetType,
        headerTarget.target,
        "append",
        req,
        res,
        { source: "header" },
      );
    }
    return this._vaultPost(filePath, req, res);
  }

  async _vaultDelete(
    path: string,
    _req: express.Request,
    res: express.Response,
  ): Promise<void> {
    if (!path || path.endsWith("/")) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.RequestMethodValidOnlyForFiles,
      });
      return;
    }
    try {
      await this.operations.deleteVaultFile(path);
    } catch (e) {
      if (e instanceof FileNotFoundError) {
        this.returnCannedResponse(res, { statusCode: 404 });
      } else {
        this.returnCannedResponse(res, { statusCode: 500 });
      }
      return;
    }
    this.returnCannedResponse(res, { statusCode: 204 });
    return;
  }

  async vaultDelete(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const segments = this.extractVaultPath(req, res);
    if (segments === null) return;
    const resolved = await this._resolvePathAndTarget(segments);
    if (resolved?.targetType) {
      this.returnCannedResponse(res, {
        statusCode: 405,
        message:
          "Deleting a targeted section via URL is not supported. Use PATCH with Operation: replace and an empty body instead.",
      });
      return;
    }
    const filePath = this.wholeFilePath(segments);
    if (filePath === null) {
      this.returnCannedResponse(res, { statusCode: 404 });
      return;
    }
    return this._vaultDelete(filePath, req, res);
  }

  async _vaultMove(
    path: string,
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    if (!path || path.endsWith("/")) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.RequestMethodValidOnlyForFiles,
      });
      return;
    }

    const rawDestination = req.header("Destination");
    const allowOverwrite = req.header("Allow-Overwrite") === "true";

    if (rawDestination === undefined) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.MissingDestinationHeader,
      });
      return;
    }

    const sourceFilename = path.includes("/")
      ? path.slice(path.lastIndexOf("/") + 1)
      : path;

    let normalized: string;
    try {
      normalized = decodeURIComponent(rawDestination.trim())
        .replace(/\\/g, "/")
        .replace(/\/+/g, "/");
    } catch {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.InvalidDestinationHeader,
      });
      return;
    }

    if (normalized.startsWith("/")) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.PathTraversalNotAllowed,
      });
      return;
    }

    const syntheticRoot = "/vault";
    const resolved = posix.resolve(syntheticRoot, normalized);
    if (resolved !== syntheticRoot && !resolved.startsWith(syntheticRoot + "/")) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.PathTraversalNotAllowed,
      });
      return;
    }

    const newPath = !normalized || normalized.endsWith("/")
      ? normalized + sourceFilename
      : normalized;

    try {
      const actualPath = await this.operations.moveVaultFile(path, newPath, allowOverwrite);
      res.set("Content-Location", encodeURI(actualPath));
      this.returnCannedResponse(res, { statusCode: 204 });
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        this.returnCannedResponse(res, { statusCode: 404 });
      } else if (error instanceof DestinationAlreadyExistsError) {
        this.returnCannedResponse(res, {
          errorCode: ErrorCode.DestinationAlreadyExists,
        });
      } else {
        const msg = error instanceof Error ? error.message : String(error);
        this.returnCannedResponse(res, {
          errorCode: ErrorCode.FileOperationFailed,
          message: `Failed to move file: ${msg}`,
        });
      }
    }
  }

  async vaultMove(req: express.Request, res: express.Response): Promise<void> {
    const segments = this.extractVaultPath(req, res);
    if (segments === null) return;
    // Move addresses a whole file; a %2F-bearing segment can't name one.
    const filePath = this.wholeFilePath(segments);
    if (filePath === null) {
      this.returnCannedResponse(res, { statusCode: 404 });
      return;
    }
    return this._vaultMove(filePath, req, res);
  }

  getPeriodicNoteInterface(): Record<string, PeriodicNoteInterface> {
    return this.operations.getPeriodicNoteInterface();
  }

  periodicGetInterface(
    period: string,
  ): [PeriodicNoteInterface | null, ErrorCode | null] {
    return this.operations.periodicGetInterface(period);
  }

  periodicGetNote(
    periodName: string,
    timestamp: number,
  ): [TFile | null, ErrorCode | null] {
    return this.operations.periodicGetNote(periodName, timestamp);
  }

  async periodicGetOrCreateNote(
    periodName: string,
    timestamp: number,
  ): Promise<[TFile | null, ErrorCode | null]> {
    return this.operations.periodicGetOrCreateNote(periodName, timestamp);
  }

  redirectToVaultPath(
    file: TFile,
    req: express.Request,
    res: express.Response,
    handler: (
      path: string,
      req: express.Request,
      res: express.Response,
    ) => void,
  ): void {
    const path = file.path;
    res.set("Content-Location", encodeURI(path));

    return handler(path, req, res);
  }

  getPeriodicDateFromParams(params: {
    year?: string;
    month?: string;
    day?: string;
  }): number {
    const { year, month, day } = params;

    if (year && month && day) {
      const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
      return date.getTime();
    }

    return Date.now();
  }

  async periodicGet(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const date = this.getPeriodicDateFromParams(req.params);
    const [file, err] = this.periodicGetNote(req.params.period, date);
    if (err || !file) {
      this.returnCannedResponse(res, {
        errorCode: err ?? ErrorCode.PeriodicNoteDoesNotExist,
      });
      return;
    }

    const suffixSegments = this.rawSuffixSegments(req, res);
    if (suffixSegments === null) return;
    res.set("Content-Location", encodeURI(file.path));
    return this._vaultGet(
      [...file.path.split("/"), ...suffixSegments],
      req,
      res,
    );
  }

  async periodicPut(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const date = this.getPeriodicDateFromParams(req.params);
    const [file, err] = await this.periodicGetOrCreateNote(
      req.params.period,
      date,
    );
    if (err || !file) {
      this.returnCannedResponse(res, {
        errorCode: err ?? ErrorCode.PeriodicNoteDoesNotExist,
      });
      return;
    }
    const suffixSegments = this.rawSuffixSegments(req, res);
    if (suffixSegments === null) return;
    if (suffixSegments.length > 0) {
      const resolved = await this._resolvePathAndTarget([
        ...file.path.split("/"),
        ...suffixSegments,
      ]);
      if (resolved?.targetType) {
        if (req.get("Target-Type") || req.get("Target")) {
          this.returnCannedResponse(res, {
            errorCode: ErrorCode.ConflictingTargetSpecification,
          });
          return;
        }
        res.set("Content-Location", encodeURI(file.path));
        return this._vaultPatchTargeted(
          resolved.filePath,
          resolved.targetType,
          resolved.target ?? "",
          "replace",
          req,
          res,
          { createTargetIfMissing: true, source: "path", targetSegments: resolved.targetSegments },
        );
      }
    }
    const headerTarget = this._getHeaderTarget(req, res);
    if (headerTarget !== undefined) {
      if (!headerTarget) return; // error already sent
      res.set("Content-Location", encodeURI(file.path));
      return this._vaultPatchTargeted(
        file.path,
        headerTarget.targetType,
        headerTarget.target,
        "replace",
        req,
        res,
        { createTargetIfMissing: true, source: "header" },
      );
    }
    return this.redirectToVaultPath(file, req, res, (p, rq, rs) => { void this._vaultPut(p, rq, rs); });
  }

  async periodicPost(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const date = this.getPeriodicDateFromParams(req.params);
    const [file, err] = await this.periodicGetOrCreateNote(
      req.params.period,
      date,
    );
    if (err || !file) {
      this.returnCannedResponse(res, {
        errorCode: err ?? ErrorCode.PeriodicNoteDoesNotExist,
      });
      return;
    }
    const suffixSegments = this.rawSuffixSegments(req, res);
    if (suffixSegments === null) return;
    if (suffixSegments.length > 0) {
      const resolved = await this._resolvePathAndTarget([
        ...file.path.split("/"),
        ...suffixSegments,
      ]);
      if (resolved?.targetType) {
        if (req.get("Target-Type") || req.get("Target")) {
          this.returnCannedResponse(res, {
            errorCode: ErrorCode.ConflictingTargetSpecification,
          });
          return;
        }
        res.set("Content-Location", encodeURI(file.path));
        return this._vaultPatchTargeted(
          resolved.filePath,
          resolved.targetType,
          resolved.target ?? "",
          "append",
          req,
          res,
          { source: "path", targetSegments: resolved.targetSegments },
        );
      }
    }
    const headerTarget = this._getHeaderTarget(req, res);
    if (headerTarget !== undefined) {
      if (!headerTarget) return; // error already sent
      res.set("Content-Location", encodeURI(file.path));
      return this._vaultPatchTargeted(
        file.path,
        headerTarget.targetType,
        headerTarget.target,
        "append",
        req,
        res,
        { source: "header" },
      );
    }
    return this.redirectToVaultPath(file, req, res, (p, rq, rs) => { void this._vaultPost(p, rq, rs); });
  }

  async periodicPatch(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const date = this.getPeriodicDateFromParams(req.params);
    const [file, err] = await this.periodicGetOrCreateNote(
      req.params.period,
      date,
    );
    if (err || !file) {
      this.returnCannedResponse(res, {
        errorCode: err ?? ErrorCode.PeriodicNoteDoesNotExist,
      });
      return;
    }
    const suffixSegments = this.rawSuffixSegments(req, res);
    if (suffixSegments === null) return;
    if (suffixSegments.length > 0) {
      const resolved = await this._resolvePathAndTarget([
        ...file.path.split("/"),
        ...suffixSegments,
      ]);
      if (resolved?.targetType) {
        res.set("Content-Location", encodeURI(file.path));
        return this._vaultPatch(resolved.filePath, req, res, {
          targetType: resolved.targetType,
          target: resolved.target,
          targetSegments: resolved.targetSegments,
        });
      }
    }
    return this.redirectToVaultPath(
      file,
      req,
      res,
      (p, rq, rs) => { void this._vaultPatch(p, rq, rs); },
    );
  }

  async periodicDelete(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const date = this.getPeriodicDateFromParams(req.params);
    const [file, err] = this.periodicGetNote(req.params.period, date);
    if (err || !file) {
      this.returnCannedResponse(res, {
        errorCode: err ?? ErrorCode.PeriodicNoteDoesNotExist,
      });
      return;
    }
    const suffixSegments = this.rawSuffixSegments(req, res);
    if (suffixSegments === null) return;
    if (suffixSegments.length > 0) {
      this.returnCannedResponse(res, {
        statusCode: 405,
        message:
          "Deleting a targeted section via URL is not supported. Use PATCH with Operation: replace and an empty body instead.",
      });
      return;
    }
    return this.redirectToVaultPath(
      file,
      req,
      res,
      (p, rq, rs) => { void this._vaultDelete(p, rq, rs); },
    );
  }

  async activeFileGet(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      this.returnCannedResponse(res, { statusCode: 404 });
      return;
    }

    const suffixSegments = this.rawSuffixSegments(req, res);
    if (suffixSegments === null) return;
    res.set("Content-Location", encodeURI(file.path));
    return this._vaultGet(
      [...file.path.split("/"), ...suffixSegments],
      req,
      res,
    );
  }

  async activeFilePut(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      this.returnCannedResponse(res, { statusCode: 404 });
      return;
    }
    const suffixSegments = this.rawSuffixSegments(req, res);
    if (suffixSegments === null) return;
    if (suffixSegments.length > 0) {
      const resolved = await this._resolvePathAndTarget([
        ...file.path.split("/"),
        ...suffixSegments,
      ]);
      if (resolved?.targetType) {
        if (req.get("Target-Type") || req.get("Target")) {
          this.returnCannedResponse(res, {
            errorCode: ErrorCode.ConflictingTargetSpecification,
          });
          return;
        }
        res.set("Content-Location", encodeURI(file.path));
        return this._vaultPatchTargeted(
          resolved.filePath,
          resolved.targetType,
          resolved.target ?? "",
          "replace",
          req,
          res,
          { createTargetIfMissing: true, source: "path", targetSegments: resolved.targetSegments },
        );
      }
    }
    const headerTarget = this._getHeaderTarget(req, res);
    if (headerTarget !== undefined) {
      if (!headerTarget) return; // error already sent
      res.set("Content-Location", encodeURI(file.path));
      return this._vaultPatchTargeted(
        file.path,
        headerTarget.targetType,
        headerTarget.target,
        "replace",
        req,
        res,
        { createTargetIfMissing: true, source: "header" },
      );
    }
    return this.redirectToVaultPath(file, req, res, (p, rq, rs) => { void this._vaultPut(p, rq, rs); });
  }

  async activeFilePost(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      this.returnCannedResponse(res, { statusCode: 404 });
      return;
    }
    const suffixSegments = this.rawSuffixSegments(req, res);
    if (suffixSegments === null) return;
    if (suffixSegments.length > 0) {
      const resolved = await this._resolvePathAndTarget([
        ...file.path.split("/"),
        ...suffixSegments,
      ]);
      if (resolved?.targetType) {
        if (req.get("Target-Type") || req.get("Target")) {
          this.returnCannedResponse(res, {
            errorCode: ErrorCode.ConflictingTargetSpecification,
          });
          return;
        }
        res.set("Content-Location", encodeURI(file.path));
        return this._vaultPatchTargeted(
          resolved.filePath,
          resolved.targetType,
          resolved.target ?? "",
          "append",
          req,
          res,
          { source: "path", targetSegments: resolved.targetSegments },
        );
      }
    }
    const headerTarget = this._getHeaderTarget(req, res);
    if (headerTarget !== undefined) {
      if (!headerTarget) return; // error already sent
      res.set("Content-Location", encodeURI(file.path));
      return this._vaultPatchTargeted(
        file.path,
        headerTarget.targetType,
        headerTarget.target,
        "append",
        req,
        res,
        { source: "header" },
      );
    }
    return this.redirectToVaultPath(file, req, res, (p, rq, rs) => { void this._vaultPost(p, rq, rs); });
  }

  async activeFilePatch(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      this.returnCannedResponse(res, { statusCode: 404 });
      return;
    }
    const suffixSegments = this.rawSuffixSegments(req, res);
    if (suffixSegments === null) return;
    if (suffixSegments.length > 0) {
      const resolved = await this._resolvePathAndTarget([
        ...file.path.split("/"),
        ...suffixSegments,
      ]);
      if (resolved?.targetType) {
        res.set("Content-Location", encodeURI(file.path));
        return this._vaultPatch(resolved.filePath, req, res, {
          targetType: resolved.targetType,
          target: resolved.target,
          targetSegments: resolved.targetSegments,
        });
      }
    }
    return this.redirectToVaultPath(
      file,
      req,
      res,
      (p, rq, rs) => { void this._vaultPatch(p, rq, rs); },
    );
  }

  async activeFileDelete(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      this.returnCannedResponse(res, { statusCode: 404 });
      return;
    }
    const suffixSegments = this.rawSuffixSegments(req, res);
    if (suffixSegments === null) return;
    if (suffixSegments.length > 0) {
      this.returnCannedResponse(res, {
        statusCode: 405,
        message:
          "Deleting a targeted section via URL is not supported. Use PATCH with Operation: replace and an empty body instead.",
      });
      return;
    }
    return this.redirectToVaultPath(
      file,
      req,
      res,
      (p, rq, rs) => { void this._vaultDelete(p, rq, rs); },
    );
  }

  async tagsGet(_req: express.Request, res: express.Response): Promise<void> {
    res.json({ tags: this.operations.getAllTags() });
  }

  async commandGet(_req: express.Request, res: express.Response): Promise<void> {
    res.json({ commands: this.operations.listCommands() });
  }

  async commandPost(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    try {
      this.operations.executeCommand(req.params.commandId);
    } catch (err) {
      if (err instanceof CommandNotFoundError) {
        this.returnCannedResponse(res, { statusCode: 404 });
      } else {
        this.returnCannedResponse(res, {
          statusCode: 500,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    this.returnCannedResponse(res, { statusCode: 204 });
  }

  async searchSimplePost(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const query: string = req.query.query as string;
    if (!(typeof query === "string")) {
      return this.returnCannedResponse(res, {
        message: "A single '?query=' parameter is required.",
        errorCode: ErrorCode.InvalidSearch,
      });
    }
    const contextLengthRaw = parseInt(req.query.contextLength as string, 10);
    const contextLength = Number.isNaN(contextLengthRaw)
      ? 100
      : contextLengthRaw;
    try {
      const results = await this.operations.simpleSearch(query, contextLength);
      res.json(results);
    } catch (e) {
      console.error("Could not prepare simple search: ", e);
      return this.returnCannedResponse(res, {
        message: `${e}`,
        errorCode: ErrorCode.ErrorPreparingSimpleSearch,
      });
    }
  }

  valueIsSaneTruthy(value: unknown): boolean {
    if (value === undefined || value === null) {
      return false;
    } else if (Array.isArray(value)) {
      return value.length > 0;
    } else if (typeof value === "object") {
      return Object.keys(value).length > 0;
    }
    return Boolean(value);
  }

  async searchQueryPost(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const handlers: Record<string, () => Promise<SearchJsonResponseItem[]>> = {
      [ContentTypes.jsonLogic]: async () => {
        return this.operations.searchJsonLogic(req.body);
      },
    };
    const contentType = req.headers["content-type"];

    if (!contentType) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.ContentTypeSpecificationRequired,
      });
      return;
    } else if (!handlers[contentType]) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.InvalidContentType,
      });
      return;
    }

    try {
      const results = await handlers[contentType]();
      res.json(results);
    } catch (e) {
      const error = e as Error;
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.InvalidFilterQuery,
        message: `${error.message}`,
      });
      return;
    }
  }

  async openPost(req: express.Request, res: express.Response): Promise<void> {
    const filePath = decodeURIComponent(
      req.path.slice(req.path.indexOf("/", 1) + 1),
    );
    const query = queryString.parseUrl(req.originalUrl, {
      parseBooleans: true,
    }).query;
    const newLeaf = Boolean(query.newLeaf);
    this.operations.openVaultFile(filePath, newLeaf);
    res.json();
  }

  async certificateGet(
    _req: express.Request,
    res: express.Response,
  ): Promise<void> {
    if (!this.settings.crypto?.cert) {
      this.returnCannedResponse(res, { statusCode: 404 });
      return;
    }
    res.set(
      "Content-type",
      `application/octet-stream; filename="${CERT_NAME}"`,
    );
    res.status(200).send(this.settings.crypto.cert);
  }

  async openapiYamlGet(
    _req: express.Request,
    res: express.Response,
  ): Promise<void> {
    res.setHeader("Content-Type", "application/yaml; charset=utf-8");
    res.status(200).send(openapiYaml);
  }

  async notFoundHandler(
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): Promise<void> {
    this.returnCannedResponse(res, {
      statusCode: 404,
    });
    return;
  }

  async errorHandler(
    err: Error,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): Promise<void> {
    if (err.stack) {
      console.error(err.stack);
    } else {
      console.error("No stack available!");
    }
    if (err instanceof SyntaxError) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.InvalidContentForContentType,
      });
      return;
    }
    this.returnCannedResponse(res, {
      statusCode: 500,
      message: err.message,
    });
    return;
  }

  private handle(
    fn: (req: express.Request, res: express.Response) => Promise<void>,
  ): (req: express.Request, res: express.Response, next: express.NextFunction) => void {
    return (req, res, next) => {
      fn(req, res).catch(next);
    };
  }

  setupRouter() {
    this.api.use((req, res, next) => {
      if (this.settings.enableVerboseLogging) {
        const originalSend = res.send;
        res.send = function (body, ...args) {
          console.debug(`[REST API] ${req.method} ${req.url} => ${res.statusCode}`);
          return originalSend.apply(res, [body, ...args]) as ReturnType<typeof res.send>;
        };
      }
      next();
    });
    this.api.use(responseTime());
    this.api.use(cors({ methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "MOVE"] }));

    const mcpRouter = express.Router();
    mcpRouter.use(cors({ methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "MOVE"] }));
    mcpRouter.use((req, res, next) => {
      if (!this.requestIsAuthenticated(req)) {
        this.returnCannedResponse(res, {
          errorCode: ErrorCode.ApiKeyAuthorizationRequired,
        });
        return;
      }
      next();
    });
    mcpRouter.use((req, res, next) => {
      const version = req.headers["mcp-protocol-version"] as string | undefined;
      if (version !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
        res.status(400).json({ error: `Unsupported MCP-Protocol-Version: ${version}` });
        return;
      }
      next();
    });
    mcpRouter.use(express.json({ limit: MaximumRequestSize }));
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    mcpRouter.all("/", async (req, res) => this.mcpHandler.handleRequest(req, res));
    this.api.use("/mcp", mcpRouter);

    this.api.use(this.publicApiExtensionRouter);
    this.api.use(this.authenticationMiddleware.bind(this));
    this.api.use(
      express.json({
        type: ContentTypes.json,
        strict: false,
        limit: MaximumRequestSize,
      }),
    );
    this.api.use(
      express.json({
        type: ContentTypes.olrapiNoteJson,
        strict: false,
        limit: MaximumRequestSize,
      }),
    );
    this.api.use(
      express.json({
        type: ContentTypes.jsonLogic,
        strict: false,
        limit: MaximumRequestSize,
      }),
    );
    this.api.use(
      express.json({
        type: ContentTypes.olrapiPatchInstruction,
        strict: false,
        limit: MaximumRequestSize,
      }),
    );
    this.api.use(
      express.text({ type: "text/*", limit: MaximumRequestSize }),
    );
    this.api.use(express.raw({ type: "*/*", limit: MaximumRequestSize }));

    this.api
      .route("/active/*")
      .get(this.handle((rq, rs) => this.activeFileGet(rq, rs)))
      .put(this.handle((rq, rs) => this.activeFilePut(rq, rs)))
      .patch(this.handle((rq, rs) => this.activeFilePatch(rq, rs)))
      .post(this.handle((rq, rs) => this.activeFilePost(rq, rs)))
      .delete(this.handle((rq, rs) => this.activeFileDelete(rq, rs)));

    this.api
      .route("/vault/*")
      .get(this.handle((rq, rs) => this.vaultGet(rq, rs)))
      .put(this.handle((rq, rs) => this.vaultPut(rq, rs)))
      .patch(this.handle((rq, rs) => this.vaultPatch(rq, rs)))
      .post(this.handle((rq, rs) => this.vaultPost(rq, rs)))
      .delete(this.handle((rq, rs) => this.vaultDelete(rq, rs)))
      .all((req, res, next) => {
        if (req.method === "MOVE") {
          return this.handle((rq, rs) => this.vaultMove(rq, rs))(req, res, next);
        } else {
          next();
        }
      });

    this.api
      .route("/periodic/:period/:year(\\d{4})/:month(\\d{1,2})/:day(\\d{1,2})/*")
      .get(this.handle((rq, rs) => this.periodicGet(rq, rs)))
      .put(this.handle((rq, rs) => this.periodicPut(rq, rs)))
      .patch(this.handle((rq, rs) => this.periodicPatch(rq, rs)))
      .post(this.handle((rq, rs) => this.periodicPost(rq, rs)))
      .delete(this.handle((rq, rs) => this.periodicDelete(rq, rs)));
    this.api
      .route("/periodic/:period/*")
      .get(this.handle((rq, rs) => this.periodicGet(rq, rs)))
      .put(this.handle((rq, rs) => this.periodicPut(rq, rs)))
      .patch(this.handle((rq, rs) => this.periodicPatch(rq, rs)))
      .post(this.handle((rq, rs) => this.periodicPost(rq, rs)))
      .delete(this.handle((rq, rs) => this.periodicDelete(rq, rs)));

    this.api.route("/tags/").get(this.handle((rq, rs) => this.tagsGet(rq, rs)));

    this.api.route("/commands/").get(this.handle((rq, rs) => this.commandGet(rq, rs)));
    this.api.route("/commands/:commandId/").post(this.handle((rq, rs) => this.commandPost(rq, rs)));

    this.api.route("/search/").post(this.handle((rq, rs) => this.searchQueryPost(rq, rs)));
    this.api.route("/search/simple/").post(this.handle((rq, rs) => this.searchSimplePost(rq, rs)));

    this.api.route("/open/*").post(this.handle((rq, rs) => this.openPost(rq, rs)));

    this.api.get(`/${CERT_NAME}`, this.handle((rq, rs) => this.certificateGet(rq, rs)));
    this.api.get("/openapi.yaml", this.handle((rq, rs) => this.openapiYamlGet(rq, rs)));
    this.api.get("/", (rq, rs) => { this.root(rq, rs); });

    this.api.use(this.apiExtensionRouter);

    this.api.use((rq, rs, next) => { this.notFoundHandler(rq, rs, next).catch(next); });
    this.api.use((err: Error, rq: express.Request, rs: express.Response, next: express.NextFunction) => { this.errorHandler(err, rq, rs, next).catch(next); });
  }
}
