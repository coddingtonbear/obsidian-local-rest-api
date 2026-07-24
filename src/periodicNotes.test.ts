import {
  buildPeriodicNoteInterface,
  seedPeriodicNoteSettingsFromExistingPlugins,
} from "./periodicNotes";
import { App, TFile } from "../mocks/obsidian";
import { PeriodicNotePeriodSettings } from "./types";

describe("buildPeriodicNoteInterface", () => {
  let app: App;

  beforeEach(() => {
    app = new App();
  });

  function settings(overrides: Partial<PeriodicNotePeriodSettings> = {}): PeriodicNotePeriodSettings {
    return {
      enabled: true,
      folder: "",
      format: "YYYY-MM-DD",
      template: "",
      ...overrides,
    };
  }

  test("loaded reflects the enabled flag", () => {
    expect(buildPeriodicNoteInterface(app, "daily", settings({ enabled: true })).loaded).toBe(true);
    expect(buildPeriodicNoteInterface(app, "daily", settings({ enabled: false })).loaded).toBe(false);
  });

  test("loaded is false and defaults are used when settings are undefined", () => {
    const iface = buildPeriodicNoteInterface(app, "daily", undefined);
    expect(iface.loaded).toBe(false);
    expect(iface.settings.format).toBe("YYYY-MM-DD");
  });

  test("falls back to the period's default format when format is blank", () => {
    const iface = buildPeriodicNoteInterface(app, "weekly", settings({ format: "" }));
    expect(iface.settings.format).toBe("gggg-[W]ww");
  });

  describe("getAll / get", () => {
    test("finds files at the vault root matching the format when no folder is configured", () => {
      const match = new TFile();
      match.path = "2024-01-15.md";
      match.basename = "2024-01-15";
      const nonMatch = new TFile();
      nonMatch.path = "not-a-date.md";
      nonMatch.basename = "not-a-date";
      app.vault._markdownFiles = [match, nonMatch];

      const iface = buildPeriodicNoteInterface(app, "daily", settings());
      const all = iface.getAll();
      expect(Object.keys(all)).toEqual(["2024-01-15"]);
      expect(all["2024-01-15"]).toBe(match);

      const found = iface.get(window.moment("2024-01-15", "YYYY-MM-DD"), all);
      expect(found).toBe(match);
    });

    test("excludes files inside subfolders when no folder is configured", () => {
      const inSubfolder = new TFile();
      inSubfolder.path = "journal/2024-01-15.md";
      inSubfolder.basename = "2024-01-15";
      app.vault._markdownFiles = [inSubfolder];

      const iface = buildPeriodicNoteInterface(app, "daily", settings());
      expect(iface.getAll()).toEqual({});
    });

    test("only includes files within the configured folder", () => {
      const inFolder = new TFile();
      inFolder.path = "journal/2024-01-15.md";
      inFolder.basename = "2024-01-15";
      const outsideFolder = new TFile();
      outsideFolder.path = "2024-01-16.md";
      outsideFolder.basename = "2024-01-16";
      app.vault._markdownFiles = [inFolder, outsideFolder];

      const iface = buildPeriodicNoteInterface(app, "daily", settings({ folder: "journal" }));
      const all = iface.getAll();
      expect(Object.keys(all)).toEqual(["2024-01-15"]);
    });

    test("excludes files whose basename doesn't strictly match the format", () => {
      const partial = new TFile();
      partial.path = "2024-01.md";
      partial.basename = "2024-01";
      app.vault._markdownFiles = [partial];

      const iface = buildPeriodicNoteInterface(app, "daily", settings({ format: "YYYY-MM-DD" }));
      expect(iface.getAll()).toEqual({});
    });

    test("a format containing '/' matches notes nested in format-derived subfolders", () => {
      // Core Daily Notes supports formats like YYYY/MM/YYYY-MM-DD, where the
      // formatted filename itself spans subfolders under the configured folder.
      const nested = new TFile();
      nested.path = "journal/2024/01/2024-01-15.md";
      nested.basename = "2024-01-15";
      const decoy = new TFile();
      decoy.path = "journal/2024/01/notes.md";
      decoy.basename = "notes";
      app.vault._markdownFiles = [nested, decoy];

      const iface = buildPeriodicNoteInterface(
        app,
        "daily",
        settings({ folder: "journal", format: "YYYY/MM/YYYY-MM-DD" }),
      );
      const all = iface.getAll();
      expect(Object.keys(all)).toEqual(["2024/01/2024-01-15"]);

      const found = iface.get(window.moment("2024-01-15", "YYYY-MM-DD"), all);
      expect(found).toBe(nested);
    });

    test("a format containing '/' works with no folder configured", () => {
      const nested = new TFile();
      nested.path = "2024/01/2024-01-15.md";
      nested.basename = "2024-01-15";
      app.vault._markdownFiles = [nested];

      const iface = buildPeriodicNoteInterface(
        app,
        "daily",
        settings({ format: "YYYY/MM/YYYY-MM-DD" }),
      );
      expect(Object.keys(iface.getAll())).toEqual(["2024/01/2024-01-15"]);
    });
  });

  describe("create", () => {
    test("creates an empty note at the vault root when no template is configured", async () => {
      const iface = buildPeriodicNoteInterface(app, "daily", settings());
      const date = window.moment("2024-01-15", "YYYY-MM-DD");
      const file = await iface.create(date);

      expect(app.vault._create).toEqual(["2024-01-15.md", ""]);
      expect(file.path).toBe("2024-01-15.md");
    });

    test("creates the note inside the configured folder", async () => {
      const iface = buildPeriodicNoteInterface(app, "daily", settings({ folder: "journal" }));
      const date = window.moment("2024-01-15", "YYYY-MM-DD");
      await iface.create(date);

      expect(app.vault._create?.[0]).toBe("journal/2024-01-15.md");
    });

    test("applies {{date}}, {{time}}, and {{title}} template placeholders", async () => {
      const templateFile = new TFile();
      templateFile.path = "templates/daily.md";
      app.vault._getAbstractFileByPath = templateFile;
      app.vault._cachedRead = "# {{title}}\n\nDate: {{date}}\nTime: {{time}}\n";

      const iface = buildPeriodicNoteInterface(
        app,
        "daily",
        settings({ format: "YYYY-MM-DD", template: "templates/daily.md" }),
      );
      const date = window.moment("2024-01-15T09:30:00");
      await iface.create(date);

      const [, content] = app.vault._create;
      expect(content).toContain("# 2024-01-15");
      expect(content).toContain("Date: 2024-01-15");
      expect(content).toContain("Time: 09:30");
    });

    test("a format containing '/' creates the full parent folder chain", async () => {
      // Previously only the configured base folder was ensured, so a
      // format-derived subfolder path (e.g. YYYY/MM/…) made vault.create fail.
      app.vault._getAbstractFileByPath = null; // nothing exists yet
      const iface = buildPeriodicNoteInterface(
        app,
        "daily",
        settings({ folder: "journal", format: "YYYY/MM/YYYY-MM-DD" }),
      );
      const date = window.moment("2024-01-15", "YYYY-MM-DD");
      await iface.create(date);

      expect(app.vault._createdFolders).toEqual(["journal/2024/01"]);
      expect(app.vault._create?.[0]).toBe("journal/2024/01/2024-01-15.md");
    });

    test("a format containing '/' creates parent folders even with no folder configured", async () => {
      app.vault._getAbstractFileByPath = null;
      const iface = buildPeriodicNoteInterface(
        app,
        "daily",
        settings({ format: "YYYY/MM/YYYY-MM-DD" }),
      );
      const date = window.moment("2024-01-15", "YYYY-MM-DD");
      await iface.create(date);

      expect(app.vault._createdFolders).toEqual(["2024/01"]);
      expect(app.vault._create?.[0]).toBe("2024/01/2024-01-15.md");
    });

    test("creates an empty note when the configured template file cannot be found", async () => {
      app.vault._getAbstractFileByPath = null;
      const iface = buildPeriodicNoteInterface(
        app,
        "daily",
        settings({ template: "templates/missing.md" }),
      );
      const date = window.moment("2024-01-15", "YYYY-MM-DD");
      await iface.create(date);

      expect(app.vault._create?.[1]).toBe("");
    });
  });
});

