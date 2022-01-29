import { App, Command, TFile } from "obsidian";
import periodicNotes from "obsidian-daily-notes-interface";

import express from "express";
import http from "http";
import cors from "cors";
import mime from "mime";
import bodyParser from "body-parser";

import {
  ErrorCode,
  ErrorResponse,
  ErrorResponseDescriptor,
  LocalRestApiSettings,
  PeriodicNoteInterface,
} from "./types";
import { findHeadingBoundary } from "./utils";
import { CERT_NAME, ERROR_CODE_MESSAGES } from "./constants";

export default class RequestHandler {
  app: App;
  api: express.Express;
  settings: LocalRestApiSettings;

  constructor(app: App, settings: LocalRestApiSettings) {
    this.app = app;
    this.api = express();
    this.settings = settings;
  }

  async authenticationMiddleware(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ): Promise<void> {
    const authorizationHeader = req.get("Authorization");

    if (req.path === `/${CERT_NAME}` || req.path === "/") {
      next();
      return;
    }

    if (authorizationHeader !== `Bearer ${this.settings.apiKey}`) {
      this.returnErrorResponse(res, {
        errorCode: ErrorCode.ApiKeyAuthorizationRequired,
      });
      return;
    }

    next();
  }

  getErrorMessage({
    statusCode = 400,
    message,
    errorCode,
  }: ErrorResponseDescriptor): string {
    if (message) {
      return message;
    } else if (errorCode) {
      return ERROR_CODE_MESSAGES[errorCode];
    }
    return http.STATUS_CODES[statusCode];
  }

  getStatusCode({ statusCode, errorCode }: ErrorResponseDescriptor): number {
    if (statusCode) {
      return statusCode;
    }
    return errorCode / 100;
  }

  returnErrorResponse(
    res: express.Response,
    { statusCode, message, errorCode }: ErrorResponseDescriptor
  ): void {
    const response: ErrorResponse = {
      error: this.getErrorMessage({ statusCode, message, errorCode }),
      errorCode: errorCode ?? statusCode * 100,
    };

    res.statusCode = this.getStatusCode({ statusCode, errorCode });

    res.json(response);
  }

  root(req: express.Request, res: express.Response): void {
    res.sendStatus(200);
  }

