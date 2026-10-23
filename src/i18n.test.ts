import { _languageMock } from "obsidian";
import {
  getCurrentLanguage,
  messageKeys,
  resetLanguage,
  setLanguage,
  t,
  tPlural,
} from "./i18n";
import { placeholderNames } from "./i18nTemplate";

describe("i18n module", () => {
  afterEach(() => {
    _languageMock.value = "en";
    resetLanguage();
  });

  describe("basic translation", () => {
    it("returns English text by default", () => {
      setLanguage("en");
      expect(t("heading.title")).toBe("Local REST API with MCP");
    });

    it("returns Chinese text when language is set to zh", () => {
      setLanguage("zh");
      expect(t("heading.title")).toBe("本地 REST API（含 MCP）");
    });

    it("ignores invalid language codes", () => {
      setLanguage("en");
      setLanguage("invalid");
      expect(getCurrentLanguage()).toBe("en");
    });
  });

  describe("language detection", () => {
    it("uses Obsidian's configured language", () => {
      _languageMock.value = "zh-CN";
      resetLanguage();
      expect(getCurrentLanguage()).toBe("zh");
    });

    it("falls back to English for other languages", () => {
      _languageMock.value = "fr";
      resetLanguage();
      expect(getCurrentLanguage()).toBe("en");
    });

    it("treats zh-TW as Simplified until a traditional locale exists", () => {
      _languageMock.value = "zh-TW";
      resetLanguage();
      expect(getCurrentLanguage()).toBe("zh");
    });
  });

  describe("placeholder interpolation", () => {
    it("replaces a single placeholder", () => {
      setLanguage("en");
      expect(t("copy.tooltip", { label: "API Key" })).toBe("Copy API Key");
    });

    it("keeps the surrounding text", () => {
      setLanguage("en");
      expect(t("advanced.noWarranty", { licenseLink: "URL" })).toContain(
        "please see URL.",
      );
    });
  });

  describe("plurals", () => {
    it("uses the singular form for one day in English", () => {
      setLanguage("en");
      expect(tPlural("cert.expiresIn", 1)).toBe("Expires in 1 day");
    });

    it("uses the plural form for several days in English", () => {
      setLanguage("en");
      expect(tPlural("cert.expiresIn", 7)).toBe("Expires in 7 days");
      expect(tPlural("status.expiringSoon", 7)).toBe(
        "Your certificate will expire in 7 days!",
      );
    });

    it("does not append an English plural suffix in Chinese", () => {
      setLanguage("zh");
      expect(tPlural("cert.expiresIn", 1)).toBe("将在 1 天后过期");
      expect(tPlural("cert.expiresIn", 7)).toBe("将在 7 天后过期");
      expect(tPlural("status.expiringSoon", 7)).toBe(
        "您的证书将在 7 天后过期！",
      );
    });
  });

  describe("translation tables", () => {
    it("translate every key in both languages", () => {
      expect(messageKeys.length).toBeGreaterThan(0);
      setLanguage("en");
      for (const key of messageKeys) {
        expect(t(key)).not.toBe(key);
      }
      setLanguage("zh");
      for (const key of messageKeys) {
        expect(t(key)).not.toBe(key);
      }
    });

    it("keep the same placeholders in Chinese as in English", () => {
      setLanguage("en");
      const expected = new Map(
        messageKeys.map((key) => [key, placeholderNames(t(key))]),
      );

      setLanguage("zh");
      for (const key of messageKeys) {
        expect(placeholderNames(t(key))).toEqual(expected.get(key));
      }
    });

    it("keep markup out of the dictionaries", () => {
      for (const language of ["en", "zh"] as const) {
        setLanguage(language);
        for (const key of messageKeys) {
          expect(t(key)).not.toMatch(/<[a-z][^>]*>/i);
        }
      }
    });
  });
});
