import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import i18next from "i18next";

import { installCountFormatting } from "../apps/geolibre-desktop/src/i18n/count-format";

// Runs the hook against the installed i18next, so an upgrade that moves or
// renames `services.interpolator.format` fails here rather than silently
// dropping the digit grouping from every count in the app.

const resources = {
  en: {
    translation: {
      features_one: "{{count}} feature",
      features_other: "{{count}} features",
      ofTotal: "{{count}} of {{total}} features",
      version: "Version {{year}}",
      explicit: "{{value, number}}",
      label: "{{count}} — {{name}}",
    },
  },
  de: { translation: { features_one: "{{count}} Objekt", features_other: "{{count}} Objekte" } },
  fr: { translation: { features_one: "{{count}} entité", features_other: "{{count}} entités" } },
  hi: { translation: { features_other: "{{count}} फ़ीचर" } },
  ar: {
    translation: {
      features_zero: "لا عناصر",
      features_one: "عنصر واحد",
      features_two: "عنصران",
      features_few: "{{count}} عناصر",
      features_many: "{{count}} عنصرًا",
      features_other: "{{count}} عنصر",
    },
  },
};

async function makeI18n(alwaysFormat = true) {
  const i18n = i18next.createInstance();
  await i18n.init({
    resources,
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false, alwaysFormat },
  });
  return i18n;
}

describe("installCountFormatting", () => {
  it("hooks the installed i18next", async () => {
    const i18n = await makeI18n();
    assert.equal(installCountFormatting(i18n), true);
  });

  it("groups count digits by the active locale and keeps plurals", async () => {
    const i18n = await makeI18n();
    installCountFormatting(i18n);
    assert.equal(i18n.t("features", { count: 1284 }), "1,284 features");
    assert.equal(i18n.t("features", { count: 1 }), "1 feature");
    assert.equal(i18n.t("features", { count: 0 }), "0 features");
    assert.equal(i18n.t("features", { count: 999 }), "999 features");
    assert.equal(i18n.t("features", { lng: "de", count: 1284 }), "1.284 Objekte");
    assert.equal(i18n.t("features", { lng: "de", count: 1 }), "1 Objekt");
    // French groups with a narrow no-break space.
    assert.equal(i18n.t("features", { lng: "fr", count: 1284 }), "1 284 entités");
    assert.equal(i18n.t("features", { lng: "hi", count: 1234567 }), "12,34,567 फ़ीचर");
  });

  it("follows changeLanguage", async () => {
    const i18n = await makeI18n();
    installCountFormatting(i18n);
    await i18n.changeLanguage("de");
    assert.equal(i18n.t("features", { count: 25000 }), "25.000 Objekte");
  });

  it("formats Arabic counts with the locale's own digits and plural forms", async () => {
    const i18n = await makeI18n();
    installCountFormatting(i18n);
    const expected = new Intl.NumberFormat("ar").format(1284);
    // 1,284 takes the "many" form (n % 100 in 11–99).
    assert.equal(i18n.t("features", { lng: "ar", count: 1284 }), `${expected} عنصرًا`);
    assert.equal(i18n.t("features", { lng: "ar", count: 1200 }).endsWith("عنصر"), true);
    assert.equal(i18n.t("features", { lng: "ar", count: 2 }), "عنصران");
  });

  it("formats total as well as count", async () => {
    const i18n = await makeI18n();
    installCountFormatting(i18n);
    assert.equal(i18n.t("ofTotal", { count: 1200, total: 50000 }), "1,200 of 50,000 features");
  });

  it("leaves numbers under other keys, strings and explicit formats alone", async () => {
    const i18n = await makeI18n();
    installCountFormatting(i18n);
    assert.equal(i18n.t("version", { year: 2026 }), "Version 2026");
    // A pre-formatted string count passes through untouched.
    assert.equal(i18n.t("label", { count: "1,284", name: "x" }), "1,284 — x");
    assert.equal(i18n.t("explicit", { value: 1234.5 }), "1,234.5");
    assert.equal(i18n.t("features", { count: Number.NaN }), "NaN features");
  });

  it("falls back to the plain number for a locale Intl rejects", async () => {
    const i18n = await makeI18n();
    installCountFormatting(i18n);
    const interpolator = i18n.services.interpolator as unknown as {
      format: (...args: unknown[]) => unknown;
    };
    const format = interpolator.format.bind(interpolator);
    assert.equal(format(1284, undefined, "not a locale!", { interpolationkey: "count" }), 1284);
  });

  it("does nothing without alwaysFormat", async () => {
    const i18n = await makeI18n(false);
    installCountFormatting(i18n);
    assert.equal(i18n.t("features", { count: 1284 }), "1284 features");
  });

  it("is enabled in the app's i18n setup", () => {
    const source = readFileSync(
      new URL("../apps/geolibre-desktop/src/i18n/index.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /alwaysFormat: true/);
    assert.match(source, /installCountFormatting\(i18n\)/);
  });
});
