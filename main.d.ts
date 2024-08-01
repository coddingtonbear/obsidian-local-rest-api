import { App, PluginManifest } from "obsidian";

import { IRoute } from "express";

declare class LocalRestApiPublicApi {
  /** Adds a route to the request handler. */
  public addRoute(path: string): IRoute;

  public unregister(): void;
}

export function getAPI(
  app: App,
  manifest: PluginManifest
): LocalRestApiPublicApi;
