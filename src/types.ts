import { FileStats, TFile } from "obsidian";

export enum ErrorCode {
  InvalidFrontmatter = 40005,
  TextContentEncodingRequired = 40010,
  ContentTypeSpecificationRequired = 40011,
  InvalidContentType = 40012,
  InvalidContentForContentType = 40015,
  MissingDestinationHeader = 40020,
  PathTraversalNotAllowed = 40021,
  InvalidDestinationHeader = 40022,
  InvalidWithinHeader = 40023,
  MissingTargetTypeHeader = 40053,
  InvalidTargetTypeHeader = 40054,
  MissingTargetHeader = 40055,
  InvalidTargetScopeHeader = 40059,
  MissingOperation = 40056,
  InvalidOperation = 40057,
  InvalidTargetHeader = 40058,
  InvalidPatchVersionHeader = 40082,
  HeaderTargetingRequiresVersion1 = 40083,
  PatchHeaderTargetingRequiresExplicitVersion = 40084,
  InvalidFilterQuery = 40070,
  PatchFailed = 40080,
  InvalidPatchInstruction = 40081,
  InvalidSearch = 40090,
  EventNameRequired = 40095,
  ApiKeyAuthorizationRequired = 40101,
  SignedUrlIsWholeFileOnly = 40102,
  ConfigDirAccessNotAllowed = 40321,
  UnknownEvent = 40460,
  EventSubscriptionNotFound = 40461,
  RequestMethodValidOnlyForFiles = 40510,
  DestinationAlreadyExists = 40920,
  ConflictingTargetSpecification = 42200,
  TooManyAuthenticationFailures = 42901,
  ErrorPreparingSimpleSearch = 50010,
  FileOperationFailed = 50020,
  EventCapacityReached = 50301,
}

/**
 * The TLS material the plugin serves.
 *
 * `cert`/`privateKey`/`publicKey` are the leaf certificate presented by the
 * HTTPS server and its keypair. `caCert`/`caPrivateKey` hold the certificate
 * authority that signed the leaf; they are absent for material generated
 * before the CA/leaf split (a single self-signed certificate that doubled as
 * its own authority), which the plugin keeps serving unchanged until the
 * user regenerates it.
 */
export interface CryptoSettings {
  cert: string;
  privateKey: string;
  publicKey: string;
  caCert?: string;
  caPrivateKey?: string;
}

export interface LocalRestApiSettings {
  apiKey?: string;
  crypto?: CryptoSettings;
  port: number;
  insecurePort: number;
  enableInsecureServer: boolean;
  enableSecureServer?: boolean;

  authorizationHeaderName?: string;
  bindingHost?: string;
  subjectAltNames?: string;
  enableVerboseLogging?: boolean;

  /**
   * Whether `GET`/`PUT /vault/<path>` accept a signed URL in place of the bearer
   * header, and whether the MCP tools that mint such URLs are registered. On by
   * default (see `DEFAULT_SETTINGS`); a stored `false` turns it off. A signed link is a
   * capability that can be pasted anywhere, which is why it can be turned off at all.
   */
  enableSignedUrls?: boolean;
  /** How long a signed URL stays valid, in seconds. See `clampSignedUrlTtl`. */
  signedUrlTtlSeconds?: number;

  /**
   * Whether the API may read or write files inside Obsidian's configuration
   * directory (`app.vault.configDir`, normally `.obsidian`). Off by default and
   * absent unless explicitly turned on.
   *
   * That directory holds plugin code, `community-plugins.json`, and each
   * plugin's `data.json` -- including this plugin's own, where the API key
   * lives. Writing into it is arbitrary code execution: Obsidian `eval`s an
   * enabled plugin's `main.js`, so an authenticated client that can drop a
   * plugin there and enable it runs code at full user privilege (GHSA-66m9-r757-qvq7).
   * Reading from it leaks those same secrets. The guard therefore covers reads
   * as well as writes.
   *
   * It exists as a setting at all because a few users deliberately manage their
   * config through the API; turning it on re-grants that access and, with it,
   * the risk above.
   */
  enableConfigDirAccess?: boolean;
}

declare module "obsidian" {
  interface App {
    setting: {
      containerEl: HTMLElement;
      openTabById(id: string): void;
      pluginTabs: Array<{
        id: string;
        name: string;
        plugin: {
          [key: string]: PluginManifest;
        };
        instance?: {
          description: string;
          id: string;
          name: string;
        };
      }>;
      activeTab: SettingTab;
      open(): void;
    };
    commands: {
      executeCommandById(id: string): void;
      commands: {
        [key: string]: Command;
      };
    };
    plugins: {
      plugins: {
        [key: string]: PluginManifest;
      };
      getPlugin(id: string): { settings?: Record<string, unknown> } | null;
    };
    internalPlugins: {
      getPluginById(id: string): { instance?: { options?: Record<string, unknown> } } | null;
      plugins: {
        [key: string]: {
          instance: {
            description: string;
            id: string;
            name: string;
          };
          enabled: boolean;
        };
        workspaces: {
          instance: {
            description: string;
            id: string;
            name: string;
            activeWorkspace: Workspace;
            saveWorkspace(workspace: Workspace): void;
            loadWorkspace(workspace: string): void;
          };
          enabled: boolean;
        };
      };
    };
  }
  interface View {
    file: TFile;
  }
}

export interface ErrorResponseDescriptor {
  statusCode?: number;
  message?: string;
  errorCode?: ErrorCode;
}

export interface CannedResponse {
  message: string;
  errorCode?: number;
}

export interface SearchContext {
  match: {
    start: number;
    end: number;
    source: "filename" | "content";
  };
  context: string;
}

export interface SearchResponseItem {
  filename: string;
  score?: number;
  matches: SearchContext[];
}

export interface SearchJsonResponseItem {
  filename: string;
  result: unknown;
}

export interface FileMetadataObject {
  tags: string[];
  frontmatter: Record<string, unknown>;
  stat: FileStats;
  path: string;
  content: string;
  links: string[];
  backlinks: string[];
  unresolvedLinks: string[];
}

export interface DocumentMapObject {
  headings: string[];
  blocks: string[];
  frontmatterFields: string[];
}
