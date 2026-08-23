/**
 * Versioned, untrusted language-pack parsing for optional Whitebox metadata.
 *
 * Packs deliberately live outside the bundled locale catalogs: the hundreds of
 * tool descriptions are useful to some users but large enough that shipping
 * every translation in every GeoLibre binary would dominate the UI catalogs.
 */

export const LANGUAGE_PACK_FORMAT = "geolibre-language-pack";
export const LANGUAGE_PACK_FORMAT_VERSION = 1;
export const LANGUAGE_PACK_SCOPE = "whitebox";
export const LANGUAGE_PACK_MAX_BYTES = 5 * 1024 * 1024;
export const LANGUAGE_PACK_MAX_LEAVES = 100_000;
export const DEFAULT_LANGUAGE_PACK_BASE_URL = "https://languages.geolibre.app";

const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const ALLOWED_WHITEBOX_KEYS = new Set(["categories", "menuTool", "menuSubcategory"]);

export type LanguagePackErrorCode =
  | "invalid-json"
  | "invalid-format"
  | "unsupported-version"
  | "invalid-locale"
  | "invalid-translations"
  | "empty-pack"
  | "too-large"
  | "not-found"
  | "download-failed"
  | "unsupported-locale";

export class LanguagePackError extends Error {
  constructor(
    public readonly code: LanguagePackErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LanguagePackError";
  }
}

export interface GeoLibreLanguagePack {
  format: typeof LANGUAGE_PACK_FORMAT;
  formatVersion: typeof LANGUAGE_PACK_FORMAT_VERSION;
  scope: typeof LANGUAGE_PACK_SCOPE;
  locale: string;
  name?: string;
  updatedAt?: string;
  translations: {
    processing: {
      toolMeta?: { whitebox: Record<string, unknown> };
      whitebox?: {
        categories?: Record<string, unknown>;
        menuTool?: Record<string, unknown>;
        menuSubcategory?: Record<string, unknown>;
      };
    };
  };
}

export type LanguagePackSource = "download" | "file";

