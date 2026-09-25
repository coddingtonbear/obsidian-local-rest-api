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
 * The content types below are structurally identical to the matching types in
 * `@modelcontextprotocol/server`, and declared here for the same reason as
 * {@link McpToolAnnotations}: consuming this package's types must not require the SDK.
 * They cover the content blocks a tool result or prompt message may carry.
 */

/** Hints about who a content block is for and how much it matters. */
export interface McpContentAnnotations {
  audience?: ("user" | "assistant")[];
  /** From 0 (least important) to 1 (effectively required). */
  priority?: number;
  /** An ISO 8601 timestamp, e.g. `2026-09-25T14:00:00Z`. */
  lastModified?: string;
}

/** Plain text. */
export interface McpTextContent {
  type: "text";
  text: string;
  annotations?: McpContentAnnotations;
  _meta?: Record<string, unknown>;
}

/** An image, as base64-encoded bytes. */
export interface McpImageContent {
  type: "image";
  /** Base64-encoded image bytes. */
  data: string;
  mimeType: string;
  annotations?: McpContentAnnotations;
  _meta?: Record<string, unknown>;
}

/** Audio, as base64-encoded bytes. */
export interface McpAudioContent {
  type: "audio";
  /** Base64-encoded audio bytes. */
  data: string;
  mimeType: string;
  annotations?: McpContentAnnotations;
  _meta?: Record<string, unknown>;
}

/** A pointer to a resource the client may read or fetch on its own. */
export interface McpResourceLinkContent {
  type: "resource_link";
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: McpContentAnnotations;
  _meta?: Record<string, unknown>;
}

/** One resource's contents, as text or as base64-encoded bytes. */
export type McpResourceContents =
  | { uri: string; mimeType?: string; text: string; _meta?: Record<string, unknown> }
  | { uri: string; mimeType?: string; blob: string; _meta?: Record<string, unknown> };

/** A resource embedded in a result, contents and all. */
export interface McpEmbeddedResourceContent {
  type: "resource";
  resource: McpResourceContents;
  annotations?: McpContentAnnotations;
  _meta?: Record<string, unknown>;
}

/** Any content block a tool result or a prompt message may carry. */
export type McpContentBlock =
  | McpTextContent
  | McpImageContent
  | McpAudioContent
  | McpResourceLinkContent
  | McpEmbeddedResourceContent;

/**
 * A tool call's result, handed to the client as-is.
 *
 * Set `isError` to report a failure the model should see and may recover from (a
 * missing file, a rejected argument), rather than throwing, which the client treats as
 * the call itself having failed. When the tool declares an `outputSchema`,
 * `structuredContent` is required and is validated against it.
 */
// The result types are type aliases rather than interfaces so that they stay assignable
// to the SDK's own result types, which carry an index signature an interface lacks.
export type McpToolResult = {
  content: McpContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

/** An MCP tool, for the object form of {@link LocalRestApiPublicApi.addMcpTool}. */
export interface McpToolDefinition {
  name: string;
  /** A human-readable name for display. `name` is used when omitted. */
  title?: string;
  description: string;
  /** The tool's arguments. Omit for a tool that takes none. */
  inputSchema?: Record<string, z.ZodTypeAny>;
  /**
   * The shape of the tool's `structuredContent`. When set, the host advertises it in
   * `tools/list` and rejects a result whose `structuredContent` is missing or does not
   * match it.
   */
  outputSchema?: Record<string, z.ZodTypeAny>;
  annotations?: McpToolAnnotations;
  /** Returns the result exactly as the client should receive it. */
  callback: (args: Record<string, unknown>) => Promise<McpToolResult>;
}

/** What a resource read returns. */
export type McpReadResourceResult = {
  contents: McpResourceContents[];
  _meta?: Record<string, unknown>;
};

/** A resource at one fixed URI. */
export interface McpResourceDefinition {
  name: string;
  uri: string;
  title?: string;
  description?: string;
  mimeType?: string;
  read: (uri: URL) => Promise<McpReadResourceResult>;
}

/** One resource a {@link McpResourceTemplateDefinition} lists in `resources/list`. */
export interface McpListedResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

/** A family of resources addressed by an RFC 6570 URI template. */
export interface McpResourceTemplateDefinition {
  name: string;
  /** An RFC 6570 URI template, e.g. `tandem://comments/{path}`. */
  uriTemplate: string;
  title?: string;
  description?: string;
  mimeType?: string;
  /**
   * The concrete resources to include in `resources/list`. Omit when the family can't
   * or shouldn't be enumerated; clients can still read any URI matching the template.
   */
  list?: () => Promise<McpListedResource[]>;
  /** `variables` holds the values the template's placeholders matched in `uri`. */
  read: (uri: URL, variables: Record<string, string | string[]>) => Promise<McpReadResourceResult>;
}

/** One message of a prompt. */
export interface McpPromptMessage {
  role: "user" | "assistant";
  content: McpContentBlock;
}

/** What getting a prompt returns. */
export type McpPromptResult = {
  description?: string;
  messages: McpPromptMessage[];
  _meta?: Record<string, unknown>;
};

/** An MCP prompt: a message template a client offers its user. */
export interface McpPromptDefinition {
  name: string;
  title?: string;
  description?: string;
  /**
   * The prompt's arguments. MCP passes prompt arguments as strings, so each field
   * should be a string schema (`z.string()`, optionally `.optional()`).
   */
  argsSchema?: Record<string, z.ZodTypeAny>;
  /** An argument declared `.optional()` is absent from `args` when the client omits it. */
  callback: (args: Record<string, string | undefined>) => Promise<McpPromptResult>;
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
 * Everything registered through this handle is torn down together by
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
   * Whatever `callback` resolves to is sent to the client as a single text block: a
   * string as-is, anything else JSON-encoded. For images, structured output, or a
   * deliberate `isError` result, use the {@link McpToolDefinition} form instead.
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

  /**
   * Registers an MCP tool whose callback returns a complete {@link McpToolResult}, which
   * is passed to the client unchanged. Available from API version 3.
   *
   * Throws if a tool with this name is already registered.
   */
  addMcpTool(definition: McpToolDefinition): void;

  /**
   * Registers an MCP resource at a fixed URI. Available from API version 3.
   *
   * Throws if a resource with this URI is already registered.
   */
  addMcpResource(definition: McpResourceDefinition): void;

  /**
   * Registers a family of MCP resources addressed by a URI template. Available from API
   * version 3.
   *
   * Throws if a resource template with this name is already registered.
   */
  addMcpResourceTemplate(definition: McpResourceTemplateDefinition): void;

  /**
   * Registers an MCP prompt. Available from API version 3.
   *
   * Throws if a prompt with this name is already registered.
   */
  addMcpPrompt(definition: McpPromptDefinition): void;

  /**
   * Removes every route, MCP tool, resource, resource template, and prompt registered
   * through this handle.
   */
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
