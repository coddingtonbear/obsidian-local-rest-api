import { App, PluginManifest } from "obsidian";

import { IRoute, Request } from "express";

declare class LocalRestApiPublicApi {
  public manifest: PluginManifest;

  /** Adds a route to the request handler. */
  public addRoute(path: string): IRoute;

  /** Is the provided request authenticated? */
  public requestIsAuthenticated(request: Request): boolean;
}

export function getAPI(
  app: App,
  manifest: PluginManifest
): LocalRestApiPublicApi;
