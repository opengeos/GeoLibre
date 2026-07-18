// Pure file-name sanitizers shared by the project-file actions. Kept in their
// own module (free of React/store/plugin imports) so they can be unit-tested in
// Node without pulling in the whole hook graph.

import { DEFAULT_PROJECT_NAME } from "@geolibre/core";

/**
 * Ensure a user-entered project file name carries a recognized extension,
 * defaulting to `.geolibre.json` when none is present so the downloaded file
 * opens cleanly again later. Falls back to the default project name when blank.
 *
 * @param name - The raw file name the user typed.
 * @returns A sanitized file name ending in a project extension.
 */
export function ensureProjectFileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return `${DEFAULT_PROJECT_NAME}.geolibre.json`;
  return /\.(geolibre\.json|geolibre|json)$/i.test(trimmed) ? trimmed : `${trimmed}.geolibre.json`;
}

/**
 * Ensure an exported HTML file name carries an `.html`/`.htm` extension,
 * defaulting to a slug-based name when blank so the browser download opens as a
 * web page rather than an unknown file type.
 *
 * @param name - The raw file name the user typed.
 * @param fallbackSlug - The project-derived slug used when the name is blank.
 * @returns A sanitized file name ending in `.html` (or the user's `.htm`).
 */
export function ensureHtmlFileName(name: string, fallbackSlug: string): string {
  const trimmed = name.trim();
  // A blank name, or one that is only dots (which would otherwise yield e.g.
  // "..html"), has no usable base, so fall back to the slug-derived name.
  if (!trimmed || /^\.+$/.test(trimmed)) return `${fallbackSlug}.html`;
  return /\.html?$/i.test(trimmed) ? trimmed : `${trimmed}.html`;
}
