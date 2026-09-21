import * as fs from "fs";
import * as path from "path";
import {
  t,
  setLanguage,
  resetLanguage,
  getCurrentLanguage,
  type MessageKey,
} from "./i18n";

describe("i18n module", () => {
  afterEach(() => {
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

  });

  describe("placeholder interpolation", () => {
    it("replaces {label} placeholder in copy.tooltip", () => {
      setLanguage("en");
      expect(t("copy.tooltip", { label: "API Key" })).toBe("Copy API Key");
    });

    it("replaces multiple placeholders in copy.success", () => {
      setLanguage("en");
      expect(t("copy.success", { label: "API Key" })).toBe(
        "Copied API Key to clipboard."
      );
    });

    it("replaces {header} placeholder in rest.authHeader", () => {
      setLanguage("en");
      const result = t("rest.authHeader", { header: "Authorization" });
      expect(result).toContain("<code>Authorization</code>");
    });

    it("replaces {days} and {suffix} placeholders in cert.expiresIn", () => {
      setLanguage("en");
      expect(t("cert.expiresIn", { days: 7, suffix: "s" })).toBe(
        "Expires in 7 days"
      );
      expect(t("cert.expiresIn", { days: 1, suffix: "" })).toBe(
        "Expires in 1 day"
      );
    });

    it("replaces {docsLink} placeholder in rest.seeMore", () => {
      setLanguage("en");
      const result = t("rest.seeMore", { docsLink: "https://docs.example.com" });
      expect(result).toContain("https://docs.example.com");
      expect(result).not.toContain("{docsLink}");
    });

    it("replaces {licenseLink} placeholder in advanced.noWarranty", () => {
      setLanguage("en");
      const result = t("advanced.noWarranty", { licenseLink: "https://mit.edu" });
      expect(result).toContain("https://mit.edu");
      expect(result).not.toContain("{licenseLink}");
    });
  });

  describe("language switching", () => {
    it("uses Obsidian's configured language", () => {
      resetLanguage();
      expect(getCurrentLanguage()).toBe("en");
    });

    it("switches to Chinese and back", () => {
      setLanguage("zh");
      expect(getCurrentLanguage()).toBe("zh");
      expect(t("heading.settings")).toBe("设置");

      resetLanguage();
      expect(getCurrentLanguage()).toBe("en");
      expect(t("heading.settings")).toBe("Settings");
    });

    it("ignores invalid language codes", () => {
      setLanguage("en");
      setLanguage("invalid");
      expect(getCurrentLanguage()).toBe("en");
    });
  });

  describe("en/zh key parity", () => {
    it("zh dictionary has all keys from en dictionary", () => {
      // Extract en keys from the source file
      const i18nPath = path.join(__dirname, "i18n.ts");
      const source = fs.readFileSync(i18nPath, "utf8");

      // Parse the en dictionary to extract all keys
      const enKeys = extractKeysFromDictionary(source, "const en = {");

      // All keys must be present in both dictionaries
      expect(enKeys.length).toBeGreaterThan(0);

      // Verify each key exists in zh by testing t() returns Chinese text
      setLanguage("zh");
      for (const key of enKeys) {
        const zhText = t(key as MessageKey);
        // Should not return the key itself (which indicates missing translation)
        expect(zhText).not.toBe(key);
        // Should not be empty
        expect(zhText.length).toBeGreaterThan(0);
      }
    });

    it("en dictionary has all keys from zh dictionary", () => {
      // This is guaranteed at compile-time by the StrMap type,
      // but we verify at runtime too
      setLanguage("en");
      const i18nPath = path.join(__dirname, "i18n.ts");
      const source = fs.readFileSync(i18nPath, "utf8");

      const zhKeys = extractKeysFromDictionary(source, "const zh: StrMap = {");

      for (const key of zhKeys) {
        const enText = t(key as MessageKey);
        expect(enText).not.toBe(key);
        expect(enText.length).toBeGreaterThan(0);
      }
    });
  });

  describe("usage scan - all t() call site keys exist", () => {
    it("every t() call in src/*.ts uses a valid key", () => {
      const srcDir = path.join(__dirname);
      const tsFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"));

      const usedKeys = new Set<string>();

      for (const file of tsFiles) {
        // Skip test files and the i18n module itself
        if (file === "i18n.ts" || file.endsWith(".test.ts")) continue;

        const filePath = path.join(srcDir, file);
        const content = fs.readFileSync(filePath, "utf8");

        // Match t("key") and t("key", { ... }) patterns
        const regex = /\bt\(["']([^"']+)["']/g;
        let match;
        while ((match = regex.exec(content)) !== null) {
          usedKeys.add(match[1]);
        }
      }

      // Verify all used keys exist in en dictionary
      setLanguage("en");
      for (const key of usedKeys) {
        const text = t(key as MessageKey);
        expect(text).not.toBe(key);
        expect(text.length).toBeGreaterThan(0);
      }
    });
  });

  describe("placeholder parity between en and zh", () => {
    it("zh translations have same placeholders as en for all keys with placeholders", () => {
      const i18nPath = path.join(__dirname, "i18n.ts");
      const source = fs.readFileSync(i18nPath, "utf8");

      // Extract placeholder patterns from en dictionary
      const enPlaceholders = extractPlaceholdersFromDictionary(source, "const en = {");

      // Extract placeholder patterns from zh dictionary
      const zhPlaceholders = extractPlaceholdersFromDictionary(source, "const zh: StrMap = {");

      // Verify placeholders match
      for (const [key, placeholders] of Object.entries(enPlaceholders)) {
        const zhPlace = zhPlaceholders[key];
        expect(zhPlace).toBeDefined();
        expect(zhPlace).toEqual(placeholders);
      }
    });
  });
});

// Helper functions for extracting keys and placeholders

function extractKeysFromDictionary(source: string, marker: string): string[] {
  const keys: string[] = [];
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) return keys;

  // Find the closing brace
  let braceCount = 0;
  let dictStart = source.indexOf("{", markerIndex);
  if (dictStart === -1) return keys;

  for (let i = dictStart; i < source.length; i++) {
    if (source[i] === "{") braceCount++;
    if (source[i] === "}") braceCount--;
    if (braceCount === 0) {
      const dictContent = source.slice(dictStart + 1, i);

      // Extract keys - they look like "key": "value" or 'key': 'value'
      const keyRegex = /["']([^"']+)["']\s*:/g;
      let match;
      while ((match = keyRegex.exec(dictContent)) !== null) {
        keys.push(match[1]);
      }
      break;
    }
  }

  return keys;
}

