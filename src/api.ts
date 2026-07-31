import express from "express";
import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { BUILT_IN_ROUTES } from "./constants";
import { McpHandler } from "./mcpHandler";
import type { LocalRestApiPublicApi, RegisteredRoute } from "./publicApi";

// The public surface — the interface, RegisteredRoute, and ApiVersionUnsupportedError —
// lives in ./publicApi, which is what the generated publicApi.d.ts is emitted from.
// Re-exported here so internal callers keep importing them from the module that
// implements them.
export { ApiVersionUnsupportedError } from "./publicApi";
export type { LocalRestApiPublicApi, RegisteredRoute } from "./publicApi";

export default class LocalRestApiPublicApiImpl implements LocalRestApiPublicApi {
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
    annotations?: ToolAnnotations,
  ): void {
    this.assertRegistered();
    const cleanup = this.mcpHandler.registerTool(name, description, schema, callback, annotations);
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

/** Resolves to `T` only when `T` is `never`; any other type is a compile error. */
type AssertNever<T extends never> = T;

/**
 * Compile-time guard that ./publicApi describes the *whole* public surface.
 *
 * The `implements` clause above already fails the build when the class drops something
 * the interface promises. This catches the opposite drift: a public member added to the
 * class that ./publicApi — and therefore the generated declaration extension authors
 * consume — never learned about. Adding a public method here without documenting it
 * there breaks `npm run typecheck`.
 *
 * Exported only so it counts as used; it has no runtime representation.
 */
export type PublicSurfaceIsComplete = AssertNever<
  Exclude<keyof LocalRestApiPublicApiImpl, keyof LocalRestApiPublicApi>
>;
