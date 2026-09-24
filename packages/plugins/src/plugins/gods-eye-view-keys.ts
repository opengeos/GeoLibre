import { getRuntimeEnvironment } from "@geolibre/core";

/**
 * Credentials for the God's Eye View layers that show nothing without one.
 *
 * A key typed into the panel is kept in this browser's `localStorage`, never in
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

export const GODS_EYE_VIEW_KEY_STORAGE_PREFIX = "geolibre.godsEyeView.apiKey.";

export type GodsEyeViewKeySource = "panel" | "environment";

export interface GodsEyeViewResolvedKey {
  key: string;
  source: GodsEyeViewKeySource;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Some embedded webviews throw on access when storage is disabled.
    return null;
  }
}

/** The key typed into the panel for `provider`, or an empty string. */
export function readStoredGodsEyeViewKey(provider: GodsEyeViewKeyProvider): string {
  try {
    return (
      storage()
        ?.getItem(GODS_EYE_VIEW_KEY_STORAGE_PREFIX + provider)
        ?.trim() ?? ""
    );
  } catch {
    return "";
  }
}

/**
 * Store (or, with an empty value, forget) the panel key for `provider`.
 *
 * @returns Whether the value could be persisted.
 */
export function writeStoredGodsEyeViewKey(
  provider: GodsEyeViewKeyProvider,
  value: string,
): boolean {
  const target = storage();
  if (!target) return false;
  try {
    const trimmed = value.trim();
    if (trimmed) target.setItem(GODS_EYE_VIEW_KEY_STORAGE_PREFIX + provider, trimmed);
    else target.removeItem(GODS_EYE_VIEW_KEY_STORAGE_PREFIX + provider);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the key a feed should use: the panel's own entry first, since it is
 * the more specific choice, then the runtime environment.
 *
 * @param provider - The keyed service.
 * @param env - The runtime environment; defaults to the live one.
 * @returns The key and where it came from, or null when none is configured.
 */
export function resolveGodsEyeViewKey(
  provider: GodsEyeViewKeyProvider,
  env: Record<string, string | undefined> = getRuntimeEnvironment(),
): GodsEyeViewResolvedKey | null {
  const stored = readStoredGodsEyeViewKey(provider);
  if (stored) return { key: stored, source: "panel" };
  for (const name of GODS_EYE_VIEW_KEY_ENV_NAMES[provider]) {
    const value = env[name]?.trim();
    if (value) return { key: value, source: "environment" };
  }
  return null;
}
