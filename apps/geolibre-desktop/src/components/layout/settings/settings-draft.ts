/**
 * The Settings dialog's draft model: the editable copies of the project
 * preferences and desktop settings the dialog works on, plus the pure helpers
 * that seed them when the dialog opens and normalize them on Save.
 *
 * Kept free of React so the helpers can be unit-tested directly.
 */
import { migrateMapboxTokenSettings } from "../../../lib/mapbox-token-settings";
import {
  DEFAULT_PROJECT_PREFERENCES,
  normalizeGeocodingProviderId,
  type MapPreferences,
  type ProjectPreferences,
  type RuntimeEnvironmentVariable,
} from "@geolibre/core";
import type { TFunction } from "i18next";
import type {
  DesktopSettings,
  DesktopLayoutSettings,
  UiProfileSettings,
  UpdateSettings,
  StartupSettings,
} from "../../../hooks/useDesktopSettings";
import type { InstalledLanguagePack } from "../../../lib/language-pack";
import type { AssistantProfile } from "../../../lib/assistant/provider";
import type { S3Connection } from "../../../lib/s3-connections";

/** A plugin offered as a visibility toggle in the Interface section. */
export interface ProfilePlugin {
  id: string;
  name: string;
}

export const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Draft env vars carry a stable client-side id so React can key the rows by
// identity. Keying by array index reuses input DOM state (focus, cursor)
// across the wrong item after a mid-list delete.
export interface DraftEnvironmentVariable extends RuntimeEnvironmentVariable {
  id: string;
}

export interface DraftPreferences {
  map: MapPreferences;
  environmentVariables: DraftEnvironmentVariable[];
  geocoding: ProjectPreferences["geocoding"];
}

export interface DraftDesktopSettings {
  layout: DesktopLayoutSettings;
  shareToken: string;
  cesiumIonToken: string;
  mapboxAccessToken: string;
  arcgisApiKey: string;
  aiProfiles: AssistantProfile[];
  defaultAiProfileId: string | null;
  s3Connections: S3Connection[];
  s3DefaultLocation: string;
  uiProfile: UiProfileSettings;
  updates: UpdateSettings;
  startup: StartupSettings;
}

/**
 * The bare host to name in the privacy notice. A configured base URL may carry a
 * scheme and a path (a self-hosted mirror often does); the notice only needs to
 * say which host the locale code is sent to.
 *
 * Args:
 *   baseUrl: The configured language-pack base URL.
 *
 * Returns:
 *   The URL's host, or `baseUrl` unchanged when it does not parse as a URL.
 */
