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
  DEFAULT_DESKTOP_LAYOUT_SETTINGS,
  DEFAULT_THEME_SETTINGS,
  DEFAULT_UI_PROFILE_SETTINGS,
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

/**
 * The settings an interface file sets, down to single fields: a file may set
 * only some of them, and {@link applyInterfaceSettings} leaves the rest as
 * they are. Values are as the file wrote them, and are normalized when they
 * are applied.
 */
export interface InterfaceSettings {
  /** UI language code, or "" to follow automatic detection. */
  language?: string;
  layout?: Partial<DesktopLayoutSettings>;
  theme?: Partial<ThemeSettings>;
  /** Interface profile fields. Never locked: only an administrator locks one. */
  uiProfile?: Partial<UiProfileSettings>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A profile as a file carries it: unlocked, since a lock belongs to the
 * deployment that set it, and onboarded, since importing one is a choice.
 */
function portableUiProfile<T extends Partial<UiProfileSettings>>(profile: T): T {
  return { ...profile, locked: false, onboarded: true };
}

/**
 * The fields of `value` that the settings object `defaults` has, as written.
 *
 * @param value - A raw object from a file.
 * @param defaults - A complete settings object naming the known fields.
 * @returns The known fields `value` sets, or undefined when it sets none.
 */
function knownFields<T extends object>(value: unknown, defaults: T): Partial<T> | undefined {
  if (!isPlainObject(value)) return undefined;
  const fields: Partial<T> = {};
  for (const key of Object.keys(defaults) as (keyof T & string)[]) {
    if (key in value) fields[key] = value[key] as T[keyof T & string];
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
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
 * Read the interface settings out of parsed JSON. Only the fields present are
 * returned, so a file that sets just the hidden plugins leaves the rest of the
 * profile, the layout, and the theme alone.
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
  const settings: InterfaceSettings = {};
  if (typeof value.language === "string") {
    settings.language = normalizeDesktopSettings({ language: value.language }).language;
  }
  const layout = knownFields(value.layout, DEFAULT_DESKTOP_LAYOUT_SETTINGS);
  if (layout) settings.layout = layout;
  const theme = knownFields(value.theme, DEFAULT_THEME_SETTINGS);
  if (theme) settings.theme = theme;
  const uiProfile = knownFields(value.uiProfile, DEFAULT_UI_PROFILE_SETTINGS);
  if (uiProfile) settings.uiProfile = portableUiProfile(uiProfile);
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
  return parseInterfaceFile(await readCappedText(response, MAX_INTERFACE_FILE_CHARS));
}

/**
 * Read a response body as text, refusing it once it passes `maxBytes`, so a
 * server that sends no length (or a false one) cannot stream an unbounded body
 * into memory.
 *
 * @param response - The response to read.
 * @param maxBytes - The most bytes to accept.
 * @returns The body text.
 * @throws Error when the body is larger than `maxBytes`.
 */
async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  const tooLarge = () => new Error("The interface file is too large to be an interface file.");
  if (Number(response.headers.get("content-length")) > maxBytes) throw tooLarge();
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Apply interface settings on top of the current ones, field by field, then
 * normalize the result the way stored settings are. The language is left out:
 * switching it loads a catalog first, so the caller applies it through
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
  return normalizeDesktopSettings({
    ...current,
    layout: { ...current.layout, ...imported.layout },
    theme: { ...current.theme, ...imported.theme },
    uiProfile: { ...current.uiProfile, ...imported.uiProfile },
  });
}
