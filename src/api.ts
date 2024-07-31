import { IRoute, Request } from "express";
import RequestHandler from "./requestHandler";
import { PluginManifest } from "obsidian";
import { TFile } from "obsidian";
import { FileMetadataObject } from "./types";

export default class LocalRestApiPublicApi {
  private requestHandler: RequestHandler;
  public manifest: PluginManifest;

  constructor(manifest: PluginManifest, requestHandler: RequestHandler) {
    this.manifest = manifest;
    this.requestHandler = requestHandler;
  }

  /** Adds a route to the request handler. */
  public addRoute(path: string): IRoute {
    return this.requestHandler.api.route(path);
  }

  /** Is the provided request authenticated? */
  public requestIsAuthenticated(request: Request): boolean {
    return this.requestHandler.requestIsAuthenticated(request);
  }

  /** Returns a `FileMetadataObject` for a provided obsidian file */
  public getFileMetadataObject(file: TFile): Promise<FileMetadataObject> {
    return this.requestHandler.getFileMetadataObject(file);
  }
}
