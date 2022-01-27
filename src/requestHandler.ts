import { App, Command, TFile } from "obsidian";
import periodicNotes from "obsidian-daily-notes-interface";

import express from "express";
import cors from "cors";
import mime from "mime";
import bodyParser from "body-parser";

import { Settings, PeriodicNoteInterface } from "./types";
import { findHeadingBoundary } from "./utils";

export default class RequestHandler {
  app: App;
  api: express.Express;
  settings: Settings;

  constructor(app: App, settings: Settings) {
    this.app = app;
    this.api = express();
    this.settings = settings;
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
        res.sendStatus(404);
      }
    }
  }

  async vaultPut(req: express.Request, res: express.Response): Promise<void> {
    const path = req.params[0];

    if (!path || path.endsWith("/")) {
      res.sendStatus(400);
    }

    if (typeof req.body != "string") {
      res.statusCode = 400;
      res.json({
        error:
          "Incoming content did not come with a bytes or text content encoding.  Be sure to set a Content-type header matching application/* or text/*.",
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
      res.statusCode = 400;
      res.json({
        error: `Unexpected 'Content-Insertion-Position' header value: '${contentPosition}'.`,
      });
      return;
    }
    if (typeof req.body != "string") {
      res.statusCode = 400;
      res.json({
        error:
          "Incoming content did not come with a bytes or text content encoding.  Be sure to set a Content-type header matching application/* or text/*.",
      });
      return;
    }

    if (!heading.length) {
      res.statusCode = 400;
      res.json({
        error: "No 'Heading' header specified as insertion target for file.",
      });
      return;
    }
    if (!path || path.endsWith("/")) {
      res.statusCode = 400;
      res.json({
        error: "PATCH can be used only for modifying an existing file.",
      });
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      res.sendStatus(404);
      return;
    }
    const cache = this.app.metadataCache.getFileCache(file);
    const position = findHeadingBoundary(cache, heading);

    if (!position) {
      res.statusCode = 400;
      res.json({
        error: `No heading found matching path '${heading.join("::")}'.`,
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
    let path = req.params[0];

    if (typeof req.body != "string") {
      res.statusCode = 400;
      res.json({
        error:
          "Incoming content did not come with a bytes or text content encoding.  Be sure to set a Content-type header matching application/* or text/*.",
      });
      return;
    }

    if (path && !path.endsWith("/")) {
      res.statusCode = 400;
      res.json({
        error: "Path must be a directory.",
      });
      return;
    }
    const pathExists = await this.app.vault.adapter.exists(path);
    if (!pathExists) {
      res.sendStatus(404);
      return;
    }

    const moment = (window as any).moment(Date.now());
    path = `${path}${moment.format("YYYYMMDDTHHmmss")}.md`;

    await this.app.vault.adapter.write(path, req.body);
    res.sendStatus(202);
  }

  async vaultDelete(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const path = req.params[0];

    if (!path || path.endsWith("/")) {
      res.statusCode = 400;
      res.json({
        error: "DELETE can only be used to delete files.",
      });
      return;
    }

    const pathExists = await this.app.vault.adapter.exists(path);
    if (!pathExists) {
      res.sendStatus(404);
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

  periodicGetInterfaceOrError(period: string): PeriodicNoteInterface {
    const periodic = this.getPeriodicNoteInterface();
    if (!periodic[period]) {
      throw new Error(`Period ${period} does not exist.`);
    }
    if (!periodic[period].loaded) {
      throw new Error(`Period ${period} is not enabled.`);
    }

    return periodic[period];
  }

  async periodicGet(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const periodName = req.params.period;
    let period: PeriodicNoteInterface;
    try {
      period = this.periodicGetInterfaceOrError(periodName);
    } catch (e) {
      res.statusCode = 404;
      res.json({
        error: e,
      });
      return;
    }

    const now = (window as any).moment(Date.now());
    const all = period.getAll();

    const file = period.get(now, all);

    if (!file) {
      res.statusCode = 404;
      res.json({
        error: `Periodic note of type ${periodName} does not exist for the current moment.  You can create one by POST-ing.`,
      });
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
    let period: PeriodicNoteInterface;
    try {
      period = this.periodicGetInterfaceOrError(periodName);
    } catch (e) {
      res.statusCode = 404;
      res.json({
        error: e,
      });
      return;
    }

    const now = (window as any).moment(Date.now());

    const file = await period.create(now);

    if (!file) {
      res.statusCode = 400;
      res.json({
        error: "Could not create new periodic note; does it already exist?",
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
      res.sendStatus(404);
    }

    try {
      this.app.commands.executeCommandById(req.params.commandId);
    } catch (e) {
      res.sendStatus(500);
    }

    res.sendStatus(202);
  }

  async authenticationMiddleware(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ): Promise<void> {
    const authorizationHeader = req.get("Authorization");

    if (authorizationHeader !== `Bearer ${this.settings.apiKey}`) {
      res.sendStatus(401);
      return;
    }

    next();
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

    this.api.get("/", this.root);
  }
}
