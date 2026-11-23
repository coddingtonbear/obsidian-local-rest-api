import type { App } from "obsidian";

import LocalRestApi, { LocalRestApiSettingTab } from "./main";
import { resetLanguage, setLanguage } from "./i18n";

/**
 * `getSettingDefinitions` reads only `settings` off the plugin, and the tab
 * itself only calls `classList.add` on its container, so this stands in for
 * both without booting Obsidian.
 */
function settingTabUnder(language: "en" | "zh"): LocalRestApiSettingTab {
  setLanguage(language);
  const plugin = { settings: {} } as unknown as LocalRestApi;
  const app = { vault: { configDir: ".obsidian" } } as unknown as App;
  return new LocalRestApiSettingTab(app, plugin);
}

type Definition = {
  name?: string;
  heading?: string;
  items?: Definition[];
};

function collectLabels(items: Definition[]): string[] {
  const labels: string[] = [];
  for (const item of items) {
    if (typeof item.name === "string") labels.push(item.name);
    if (typeof item.heading === "string") labels.push(item.heading);
    if (Array.isArray(item.items)) labels.push(...collectLabels(item.items));
  }
  return labels;
}

function labelsUnder(language: "en" | "zh"): string[] {
  const tab = settingTabUnder(language);
  const definitions = tab.getSettingDefinitions() as unknown as Definition[];
  return collectLabels(definitions);
}

describe("settings localization", () => {
  afterEach(() => {
    resetLanguage();
  });

  it("labels the settings page in Chinese when the language is zh", () => {
    const labels = labelsUnder("zh");

    expect(labels).toContain("服务器状态");
    expect(labels).toContain("API 密钥");
    expect(labels).toContain("设置");
    expect(labels.join("\n")).not.toContain("Server status");
  });

  it("labels the settings page in English when the language is en", () => {
    const labels = labelsUnder("en");

    expect(labels).toContain("Server status");
    expect(labels).toContain("API key");
    expect(labels).toContain("Settings");
  });
});
