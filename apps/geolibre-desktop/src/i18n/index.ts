import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { DESKTOP_SETTINGS_STORAGE_KEY } from "../lib/storage-keys";
import {
  fetchLanguagePack,
  LanguagePackError,
  parseLanguagePack,
  type GeoLibreLanguagePack,
  type InstalledLanguagePack,
  type LanguagePackSource,
} from "../lib/language-pack";
import {
  deleteInstalledLanguagePack,
  loadInstalledLanguagePack,
  saveInstalledLanguagePack,
} from "../lib/language-pack-store";
import { DEFAULT_LANGUAGE, languageDirection, resolveLanguage } from "./languages";
import enTranslation from "./locales/en.json";

/**
 * English is the fallback baseline (and the source of truth `i18next.d.ts` types
 * `t()` against), so it is bundled statically — always present and synchronous.
 * Every *other* locale is a separate lazily-imported chunk, fetched only when it
 * becomes the active language: fully translated, the 15 non-English catalogs run
 * to several MB and must not ship in the boot graph. The service worker keeps
 * these chunks out of the app-shell precache and CacheFirst-caches each on first
 * use (see `vite.config.ts`); `docs/i18n.md` has the details.
 */
const localeLoaders = import.meta.glob<{ default: Record<string, unknown> }>([
  "./locales/*.json",
  "!./locales/en.json",
]);

