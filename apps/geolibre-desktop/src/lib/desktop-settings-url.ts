import { normalizeDesktopSettings, type DesktopSettings } from "../hooks/useDesktopSettings";

export const DESKTOP_SETTINGS_URL_PARAMS = ["settingsUrl", "settingUrl"] as const;

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
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopSettings> {
  const response = await fetchImpl(url, {
    cache: "no-cache",
    credentials: "same-origin",
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
  return normalizeDesktopSettings(parsed);
}
