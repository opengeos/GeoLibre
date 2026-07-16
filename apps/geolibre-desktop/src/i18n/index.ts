import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { DESKTOP_SETTINGS_STORAGE_KEY } from "../lib/storage-keys";
import {
  DEFAULT_LANGUAGE,
  languageDirection,
  resolveLanguage,
} from "./languages";

/**
 * Catalogs are auto-discovered: every `locales/<code>.json` is bundled eagerly,
 * so adding a locale is a pure drop-in — no edits to this file. The web build
 * keeps them in the main chunk (catalogs are tiny); see `docs/i18n.md`.
 */
const catalogModules = import.meta.glob<{ default: Record<string, unknown> }>(
  "./locales/*.json",
  { eager: true },
);

const resources: Record<string, { translation: Record<string, unknown> }> = {};
for (const [path, mod] of Object.entries(catalogModules)) {
  const code = path.replace(/^\.\/locales\//, "").replace(/\.json$/, "");
  resources[code] = { translation: mod.default };
}

/** Catalog codes we actually ship, e.g. `["en", "zh"]`. */
export const AVAILABLE_LANGUAGES: string[] = Object.keys(resources).sort();

const QUERY_PARAM_KEYS = ["locale", "lang"];

/**
 * Read the persisted language from the desktop-settings blob in localStorage
 * without importing the settings store (i18n initializes before React, and we
 * want to avoid an import cycle). Returns `null` if absent or unparseable.
 */
function persistedLanguage(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(DESKTOP_SETTINGS_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as { language?: unknown };
    return typeof parsed.language === "string" ? parsed.language : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the initial UI language, in priority order:
 *   1. `?locale=` / `?lang=` query param (for embeds, consistent with `theme`)
 *   2. the language persisted in desktop settings
 *   3. the browser's preferred languages (`navigator.languages`)
 *   4. the default (`en`)
 * Only languages we ship a catalog for are honored; anything else falls through.
 */
export function getInitialLanguage(): string {
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    for (const key of QUERY_PARAM_KEYS) {
      const fromQuery = resolveLanguage(params.get(key), AVAILABLE_LANGUAGES);
      if (fromQuery) return fromQuery;
    }

    const fromSettings = resolveLanguage(
      persistedLanguage(),
      AVAILABLE_LANGUAGES,
    );
    if (fromSettings) return fromSettings;

    const navigatorLanguages =
      typeof navigator !== "undefined"
        ? (navigator.languages ?? [navigator.language])
        : [];
    for (const candidate of navigatorLanguages) {
      const fromNavigator = resolveLanguage(candidate, AVAILABLE_LANGUAGES);
      if (fromNavigator) return fromNavigator;
    }
  }

  return DEFAULT_LANGUAGE;
}

/**
 * Keep the document's `lang`/`dir` attributes in sync with the active
 * language so right-to-left locales (e.g. Arabic) mirror the whole UI.
 * Registered before `init` so the event fired during init already applies
 * the direction on first paint.
 */
function applyDocumentDirection(code: string) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = code;
  document.documentElement.dir = languageDirection(code);
}

i18n.on("languageChanged", applyDocumentDirection);

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: getInitialLanguage(),
    fallbackLng: DEFAULT_LANGUAGE,
    defaultNS: "translation",
    interpolation: {
      // React already escapes rendered values, so i18next double-escaping would
      // mangle any text that legitimately contains `<`, `&`, etc.
      escapeValue: false,
    },
    // Catalogs are bundled eagerly (synchronous), so there is nothing to wait on
    // — skip Suspense and render immediately rather than requiring a boundary.
    react: { useSuspense: false },
    returnNull: false,
    // Eager catalogs make init resolve synchronously today, but surface any error
    // (e.g. if loading ever becomes async) instead of silently swallowing it.
  })
  .catch((error: unknown) => {
    console.error("[GeoLibre] i18n initialization failed", error);
  });

export default i18n;
