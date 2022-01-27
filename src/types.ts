import type { Moment } from "moment";
import { Loc, TFile } from "obsidian";
import { IPeriodicNoteSettings } from "obsidian-daily-notes-interface";

export interface LocalRestApiSettings {
  apiKey?: string;
  crypto?: {
    cert: string;
    privateKey: string;
    publicKey: string;
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
