// eslint-disable-next-line no-restricted-imports -- Moment type is not re-exported by 'obsidian'; import type causes no runtime bundling
import type { Moment } from "moment";
import { App, normalizePath, TFile } from "obsidian";
import {
  PeriodicNoteInterface,
  PeriodicNotePeriod,
  PeriodicNotePeriodSettings,
} from "./types";

export const PERIOD_DEFAULT_FORMAT: Record<PeriodicNotePeriod, string> = {
  daily: "YYYY-MM-DD",
  weekly: "gggg-[W]ww",
  monthly: "YYYY-MM",
  quarterly: "YYYY-[Q]Q",
  yearly: "YYYY",
};

export const DEFAULT_PERIODIC_NOTE_SETTINGS: PeriodicNotePeriodSettings = {
  folder: "",
  format: "",
  template: "",
};

function applyTemplate(
  templateContent: string,
  date: Moment,
  format: string,
  title: string,
): string {
  return templateContent
    .replace(/{{\s*date\s*}}/gi, date.format(format))
    .replace(/{{\s*time\s*}}/gi, date.format("HH:mm"))
    .replace(/{{\s*title\s*}}/gi, title);
}

export function buildPeriodicNoteInterface(
  app: App,
  period: PeriodicNotePeriod,
  settings: PeriodicNotePeriodSettings | undefined,
): PeriodicNoteInterface {
  const format = settings?.format?.trim() || PERIOD_DEFAULT_FORMAT[period];
  const folder = settings?.folder?.trim() ?? "";
  const template = settings?.template?.trim() ?? "";
  const folderPath = folder ? normalizePath(folder) : "";

  // A format may itself contain "/" (e.g. YYYY/MM/YYYY-MM-DD), in which case
  // the formatted filename spans subfolders and must be matched against the
  // file's folder-relative path rather than its basename.
  const formatSpansFolders = format.includes("/");

  const getAll = (): Record<string, TFile> => {
    const notes: Record<string, TFile> = {};
    const folderPrefix = folderPath ? `${folderPath}/` : "";
    for (const file of app.vault.getMarkdownFiles()) {
      let candidate: string;
      if (formatSpansFolders) {
        if (folderPrefix && !file.path.startsWith(folderPrefix)) continue;
        candidate = file.path
          .slice(folderPrefix.length)
          .replace(/\.md$/, "");
      } else {
        if (folderPrefix) {
          if (!file.path.startsWith(folderPrefix)) continue;
        } else if (file.path.includes("/")) {
          continue;
        }
        candidate = file.basename;
      }
      const parsed = window.moment(candidate, format, true);
      if (!parsed.isValid()) continue;
      notes[parsed.format(format)] = file;
    }
    return notes;
  };

  return {
    settings: { folder, format, template },
    getAll,
    get: (date: Moment, all: Record<string, TFile>) => all[date.format(format)],
    create: async (date: Moment): Promise<TFile> => {
      const filename = date.format(format);
      const path = normalizePath(
        `${folderPath ? folderPath + "/" : ""}${filename}.md`,
      );

      // Ensure the parent folder chain of the full note path — not just the
      // configured base folder — since the formatted filename may itself
      // contain "/" segments. createFolder creates intermediate folders.
      const parentDir = path.split("/").slice(0, -1).join("/");
      if (parentDir && !app.vault.getAbstractFileByPath(parentDir)) {
        await app.vault.createFolder(parentDir);
      }

      let content = "";
      if (template) {
        const templateFile = app.vault.getAbstractFileByPath(
          normalizePath(template),
        );
        if (templateFile instanceof TFile) {
          const templateContent = await app.vault.cachedRead(templateFile);
          content = applyTemplate(templateContent, date, format, filename);
        }
      }

      return app.vault.create(path, content);
    },
  };
}

type RawPeriodSettings = {
  enabled?: boolean;
  folder?: string;
  format?: string;
  template?: string;
};

function toPeriodicNotePeriodSettings(raw: RawPeriodSettings): PeriodicNotePeriodSettings {
  return {
    folder: raw.folder?.trim() ?? "",
    format: raw.format?.trim() ?? "",
    template: raw.template?.trim() ?? "",
  };
}

/**
 * Best-effort, one-time migration of existing Daily Notes (core) / Periodic
 * Notes (community) plugin configuration into our own native settings, so
 * upgrading users don't lose their periodic-note configuration. Reads
 * undocumented plugin internals defensively — any unexpected shape is
 * skipped rather than thrown, leaving that period unseeded (falling back
 * to the built-in defaults) rather than risk seeding a bad value. Runs at
 * most once per vault (callers should only invoke this when
 * `settings.periodicNotes` is not yet set).
 *
 * Known gap: weekly notes configured only via the legacy "Calendar" plugin
 * (not the "Periodic Notes" plugin) are not migrated — reading a third
 * undocumented plugin's internals for this one legacy path was judged not
 * worth it. Users in that situation will need to configure weekly notes
 * manually after upgrading.
 */
export function seedPeriodicNoteSettingsFromExistingPlugins(
  app: App,
): Partial<Record<PeriodicNotePeriod, PeriodicNotePeriodSettings>> {
  const seeded: Partial<Record<PeriodicNotePeriod, PeriodicNotePeriodSettings>> = {};

  let periodicNotesSettings: Record<string, RawPeriodSettings> | undefined;
  try {
    const periodicNotesPlugin = app.plugins.getPlugin("periodic-notes");
    periodicNotesSettings = periodicNotesPlugin?.settings;
  } catch (e) {
    console.warn("[REST API] Failed to read existing periodic-notes plugin settings for migration", e);
  }

  try {
    if (periodicNotesSettings?.daily?.enabled) {
      seeded.daily = toPeriodicNotePeriodSettings(periodicNotesSettings.daily);
    } else if (app.internalPlugins.plugins["daily-notes"]?.enabled) {
      const options = app.internalPlugins.getPluginById("daily-notes")?.instance?.options as
        | RawPeriodSettings
        | undefined;
      if (options) {
        seeded.daily = toPeriodicNotePeriodSettings(options);
      }
    }
  } catch (e) {
    console.warn("[REST API] Failed to read existing daily note settings for migration", e);
  }

  for (const period of ["weekly", "monthly", "quarterly", "yearly"] as const) {
    try {
      const raw = periodicNotesSettings?.[period];
      if (raw?.enabled) {
        seeded[period] = toPeriodicNotePeriodSettings(raw);
      }
    } catch (e) {
      console.warn(`[REST API] Failed to read existing "${period}" periodic note settings for migration`, e);
    }
  }

  return seeded;
}