  async vaultGet(req: express.Request, res: express.Response): Promise<void> {
    const path = req.params[0];

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

      res.json({
        files: files,
      });
    } else {
      const exists = await this.app.vault.adapter.exists(path);

      if (exists) {
        const content = await this.app.vault.adapter.read(path);
        const mimeType = mime.lookup(path);

        res.set({
          "Content-Disposition": `attachment; filename="${path}"`,
          "Content-Type":
            `${mimeType}` +
            (mimeType == "text/markdown" ? "; charset=UTF-8" : ""),
        });
        res.send(content);
      } else {
        this.returnErrorResponse(res, {
          statusCode: 404,
        });
        return;
      }
    }
  }

  async vaultPut(req: express.Request, res: express.Response): Promise<void> {
    const path = req.params[0];

    if (!path || path.endsWith("/")) {
      this.returnErrorResponse(res, {
        errorCode: ErrorCode.RequestMethodValidOnlyForFiles,
      });
      return;
    }

    if (typeof req.body != "string") {
      this.returnErrorResponse(res, {
        errorCode: ErrorCode.TextOrByteContentEncodingRequired,
      });
      return;
    }

    await this.app.vault.adapter.write(path, req.body);
    res.sendStatus(202);
  }

  async vaultPatch(req: express.Request, res: express.Response): Promise<void> {
    const headingBoundary = req.get("Heading-Boundary") || "::";
    const heading = (req.get("Heading") || "")
      .split(headingBoundary)
      .filter(Boolean);
    const contentPosition = req.get("Content-Insertion-Position");
    let insert = false;
    const path = req.params[0];

    if (contentPosition === "beginning") {
      insert = true;
    } else if (contentPosition === "end") {
      insert = false;
    } else {
      this.returnErrorResponse(res, {
        errorCode: ErrorCode.InvalidContentInsertionPositionValue,
      });
      return;
    }
    if (typeof req.body != "string") {
      this.returnErrorResponse(res, {
        errorCode: ErrorCode.TextOrByteContentEncodingRequired,
      });
      return;
    }

    if (!heading.length) {
      this.returnErrorResponse(res, {
        errorCode: ErrorCode.MissingHeadingHeader,
      });
      return;
    }
    if (!path || path.endsWith("/")) {
      this.returnErrorResponse(res, {
        errorCode: ErrorCode.RequestMethodValidOnlyForFiles,
      });
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      this.returnErrorResponse(res, {
        statusCode: 404,
      });
      return;
    }
    const cache = this.app.metadataCache.getFileCache(file);
    const position = findHeadingBoundary(cache, heading);

    if (!position) {
      this.returnErrorResponse(res, {
        errorCode: ErrorCode.InvalidHeadingHeader,
      });
      return;
    }

    const fileContents = await this.app.vault.read(file);
    const fileLines = fileContents.split("\n");

    fileLines.splice(
      insert === false
        ? position.end?.line ?? fileLines.length
        : position.start.line + 1,
      0,
      req.body
    );

    const content = fileLines.join("\n");

    await this.app.vault.adapter.write(path, content);

    res.statusCode = 200;
    res.send(content);
  }

  async vaultPost(req: express.Request, res: express.Response): Promise<void> {
    const path = req.params[0];

    if (typeof req.body != "string") {
      this.returnErrorResponse(res, {
        errorCode: ErrorCode.TextOrByteContentEncodingRequired,
      });
      return;
    }

    if (!path || path.endsWith("/")) {
      this.returnErrorResponse(res, {
        errorCode: ErrorCode.RequestMethodValidOnlyForFiles,
      });
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      this.returnErrorResponse(res, { statusCode: 404 });
      return;
    }

    const fileContents = await this.app.vault.read(file);

    await this.app.vault.adapter.write(path, fileContents + req.body);

    res.sendStatus(200);
    return;
  }

  async vaultDelete(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const path = req.params[0];

    if (!path || path.endsWith("/")) {
      this.returnErrorResponse(res, {
        errorCode: ErrorCode.RequestMethodValidOnlyForFiles,
      });
      return;
    }

    const pathExists = await this.app.vault.adapter.exists(path);
    if (!pathExists) {
      this.returnErrorResponse(res, { statusCode: 404 });
      return;
    }

    await this.app.vault.adapter.remove(path);
    res.sendStatus(202);
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

  periodicGetInterfaceOrError(
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

  async periodicGet(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const periodName = req.params.period;
    const [period, err] = this.periodicGetInterfaceOrError(periodName);
    if (err) {
      this.returnErrorResponse(res, { errorCode: err });
      return;
    }

    const now = (window as any).moment(Date.now());
    const all = period.getAll();

    const file = period.get(now, all);

    if (!file) {
      this.returnErrorResponse(res, {
        errorCode: ErrorCode.PeriodicNoteDoesNotExist,
      });
      return;
    }

    res.statusCode = 307;
    res.set("Location", `/vault/${file.path}`);
    res.send("");
  }

  async periodicPost(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const periodName = req.params.period;
    const [period, err] = this.periodicGetInterfaceOrError(periodName);
    if (err) {
      this.returnErrorResponse(res, { errorCode: err });
      return;
    }

    const now = (window as any).moment(Date.now());

    const file = await period.create(now);

    if (!file) {
      this.returnErrorResponse(res, {
        statusCode: 500,
        message: "Could not create new periodic note.",
      });
      return;
    }

    res.statusCode = 307;
    res.set("Location", `/vault/${file.path}`);
    res.send("");
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
      this.returnErrorResponse(res, { statusCode: 404 });
      return;
    }

    try {
      this.app.commands.executeCommandById(req.params.commandId);
    } catch (e) {
      this.returnErrorResponse(res, { statusCode: 500, message: e.message });
      return;
    }

    res.sendStatus(202);
  }

  async certificateGet(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    res.set(
      "Content-type",
      `application/octet-stream; filename="${CERT_NAME}"`
    );
    res.statusCode = 200;
    res.send(this.settings.crypto.cert);
  }

  setupRouter() {
    this.api.use(cors());
    this.api.use(this.authenticationMiddleware.bind(this));
    this.api.use(bodyParser.text({ type: "text/*" }));
    this.api.use(bodyParser.raw({ type: "application/*" }));

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
      .post(this.periodicPost.bind(this));

    this.api.route("/commands/").get(this.commandGet.bind(this));
    this.api.route("/commands/:commandId/").post(this.commandPost.bind(this));

    this.api.get(`/${CERT_NAME}`, this.certificateGet.bind(this));

    this.api.get("/", this.root);
  }
}
