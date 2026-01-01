import type { Moment } from "moment";
import { FileStats, Loc, TFile } from "obsidian";
import { IPeriodicNoteSettings } from "obsidian-daily-notes-interface";

export enum ErrorCode {
  TextContentEncodingRequired = 40010,
  ContentTypeSpecificationRequired = 40011,
  InvalidContentType = 40012,
  InvalidContentForContentType = 40015,
  InvalidContentInsertionPositionValue = 40050,
  MissingHeadingHeader = 40051,
  InvalidHeadingHeader = 40052,
  MissingTargetTypeHeader = 40053,
  InvalidTargetTypeHeader = 40054,
  MissingTargetHeader = 40055,
  MissingOperation = 40056,
  InvalidOperation = 40057,
  PeriodIsNotEnabled = 40060,
  InvalidFilterQuery = 40070,
  PatchFailed = 40080,
  InvalidSearch = 40090,
  ApiKeyAuthorizationRequired = 40101,
  PeriodDoesNotExist = 40460,
  PeriodicNoteDoesNotExist = 40461,
  RequestMethodValidOnlyForFiles = 40510,
  SourcePathNotFound = 40420,
  DestinationAlreadyExists = 40921,
  CannotMoveToSubdirectory = 40022,
  MissingSourcePath = 40023,
  MissingDestinationPath = 40024,
  ErrorPreparingSimpleSearch = 50010,
}

export interface LocalRestApiSettings {
  apiKey?: string;
  crypto?: {
    cert: string;
    privateKey: string;
    publicKey: string;
  };
  port: number;
  insecurePort: number;
  enableInsecureServer: boolean;
  enableSecureServer?: boolean;

  authorizationHeaderName?: string;
  bindingHost?: string;
  subjectAltNames?: string;
}

export interface HeadingBoundary {
  start: Loc;
  end?: Loc;
}

export interface PeriodicNoteInterface {
  settings: IPeriodicNoteSettings;
  loaded: boolean;
  create: (date: Moment) => Promise<TFile>;
  get: (date: Moment, all: Record<string, TFile>) => TFile;
  getAll: () => Record<string, TFile>;
}

declare module "obsidian" {
  interface FileManager {
    renameFile(file: TAbstractFile, newPath: string): Promise<void>;
  }
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
    };
    internalPlugins: {
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
}
