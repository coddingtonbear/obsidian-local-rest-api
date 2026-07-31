/**
 * The public extension interface of Obsidian Local REST API.
 *
 * This module is the single source of truth for everything other plugins are allowed
 * to depend on. `publicApi.d.ts` and `publicApi.js` at the repository root are
 * generated from this file by `npm run build-types`, and package.json points its
 * `types` and `main` fields at them, so an extension author who installs this package
 * gets an accurate, dependency-light entry point rather than the multi-megabyte plugin
 * bundle.
 *
 * Two rules keep that promise honest:
 *
 * 1. Nothing here may import plugin internals. Only `import type` from obsidian,
 *    express, and zod — anything else would leak a `./somethingInternal` reference
 *    into the generated declaration and break for consumers.
 * 2. `LocalRestApiPublicApi` is implemented by the class in `./api`, which carries a
 *    compile-time guard in both directions: `implements` catches a member this
 *    interface promises but the class dropped, and an explicit key check catches a
 *    public member the class grew but this interface never learned about. The types
 *    therefore cannot drift from the implementation the way the old hand-written
 *    `main.d.ts` did.
 *
 * A member the host calls on the implementation but does not want to promise to
 * extensions is opted out by name in `HostOnlyMembers` in `./api`, rather than being
 * declared here. Adding it here instead is the easy mistake: it silences the guard just
 * as well, but it also freezes the member's signature into the published contract
 * forever.
 */
import type { App, PluginManifest } from "obsidian";
import type { IRoute } from "express";
import type { z } from "zod";

/** The plugin ID the host registers itself under in Obsidian's plugin registry. */
export const LOCAL_REST_API_PLUGIN_ID = "obsidian-local-rest-api";

/**
 * Behavior hints attached to a registered MCP tool.
 *
 * Structurally identical to `ToolAnnotations` from `@modelcontextprotocol/sdk`, but
 * declared here so that consuming this package's types does not require the SDK to be
 * installed. The host passes whatever it receives straight through to the SDK.
 */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * Thrown by {@link getAPI} when the caller asks for an extension API version newer
 * than the installed plugin implements.
 */
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

/**
 * The handle an extension receives from {@link getAPI}.
 *
 * Every route and tool registered through this handle is torn down together by
 * {@link unregister}, which an extension should call from its `onunload`.
 */
export interface LocalRestApiPublicApi {
  /** The extension API version implemented by the installed host plugin. */
  readonly apiVersion: number;

  /**
   * Adds a route that requires the caller to present the API key, exactly as the
   * plugin's own routes do.
   */
  addRoute(path: string): IRoute;

  /**
   * Adds a route reachable without an API key.
   *
   * Throws if `path` collides with a path reserved by the host plugin.
   */
  addPublicRoute(path: string): IRoute;

  /**
   * Registers an MCP tool, exposing it to every MCP client connected to the host.
   *
   * Throws if a tool with this name is already registered.
   */
  addMcpTool(
    name: string,
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    callback: (args: Record<string, unknown>) => Promise<unknown>,
    annotations?: McpToolAnnotations,
  ): void;

  /** Removes every route and MCP tool registered through this handle. */
  unregister(): void;
}

/**
 * The slice of the host plugin instance this module calls into. Declared structurally
 * rather than imported so that nothing internal leaks into the generated declaration.
 */
interface LocalRestApiHostPlugin {
  getPublicApi(manifest: PluginManifest): LocalRestApiPublicApi;
}

/**
 * Obsidian's undocumented plugin registry. `App` as typed by the `obsidian` package
 * has no `plugins`, and the host's own augmentation of it is not part of this module's
 * dependency-free surface, so it is narrowed locally here.
 */
interface AppWithPluginRegistry {
  plugins?: { plugins?: Record<string, unknown> };
}

/**
 * Resolves the host plugin's extension API, or `undefined` when Obsidian Local REST
 * API is not installed or not yet loaded.
 *
 * Pass `version` to assert that the installed host implements at least that extension
 * API version; {@link ApiVersionUnsupportedError} is thrown when it does not.
 */
export function getAPI(
  app: App,
  manifest: PluginManifest,
  version?: number,
): LocalRestApiPublicApi | undefined {
  const plugin = (app as unknown as AppWithPluginRegistry).plugins?.plugins?.[
    LOCAL_REST_API_PLUGIN_ID
  ] as LocalRestApiHostPlugin | undefined;
  if (!plugin) return undefined;

  const api = plugin.getPublicApi(manifest);
  if (version !== undefined) {
    // Hosts predating the apiVersion field implement version 1.
    const availableVersion = api.apiVersion ?? 1;
    if (availableVersion < version) {
      throw new ApiVersionUnsupportedError(version, availableVersion);
    }
  }
  return api;
}