export function languagePackHostname(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * The "installed from X on Y" line for an installed language pack.
 *
 * `installedAt` comes back from IndexedDB, which the i18n layer already treats
 * as untrusted for the pack payload; the record's own timestamp gets the same
 * treatment here. `Intl.DateTimeFormat.prototype.format` throws a `RangeError`
 * on an invalid `Date`, and this renders inside the dialog, so an unparseable
 * timestamp would take the whole Settings pane down. Drop the date instead.
 *
 * Args:
 *   t: The i18next translate function.
 *   language: The active UI language, used to format the date.
 *   installed: The installed pack record.
 *
 * Returns:
 *   The translated detail line.
 */
export function installedPackDetail(
  t: TFunction,
  language: string,
  installed: InstalledLanguagePack,
): string {
  const source =
    installed.source === "download"
      ? t("settings.languagePack.sourceOfficial")
      : t("settings.languagePack.sourceFile");
  const installedAt = new Date(installed.installedAt);
  if (Number.isNaN(installedAt.getTime())) {
    return t("settings.languagePack.installedDetailNoDate", { source });
  }
  return t("settings.languagePack.installedDetail", {
    source,
    date: new Intl.DateTimeFormat(language, { dateStyle: "medium" }).format(installedAt),
  });
}

/**
 * A fresh client-side id for a draft row.
 *
 * Returns:
 *   A UUID when `crypto.randomUUID` exists, otherwise a time-and-random string.
 */
export function createDraftId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Seed the draft preferences from the project preferences.
 *
 * Args:
 *   preferences: The project preferences (with stored credentials filled in).
 *
 * Returns:
 *   A deep-enough copy the dialog can edit without touching the store.
 */
export function clonePreferences(preferences: ProjectPreferences): DraftPreferences {
  return {
    map: { ...preferences.map },
    environmentVariables: migrateMapboxTokenSettings(
      preferences.environmentVariables,
    ).variables.map((variable) => ({
      ...variable,
      id: createDraftId(),
    })),
    geocoding: {
      ...preferences.geocoding,
      apiKeys: { ...preferences.geocoding.apiKeys },
    },
  };
}

/**
 * Seed the draft desktop settings from the saved desktop settings.
 *
 * Args:
 *   settings: The saved desktop settings.
 *   preferences: The project preferences, read for a legacy Mapbox token row.
 *
 * Returns:
 *   A copy the dialog can edit without touching the store.
 */
export function cloneDesktopSettings(
  settings: DesktopSettings,
  preferences: ProjectPreferences,
): DraftDesktopSettings {
  return {
    layout: { ...settings.layout },
    shareToken: settings.shareToken,
    cesiumIonToken: settings.cesiumIonToken,
    mapboxAccessToken: migrateMapboxTokenSettings(
      preferences.environmentVariables,
      settings.mapboxAccessToken,
    ).token,
    arcgisApiKey: settings.arcgisApiKey,
    aiProfiles: settings.aiProfiles.map((p) => ({
      ...p,
      fieldValues: { ...p.fieldValues },
    })),
    defaultAiProfileId: settings.defaultAiProfileId,
    s3Connections: settings.s3Connections.map((connection) => ({
      ...connection,
      buckets: [...connection.buckets],
    })),
    s3DefaultLocation: settings.s3DefaultLocation,
    uiProfile: {
      ...settings.uiProfile,
      hiddenDataSources: [...settings.uiProfile.hiddenDataSources],
      hiddenPlugins: [...settings.uiProfile.hiddenPlugins],
      hiddenMenus: [...settings.uiProfile.hiddenMenus],
      hiddenMenuItems: [...settings.uiProfile.hiddenMenuItems],
    },
    updates: { ...settings.updates },
    startup: { ...settings.startup, center: [...settings.startup.center] },
  };
}

/**
 * Clamp map bounds to valid ranges, falling back to the default bounds when the
 * result is empty or inverted.
 *
 * Args:
 *   bounds: `[west, south, east, north]` in degrees.
 *
 * Returns:
 *   The clamped bounds, or the default bounds.
 */
export function normalizeBounds(bounds: MapPreferences["bounds"]): MapPreferences["bounds"] {
  const west = clamp(bounds[0], -180, 180);
  const south = clamp(bounds[1], -85, 85);
  const east = clamp(bounds[2], -180, 180);
  const north = clamp(bounds[3], -85, 85);
  if (west >= east || south >= north) {
    return DEFAULT_PROJECT_PREFERENCES.map.bounds;
  }

  return [west, south, east, north];
}

/**
 * Clamp `value` to `[min, max]`; a non-finite value becomes `min`.
 *
 * Args:
 *   value: The number to clamp.
 *   min: The lower bound.
 *   max: The upper bound.
 *
 * Returns:
 *   The clamped number.
 */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Round a coordinate to six decimal places (about 0.1 m).
 *
 * Args:
 *   value: The coordinate in degrees.
 *
 * Returns:
 *   The rounded coordinate.
 */
export function roundCoordinate(value: number): number {
  return Number(value.toFixed(6));
}

/**
 * Normalize draft preferences for saving: clamp the map constraints, trim and
 * drop blank environment variables, and tidy the geocoding settings.
 *
 * Args:
 *   preferences: The draft preferences.
 *
 * Returns:
 *   The preferences to commit to the project store.
 */
export function normalizePreferences(preferences: ProjectPreferences): ProjectPreferences {
  const minZoom = clamp(preferences.map.minZoom, 0, 24);
  const maxZoom = Math.max(minZoom, clamp(preferences.map.maxZoom, 0, 24));
  return {
    map: {
      ...preferences.map,
      bounds: normalizeBounds(preferences.map.bounds),
      minZoom,
      maxZoom,
      maxPitch: clamp(preferences.map.maxPitch, 0, 85),
    },
    environmentVariables: preferences.environmentVariables
      .map((variable) => ({
        key: variable.key.trim(),
        value: variable.value,
        enabled: variable.enabled,
        ...(variable.secret === false ? { secret: false } : {}),
      }))
      .filter((variable) => variable.key.length > 0),
    geocoding: normalizeGeocodingPreferences(preferences.geocoding),
  };
}

/**
 * Normalize the geocoding preferences for saving.
 *
 * Args:
 *   geocoding: The draft geocoding preferences.
 *
 * Returns:
 *   The preferences with a known provider id, only non-empty API keys, and
 *   blank optional fields dropped.
 */
export function normalizeGeocodingPreferences(
  geocoding: ProjectPreferences["geocoding"],
): ProjectPreferences["geocoding"] {
  const providerId = normalizeGeocodingProviderId(geocoding.providerId);
  // Keep only non-empty keys so the saved project does not carry blank entries.
  const apiKeys: Record<string, string> = {};
  for (const [id, key] of Object.entries(geocoding.apiKeys)) {
    if (key.trim()) apiKeys[id] = key.trim();
  }
  return {
    providerId,
    apiKeys,
    forwardEndpoint: geocoding.forwardEndpoint?.trim() || undefined,
    reverseEndpoint: geocoding.reverseEndpoint?.trim() || undefined,
    email: geocoding.email?.trim() || undefined,
  };
}

// Returned as a code (not a message) so the user-facing string is resolved
// through i18n at the call site, where `t` is in scope.
export type EnvironmentValidationError = { kind: "pattern" } | { kind: "duplicate"; name: string };

/**
 * Check environment variable names: each must be a valid identifier and unique.
 * Blank names are skipped (they are dropped on save).
 *
 * Args:
 *   variables: The variables to check.
 *
 * Returns:
 *   The first problem found, or null when every name is valid.
 */
export function validateEnvironmentVariables(
  variables: RuntimeEnvironmentVariable[],
): EnvironmentValidationError | null {
  const keys = new Set<string>();

  for (const variable of variables) {
    const key = variable.key.trim();
    if (!key) continue;
    if (!VARIABLE_NAME_PATTERN.test(key)) {
      return { kind: "pattern" };
    }
    if (keys.has(key)) {
      return { kind: "duplicate", name: key };
    }
    keys.add(key);
  }

  return null;
}
