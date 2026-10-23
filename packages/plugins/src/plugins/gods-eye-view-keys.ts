import { getRuntimeEnvironment } from "@geolibre/core";
import type { GeoLibrePluginCredentials } from "../types";

/**
 * Credentials for the God's Eye View layers that show nothing without one.
 *
 * A key typed into the panel is kept through `app.credentials` (the OS keychain
 * on desktop, `localStorage` elsewhere), never in
 * the plugin's project state: the `gods-eye-view` settings blob is listed whole
 * in `PUBLISHABLE_PLUGIN_SETTINGS`, so anything stored there is written into
 * every shared or exported project. The runtime environment (Settings →
 * Environment variables, or a build-time `VITE_` key) is the fallback, so a key
 * configured once for the basemap control's TomTom traffic overlay also serves
 * the Street Traffic flow coloring.
 */
export type GodsEyeViewKeyProvider = "tomtom" | "aisstream";

export const GODS_EYE_VIEW_KEY_PROVIDERS: readonly GodsEyeViewKeyProvider[] = [
  "tomtom",
  "aisstream",
];

/** Runtime-env names each provider's key is read from, highest precedence first. */
export const GODS_EYE_VIEW_KEY_ENV_NAMES: Readonly<
  Record<GodsEyeViewKeyProvider, readonly string[]>
> = {
  tomtom: ["VITE_TOMTOM_API_KEY", "TOMTOM_API_KEY"],
  aisstream: ["VITE_AISSTREAM_API_KEY", "AISSTREAM_API_KEY"],
};

export type GodsEyeViewKeySource = "panel" | "environment";

export interface GodsEyeViewResolvedKey {
  key: string;
  source: GodsEyeViewKeySource;
}

/** The key typed into the panel for `provider`, or an empty string. */
export function readStoredGodsEyeViewKey(
  credentials: GeoLibrePluginCredentials | undefined,
  provider: GodsEyeViewKeyProvider,
): string {
  return credentials?.get(provider).trim() ?? "";
}

/**
 * Store (or, with an empty value, forget) the panel key for `provider`.
 *
 * @returns Whether the value was persisted. On false the host still keeps it
 * for this session.
 */
export function writeStoredGodsEyeViewKey(
  credentials: GeoLibrePluginCredentials | undefined,
  provider: GodsEyeViewKeyProvider,
  value: string,
): boolean {
  return credentials ? credentials.set(provider, value.trim()) : false;
}

/**
 * Resolve the key a feed should use: the panel's own entry first, since it is
 * the more specific choice, then the runtime environment.
 *
 * @param credentials - The plugin's `app.credentials`.
 * @param provider - The keyed service.
 * @param env - The runtime environment; defaults to the live one.
 * @returns The key and where it came from, or null when none is configured.
 */
export function resolveGodsEyeViewKey(
  credentials: GeoLibrePluginCredentials | undefined,
  provider: GodsEyeViewKeyProvider,
  env: Record<string, string | undefined> = getRuntimeEnvironment(),
): GodsEyeViewResolvedKey | null {
  const stored = readStoredGodsEyeViewKey(credentials, provider);
  if (stored) return { key: stored, source: "panel" };
  for (const name of GODS_EYE_VIEW_KEY_ENV_NAMES[provider]) {
    const value = env[name]?.trim();
    if (value) return { key: value, source: "environment" };
  }
  return null;
}
