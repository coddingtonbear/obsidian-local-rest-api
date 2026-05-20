import { TFile } from "./obsidian";

export interface IPeriodicNoteSettings {
  folder?: string;
  format?: string;
  template?: string;
}

const mockFile = new TFile();

export const getDailyNoteSettings = jest
  .fn()
  .mockReturnValue({ format: "YYYY-MM-DD", folder: "", template: "" });
export const appHasDailyNotesPluginLoaded = jest.fn().mockReturnValue(true);
export const createDailyNote = jest.fn().mockResolvedValue(mockFile);
export const getDailyNote = jest.fn().mockReturnValue(null);
export const getAllDailyNotes = jest.fn().mockReturnValue({});

export const getWeeklyNoteSettings = jest
  .fn()
  .mockReturnValue({ format: "gggg-[W]ww", folder: "", template: "" });
export const appHasWeeklyNotesPluginLoaded = jest.fn().mockReturnValue(true);
export const createWeeklyNote = jest.fn().mockResolvedValue(mockFile);
export const getWeeklyNote = jest.fn().mockReturnValue(null);
export const getAllWeeklyNotes = jest.fn().mockReturnValue({});

export const getMonthlyNoteSettings = jest
  .fn()
  .mockReturnValue({ format: "YYYY-MM", folder: "", template: "" });
export const appHasMonthlyNotesPluginLoaded = jest.fn().mockReturnValue(true);
export const createMonthlyNote = jest.fn().mockResolvedValue(mockFile);
export const getMonthlyNote = jest.fn().mockReturnValue(null);
export const getAllMonthlyNotes = jest.fn().mockReturnValue({});

export const getQuarterlyNoteSettings = jest
  .fn()
  .mockReturnValue({ format: "YYYY-[Q]Q", folder: "", template: "" });
export const appHasQuarterlyNotesPluginLoaded = jest.fn().mockReturnValue(true);
export const createQuarterlyNote = jest.fn().mockResolvedValue(mockFile);
export const getQuarterlyNote = jest.fn().mockReturnValue(null);
export const getAllQuarterlyNotes = jest.fn().mockReturnValue({});

export const getYearlyNoteSettings = jest
  .fn()
  .mockReturnValue({ format: "YYYY", folder: "", template: "" });
export const appHasYearlyNotesPluginLoaded = jest.fn().mockReturnValue(true);
export const createYearlyNote = jest.fn().mockResolvedValue(mockFile);
export const getYearlyNote = jest.fn().mockReturnValue(null);
export const getAllYearlyNotes = jest.fn().mockReturnValue({});
