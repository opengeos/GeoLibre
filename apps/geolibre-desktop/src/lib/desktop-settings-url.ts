import { normalizeDesktopSettings, type DesktopSettings } from "../hooks/useDesktopSettings";
import { resolveLanguage } from "../i18n/languages";

export const DESKTOP_SETTINGS_URL_PARAMS = ["settingsUrl", "settingUrl"] as const;
const LANGUAGE_URL_PARAMS = ["locale", "lang"] as const;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * Keep URL-controlled settings limited to presentation. In particular, a
 * shared link must never supply credentials, plugin sources, or local paths.
 */
export function normalizeSharedDesktopSettings(settings: Record<string, unknown>): DesktopSettings {
  return normalizeDesktopSettings({
    language: settings.language,
    layout: settings.layout,
    theme: settings.theme,
    uiProfile: settings.uiProfile,
  });
}

export function desktopSettingsUrl(search: string): string | null {
  const params = new URLSearchParams(search);
  for (const name of DESKTOP_SETTINGS_URL_PARAMS) {
    const value = params.get(name)?.trim();
    if (value) return value;
  }
  return null;
}

export async function fetchDesktopSettings(
  url: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<DesktopSettings> {
  const { fetchImpl = fetch, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = options;
  const response = await fetchImpl(url, {
    cache: "no-cache",
    credentials: "same-origin",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const status = response.statusText
      ? `${response.status} ${response.statusText}`
      : String(response.status);
    throw new Error(`Could not load desktop settings from ${url} (HTTP ${status}).`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text()) as unknown;
  } catch (error) {
    throw new Error(`Desktop settings at ${url} are not valid JSON.`, {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Desktop settings at ${url} must be a JSON object.`);
  }
  return normalizeSharedDesktopSettings(parsed as Record<string, unknown>);
}

/** Resolve a shared language only when a valid locale/lang URL override is absent. */
export function sharedSettingsLanguage(
  search: string,
  language: string,
  availableLanguages: readonly string[],
): string | null {
  const params = new URLSearchParams(search);
  for (const name of LANGUAGE_URL_PARAMS) {
    if (resolveLanguage(params.get(name), availableLanguages)) return null;
  }
  return resolveLanguage(language, availableLanguages);
}
