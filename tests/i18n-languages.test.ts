import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_LANGUAGE,
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
    assert.equal(zh.nativeName, "中文");
    assert.equal(zh.englishName, "Chinese");
  });
});
