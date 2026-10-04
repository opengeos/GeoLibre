import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PROJECT_PREFERENCES, type ProjectPreferences } from "@geolibre/core";
import type { TFunction } from "i18next";
import type { InstalledLanguagePack } from "../apps/geolibre-desktop/src/lib/language-pack";
import {
  clamp,
  clonePreferences,
  installedPackDetail,
  languagePackHostname,
  normalizeBounds,
  normalizeGeocodingPreferences,
  normalizePreferences,
  roundCoordinate,
  validateEnvironmentVariables,
} from "../apps/geolibre-desktop/src/components/layout/settings/settings-draft";

/** A `t` that echoes the key and its options, so tests can see what was asked for. */
const echoT = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key} ${JSON.stringify(options)}` : key) as unknown as TFunction;

/** An installed-pack record; only `source` and `installedAt` matter here. */
function installedPack(
  source: InstalledLanguagePack["source"],
  installedAt: string,
): InstalledLanguagePack {
  return { locale: "fr", pack: {} as InstalledLanguagePack["pack"], source, installedAt };
}

function preferences(patch: Partial<ProjectPreferences> = {}): ProjectPreferences {
  return {
    ...DEFAULT_PROJECT_PREFERENCES,
    map: { ...DEFAULT_PROJECT_PREFERENCES.map },
    environmentVariables: [],
    geocoding: { ...DEFAULT_PROJECT_PREFERENCES.geocoding, apiKeys: {} },
    ...patch,
  };
}

describe("settings draft helpers", () => {
  it("clamps numbers and treats non-finite values as the minimum", () => {
    assert.equal(clamp(5, 0, 10), 5);
    assert.equal(clamp(-1, 0, 10), 0);
    assert.equal(clamp(11, 0, 10), 10);
    assert.equal(clamp(Number.NaN, 0, 10), 0);
  });

  it("rounds coordinates to six decimals", () => {
    assert.equal(roundCoordinate(12.34567891), 12.345679);
  });

  it("clamps bounds and falls back to the default when they are inverted", () => {
    assert.deepEqual(normalizeBounds([-200, -90, 200, 90]), [-180, -85, 180, 85]);
    assert.deepEqual(normalizeBounds([10, 0, 5, 1]), DEFAULT_PROJECT_PREFERENCES.map.bounds);
  });

  it("normalizes zoom, pitch and environment variables for saving", () => {
    const normalized = normalizePreferences(
      preferences({
        map: { ...DEFAULT_PROJECT_PREFERENCES.map, minZoom: 10, maxZoom: 4, maxPitch: 120 },
        environmentVariables: [
          { key: "  TOKEN ", value: "a", enabled: true, secret: false },
          { key: "   ", value: "dropped", enabled: true },
          { key: "SECRET", value: "b", enabled: false, secret: true },
        ],
      }),
    );
    assert.equal(normalized.map.minZoom, 10);
    assert.equal(normalized.map.maxZoom, 10);
    assert.equal(normalized.map.maxPitch, 85);
    assert.deepEqual(normalized.environmentVariables, [
      { key: "TOKEN", value: "a", enabled: true, secret: false },
      { key: "SECRET", value: "b", enabled: false },
    ]);
  });

  it("keeps only non-empty geocoding keys and drops blank endpoints", () => {
    const geocoding = normalizeGeocodingPreferences({
      providerId: "mapbox",
      apiKeys: { mapbox: " key ", opencage: "  " },
      forwardEndpoint: "  ",
      reverseEndpoint: " https://example.com/reverse ",
      email: "",
    });
    assert.deepEqual(geocoding.apiKeys, { mapbox: "key" });
    assert.equal(geocoding.forwardEndpoint, undefined);
    assert.equal(geocoding.reverseEndpoint, "https://example.com/reverse");
    assert.equal(geocoding.email, undefined);
  });

  it("reports the first invalid or duplicate environment variable name", () => {
    assert.equal(
      validateEnvironmentVariables([
        { key: "A", value: "", enabled: true },
        { key: "", value: "", enabled: true },
      ]),
      null,
    );
    assert.deepEqual(validateEnvironmentVariables([{ key: "1BAD", value: "", enabled: true }]), {
      kind: "pattern",
    });
    assert.deepEqual(
      validateEnvironmentVariables([
        { key: "A", value: "", enabled: true },
        { key: " A ", value: "", enabled: false },
      ]),
      { kind: "duplicate", name: "A" },
    );
  });

  it("gives every cloned environment variable its own draft id", () => {
    const draft = clonePreferences(
      preferences({
        environmentVariables: [
          { key: "A", value: "1", enabled: true },
          { key: "B", value: "2", enabled: true },
        ],
      }),
    );
    const [first, second] = draft.environmentVariables;
    assert.ok(first.id && second.id);
    assert.notEqual(first.id, second.id);
  });

  it("names only the host of a language pack base URL", () => {
    assert.equal(languagePackHostname("https://cdn.example.com/packs/v1"), "cdn.example.com");
    assert.equal(languagePackHostname("not a url"), "not a url");
  });

  it("drops the date from an installed pack with an unparseable timestamp", () => {
    assert.equal(
      installedPackDetail(echoT, "en", installedPack("file", "garbage")),
      'settings.languagePack.installedDetailNoDate {"source":"settings.languagePack.sourceFile"}',
    );
    assert.match(
      installedPackDetail(echoT, "en", installedPack("download", "2026-01-02T00:00:00Z")),
      /^settings\.languagePack\.installedDetail .*sourceOfficial.*2026/,
    );
  });
});
