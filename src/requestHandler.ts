import {
  apiVersion,
  App,
  CachedMetadata,
  Command,
  PluginManifest,
  prepareSimpleSearch,
  TFile,
} from "obsidian";
import periodicNotes from "obsidian-daily-notes-interface";
import { getAPI as getDataviewAPI } from "obsidian-dataview";
import forge from "node-forge";

import express from "express";
import http from "http";
import cors from "cors";
import mime from "mime-types";
import bodyParser from "body-parser";
import jsonLogic from "json-logic-js";
import responseTime from "response-time";
import queryString from "query-string";
import WildcardRegexp from "glob-to-regexp";
import path from "path";
import {
  applyPatch,
  ContentType,
  PatchFailed,
  PatchInstruction,
  PatchOperation,
  PatchTargetType,
} from "markdown-patch";

import {
  CannedResponse,
  ErrorCode,
  ErrorResponseDescriptor,
  FileMetadataObject,
  LocalRestApiSettings,
  PeriodicNoteInterface,
  SearchContext,
  SearchJsonResponseItem,
  SearchResponseItem,
} from "./types";
import {
  findHeadingBoundary,
  getCertificateIsUptoStandards,
  getCertificateValidityDays,
  getSplicePosition,
  toArrayBuffer,
} from "./utils";
import {
  CERT_NAME,
  ContentTypes,
  ERROR_CODE_MESSAGES,
  MaximumRequestSize,
} from "./constants";
import LocalRestApiPublicApi from "./api";

// Import openapi.yaml as a string
import openapiYaml from "../docs/openapi.yaml";

export default class RequestHandler {
  app: App;
  api: express.Express;
  manifest: PluginManifest;
  settings: LocalRestApiSettings;

  apiExtensionRouter: express.Router;
  apiExtensions: {
    manifest: PluginManifest;
    api: LocalRestApiPublicApi;
  }[] = [];
  
  requestCounter: number = 0;

  constructor(
    app: App,
    manifest: PluginManifest,
    settings: LocalRestApiSettings
  ) {
    this.app = app;
    this.manifest = manifest;
    this.api = express();
    this.settings = settings;

    this.apiExtensionRouter = express.Router();

    this.api.set("json spaces", 2);

    jsonLogic.add_operation(
      "glob",
      (pattern: string | undefined, field: string | undefined) => {
        if (typeof field === "string" && typeof pattern === "string") {
          const glob = WildcardRegexp(pattern);
          return glob.test(field);
        }
        return false;
      }
    );
    jsonLogic.add_operation(
      "regexp",
      (pattern: string | undefined, field: string | undefined) => {
        if (typeof field === "string" && typeof pattern === "string") {
          const rex = new RegExp(pattern);
          return rex.test(field);
        }
        return false;
      }
    );
  }

  registerApiExtension(manifest: PluginManifest): LocalRestApiPublicApi {
    let api: LocalRestApiPublicApi | undefined = undefined;
    for (const { manifest: existingManifest, api: existingApi } of this
      .apiExtensions) {
      if (JSON.stringify(existingManifest) === JSON.stringify(manifest)) {
        api = existingApi;
        break;
      }
    }
    if (!api) {
      const router = express.Router();
      this.apiExtensionRouter.use(router);
      api = new LocalRestApiPublicApi(router, () => {
        const idx = this.apiExtensions.findIndex(
          ({ manifest: storedManifest }) =>
            JSON.stringify(manifest) === JSON.stringify(storedManifest)
        );
        if (idx !== -1) {
          this.apiExtensions.splice(idx, 1);
          this.apiExtensionRouter.stack.splice(idx, 1);
        }
      });
      this.apiExtensions.push({
        manifest,
        api,
      });
    }

    return api;
  }

  requestIsAuthenticated(req: express.Request): boolean {
    const authorizationHeader = req.get(
      this.settings.authorizationHeaderName ?? "Authorization"
    );
    if (authorizationHeader === `Bearer ${this.settings.apiKey}`) {
      return true;
    }

    return false;
  }

