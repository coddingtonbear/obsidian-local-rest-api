import type { Moment } from "moment";
import { Loc, TFile } from "obsidian";
import { IPeriodicNoteSettings } from "obsidian-daily-notes-interface";

export interface Settings {
  apiKey?: string;
  crypto?: {
    cert: string;
    privateKey: string;
    publicKey: string;
  };
  port: number;
}

export interface HeadingBoundary {
  start: Loc
  end?: Loc
}

export interface PeriodicNoteInterface {
  settings: IPeriodicNoteSettings
  loaded: boolean
  create: (date: Moment) => Promise<TFile>
  get: (date: Moment, all: Record<string, TFile>) => TFile
  getAll: () => Record<string, TFile>
}
