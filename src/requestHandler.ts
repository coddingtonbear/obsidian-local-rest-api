import {
  apiVersion,
  App,
  PluginManifest,
  TFile,
} from "obsidian";
import forge from "node-forge";

import express from "express";
import http from "http";
import cors from "cors";
import mime from "mime-types";
import responseTime from "response-time";
import queryString from "query-string";
import {
  getDocumentMap,
  PatchFailed,
  PatchOperation,
} from "markdown-patch";
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
} from "./typeGuards";
import LocalRestApiPublicApi from "./api";
import {
  CommandNotFoundError,
  FileNotFoundError,
  VaultOperations,
} from "./vaultOperations";
import { McpHandler } from "./mcpHandler";

// Import openapi.yaml as a string
import openapiYaml from "../docs/openapi.yaml";

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

  async _vaultGet(
    path: string,
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    // Step 1: Normalize trailing slash
    const normalizedPath = path.endsWith("/") ? path.slice(0, -1) : path;

    // Step 2: Exact file match (fast path)
    let filePath = normalizedPath;
    let urlTargetType: string | undefined;
    let urlTarget: string | undefined;

    let exactStat = null;
    try {
      exactStat = normalizedPath
        ? await this.app.vault.adapter.stat(normalizedPath)
        : null;
    } catch {
      // ENOTDIR: a path segment is a file, not a directory — treat as no match.
    }

    if (!exactStat || exactStat.type !== "file") {
      // Step 3: Directory listing check
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

      // Steps 4-5: Walk backward to find file + target (404 if nothing found)
      const resolved = await this._resolvePathAndTarget(normalizedPath);
      if (!resolved?.targetType) {
        this.returnCannedResponse(res, { statusCode: 404 });
        return;
      }
      filePath = resolved.filePath;
      urlTargetType = resolved.targetType;
      urlTarget = resolved.target;
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
      res.setHeader("Content-Type", ContentTypes.olrapiDocumentMap);
      res.send(
        JSON.stringify(await this.getDocumentMapObject(file), null, 2),
      );
      return;
    }

    if (urlTargetType !== undefined && (req.get("Target-Type") || req.get("Target"))) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.ConflictingTargetSpecification,
      });
      return;
    }

    const targetType = urlTargetType ?? req.get("Target-Type");
    if (targetType) {
      if (!["heading", "block", "frontmatter"].includes(targetType)) {
        this.returnCannedResponse(res, {
          errorCode: ErrorCode.InvalidTargetTypeHeader,
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
      const documentMap = getDocumentMap(fileContent);
      const targetDelimiter = req.get("Target-Delimiter") || "::";

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
    const path = decodeURIComponent(
      req.path.slice(req.path.indexOf("/", 1) + 1),
    );

    return this._vaultGet(path, req, res);
  }

  /** Resolves a raw path (possibly containing a URL-embedded target) into a
   *  file path and optional target type + target string.  Returns null when no
   *  vault file can be found at any prefix of the path. */
  async _resolvePathAndTarget(rawPath: string): Promise<{
    filePath: string;
    targetType?: string;
    target?: string;
  } | null> {
    return this.operations.resolvePathAndTarget(rawPath);
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
    const rawPath = decodeURIComponent(
      req.path.slice(req.path.indexOf("/", 1) + 1),
    );
    const resolved = await this._resolvePathAndTarget(rawPath);
    if (resolved === null) {
      if (
        rawPath
          .split("/")
          .some((s) => ["heading", "block", "frontmatter"].includes(s))
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
        { createTargetIfMissing: true },
      );
    }
    const headerTarget = this._getHeaderTarget(req, res);
    if (headerTarget !== undefined) {
      if (!headerTarget) return; // error already sent
      return this._vaultPatchTargeted(
        rawPath,
        headerTarget.targetType,
        headerTarget.target,
        "replace",
        req,
        res,
        { createTargetIfMissing: true },
      );
    }
    return this._vaultPut(rawPath, req, res);
  }

  async _vaultPatch(
    path: string,
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    if (!path || path.endsWith("/")) {
      this.returnCannedResponse(res, { errorCode: ErrorCode.RequestMethodValidOnlyForFiles });
      return;
    }

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
      this.returnCannedResponse(res, { errorCode: ErrorCode.InvalidTargetScopeHeader });
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
      } else {
        this.returnCannedResponse(res, { statusCode: 500, message: (e as Error).message });
      }
    }
  }

  async vaultPatch(req: express.Request, res: express.Response): Promise<void> {
    const rawPath = decodeURIComponent(
      req.path.slice(req.path.indexOf("/", 1) + 1),
    );
    return this._vaultPatch(rawPath, req, res);
  }

  async _vaultPatchTargeted(
    filePath: string,
    targetType: string,
    target: string,
    operation: PatchOperation,
    req: express.Request,
    res: express.Response,
    extraOpts?: { createTargetIfMissing?: boolean },
  ): Promise<void> {
    const contentType = req.get("Content-Type");
    const createTargetIfMissing =
      extraOpts?.createTargetIfMissing ??
      req.get("Create-Target-If-Missing") == "true";
    const rejectIfContentPreexists =
      req.get("Reject-If-Content-Preexists") == "true";
    const trimTargetWhitespace = req.get("Trim-Target-Whitespace") == "true";
    const targetDelimiter = req.get("Target-Delimiter") || "::";
    const rawTargetScope = req.get("Target-Scope");
    const targetScope = rawTargetScope || undefined;

    if (!isPatchTargetType(targetType)) {
      this.returnCannedResponse(res, { errorCode: ErrorCode.InvalidTargetTypeHeader });
      return;
    }
    if (!isContentType(contentType)) {
      this.returnCannedResponse(res, { errorCode: ErrorCode.InvalidContentType });
      return;
    }
    if (targetScope && !isPatchTargetScope(targetScope)) {
      this.returnCannedResponse(res, { errorCode: ErrorCode.InvalidTargetScopeHeader });
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
      } else {
        this.returnCannedResponse(res, { statusCode: 500, message: (e as Error).message });
      }
    }
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
    const rawPath = decodeURIComponent(
      req.path.slice(req.path.indexOf("/", 1) + 1),
    );
    const resolved = await this._resolvePathAndTarget(rawPath);
    if (resolved === null) {
      if (
        rawPath
          .split("/")
          .some((s) => ["heading", "block", "frontmatter"].includes(s))
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
      );
    }
    const headerTarget = this._getHeaderTarget(req, res);
    if (headerTarget !== undefined) {
      if (!headerTarget) return; // error already sent
      return this._vaultPatchTargeted(
        rawPath,
        headerTarget.targetType,
        headerTarget.target,
        "append",
        req,
        res,
      );
    }
    return this._vaultPost(rawPath, req, res);
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
    const rawPath = decodeURIComponent(
      req.path.slice(req.path.indexOf("/", 1) + 1),
    );
    const resolved = await this._resolvePathAndTarget(rawPath);
    if (resolved?.targetType) {
      this.returnCannedResponse(res, {
        statusCode: 405,
        message:
          "Deleting a targeted section via URL is not supported. Use PATCH with Operation: replace and an empty body instead.",
      });
      return;
    }
    return this._vaultDelete(rawPath, req, res);
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
    const overwriteAllowed =
      (req.header("Overwrite") ?? "F").toUpperCase() !== "F";

    if (!rawDestination) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.MissingDestinationHeader,
      });
      return;
    }

    const rawNewPath = decodeURIComponent(rawDestination.trim());

    if (rawNewPath.includes("..") || rawNewPath.startsWith("/")) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.PathTraversalNotAllowed,
      });
      return;
    }

    if (rawNewPath.endsWith("/")) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.InvalidDestinationPath,
      });
      return;
    }

    const newPath = rawNewPath
      .replace(/\\/g, "/")
      .replace(/\/+/g, "/")
      .replace(/^\/|\/$/g, "");

    const sourceFile = this.app.vault.getAbstractFileByPath(path);
    if (!sourceFile || !(sourceFile instanceof TFile)) {
      this.returnCannedResponse(res, { statusCode: 404 });
      return;
    }

    const destExists = await this.app.vault.adapter.exists(newPath);
    if (destExists && !overwriteAllowed) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.DestinationAlreadyExists,
      });
      return;
    }

    try {
      const parentDir = newPath.substring(0, newPath.lastIndexOf("/"));
      if (parentDir && !(await this.app.vault.adapter.exists(parentDir))) {
        await this.app.vault.createFolder(parentDir);
      }

      // @ts-ignore - fileManager exists at runtime but not in type definitions
      await this.app.fileManager.renameFile(sourceFile, newPath);

      res.status(201).json({
        message: "File successfully moved",
        oldPath: path,
        newPath: newPath,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.FileOperationFailed,
        message: `Failed to move file: ${msg}`,
      });
    }
  }

  async vaultMove(req: express.Request, res: express.Response): Promise<void> {
    const path = decodeURIComponent(
      req.path.slice(req.path.indexOf("/", 1) + 1),
    );
    return this._vaultMove(path, req, res);
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

    const suffix = req.params[0] ? decodeURIComponent(req.params[0]) : "";
    const path = file.path + (suffix ? "/" + suffix : "");
    res.set("Content-Location", encodeURI(file.path));
    return this._vaultGet(path, req, res);
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
    const suffix = req.params[0] ? decodeURIComponent(req.params[0]) : "";
    if (suffix) {
      const resolved = await this._resolvePathAndTarget(file.path + "/" + suffix);
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
          { createTargetIfMissing: true },
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
        { createTargetIfMissing: true },
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
    const suffix = req.params[0] ? decodeURIComponent(req.params[0]) : "";
    if (suffix) {
      const resolved = await this._resolvePathAndTarget(file.path + "/" + suffix);
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
    const suffix = req.params[0] ? decodeURIComponent(req.params[0]) : "";
    if (suffix) {
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

    const suffix = req.params[0] ? decodeURIComponent(req.params[0]) : "";
    const path = file.path + (suffix ? "/" + suffix : "");
    res.set("Content-Location", encodeURI(file.path));
    return this._vaultGet(path, req, res);
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
    const suffix = req.params[0] ? decodeURIComponent(req.params[0]) : "";
    if (suffix) {
      const resolved = await this._resolvePathAndTarget(file.path + "/" + suffix);
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
          { createTargetIfMissing: true },
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
        { createTargetIfMissing: true },
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
    const suffix = req.params[0] ? decodeURIComponent(req.params[0]) : "";
    if (suffix) {
      const resolved = await this._resolvePathAndTarget(file.path + "/" + suffix);
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
    const suffix = req.params[0] ? decodeURIComponent(req.params[0]) : "";
    if (suffix) {
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
      express.text({ type: "text/*", limit: MaximumRequestSize }),
    );
    this.api.use(express.raw({ type: "*/*", limit: MaximumRequestSize }));

    this.api
      .route("/active/*")
      .get((rq, rs) => { void this.activeFileGet(rq, rs); })
      .put((rq, rs) => { void this.activeFilePut(rq, rs); })
      .patch((rq, rs) => { void this.activeFilePatch(rq, rs); })
      .post((rq, rs) => { void this.activeFilePost(rq, rs); })
      .delete((rq, rs) => { void this.activeFileDelete(rq, rs); });

    this.api
      .route("/vault/*")
      .get((rq, rs) => { void this.vaultGet(rq, rs); })
      .put((rq, rs) => { void this.vaultPut(rq, rs); })
      .patch((rq, rs) => { void this.vaultPatch(rq, rs); })
      .post((rq, rs) => { void this.vaultPost(rq, rs); })
      .delete((rq, rs) => { void this.vaultDelete(rq, rs); })
      .all((req, res, next) => {
        if (req.method === "MOVE") {
          void this.vaultMove(req, res);
        } else {
          next();
        }
      });

    this.api
      .route("/periodic/:period/:year(\\d{4})/:month(\\d{1,2})/:day(\\d{1,2})/*")
      .get((rq, rs) => { void this.periodicGet(rq, rs); })
      .put((rq, rs) => { void this.periodicPut(rq, rs); })
      .patch((rq, rs) => { void this.periodicPatch(rq, rs); })
      .post((rq, rs) => { void this.periodicPost(rq, rs); })
      .delete((rq, rs) => { void this.periodicDelete(rq, rs); });
    this.api
      .route("/periodic/:period/*")
      .get((rq, rs) => { void this.periodicGet(rq, rs); })
      .put((rq, rs) => { void this.periodicPut(rq, rs); })
      .patch((rq, rs) => { void this.periodicPatch(rq, rs); })
      .post((rq, rs) => { void this.periodicPost(rq, rs); })
      .delete((rq, rs) => { void this.periodicDelete(rq, rs); });

    this.api.route("/tags/").get((rq, rs) => { void this.tagsGet(rq, rs); });

    this.api.route("/commands/").get((rq, rs) => { void this.commandGet(rq, rs); });
    this.api.route("/commands/:commandId/").post((rq, rs) => { void this.commandPost(rq, rs); });

    this.api.route("/search/").post((rq, rs) => { void this.searchQueryPost(rq, rs); });
    this.api.route("/search/simple/").post((rq, rs) => { void this.searchSimplePost(rq, rs); });

    this.api.route("/open/*").post((rq, rs) => { void this.openPost(rq, rs); });

    this.api.get(`/${CERT_NAME}`, (rq, rs) => { void this.certificateGet(rq, rs); });
    this.api.get("/openapi.yaml", (rq, rs) => { void this.openapiYamlGet(rq, rs); });
    this.api.get("/", (rq, rs) => { void this.root(rq, rs); });

    this.api.use(this.apiExtensionRouter);

    this.api.use((rq, rs, next) => { void this.notFoundHandler(rq, rs, next); });
    this.api.use((err: Error, rq: express.Request, rs: express.Response, next: express.NextFunction) => { void this.errorHandler(err, rq, rs, next); });
  }
}
