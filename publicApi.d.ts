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
import type { App, Events, PluginManifest } from "obsidian";
import type { IRoute } from "express";
import type { z } from "zod";
/** The plugin ID the host registers itself under in Obsidian's plugin registry. */
export declare const LOCAL_REST_API_PLUGIN_ID = "obsidian-local-rest-api";
/**
 * Behavior hints attached to a registered MCP tool.
 *
 * Structurally identical to `ToolAnnotations` from `@modelcontextprotocol/server`, but
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
export declare class ApiVersionUnsupportedError extends Error {
    readonly requestedVersion: number;
    readonly availableVersion: number;
    constructor(requestedVersion: number, availableVersion: number);
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
    addMcpTool(name: string, description: string, schema: Record<string, z.ZodTypeAny>, callback: (args: Record<string, unknown>) => Promise<unknown>, annotations?: McpToolAnnotations): void;
    /**
     * Makes one of the extension's events streamable through the host's event streams,
     * under the extension's plugin id: `POST /events/<plugin id>/<event>/` subscribes, and
     * the MCP `events_get_listener_url` tool accepts it too.
     *
     * `serialize` decides everything a stream sends. The host adds `emitter` and `event`
     * fields and sends nothing else, so return only what a holder of a stream URL may see
     * -- never live objects or note text they did not ask for. Returning null drops the
     * occurrence.
     *
     * Throws if `event` is not 1-128 letters, digits, or `.`, `_`, `:`, `-`, is `.` or `..`,
     * or is already registered by this extension. Available from extension API version 3.
     */
    addStreamableEvent(event: string, definition: StreamableEventDefinition): void;
    /** Removes every route, MCP tool and streamable event registered through this handle. */
    unregister(): void;
}
/** How an extension's event is listened for and turned into what a stream sends. */
export interface StreamableEventDefinition {
    /**
     * What the event fires on: the extension's own `Events` instance, or one of
     * Obsidian's (`app.metadataCache`, say, for an event another plugin triggers there).
     */
    source: Pick<Events, "on" | "off">;
    /**
     * Builds a JSON-serializable object from the listener's arguments: what the stream
     * sends and what a subscriber's JSONLogic filter is evaluated against. May be async.
     * Return null to send nothing for this occurrence.
     */
    serialize: (...args: unknown[]) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
}
/**
 * Resolves the host plugin's extension API, or `undefined` when Obsidian Local REST
 * API is not installed or not yet loaded.
 *
 * Pass `version` to assert that the installed host implements at least that extension
 * API version; {@link ApiVersionUnsupportedError} is thrown when it does not.
 */
export declare function getAPI(app: App, manifest: PluginManifest, version?: number): LocalRestApiPublicApi | undefined;
