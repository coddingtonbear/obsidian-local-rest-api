import { Loc } from "obsidian";

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
