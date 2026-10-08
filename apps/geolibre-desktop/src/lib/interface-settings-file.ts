/**
 * Interface files (Settings → Interface → Export and Import): the language,
 * panel layout, accent theme and interface profile, so one setup can be copied
 * to other machines or handed to a team.
 *
 * The file holds exactly the presentation fields a `?settingsUrl=` link loads
 * (see `desktop-settings-url.ts`), so an exported file also works as that link's
 * target. Like that link, it can never carry credentials, plugin sources, or
 * local paths.
 */

import {
  normalizeDesktopSettings,
  type DesktopLayoutSettings,
  type DesktopSettings,
  type ThemeSettings,
  type UiProfileSettings,
} from "../hooks/useDesktopSettings";

/** `type` tag identifying an interface file. */
export const INTERFACE_FILE_TYPE = "geolibre-interface";

/** Format version written by {@link serializeInterfaceFile}. */
export const INTERFACE_FILE_VERSION = 1;

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * Size ceiling for an interface file, in characters. A real one is a few
 * kilobytes, so anything past this is not one, and is refused before parsing.
 */
export const MAX_INTERFACE_FILE_CHARS = 256 * 1024;

/** The settings an interface file sets. A file may set only some of them. */
export interface InterfaceSettings {
  /** UI language code, or "" to follow automatic detection. */
  language?: string;
  layout?: DesktopLayoutSettings;
  theme?: ThemeSettings;
  /** The interface profile. Never locked: only an administrator locks one. */
  uiProfile?: UiProfileSettings;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A profile as a file carries it: unlocked, since a lock belongs to the
 * deployment that set it, and onboarded, since importing one is a choice.
 */
function portableUiProfile(profile: UiProfileSettings): UiProfileSettings {
  return { ...profile, locked: false, onboarded: true };
}

/**
 * Serialize the interface settings of `settings` into an interface file.
 *
 * @param settings - The desktop settings to export from.
 * @returns Pretty-printed file content.
 */
export function serializeInterfaceFile(settings: DesktopSettings): string {
  return JSON.stringify(
    {
      type: INTERFACE_FILE_TYPE,
      version: INTERFACE_FILE_VERSION,
      language: settings.language,
      layout: settings.layout,
      theme: settings.theme,
      uiProfile: portableUiProfile(settings.uiProfile),
    },
    null,
    2,
  );
}

/**
 * Read the interface settings out of parsed JSON. Only the keys present are
 * returned, each normalized the way stored settings are, so a file that sets
 * just the profile leaves the layout and theme alone.
 *
 * A file without a `type` is accepted as long as it sets one of the keys, so a
 * hand-written `?settingsUrl=` file can be imported too.
 *
 * @param value - The parsed file.
 * @returns The settings the file sets.
 * @throws Error when the value is not an interface file, comes from a newer
 *   format version, or sets nothing.
 */
export function readInterfaceSettings(value: unknown): InterfaceSettings {
  if (!isPlainObject(value)) throw new Error("Not a valid interface file.");
  if (value.type !== undefined) {
    if (value.type !== INTERFACE_FILE_TYPE) throw new Error("Not a valid interface file.");
    if (value.version !== INTERFACE_FILE_VERSION) {
      throw new Error("Unsupported interface file version.");
    }
  }
  const normalized = normalizeDesktopSettings({
    language: value.language,
    layout: value.layout,
    theme: value.theme,
    uiProfile: value.uiProfile,
  });
  const settings: InterfaceSettings = {};
  if (typeof value.language === "string") settings.language = normalized.language;
  if (isPlainObject(value.layout)) settings.layout = normalized.layout;
  if (isPlainObject(value.theme)) settings.theme = normalized.theme;
  if (isPlainObject(value.uiProfile)) settings.uiProfile = portableUiProfile(normalized.uiProfile);
  if (Object.keys(settings).length === 0) {
    throw new Error("The interface file sets no interface settings.");
  }
  return settings;
}

/**
 * Parse an interface file's text.
 *
 * @param json - The file content.
 * @returns The settings the file sets.
 * @throws Error when the content is too large, not valid JSON, or not an
 *   interface file.
 */
export function parseInterfaceFile(json: string): InterfaceSettings {
  if (json.length > MAX_INTERFACE_FILE_CHARS) {
    throw new Error("The interface file is too large to be an interface file.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Not a valid interface file (invalid JSON).");
  }
  return readInterfaceSettings(parsed);
}

/**
 * Fetch and parse an interface file from a URL.
 *
 * @param url - An http(s) URL.
 * @param options - An optional fetch implementation and timeout, for tests.
 * @returns The settings the file sets.
 * @throws Error when the URL is not http(s), the request fails, or the
 *   response is not an interface file.
 */
export async function fetchInterfaceFile(
  url: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<InterfaceSettings> {
  const { fetchImpl = fetch, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = options;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url.trim());
  } catch {
    throw new Error("Enter a valid http(s) URL.");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("Enter a valid http(s) URL.");
  }
  const response = await fetchImpl(parsedUrl.href, {
    cache: "no-cache",
    credentials: "same-origin",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Could not load the interface file (HTTP ${response.status}).`);
  }
  // Refuse a declared oversize body before reading it; the parser's own check
  // still covers a server that sends no length.
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_INTERFACE_FILE_CHARS * 4) {
    throw new Error("The interface file is too large to be an interface file.");
  }
  return parseInterfaceFile(await response.text());
}

/**
 * Apply interface settings on top of the current ones. The language is left
 * out: switching it loads a catalog first, so the caller applies it through
 * `useLanguage`.
 *
 * @param current - The current desktop settings.
 * @param imported - The settings to apply.
 * @returns The updated desktop settings.
 */
export function applyInterfaceSettings(
  current: DesktopSettings,
  imported: InterfaceSettings,
): DesktopSettings {
  return {
    ...current,
    ...(imported.layout ? { layout: imported.layout } : {}),
    ...(imported.theme ? { theme: imported.theme } : {}),
    ...(imported.uiProfile ? { uiProfile: imported.uiProfile } : {}),
  };
}