describe("seedPeriodicNoteSettingsFromExistingPlugins", () => {
  let app: App;

  beforeEach(() => {
    app = new App();
  });

  test("returns an empty object when no relevant plugins are installed", () => {
    expect(seedPeriodicNoteSettingsFromExistingPlugins(app)).toEqual({});
  });

  test("seeds daily settings from the core daily-notes plugin when enabled", () => {
    app.internalPlugins.plugins["daily-notes"] = {
      enabled: true,
      instance: { options: { folder: "daily", format: "YYYY-MM-DD", template: "" } },
    };

    const seeded = seedPeriodicNoteSettingsFromExistingPlugins(app);
    expect(seeded.daily).toEqual({
      enabled: true,
      folder: "daily",
      format: "YYYY-MM-DD",
      template: "",
    });
  });

  test("does not seed daily settings when the core plugin is installed but disabled", () => {
    app.internalPlugins.plugins["daily-notes"] = {
      enabled: false,
      instance: { options: { folder: "daily", format: "YYYY-MM-DD", template: "" } },
    };

    expect(seedPeriodicNoteSettingsFromExistingPlugins(app).daily).toBeUndefined();
  });

  test("prefers the periodic-notes plugin's daily settings when its daily period is enabled", () => {
    app.internalPlugins.plugins["daily-notes"] = {
      enabled: true,
      instance: { options: { folder: "core-daily", format: "YYYY-MM-DD", template: "" } },
    };
    app.plugins.plugins["periodic-notes"] = {
      settings: {
        daily: { enabled: true, folder: "pn-daily", format: "YYYY-MM-DD", template: "t.md" },
      },
    };

    const seeded = seedPeriodicNoteSettingsFromExistingPlugins(app);
    expect(seeded.daily?.folder).toBe("pn-daily");
  });

  test("falls back to the core daily-notes plugin when periodic-notes' daily period is not enabled", () => {
    app.internalPlugins.plugins["daily-notes"] = {
      enabled: true,
      instance: { options: { folder: "core-daily", format: "YYYY-MM-DD", template: "" } },
    };
    app.plugins.plugins["periodic-notes"] = {
      settings: {
        daily: { enabled: false, folder: "pn-daily", format: "YYYY-MM-DD", template: "" },
      },
    };

    const seeded = seedPeriodicNoteSettingsFromExistingPlugins(app);
    expect(seeded.daily?.folder).toBe("core-daily");
  });

  test("seeds weekly/monthly/quarterly/yearly from the periodic-notes plugin when enabled", () => {
    app.plugins.plugins["periodic-notes"] = {
      settings: {
        weekly: { enabled: true, folder: "weekly", format: "gggg-[W]ww", template: "" },
        monthly: { enabled: true, folder: "monthly", format: "YYYY-MM", template: "" },
        quarterly: { enabled: false, folder: "quarterly", format: "YYYY-[Q]Q", template: "" },
        // yearly omitted entirely
      },
    };

    const seeded = seedPeriodicNoteSettingsFromExistingPlugins(app);
    expect(seeded.weekly).toEqual({ enabled: true, folder: "weekly", format: "gggg-[W]ww", template: "" });
    expect(seeded.monthly).toEqual({ enabled: true, folder: "monthly", format: "YYYY-MM", template: "" });
    expect(seeded.quarterly).toBeUndefined();
    expect(seeded.yearly).toBeUndefined();
  });

  test("does not throw and skips seeding when plugin internals are malformed", () => {
    // @ts-expect-error intentionally malformed for this test
    app.plugins.plugins["periodic-notes"] = { settings: "not-an-object" };
    // @ts-expect-error intentionally malformed for this test
    app.internalPlugins.plugins["daily-notes"] = "not-an-object";

    expect(() => seedPeriodicNoteSettingsFromExistingPlugins(app)).not.toThrow();
  });
});
