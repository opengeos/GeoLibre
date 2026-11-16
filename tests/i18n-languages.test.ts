import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_LANGUAGE,
  languageDirection,
  languageOptions,
  resolveLanguage,
} from "../apps/geolibre-desktop/src/i18n/languages";

describe("resolveLanguage", () => {
  const available = ["en", "zh", "pt"];

  it("returns null for empty or unknown input", () => {
    assert.equal(resolveLanguage(null, available), null);
    assert.equal(resolveLanguage("", available), null);
    assert.equal(resolveLanguage("  ", available), null);
    assert.equal(resolveLanguage("xx", available), null);
  });

  it("matches an exact code case-insensitively", () => {
    assert.equal(resolveLanguage("en", available), "en");
    assert.equal(resolveLanguage("ZH", available), "zh");
    assert.equal(resolveLanguage(" Pt ", available), "pt");
  });

  it("falls back to the base subtag of a regional tag", () => {
    assert.equal(resolveLanguage("pt-BR", available), "pt");
    assert.equal(resolveLanguage("en_US", available), "en");
    assert.equal(resolveLanguage("zh-Hans-CN", available), "zh");
  });

  it("routes Traditional Chinese tags to the matching Traditional catalog", () => {
    const traditional = ["en", "zh", "zh-TW", "zh-HK", "zh-MO"];
    assert.equal(resolveLanguage("zh-TW", traditional), "zh-TW");
    assert.equal(resolveLanguage("zh_tw", traditional), "zh-TW");
    assert.equal(resolveLanguage("zh-Hant", traditional), "zh-TW");
    assert.equal(resolveLanguage("zh-Hant-TW", traditional), "zh-TW");
    assert.equal(resolveLanguage("zh-HK", traditional), "zh-HK");
    assert.equal(resolveLanguage("zh-Hant-HK", traditional), "zh-HK");
    assert.equal(resolveLanguage("zh-MO", traditional), "zh-MO");
    assert.equal(resolveLanguage("zh-Hant-MO", traditional), "zh-MO");
    assert.equal(resolveLanguage("zh", traditional), "zh");
    assert.equal(resolveLanguage("zh-CN", traditional), "zh");
    assert.equal(resolveLanguage("zh-Hans-CN", traditional), "zh");
    assert.equal(resolveLanguage("zh-Hans-HK", traditional), "zh");
    assert.equal(resolveLanguage("zh-Hans-TW", traditional), "zh");
    assert.equal(resolveLanguage("zh-SG", traditional), "zh");
  });

  it("ignores extension and private-use subtags when picking the script", () => {
    const traditional = ["en", "zh", "zh-TW", "zh-HK", "zh-MO"];
    assert.equal(resolveLanguage("zh-Hant-HK-u-nu-hans", traditional), "zh-HK");
    assert.equal(resolveLanguage("zh-TW-u-ca-roc", traditional), "zh-TW");
    assert.equal(resolveLanguage("zh-CN-x-hk", traditional), "zh");
    assert.equal(resolveLanguage("zh-x-hant", traditional), "zh");
  });

  it("falls back across Traditional catalogs before Simplified", () => {
    assert.equal(resolveLanguage("zh-MO", ["en", "zh", "zh-HK"]), "zh-HK");
    assert.equal(resolveLanguage("zh-Hant", ["en", "zh", "zh-HK"]), "zh-HK");
    assert.equal(resolveLanguage("zh-HK", ["en", "zh", "zh-TW"]), "zh-TW");
    // Hong Kong and Macau prefer each other over Taiwan.
    assert.equal(resolveLanguage("zh-MO", ["en", "zh", "zh-TW", "zh-HK"]), "zh-HK");
    assert.equal(resolveLanguage("zh-HK", ["en", "zh", "zh-TW", "zh-MO"]), "zh-MO");
    assert.equal(resolveLanguage("zh-Hant", ["en", "zh", "zh-HK", "zh-MO"]), "zh-HK");
  });

  it("falls back to zh for Traditional tags when no Traditional catalog ships", () => {
    assert.equal(resolveLanguage("zh-Hant", available), "zh");
    assert.equal(resolveLanguage("zh-TW", available), "zh");
  });

  it("returns null when only the region differs from an unavailable base", () => {
    assert.equal(resolveLanguage("fr-CA", available), null);
  });
});

describe("languageOptions", () => {
  it("sorts the default language first, then alphabetically by English name", () => {
    // en is pinned first; the rest sort by English name: Chinese < Portuguese.
    const options = languageOptions(["pt", "zh", "en"]);
    assert.deepEqual(
      options.map((option) => option.code),
      ["en", "zh", "pt"],
    );
    assert.equal(options[0].code, DEFAULT_LANGUAGE);
  });

  it("provides friendly names and falls back to the raw code", () => {
    const [, , unknown] = languageOptions(["en", "zh", "xx"]);
    assert.equal(unknown.code, "xx");
    assert.equal(unknown.nativeName, "xx");
    assert.equal(unknown.englishName, "xx");

    const zh = languageOptions(["zh"])[0];
    assert.equal(zh.nativeName, "简体中文");
    assert.equal(zh.englishName, "Chinese (Simplified)");

    const zhTw = languageOptions(["zh-TW"])[0];
    assert.equal(zhTw.nativeName, "繁體中文（台灣）");
    assert.equal(zhTw.englishName, "Chinese (Traditional, Taiwan)");
  });

  it("orders the Chinese variants Simplified first, then Traditional by region", () => {
    const options = languageOptions(["zh-TW", "zh-MO", "zh", "zh-HK", "en"]);
    assert.deepEqual(
      options.map((option) => option.code),
      ["en", "zh", "zh-HK", "zh-MO", "zh-TW"],
    );
  });
});

describe("languageDirection", () => {
  it("marks right-to-left languages as rtl", () => {
    assert.equal(languageDirection("ar"), "rtl");
    assert.equal(languageDirection("he"), "rtl");
    assert.equal(languageDirection("fa"), "rtl");
    assert.equal(languageDirection("ur"), "rtl");
  });

  it("resolves regional tags and casing through the base subtag", () => {
    assert.equal(languageDirection("ar-SA"), "rtl");
    assert.equal(languageDirection("AR_EG"), "rtl");
    assert.equal(languageDirection(" Ar "), "rtl");
    assert.equal(languageDirection("pt-BR"), "ltr");
  });

  it("defaults to ltr for left-to-right, unknown, or empty input", () => {
    assert.equal(languageDirection("en"), "ltr");
    assert.equal(languageDirection("zh"), "ltr");
    assert.equal(languageDirection("xx"), "ltr");
    assert.equal(languageDirection(""), "ltr");
    assert.equal(languageDirection(null), "ltr");
    assert.equal(languageDirection(undefined), "ltr");
  });
});