export interface InstalledLanguagePack {
  locale: string;
  pack: GeoLibreLanguagePack;
  source: LanguagePackSource;
  sourceUrl?: string;
  installedAt: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownKeysOnly(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function validateStringTree(value: unknown, path: string): number {
  if (typeof value === "string") return 1;
  if (!isPlainObject(value)) {
    throw new LanguagePackError(
      "invalid-translations",
      `${path} must contain only nested objects and string values.`,
    );
  }

  let leaves = 0;
  for (const [key, child] of Object.entries(value)) {
    if (!key || DANGEROUS_KEYS.has(key)) {
      throw new LanguagePackError("invalid-translations", `${path} contains an unsafe key.`);
    }
    leaves += validateStringTree(child, `${path}.${key}`);
    if (leaves > LANGUAGE_PACK_MAX_LEAVES) {
      throw new LanguagePackError("too-large", "The language pack contains too many messages.");
    }
  }
  return leaves;
}

/** Parse and strictly validate a language pack before it reaches i18next. */
export function parseLanguagePack(text: string): GeoLibreLanguagePack {
  if (new TextEncoder().encode(text).byteLength > LANGUAGE_PACK_MAX_BYTES) {
    throw new LanguagePackError("too-large", "The language pack exceeds the 5 MB limit.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LanguagePackError("invalid-json", "The selected file is not valid JSON.");
  }

  if (!isPlainObject(raw)) {
    throw new LanguagePackError("invalid-format", "The language pack root must be an object.");
  }
  if (raw.format !== LANGUAGE_PACK_FORMAT || raw.scope !== LANGUAGE_PACK_SCOPE) {
    throw new LanguagePackError("invalid-format", "This is not a GeoLibre Whitebox language pack.");
  }
  if (raw.formatVersion !== LANGUAGE_PACK_FORMAT_VERSION) {
    throw new LanguagePackError(
      "unsupported-version",
      `Language-pack format ${String(raw.formatVersion)} is not supported.`,
    );
  }
  if (typeof raw.locale !== "string" || !LANGUAGE_CODE_PATTERN.test(raw.locale)) {
    throw new LanguagePackError("invalid-locale", "The language pack has an invalid locale code.");
  }
  if (raw.name !== undefined && typeof raw.name !== "string") {
    throw new LanguagePackError("invalid-format", "Language-pack name must be a string.");
  }
  if (raw.updatedAt !== undefined) {
    if (typeof raw.updatedAt !== "string" || !Number.isFinite(Date.parse(raw.updatedAt))) {
      throw new LanguagePackError("invalid-format", "Language-pack updatedAt must be an ISO date.");
    }
  }
  if (!isPlainObject(raw.translations) || !ownKeysOnly(raw.translations, new Set(["processing"]))) {
    throw new LanguagePackError(
      "invalid-translations",
      "Only Processing translations are allowed.",
    );
  }
  const processing = raw.translations.processing;
  if (!isPlainObject(processing) || !ownKeysOnly(processing, new Set(["toolMeta", "whitebox"]))) {
    throw new LanguagePackError(
      "invalid-translations",
      "The Processing translation root is invalid.",
    );
  }

  let leaves = 0;
  if (processing.toolMeta !== undefined) {
    if (
      !isPlainObject(processing.toolMeta) ||
      !ownKeysOnly(processing.toolMeta, new Set(["whitebox"])) ||
      !isPlainObject(processing.toolMeta.whitebox)
    ) {
      throw new LanguagePackError(
        "invalid-translations",
        "A language pack may contain only processing.toolMeta.whitebox metadata.",
      );
    }
    leaves += validateStringTree(
      processing.toolMeta.whitebox,
      "translations.processing.toolMeta.whitebox",
    );
  }

  if (processing.whitebox !== undefined) {
    if (
      !isPlainObject(processing.whitebox) ||
      !ownKeysOnly(processing.whitebox, ALLOWED_WHITEBOX_KEYS)
    ) {
      throw new LanguagePackError(
        "invalid-translations",
        "The Whitebox translation subtree contains unsupported keys.",
      );
    }
    leaves += validateStringTree(processing.whitebox, "translations.processing.whitebox");
  }

  if (leaves === 0) {
    throw new LanguagePackError("empty-pack", "The language pack contains no translations.");
  }
  if (leaves > LANGUAGE_PACK_MAX_LEAVES) {
    throw new LanguagePackError("too-large", "The language pack contains too many messages.");
  }

  return raw as unknown as GeoLibreLanguagePack;
}

function configuredLanguagePackBaseUrl(): string {
  const configured =
    typeof import.meta.env === "undefined"
      ? undefined
      : (import.meta.env.VITE_LANGUAGE_PACK_BASE_URL as string | undefined);
  if (configured?.trim()) return configured.trim().replace(/\/+$/, "");
  const noExternalCdn = typeof __NO_EXTERNAL_CDN__ !== "undefined" ? __NO_EXTERNAL_CDN__ : false;
  return noExternalCdn ? "" : DEFAULT_LANGUAGE_PACK_BASE_URL;
}

/**
 * The configured language-pack host, or `""` when this build has no host to
 * download from. Settings renders its "browse the catalog" link from this so
 * the link can never point at the public host a `__NO_EXTERNAL_CDN__` build
 * opted out of, nor at a different host than `languagePackUrl` downloads from.
 */
export function languagePackBaseUrl(): string {
  return configuredLanguagePackBaseUrl();
}

/** Stable download URL for an official pack for `locale`. */
export function languagePackUrl(locale: string, baseUrl = configuredLanguagePackBaseUrl()): string {
  if (!baseUrl) {
    throw new LanguagePackError(
      "download-failed",
      "Official language-pack downloads are disabled in this build.",
    );
  }
  return `${baseUrl.replace(/\/+$/, "")}/v1/whitebox/${encodeURIComponent(locale)}.json`;
}

/**
 * How long a pack download may take before it is aborted. Settings disables the
 * Download/Import/Remove buttons for the duration of a download and re-enables
 * them in a `finally`, so a host that accepts the connection and then never
 * responds would otherwise leave those controls dead for the whole session.
 */
export const LANGUAGE_PACK_TIMEOUT_MS = 30_000;

/** Download and validate an official language pack. */
export async function fetchLanguagePack(
  locale: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  baseUrl?: string,
  timeoutMs: number = LANGUAGE_PACK_TIMEOUT_MS,
): Promise<{ pack: GeoLibreLanguagePack; sourceUrl: string }> {
  const sourceUrl = languagePackUrl(locale, baseUrl);
  let response: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    response = await fetchImpl(sourceUrl, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (error) {
    throw new LanguagePackError(
      "download-failed",
      controller.signal.aborted
        ? "The language-pack download timed out."
        : error instanceof Error
          ? error.message
          : "The language-pack service could not be reached.",
    );
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 404) {
    throw new LanguagePackError("not-found", `No language pack is available for ${locale}.`);
  }
  if (!response.ok) {
    throw new LanguagePackError(
      "download-failed",
      `The language-pack service returned HTTP ${response.status}.`,
    );
  }
  // A chunked response has no `content-length`, and `Number(null)` is 0, which
  // would pass a `Number.isFinite` check as if the body were empty. Only trust a
  // declared length; `parseLanguagePack` still enforces the limit on the decoded
  // text, so this stays an early exit rather than the only guard.
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > LANGUAGE_PACK_MAX_BYTES) {
    throw new LanguagePackError("too-large", "The language pack exceeds the 5 MB limit.");
  }
  const pack = parseLanguagePack(await response.text());
  return { pack, sourceUrl };
}