function extractPlaceholdersFromDictionary(
  source: string,
  marker: string
): Record<string, string[]> {
  const placeholders: Record<string, string[]> = {};
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) return placeholders;

  let braceCount = 0;
  let dictStart = source.indexOf("{", markerIndex);
  if (dictStart === -1) return placeholders;

  for (let i = dictStart; i < source.length; i++) {
    if (source[i] === "{") braceCount++;
    if (source[i] === "}") braceCount--;
    if (braceCount === 0) {
      const dictContent = source.slice(dictStart + 1, i);

      // Extract key-value pairs
      const keyValueRegex = /["']([^"']+)["']\s*:\s*["']([^"']*)["']/g;
      let match;
      while ((match = keyValueRegex.exec(dictContent)) !== null) {
        const key = match[1];
        const value = match[2];

        // Extract placeholders from value
        const placeholderRegex = /\{([^}]+)\}/g;
        const keyPlaceholders: string[] = [];
        let placeholderMatch;
        while ((placeholderMatch = placeholderRegex.exec(value)) !== null) {
          keyPlaceholders.push(placeholderMatch[1]);
        }

        if (keyPlaceholders.length > 0) {
          placeholders[key] = keyPlaceholders.sort();
        }
      }
      break;
    }
  }

  return placeholders;
}
