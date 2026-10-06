/**
 * Errors from plugin library code that reach the UI as text.
 *
 * Non-UI modules (layer loaders, sign-in flows) have no `t()`, and their
 * messages surface wherever a caller shows `error.message`: a dialog, a toast,
 * or an upstream control that renders it verbatim. A {@link LocalizedError}
 * names its catalog key and translates itself when constructed, through the
 * translator the host registers once with {@link setLocalizedErrorTranslator},
 * so every one of those surfaces shows it in the active language without
 * being changed. The English text stays on the error for logs and Diagnostics.
 */
import { interpolatePluginText, type PluginTranslateParams } from "./plugin-i18n";

/** Resolves a catalog key to text, interpolating `{{params}}`. */
export type LocalizedErrorTranslator = (
  key: string,
  defaultValue: string,
  params?: PluginTranslateParams,
) => string;

let translator: LocalizedErrorTranslator | null = null;

/**
 * Register the host's translator. Until one is set (tests, the Python embed
 * before boot), errors keep their English text.
 *
 * @param next - The translator, or `null` to clear it.
 */
export function setLocalizedErrorTranslator(next: LocalizedErrorTranslator | null): void {
  translator = next;
}

/**
 * Translate a catalog key now, for an error class that cannot extend
 * {@link LocalizedError} (one that also carries server-supplied text).
 * Falls back to the interpolated English when no translator is registered or
 * it fails.
 *
 * @param key - The full catalog key.
 * @param englishTemplate - The English text, with `{{params}}` placeholders.
 * @param params - Values to interpolate.
 * @returns The message in the active language.
 */
export function localizedMessage(
  key: string,
  englishTemplate: string,
  params?: PluginTranslateParams,
): string {
  const english = interpolatePluginText(englishTemplate, params);
  if (!translator) return english;
  try {
    return translator(key, englishTemplate, params) || english;
  } catch {
    // A translator failure must never replace the error being reported.
    return english;
  }
}

/**
 * An error whose message is translated from a catalog key at construction.
 *
 * @example
 * throw new LocalizedError("arcgisService.errors.serviceRequestFailed",
 *   "ArcGIS service request failed with {{status}}.", { status: 502 });
 */
export class LocalizedError extends Error {
  /** The full catalog key, for example `arcgisService.errors.serviceRequestFailed`. */
  readonly key: string;
  /** The English message with `{{params}}` already filled in. */
  readonly englishMessage: string;
  /** The values interpolated into the message. */
  readonly params?: PluginTranslateParams;

  constructor(
    key: string,
    englishTemplate: string,
    params?: PluginTranslateParams,
    options?: ErrorOptions,
  ) {
    super(localizedMessage(key, englishTemplate, params), options);
    this.name = "LocalizedError";
    this.key = key;
    this.englishMessage = interpolatePluginText(englishTemplate, params);
    this.params = params;
  }
}
