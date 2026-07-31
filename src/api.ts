import express from "express";
import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { BUILT_IN_ROUTES } from "./constants";
import { McpHandler } from "./mcpHandler";
import type { LocalRestApiPublicApi } from "./publicApi";

// The public surface — the interface and ApiVersionUnsupportedError — lives in
// ./publicApi, which is what the generated publicApi.d.ts is emitted from. Re-exported
// here so internal callers keep importing them from the module that implements them.
export { ApiVersionUnsupportedError } from "./publicApi";
export type { LocalRestApiPublicApi } from "./publicApi";

/**
 * A route an extension has registered, as reported by {@link
 * LocalRestApiPublicApiImpl.getRoutes}.
 *
 * Deliberately declared here rather than in ./publicApi: it describes the host's own
 * bookkeeping, which only `GET /` consumes, so publishing it would freeze this shape
 * into the extension contract for no one's benefit.
 */
export interface RegisteredRoute {
  path: string;
  authenticated: boolean;
}

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

  /**
   * Host-only: the routes registered through this handle, for the `GET /` response.
   * Not part of {@link LocalRestApiPublicApi} — see `HostOnlyMembers` below.
   *
   * Returns a copy. Handing back the live array would let any caller reorder or empty
   * the registration bookkeeping this instance relies on.
   */
  public getRoutes(): RegisteredRoute[] {
    return [...this.registeredRoutes];
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

  /** Host-only counterpart to {@link getRoutes}, returning a copy for the same reason. */
  public getMcpTools(): string[] {
    return [...this.registeredMcpTools];
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
 * Members that are public on the class because the host calls them across module
 * boundaries, but that are deliberately *not* promised to extensions.
 *
 * TypeScript has no visibility level for "public to this codebase, private to our
 * consumers", so the distinction has to be written down. Anything named here is exempt
 * from the completeness check below; everything else must appear in
 * {@link LocalRestApiPublicApi}.
 */
type HostOnlyMembers = "getRoutes" | "getMcpTools";

/**
 * Compile-time guard that every public member is a deliberate choice.
 *
 * The `implements` clause above already fails the build when the class drops something
 * the interface promises. This catches the opposite drift: a public member added to the
 * class that neither ./publicApi nor HostOnlyMembers accounts for. Adding a public
 * method here without classifying it breaks `npm run typecheck`.
 *
 * The classification matters more than it looks. Before HostOnlyMembers existed, the
 * only way to satisfy this guard was to declare the member in ./publicApi — so the
 * guard, meant to keep the published surface honest, actively pushed host-internal
 * methods into the extension contract. `getRoutes` and `getMcpTools` reached the
 * published types that way; both are called only by the `GET /` handler.
 *
 * Exported only so it counts as used; it has no runtime representation.
 */
export type PublicSurfaceIsComplete = AssertNever<
  Exclude<
    keyof LocalRestApiPublicApiImpl,
    keyof LocalRestApiPublicApi | HostOnlyMembers
  >
>;