/** Non-English catalog code → dynamic-import loader for its chunk. */
const loaders: Record<string, () => Promise<{ default: Record<string, unknown> }>> = {};
for (const [path, loader] of Object.entries(localeLoaders)) {
  const code = path.replace(/^\.\/locales\//, "").replace(/\.json$/, "");
  loaders[code] = loader;
}

/** Catalog codes we ship: English plus every lazily-loadable locale. */
export const AVAILABLE_LANGUAGES: string[] = [DEFAULT_LANGUAGE, ...Object.keys(loaders)].sort();

/** English is registered up front; other locales are added on demand. */
const resources: Record<string, { translation: Record<string, unknown> }> = {
  [DEFAULT_LANGUAGE]: { translation: enTranslation as Record<string, unknown> },
};

/** Base catalogs already registered independently of an optional language pack. */
const loadedBaseCatalogs = new Set<string>([DEFAULT_LANGUAGE]);

async function loadBaseCatalog(code: string): Promise<void> {
  if (loadedBaseCatalogs.has(code)) return;
  const loader = loaders[code];
  if (!loader) return;
  const mod = await loader();
  i18n.addResourceBundle(code, "translation", mod.default, true, true);
  loadedBaseCatalogs.add(code);
}

function applyLanguagePack(pack: GeoLibreLanguagePack): void {
  i18n.addResourceBundle(pack.locale, "translation", pack.translations, true, true);
}

async function applyPersistedLanguagePack(code: string): Promise<InstalledLanguagePack | null> {
  let installed: InstalledLanguagePack | null;
  try {
    installed = await loadInstalledLanguagePack(code);
  } catch (error) {
    // A pack is optional, so a storage failure must degrade to the base catalog
    // rather than reject. `storageAvailable()` only checks that `indexedDB`
    // exists; `indexedDB.open()` itself still rejects in storage-restricted
    // contexts (Safari private browsing, a sandboxed embed iframe without
    // storage access). Boot awaits this via `i18nReady`, so an uncaught
    // rejection here would stop `main.tsx` before it renders — a blank app
    // merely because a language pack could not be read.
    console.error("[GeoLibre] Could not read the installed language pack", error);
    return null;
  }
  if (!installed) return null;
  try {
    // IndexedDB is local but not trusted: browser extensions, DevTools, or a
    // previous buggy build can alter a record after its initial validation.
    // Re-run the same parser on every restore before merging it into i18next.
    const validated = parseLanguagePack(JSON.stringify(installed.pack));
    if (validated.locale.toLowerCase() !== code.toLowerCase()) {
      throw new LanguagePackError(
        "invalid-locale",
        `Stored language pack ${validated.locale} does not match ${code}.`,
      );
    }
    applyLanguagePack(validated);
    return { ...installed, pack: validated };
  } catch (error) {
    console.error("[GeoLibre] Ignoring an invalid persisted language pack", error);
    await deleteInstalledLanguagePack(code).catch(() => {});
    return null;
  }
}

/**
 * Ensure a locale's catalog is registered with i18next, importing its chunk on
 * first use. English is always present, and an unknown or already-loaded code is
 * a no-op, so callers can await this unconditionally before switching language.
 * A failed import rejects, letting the caller keep the current language rather
 * than switch to an empty catalog.
 */
export async function loadCatalog(code: string): Promise<void> {
  await loadBaseCatalog(code);
  await applyPersistedLanguagePack(code);
}

function supportedPackLocale(locale: string): string {
  const supported = resolveLanguage(locale, AVAILABLE_LANGUAGES);
  if (!supported || supported.toLowerCase() !== locale.toLowerCase()) {
    throw new LanguagePackError(
      "unsupported-locale",
      `GeoLibre does not ship a base catalog for ${locale}.`,
    );
  }
  return supported;
}

async function persistAndApplyLanguagePack(
  pack: GeoLibreLanguagePack,
  source: LanguagePackSource,
  sourceUrl?: string,
): Promise<InstalledLanguagePack> {
  const locale = supportedPackLocale(pack.locale);
  const normalizedPack = locale === pack.locale ? pack : { ...pack, locale };
  const installed: InstalledLanguagePack = {
    locale,
    pack: normalizedPack,
    source,
    sourceUrl,
    installedAt: new Date().toISOString(),
  };
  await saveInstalledLanguagePack(installed);

  const activeLocale = resolveLanguage(i18n.language, AVAILABLE_LANGUAGES);
  if (activeLocale === locale) {
    await loadBaseCatalog(locale);
    applyLanguagePack(normalizedPack);
    // Resource changes do not trigger React updates by themselves. Re-selecting
    // the current language emits languageChanged and refreshes every t() caller.
    await i18n.changeLanguage(i18n.language);
  }
  return installed;
}

/** Validate, persist, and activate a pack selected from the local filesystem. */
export async function installLanguagePackFile(text: string): Promise<InstalledLanguagePack> {
  return persistAndApplyLanguagePack(parseLanguagePack(text), "file");
}

/** Download, persist, and activate the official pack for a shipped locale. */
export async function downloadLanguagePack(locale: string): Promise<InstalledLanguagePack> {
  const supported = supportedPackLocale(locale);
  const { pack, sourceUrl } = await fetchLanguagePack(supported);
  if (pack.locale.toLowerCase() !== supported.toLowerCase()) {
    throw new LanguagePackError(
      "invalid-locale",
      `The downloaded pack is for ${pack.locale}, not ${supported}.`,
    );
  }
  return persistAndApplyLanguagePack(pack, "download", sourceUrl);
}

/** Read the persisted pack metadata shown by Settings. */
export function getInstalledLanguagePack(locale: string): Promise<InstalledLanguagePack | null> {
  return loadInstalledLanguagePack(locale);
}

/** Remove a pack and restore the bundled base catalog immediately. */
export async function removeLanguagePack(locale: string): Promise<void> {
  const supported = supportedPackLocale(locale);
  await deleteInstalledLanguagePack(supported);
  const activeLocale = resolveLanguage(i18n.language, AVAILABLE_LANGUAGES);
  if (activeLocale !== supported) return;

  i18n.removeResourceBundle(supported, "translation");
  loadedBaseCatalogs.delete(supported);
  if (supported === DEFAULT_LANGUAGE) {
    i18n.addResourceBundle(
      DEFAULT_LANGUAGE,
      "translation",
      enTranslation as Record<string, unknown>,
      true,
      true,
    );
    loadedBaseCatalogs.add(DEFAULT_LANGUAGE);
  } else {
    await loadBaseCatalog(supported);
  }
  await i18n.changeLanguage(i18n.language);
}

/**
 * Monotonic token for the most recent `setActiveLanguage` call. Kept at module
 * scope (not in a hook's ref) so the "latest request wins" guard holds across
 * *every* caller — multiple components, or a remount — not just one hook
 * instance.
 */
let languageRequestToken = 0;

/**
 * Serializes the `i18n.changeLanguage` calls. Catalog fetches may finish out of
 * order, but the actual switches run one at a time in the order they were
 * issued, so a slower earlier switch can't resolve last and flip the active
 * language back to a superseded selection. Each queued switch skips itself if a
 * newer request has already superseded it by the time its turn comes up.
 */
let languageSwitchQueue: Promise<void> = Promise.resolve();

/**
 * Load a locale's catalog (if needed) and switch to it, ignoring any request a
 * newer call has since superseded — so rapidly picking two uncached locales
 * can't let a slower earlier request clobber the newer selection (neither the
 * persisted choice nor the visible language). Resolves `true` only when this
 * call actually applied the language (callers persist the choice on `true`),
 * `false` when it was superseded. Rejects only when the *latest* request fails
 * — its catalog fetch or the switch itself; a superseded request's failure is
 * swallowed.
 */
export async function setActiveLanguage(code: string): Promise<boolean> {
  const token = ++languageRequestToken;
  try {
    await loadCatalog(code);
  } catch (error) {
    if (token === languageRequestToken) throw error;
    return false;
  }
  if (token !== languageRequestToken) return false;

  // Chain onto the switch queue so overlapping `changeLanguage` calls apply in
  // issue order rather than resolution order. The queue promise never rejects
  // (failures are captured below), so the chain always advances.
  let failure: unknown;
  const run = languageSwitchQueue.then(async () => {
    // A newer request superseded this one before its turn — leave the language
    // to that newer switch.
    if (token !== languageRequestToken) return;
    try {
      await i18n.changeLanguage(code);
    } catch (error) {
      // Surface only the latest request's failure; a superseded one's is moot.
      if (token === languageRequestToken) failure = error;
    }
  });
  languageSwitchQueue = run;
  await run;

  if (failure) throw failure;
  return token === languageRequestToken;
}

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
 * Resolution is synchronous — it inspects the catalog *codes*, never their
 * (possibly not-yet-loaded) contents.
 */
export function getInitialLanguage(): string {
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    for (const key of QUERY_PARAM_KEYS) {
      const fromQuery = resolveLanguage(params.get(key), AVAILABLE_LANGUAGES);
      if (fromQuery) return fromQuery;
    }

    const fromSettings = resolveLanguage(persistedLanguage(), AVAILABLE_LANGUAGES);
    if (fromSettings) return fromSettings;

    const navigatorLanguages =
      typeof navigator !== "undefined" ? (navigator.languages ?? [navigator.language]) : [];
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

const initialLanguage = getInitialLanguage();

/**
 * Resolves once i18next is initialized with English plus (if applicable) the
 * initial language's catalog. `main.tsx` awaits this before the first render so
 * the UI paints in the right language rather than flashing raw translation keys
 * while a lazy catalog loads.
 */
export const i18nReady: Promise<unknown> = (async () => {
  // English is already bundled; preload only a non-default initial locale so its
  // strings are present on the very first paint.
  let effectiveLanguage = initialLanguage;
  if (initialLanguage !== DEFAULT_LANGUAGE && loaders[initialLanguage]) {
    try {
      const mod = await loaders[initialLanguage]();
      resources[initialLanguage] = { translation: mod.default };
      loadedBaseCatalogs.add(initialLanguage);
    } catch (error) {
      // The catalog fetch failed (e.g. offline first visit): boot in English
      // rather than in a locale whose strings are absent, which would render
      // English fallback text while still applying the locale's `lang`/`dir`
      // (wrong RTL direction for e.g. Arabic). The user can switch once online.
      console.error("[GeoLibre] Failed to load initial locale catalog; using English", error);
      effectiveLanguage = DEFAULT_LANGUAGE;
    }
  }

  // Deliberately no `.catch` here: English is always bundled, so init only
  // rejects on a genuine i18next failure. Swallowing it would fulfill
  // `i18nReady` and let `main.tsx` render an uninitialized instance (raw keys);
  // instead let it reject so the startup chain's error handler runs.
  await i18n.use(initReactI18next).init({
    resources,
    lng: effectiveLanguage,
    fallbackLng: DEFAULT_LANGUAGE,
    defaultNS: "translation",
    interpolation: {
      // React already escapes rendered values, so i18next double-escaping would
      // mangle any text that legitimately contains `<`, `&`, etc.
      escapeValue: false,
    },
    // We gate the first render on `i18nReady`, so the initial catalog is always
    // present by mount — no Suspense boundary needed.
    react: { useSuspense: false },
    returnNull: false,
  });
  await applyPersistedLanguagePack(effectiveLanguage);
  return i18n;
})();

export default i18n;
