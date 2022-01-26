import { App, TFile } from "obsidian";

import express from "express";
import cors from "cors";
import mime from "mime";
import bodyParser from "body-parser";

import { Settings } from "./types";
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
      res.sendStatus(404);
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

  async vaultPost(req: express.Request, res: express.Response): Promise<void> {
    const headingBoundary = req.get("Heading-Boundary") || "::"
    const heading = (req.get("Heading") || "").split(headingBoundary).filter(Boolean)
    const insert = req.get("Heading-Insert") !== undefined
    let path = req.params[0];
    let content = ""

    if (typeof req.body != "string") {
      res.statusCode = 400;
      res.json({
        error:
          "Incoming content did not come with a bytes or text content encoding.  Be sure to set a Content-type header matching application/* or text/*.",
      });
      return;
    }

    if (heading.length) {
      if (!path || path.endsWith("/")) {
        res.statusCode = 400;
        res.json({
          error: "Cannot set 'Heading' while creating new file.",
        });
        return;
      }
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        res.sendStatus(404);
        return;
      }
      const cache = this.app.metadataCache.getFileCache(file);
      const position = findHeadingBoundary(cache, heading)

      if(!position) {
        res.statusCode = 400;
        res.json({
          error: `No heading found matching path '${heading.join("::")}'.`,
        });
        return;
      }

      const fileContents = await this.app.vault.read(file)
      const fileLines = fileContents.split("\n")

      console.log(position)

      fileLines.splice(insert === false ? (position.end?.line ?? fileLines.length) : position.start.line + 1, 0, req.body)

      content = fileLines.join("\n")
    } else {
      if (path && !path.endsWith("/")) {
        res.statusCode = 400;
        res.json({
          error: "No 'Heading' header specified as insertion target for file.",
        });
        return;
      }
      const pathExists = await this.app.vault.adapter.exists(path)
      if(!pathExists) {
        res.sendStatus(404);
        return;
      }

      const moment = (window as any).moment(Date.now());
      path = `${path}${moment.format("YYYYMMddTHHmmss")}.md`;
      content = req.body
    }
    res.statusCode = 203
    res.send(content)
    return;
  }

  setupRouter() {
    this.api.use(cors());
    this.api.use(bodyParser.text({ type: "text/*" }));
    this.api.use(bodyParser.raw({ type: "application/*" }));

    this.api
      .route("/vault/*")
      .get(this.vaultGet.bind(this))
      .put(this.vaultPut.bind(this))
      .post(this.vaultPost.bind(this));

    this.api.get("/", this.root);
  }
}
