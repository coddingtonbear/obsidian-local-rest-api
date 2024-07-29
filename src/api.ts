import { IRoute } from "express";
import RequestHandler from "./requestHandler";
import { PluginManifest } from "mocks/obsidian";

export default class LocalRestApiPublicApi {
  private requestHandler: RequestHandler;
  public manifest: PluginManifest;

  constructor(manifest: PluginManifest, requestHandler: RequestHandler) {
    this.manifest = manifest;
    this.requestHandler = requestHandler;
  }

  public addRoute(path: string): IRoute {
    return this.requestHandler.api.route(path);
  }
}
