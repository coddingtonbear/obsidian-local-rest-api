import express from "express";
import { z } from "zod";
import { BUILT_IN_ROUTES } from "./constants";
import { McpHandler } from "./mcpHandler";

export interface RegisteredRoute {
  path: string;
  authenticated: boolean;
}

export class ApiVersionUnsupportedError extends Error {
  constructor(
    public readonly requestedVersion: number,
    public readonly availableVersion: number,
  ) {
    super(
      `Obsidian Local REST API does not support API version ${requestedVersion}. ` +
      `The installed plugin supports API version ${availableVersion}.`
    );
    this.name = "ApiVersionUnsupportedError";
  }
}

export default class LocalRestApiPublicApi {
  public readonly apiVersion = 2;
  private router: express.Router;
  private publicRouter: express.Router;
  private mcpHandler: McpHandler;
  private onUnregister: () => void;
  private unregistered = false;
  private registeredRoutes: RegisteredRoute[] = [];
  private mcpToolCleanups: (() => void)[] = [];
  private registeredMcpTools: string[] = [];

  constructor(router: express.Router, publicRouter: express.Router, mcpHandler: McpHandler, onUnregister: () => void) {
    this.router = router;
    this.publicRouter = publicRouter;
    this.mcpHandler = mcpHandler;
    this.onUnregister = onUnregister;
    this.unregistered = false;
  }

  private assertRegistered(): void {
    if (this.unregistered) {
      throw new Error(
        "Routes cannot be added after API extension has been unregistered."
      );
    }
  }

  public getRoutes(): RegisteredRoute[] {
    return this.registeredRoutes;
  }

  /** Adds an authenticated route to the request handler. */
  public addRoute(path: string): express.IRoute {
    this.assertRegistered();
    this.registeredRoutes.push({ path, authenticated: true });
    return this.router.route(path);
  }

  /** Adds an unauthenticated route to the request handler. */
  public addPublicRoute(path: string): express.IRoute {
    this.assertRegistered();
    if (BUILT_IN_ROUTES.includes(path)) {
      throw new Error(
        `Cannot register a public route at "${path}" — this path is reserved by Obsidian Local REST API.`
      );
    }
    this.registeredRoutes.push({ path, authenticated: false });
    return this.publicRouter.route(path);
  }

  /** Registers an MCP tool that will be available to MCP clients. */
  public addMcpTool(
    name: string,
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    callback: (args: Record<string, unknown>) => Promise<unknown>,
  ): void {
    this.assertRegistered();
    const cleanup = this.mcpHandler.registerTool(name, description, schema, callback);
    this.mcpToolCleanups.push(cleanup);
    this.registeredMcpTools.push(name);
  }

  public getMcpTools(): string[] {
    return this.registeredMcpTools;
  }

  public unregister(): void {
    for (const cleanup of this.mcpToolCleanups) {
      cleanup();
    }
    this.onUnregister();
    this.unregistered = true;
  }
}