  async authenticationMiddleware(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
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

  async getFileMetadataObject(file: TFile): Promise<FileMetadataObject> {
    const cache = this.app.metadataCache.getFileCache(file);

    // Gather frontmatter & strip out positioning information
    const frontmatter = { ...(cache.frontmatter ?? {}) };
    delete frontmatter.position; // This just adds noise

    // Gather both in-line tags (hash'd) & frontmatter tags; strip
    // leading '#' from them if it's there, and remove duplicates
    const directTags =
      (cache.tags ?? []).filter((tag) => tag).map((tag) => tag.tag) ?? [];
    const frontmatterTags = Array.isArray(frontmatter.tags)
      ? frontmatter.tags
      : [];
    const filteredTags: string[] = [...frontmatterTags, ...directTags]
      // Filter out falsy tags
      .filter((tag) => tag)
      // Strip leading hash and get tag's string representation --
      // although it should always be a string, it apparently isn't always!
      .map((tag) => tag.toString().replace(/^#/, ""))
      // Remove duplicates
      .filter((value, index, self) => self.indexOf(value) === index);

    return {
      tags: filteredTags,
      frontmatter: frontmatter,
      stat: file.stat,
      path: file.path,
      content: await this.app.vault.cachedRead(file),
    };
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
      errorMessages.push(http.STATUS_CODES[statusCode]);
    }
    if (message) {
      errorMessages.push(message);
    }

    return errorMessages.join("\n");
  }

  getStatusCode({ statusCode, errorCode }: ErrorResponseDescriptor): number {
    if (statusCode) {
      return statusCode;
    }
    return Math.floor(errorCode / 100);
  }

  returnCannedResponse(
    res: express.Response,
    { statusCode, message, errorCode }: ErrorResponseDescriptor
  ): void {
    const response: CannedResponse = {
      message: this.getResponseMessage({ statusCode, message, errorCode }),
      errorCode: errorCode ?? statusCode * 100,
    };

    res.status(this.getStatusCode({ statusCode, errorCode })).json(response);
  }

  root(req: express.Request, res: express.Response): void {
    let certificate: forge.pki.Certificate | undefined;
    try {
      certificate = forge.pki.certificateFromPem(this.settings.crypto.cert);
    } catch (e) {
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
        ? this.apiExtensions.map(({ manifest }) => manifest)
        : undefined,
    });
  }


  async _vaultGet(
    path: string,
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    if (!path || path.endsWith("/")) {
      const files = [
        ...new Set(
          this.app.vault
            .getFiles()
            .map((e) => e.path)
            .filter((filename) => filename.startsWith(path))
            .map((filename) => {
              const subPath = filename.slice(path.length);
              if (subPath.indexOf("/") > -1) {
                return subPath.slice(0, subPath.indexOf("/") + 1);
              }
              return subPath;
            })
        ),
      ];
      files.sort();

      if (files.length === 0) {
        this.returnCannedResponse(res, { statusCode: 404 });
        return;
      }

      res.json({
        files: files,
      });
    } else {
      const exists = await this.app.vault.adapter.exists(path);

      if (exists && (await this.app.vault.adapter.stat(path)).type === "file") {
        const content = await this.app.vault.adapter.readBinary(path);
        const mimeType = mime.lookup(path);

        res.set({
          "Content-Disposition": `attachment; filename="${encodeURI(
            path
          ).replace(",", "%2C")}"`,
          "Content-Type":
            `${mimeType}` +
            (mimeType == ContentTypes.markdown ? "; charset=utf-8" : ""),
        });

        if (req.headers.accept === ContentTypes.olrapiNoteJson) {
          const file = this.app.vault.getAbstractFileByPath(path) as TFile;
          res.setHeader("Content-Type", ContentTypes.olrapiNoteJson);
          res.send(
            JSON.stringify(await this.getFileMetadataObject(file), null, 2)
          );
          return;
        }

        res.send(Buffer.from(content));
      } else {
        this.returnCannedResponse(res, {
          statusCode: 404,
        });
        return;
      }
    }
  }

  async vaultGet(req: express.Request, res: express.Response): Promise<void> {
    const path = decodeURIComponent(
      req.path.slice(req.path.indexOf("/", 1) + 1)
    );

    return this._vaultGet(path, req, res);
  }

  async _vaultPut(
    filepath: string,
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    if (!filepath || filepath.endsWith("/")) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.RequestMethodValidOnlyForFiles,
      });
      return;
    }

    try {
      await this.app.vault.createFolder(path.dirname(filepath));
    } catch {
      // the folder/file already exists, but we don't care
    }

    if (typeof req.body === "string") {
      await this.app.vault.adapter.write(filepath, req.body);
    } else {
      await this.app.vault.adapter.writeBinary(
        filepath,
        toArrayBuffer(req.body)
      );
    }

    this.returnCannedResponse(res, { statusCode: 204 });
    return;
  }

  async vaultPut(req: express.Request, res: express.Response): Promise<void> {
    const path = decodeURIComponent(
      req.path.slice(req.path.indexOf("/", 1) + 1)
    );

    return this._vaultPut(path, req, res);
  }

  async _vaultPatchV2(
    path: string,
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const headingBoundary = req.get("Heading-Boundary") || "::";
    const heading = (req.get("Heading") || "")
      .split(headingBoundary)
      .filter(Boolean);
    const contentPosition = req.get("Content-Insertion-Position");
    let insert = false;
    let aboveNewLine = false;

    if (contentPosition === undefined) {
      insert = false;
    } else if (contentPosition === "beginning") {
      insert = true;
    } else if (contentPosition === "end") {
      insert = false;
    } else {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.InvalidContentInsertionPositionValue,
      });
      return;
    }
    if (typeof req.body != "string") {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.TextContentEncodingRequired,
      });
      return;
    }

    if (typeof req.get("Content-Insertion-Ignore-Newline") == "string") {
      aboveNewLine =
        req.get("Content-Insertion-Ignore-Newline").toLowerCase() == "true";
    }

    if (!heading.length) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.MissingHeadingHeader,
      });
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      this.returnCannedResponse(res, {
        statusCode: 404,
      });
      return;
    }
    const cache = this.app.metadataCache.getFileCache(file);
    const position = findHeadingBoundary(cache, heading);

    if (!position) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.InvalidHeadingHeader,
      });
      return;
    }

    const fileContents = await this.app.vault.read(file);
    const fileLines = fileContents.split("\n");

    const splicePosition = getSplicePosition(
      fileLines,
      position,
      insert,
      aboveNewLine
    );

    fileLines.splice(splicePosition, 0, req.body);

    const content = fileLines.join("\n");

    await this.app.vault.adapter.write(path, content);

    console.warn(
      `2.x PATCH implementation is deprecated and will be removed in version 4.0`
    );
    res
      .header("Deprecation", 'true; sunset-version="4.0"')
      .header(
        "Link",
        '<https://github.com/coddingtonbear/obsidian-local-rest-api/wiki/Changes-to-PATCH-requests-between-versions-2.0-and-3.0>; rel="alternate"'
      )
      .status(200)
      .send(content);
  }

  async _vaultPatchV3(
    path: string,
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    
    const operation = req.get("Operation");
    const targetType = req.get("Target-Type");
    const rawTarget = req.get("Target") ? decodeURIComponent(req.get("Target")) : "";
    const contentType = req.get("Content-Type");
    const createTargetIfMissing = req.get("Create-Target-If-Missing") == "true";
    const applyIfContentPreexists =
      req.get("Apply-If-Content-Preexists") == "true";
    const trimTargetWhitespace = req.get("Trim-Target-Whitespace") == "true";
    const targetDelimiter = req.get("Target-Delimiter") || "::";

    const target =
      targetType == "heading" ? rawTarget.split(targetDelimiter) : rawTarget;

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      this.returnCannedResponse(res, {
        statusCode: 404,
      });
      return;
    }
    const fileContents = await this.app.vault.read(file);

    if (!targetType) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.MissingTargetTypeHeader,
      });
      return;
    }
    
    // Check for file-level operations BEFORE general validation
    if (targetType === "file") {
      // Handle semantic file operations
      if (operation === "rename") {
        if (rawTarget !== "name") {
          res.status(400).json({
            errorCode: 40004,
            message: "rename operation must use Target: name"
          });
          return;
        }
        return this.handleRenameOperation(path, req, res);
      }
      
      if (operation === "move") {
        if (rawTarget !== "path") {
          res.status(400).json({
            errorCode: 40005,
            message: "move operation must use Target: path"  
          });
          return;
        }
        return this.handleRenameOperation(path, req, res);
      }
    }
    
    // Validate that file-specific operations are only used with file target type
    if ((operation === "rename" || operation === "move") && targetType !== "file") {
      res.status(400).json({
        errorCode: 40006,
        message: `Operation '${operation}' is only valid for Target-Type: file`
      });
      return;
    }
    
    if (!["heading", "block", "frontmatter", "file"].includes(targetType)) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.InvalidTargetTypeHeader,
      });
      return;
    }
    if (!operation) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.MissingOperation,
      });
      return;
    }
    if (!["append", "prepend", "replace", "rename", "move"].includes(operation)) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.InvalidOperation,
      });
      return;
    }
    if (!path || path.endsWith("/")) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.RequestMethodValidOnlyForFiles,
      });
      return;
    }

    try {
      const instruction: PatchInstruction = {
        operation: operation as PatchOperation,
        targetType: targetType as PatchTargetType,
        target,
        contentType: contentType as ContentType,
        content: req.body,
        applyIfContentPreexists,
        trimTargetWhitespace,
        createTargetIfMissing,
      } as PatchInstruction;

      const patched = applyPatch(fileContents, instruction);
      await this.app.vault.adapter.write(path, patched);
      res.status(200).send(patched);
    } catch (e) {
      if (e instanceof PatchFailed) {
        this.returnCannedResponse(res, {
          errorCode: ErrorCode.PatchFailed,
          message: e.reason,
        });
      } else {
        this.returnCannedResponse(res, {
          statusCode: 500,
          message: e.message,
        });
      }
    }
  }

  async _vaultPatch(
    path: string,
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    if (!path || path.endsWith("/")) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.RequestMethodValidOnlyForFiles,
      });
      return;
    }

    if (req.get("Heading") && !req.get("Target-Type")) {
      return this._vaultPatchV2(path, req, res);
    }
    return this._vaultPatchV3(path, req, res);
  }

  async vaultPatch(req: express.Request, res: express.Response): Promise<void> {
    const path = decodeURIComponent(
      req.path.slice(req.path.indexOf("/", 1) + 1)
    );

    return this._vaultPatch(path, req, res);
  }

  async _vaultPost(
    filepath: string,
    req: express.Request,
    res: express.Response
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

    try {
      await this.app.vault.createFolder(path.dirname(filepath));
    } catch {
      // the folder/file already exists, but we don't care
    }

    let fileContents = "";
    const file = this.app.vault.getAbstractFileByPath(filepath);
    if (file instanceof TFile) {
      fileContents = await this.app.vault.read(file);
      if (!fileContents.endsWith("\n")) {
        fileContents += "\n";
      }
    }

    fileContents += req.body;

    await this.app.vault.adapter.write(filepath, fileContents);

    this.returnCannedResponse(res, { statusCode: 204 });
    return;
  }

  async vaultPost(req: express.Request, res: express.Response): Promise<void> {
    const path = decodeURIComponent(
      req.path.slice(req.path.indexOf("/", 1) + 1)
    );

    return this._vaultPost(path, req, res);
  }

  async _vaultDelete(
    path: string,
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    if (!path || path.endsWith("/")) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.RequestMethodValidOnlyForFiles,
      });
      return;
    }

    const pathExists = await this.app.vault.adapter.exists(path);
    if (!pathExists) {
      this.returnCannedResponse(res, { statusCode: 404 });
      return;
    }

    await this.app.vault.adapter.remove(path);
    this.returnCannedResponse(res, { statusCode: 204 });
    return;
  }

  async vaultDelete(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const path = decodeURIComponent(
      req.path.slice(req.path.indexOf("/", 1) + 1)
    );

    return this._vaultDelete(path, req, res);
  }

  async handleRenameOperation(
    path: string,
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    
    if (!path || path.endsWith("/")) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.RequestMethodValidOnlyForFiles,
      });
      return;
    }

    const target = req.get("Target");
    const isMove = target === "path";
    const isRename = target === "name";
    
    if (!isMove && !isRename) {
      res.status(400).json({
        errorCode: 40003,
        message: "Invalid Target value for file operations. Use 'name' for rename or 'path' for move"
      });
      return;
    }

    // For PATCH operations, the new filename/path should be in the request body
    const newValue = typeof req.body === 'string' ? req.body.trim() : '';
    
    if (!newValue) {
      res.status(400).json({
        errorCode: 40001,
        message: isMove ? "New path is required in request body" : "New filename is required in request body"
      });
      return;
    }

    let newPath: string;
    if (isRename) {
      // For rename, construct the new path by replacing just the filename
      const dirPath = path.substring(0, path.lastIndexOf('/'));
      newPath = dirPath ? `${dirPath}/${newValue}` : newValue;
    } else {
      // For move, use the provided path directly
      newPath = newValue;
    }

    // Validate new path
    if (newPath.endsWith("/")) {
      res.status(400).json({
        errorCode: 40002,
        message: "New path must be a file path, not a directory"
      });
      return;
    }

    // Check if source file exists
    const sourceFile = this.app.vault.getAbstractFileByPath(path);
    if (!sourceFile || !(sourceFile instanceof TFile)) {
      this.returnCannedResponse(res, { statusCode: 404 });
      return;
    }

    // Check if destination already exists
    const destExists = await this.app.vault.adapter.exists(newPath);
    if (destExists) {
      res.status(409).json({
        errorCode: 40901,
        message: "Destination file already exists"
      });
      return;
    }

    // Create parent directories if needed (for move operations)
    if (isMove) {
      const parentDir = newPath.substring(0, newPath.lastIndexOf('/'));
      if (parentDir) {
        try {
          await this.app.vault.createFolder(parentDir);
        } catch {
          // Folder might already exist, continue
        }
      }
    }

    try {
      // Use FileManager to rename/move the file (preserves history and updates links)
      // @ts-ignore - fileManager exists at runtime but not in type definitions
      await this.app.fileManager.renameFile(sourceFile, newPath);
      
      res.status(200).json({
        message: isMove ? "File successfully moved" : "File successfully renamed",
        oldPath: path,
        newPath: newPath
      });
    } catch (error) {
      res.status(500).json({
        errorCode: 50001,
        message: `Failed to ${isMove ? 'move' : 'rename'} file: ${error.message}`
      });
    }
  }

  getPeriodicNoteInterface(): Record<string, PeriodicNoteInterface> {
    return {
      daily: {
        settings: periodicNotes.getDailyNoteSettings(),
        loaded: periodicNotes.appHasDailyNotesPluginLoaded(),
        create: periodicNotes.createDailyNote,
        get: periodicNotes.getDailyNote,
        getAll: periodicNotes.getAllDailyNotes,
      },
      weekly: {
        settings: periodicNotes.getWeeklyNoteSettings(),
        loaded: periodicNotes.appHasWeeklyNotesPluginLoaded(),
        create: periodicNotes.createWeeklyNote,
        get: periodicNotes.getWeeklyNote,
        getAll: periodicNotes.getAllWeeklyNotes,
      },
      monthly: {
        settings: periodicNotes.getMonthlyNoteSettings(),
        loaded: periodicNotes.appHasMonthlyNotesPluginLoaded(),
        create: periodicNotes.createMonthlyNote,
        get: periodicNotes.getMonthlyNote,
        getAll: periodicNotes.getAllMonthlyNotes,
      },
      quarterly: {
        settings: periodicNotes.getQuarterlyNoteSettings(),
        loaded: periodicNotes.appHasQuarterlyNotesPluginLoaded(),
        create: periodicNotes.createQuarterlyNote,
        get: periodicNotes.getQuarterlyNote,
        getAll: periodicNotes.getAllQuarterlyNotes,
      },
      yearly: {
        settings: periodicNotes.getYearlyNoteSettings(),
        loaded: periodicNotes.appHasYearlyNotesPluginLoaded(),
        create: periodicNotes.createYearlyNote,
        get: periodicNotes.getYearlyNote,
        getAll: periodicNotes.getAllYearlyNotes,
      },
    };
  }

  periodicGetInterface(
    period: string
  ): [PeriodicNoteInterface | null, ErrorCode | null] {
    const periodic = this.getPeriodicNoteInterface();
    if (!periodic[period]) {
      return [null, ErrorCode.PeriodDoesNotExist];
    }
    if (!periodic[period].loaded) {
      return [null, ErrorCode.PeriodIsNotEnabled];
    }

    return [periodic[period], null];
  }

  periodicGetNote(
    periodName: string,
    timestamp: number
  ): [TFile | null, ErrorCode | null] {
    const [period, err] = this.periodicGetInterface(periodName);
    if (err) {
      return [null, err];
    }

    const now = (window as any).moment(timestamp);
    const all = period.getAll();

    const file = period.get(now, all);
    if (!file) {
      return [null, ErrorCode.PeriodicNoteDoesNotExist];
    }

    return [file, null];
  }

  async periodicGetOrCreateNote(
    periodName: string,
    timestamp: number
  ): Promise<[TFile | null, ErrorCode | null]> {
    const [gottenFile, err] = this.periodicGetNote(periodName, timestamp);
    let file = gottenFile;
    if (err === ErrorCode.PeriodicNoteDoesNotExist) {
      const [period] = this.periodicGetInterface(periodName);
      const now = (window as any).moment(Date.now());

      file = await period.create(now);

      const metadataCachePromise = new Promise<CachedMetadata>((resolve) => {
        let cache: CachedMetadata = null;

        const interval: ReturnType<typeof setInterval> = setInterval(() => {
          cache = this.app.metadataCache.getFileCache(file);
          if (cache) {
            clearInterval(interval);
            resolve(cache);
          }
        }, 100);
      });
      await metadataCachePromise;
    } else if (err) {
      return [null, err];
    }

    return [file, null];
  }

  redirectToVaultPath(
    file: TFile,
    req: express.Request,
    res: express.Response,
    handler: (path: string, req: express.Request, res: express.Response) => void
  ): void {
    const path = file.path;
    res.set("Content-Location", encodeURI(path));

    return handler(path, req, res);
  }

  getPeriodicDateFromParams(params: any): number {
    const { year, month, day } = params;

    if (year && month && day) {
      const date = new Date(year, month - 1, day);
      return date.getTime();
    }

    return Date.now();
  }

  async periodicGet(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const date = this.getPeriodicDateFromParams(req.params);
    const [file, err] = this.periodicGetNote(req.params.period, date);
    if (err) {
      this.returnCannedResponse(res, { errorCode: err });
      return;
    }

    return this.redirectToVaultPath(file, req, res, this._vaultGet.bind(this));
  }

  async periodicPut(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const date = this.getPeriodicDateFromParams(req.params);
    const [file, err] = await this.periodicGetOrCreateNote(
      req.params.period,
      date
    );
    if (err) {
      this.returnCannedResponse(res, { errorCode: err });
      return;
    }

    return this.redirectToVaultPath(file, req, res, this._vaultPut.bind(this));
  }

  async periodicPost(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const date = this.getPeriodicDateFromParams(req.params);
    const [file, err] = await this.periodicGetOrCreateNote(
      req.params.period,
      date
    );
    if (err) {
      this.returnCannedResponse(res, { errorCode: err });
      return;
    }

    return this.redirectToVaultPath(file, req, res, this._vaultPost.bind(this));
  }

  async periodicPatch(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const date = this.getPeriodicDateFromParams(req.params);
    const [file, err] = await this.periodicGetOrCreateNote(
      req.params.period,
      date
    );
    if (err) {
      this.returnCannedResponse(res, { errorCode: err });
      return;
    }

    return this.redirectToVaultPath(
      file,
      req,
      res,
      this._vaultPatch.bind(this)
    );
  }

  async periodicDelete(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const date = this.getPeriodicDateFromParams(req.params);
    const [file, err] = this.periodicGetNote(req.params.period, date);
    if (err) {
      this.returnCannedResponse(res, { errorCode: err });
      return;
    }

    return this.redirectToVaultPath(
      file,
      req,
      res,
      this._vaultDelete.bind(this)
    );
  }

  async activeFileGet(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const file = this.app.workspace.getActiveFile();

    return this.redirectToVaultPath(file, req, res, this._vaultGet.bind(this));
  }

  async activeFilePut(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const file = this.app.workspace.getActiveFile();

    return this.redirectToVaultPath(file, req, res, this._vaultPut.bind(this));
  }

  async activeFilePost(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const file = this.app.workspace.getActiveFile();

    return this.redirectToVaultPath(file, req, res, this._vaultPost.bind(this));
  }

  async activeFilePatch(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const file = this.app.workspace.getActiveFile();

    return this.redirectToVaultPath(
      file,
      req,
      res,
      this._vaultPatch.bind(this)
    );
  }

  async activeFileDelete(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const file = this.app.workspace.getActiveFile();

    return this.redirectToVaultPath(
      file,
      req,
      res,
      this._vaultDelete.bind(this)
    );
  }

  async commandGet(req: express.Request, res: express.Response): Promise<void> {
    const commands: Command[] = [];
    for (const commandName in this.app.commands.commands) {
      commands.push({
        id: commandName,
        name: this.app.commands.commands[commandName].name,
      });
    }

    const commandResponse = {
      commands: commands,
    };

    res.json(commandResponse);
  }

  async commandPost(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const cmd = this.app.commands.commands[req.params.commandId];

    if (!cmd) {
      this.returnCannedResponse(res, { statusCode: 404 });
      return;
    }

    try {
      this.app.commands.executeCommandById(req.params.commandId);
    } catch (e) {
      this.returnCannedResponse(res, { statusCode: 500, message: e.message });
      return;
    }

    this.returnCannedResponse(res, { statusCode: 204 });
    return;
  }

  async searchSimplePost(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const results: SearchResponseItem[] = [];

    const query: string = req.query.query as string;
    const contextLength: number =
      parseInt(req.query.contextLength as string, 10) ?? 100;
    const search = prepareSimpleSearch(query);

    for (const file of this.app.vault.getMarkdownFiles()) {
      const cachedContents = await this.app.vault.cachedRead(file);
      const result = search(cachedContents);
      if (result) {
        const contextMatches: SearchContext[] = [];
        for (const match of result.matches) {
          contextMatches.push({
            match: {
              start: match[0],
              end: match[1],
            },
            context: cachedContents.slice(
              Math.max(match[0] - contextLength, 0),
              match[1] + contextLength
            ),
          });
        }

        results.push({
          filename: file.path,
          score: result.score,
          matches: contextMatches,
        });
      }
    }

    results.sort((a, b) => (a.score > b.score ? 1 : -1));
    res.json(results);
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
    res: express.Response
  ): Promise<void> {
    const dataviewApi = getDataviewAPI();

    const handlers: Record<string, () => Promise<SearchJsonResponseItem[]>> = {
      [ContentTypes.dataviewDql]: async () => {
        const results: SearchJsonResponseItem[] = [];
        const dataviewResults = await dataviewApi.tryQuery(req.body);

        const fileColumn =
          dataviewApi.evaluationContext.settings.tableIdColumnName;

        if (dataviewResults.type !== "table") {
          throw new Error("Only TABLE dataview queries are supported.");
        }
        if (!dataviewResults.headers.includes(fileColumn)) {
          throw new Error("TABLE WITHOUT ID queries are not supported.");
        }

        for (const dataviewResult of dataviewResults.values) {
          const fieldValues: Record<string, any> = {};

          dataviewResults.headers.forEach((value: string, index: number) => {
            if (value !== fileColumn) {
              fieldValues[value] = dataviewResult[index];
            }
          });

          results.push({
            filename: dataviewResult[0].path,
            result: fieldValues,
          });
        }

        return results;
      },
      [ContentTypes.jsonLogic]: async () => {
        const results: SearchJsonResponseItem[] = [];

        for (const file of this.app.vault.getMarkdownFiles()) {
          const fileContext = await this.getFileMetadataObject(file);

          try {
            const fileResult = jsonLogic.apply(req.body, fileContext);

            if (this.valueIsSaneTruthy(fileResult)) {
              results.push({
                filename: file.path,
                result: fileResult,
              });
            }
          } catch (e) {
            throw new Error(`${e.message} (while processing ${file.path})`);
          }
        }

        return results;
      },
    };
    const contentType = req.headers["content-type"];

    if (!handlers[contentType]) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.ContentTypeSpecificationRequired,
      });
      return;
    }

    try {
      const results = await handlers[contentType]();
      res.json(results);
    } catch (e) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.InvalidFilterQuery,
        message: `${e.message}`,
      });
      return;
    }
  }

  async openPost(req: express.Request, res: express.Response): Promise<void> {
    const path = decodeURIComponent(
      req.path.slice(req.path.indexOf("/", 1) + 1)
    );

    const query = queryString.parseUrl(req.originalUrl, {
      parseBooleans: true,
    }).query;
    const newLeaf = Boolean(query.newLeaf);

    this.app.workspace.openLinkText(path, "/", newLeaf);

    res.json();
  }

  async certificateGet(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    res.set(
      "Content-type",
      `application/octet-stream; filename="${CERT_NAME}"`
    );
    res.status(200).send(this.settings.crypto.cert);
  }

  async openapiYamlGet(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    res.setHeader("Content-Type", "application/yaml; charset=utf-8");
    res.status(200).send(openapiYaml);
  }

  async notFoundHandler(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ): Promise<void> {
    this.returnCannedResponse(res, {
      statusCode: 404,
    });
    return;
  }

  async errorHandler(
    err: Error,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
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
      this.requestCounter++;
      const originalSend = res.send;
      res.send = function (body, ...args) {
        console.log(`[REST API] ${req.method} ${req.url} => ${res.statusCode}`);

        return originalSend.apply(res, [body, ...args]);
      };
      next();
    });
    this.api.use(responseTime());
    this.api.use(cors());
    this.api.use(this.authenticationMiddleware.bind(this));
    this.api.use(
      bodyParser.text({
        type: ContentTypes.dataviewDql,
        limit: MaximumRequestSize,
      })
    );
    this.api.use(
      bodyParser.json({
        type: ContentTypes.json,
        strict: false,
        limit: MaximumRequestSize,
      })
    );
    this.api.use(
      bodyParser.json({
        type: ContentTypes.olrapiNoteJson,
        strict: false,
        limit: MaximumRequestSize,
      })
    );
    this.api.use(
      bodyParser.json({
        type: ContentTypes.jsonLogic,
        strict: false,
        limit: MaximumRequestSize,
      })
    );
    this.api.use(
      bodyParser.text({ type: "text/*", limit: MaximumRequestSize })
    );
    this.api.use(bodyParser.raw({ type: "*/*", limit: MaximumRequestSize }));

    this.api
      .route("/active/")
      .get(this.activeFileGet.bind(this))
      .put(this.activeFilePut.bind(this))
      .patch(this.activeFilePatch.bind(this))
      .post(this.activeFilePost.bind(this))
      .delete(this.activeFileDelete.bind(this));


    this.api
      .route("/vault/*")
      .get(this.vaultGet.bind(this))
      .put(this.vaultPut.bind(this))
      .patch(this.vaultPatch.bind(this))
      .post(this.vaultPost.bind(this))
      .delete(this.vaultDelete.bind(this));


    this.api
      .route("/periodic/:period/")
      .get(this.periodicGet.bind(this))
      .put(this.periodicPut.bind(this))
      .patch(this.periodicPatch.bind(this))
      .post(this.periodicPost.bind(this))
      .delete(this.periodicDelete.bind(this));
    this.api
      .route("/periodic/:period/:year/:month/:day/")
      .get(this.periodicGet.bind(this))
      .put(this.periodicPut.bind(this))
      .patch(this.periodicPatch.bind(this))
      .post(this.periodicPost.bind(this))
      .delete(this.periodicDelete.bind(this));

    this.api.route("/commands/").get(this.commandGet.bind(this));
    this.api.route("/commands/:commandId/").post(this.commandPost.bind(this));

    this.api.route("/search/").post(this.searchQueryPost.bind(this));
    this.api.route("/search/simple/").post(this.searchSimplePost.bind(this));

    this.api.route("/open/*").post(this.openPost.bind(this));

    this.api.get(`/${CERT_NAME}`, this.certificateGet.bind(this));
    this.api.get("/openapi.yaml", this.openapiYamlGet.bind(this));
    this.api.get("/", this.root.bind(this));

    this.api.use(this.apiExtensionRouter);

    this.api.use(this.notFoundHandler.bind(this));
    this.api.use(this.errorHandler.bind(this));
  }
}
