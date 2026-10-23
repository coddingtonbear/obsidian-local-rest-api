import LocalRestApi from "./main";
import {
  getCurrentLanguage,
  resetLanguage,
  setLanguage,
  t,
} from "./i18n";

describe("settings localization", () => {
  afterEach(() => {
    resetLanguage();
  });

  it.each([
    ["heading.settings", "设置"],
    ["setting.insecureServer", "启用非加密（HTTP）服务器"],
    ["setting.resetCryptoBtn", "重置所有加密"],
  ] as const)("renders %s in Chinese", (key, expected) => {
    setLanguage("zh");

    expect(t(key)).toBe(expected);
  });

  it("uses different anchor text for English and Chinese settings labels", () => {
    setLanguage("en");
    const english = [
      t("heading.settings"),
      t("setting.insecureServer"),
      t("setting.resetCryptoBtn"),
    ];

    setLanguage("zh");
    const chinese = [
      t("heading.settings"),
      t("setting.insecureServer"),
      t("setting.resetCryptoBtn"),
    ];

    expect(english).not.toEqual(chinese);
    expect(chinese).not.toContain("heading.settings");
    expect(chinese).not.toContain("setting.insecureServer");
    expect(chinese).not.toContain("setting.resetCryptoBtn");
  });

  it("can import the settings host module with the minimal Obsidian tab mock", () => {
    expect(LocalRestApi).toBeDefined();
    expect(getCurrentLanguage()).toMatch(/^(en|zh)$/);
  });
});
