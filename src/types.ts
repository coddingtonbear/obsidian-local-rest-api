import type { Moment } from "moment";
import { Loc, TFile } from "obsidian";
import { IPeriodicNoteSettings } from "obsidian-daily-notes-interface";

export enum ErrorCode {
  TextOrByteContentEncodingRequired = 40010,
  InvalidContentInsertionPositionValue = 40050,
  MissingHeadingHeader = 40051,
  InvalidHeadingHeader = 40052,
  PeriodIsNotEnabled = 40060,
  ApiKeyAuthorizationRequired = 40101,
  PeriodDoesNotExist = 40460,
  PeriodicNoteDoesNotExist = 40461,
  RequestMethodValidOnlyForFiles = 40510,
}

export interface LocalRestApiSettings {
  apiKey?: string;
  crypto?: {
    cert: string;
    privateKey: string;
    publicKey: string;
    resetOnNextLoad?: boolean;
  };
  port: number;
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

export interface ErrorResponse {
  error: string;
  errorCode?: number;
}
