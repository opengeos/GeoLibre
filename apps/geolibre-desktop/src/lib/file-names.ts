// Pure file-name sanitizers shared by the project-file actions. Kept in their
// own module (free of React/store/plugin imports) so they can be unit-tested in
// Node without pulling in the whole hook graph.

import { DEFAULT_PROJECT_NAME } from "@geolibre/core";

/**
 * Ensure a user-entered project file name carries a recognized extension,
 * defaulting to `.geolibre` when none is present so desktop installers can
 * associate the file with GeoLibre without claiming every JSON document.
 * Falls back to the default project name when blank.
 *
 * @param name - The raw file name the user typed.
 * @returns A sanitized file name ending in a project extension.
 */
export function ensureProjectFileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return `${DEFAULT_PROJECT_NAME}.geolibre`;
  return /\.(geolibre\.json|geolibre|json)$/i.test(trimmed) ? trimmed : `${trimmed}.geolibre`;
}

/**
 * The name to suggest for a project's file. An untitled project carries the
 * English {@link DEFAULT_PROJECT_NAME} in the store, but the toolbar shows the
 * localized "Untitled project" label, so the save dialog suggests that label
 * instead of a differently cased English name (#3492).
 *
 * @param name - The project's current name.
 * @param untitledLabel - The localized label for an untitled project.
 * @returns The project name, or the localized label when it is untitled.
 */
export function suggestedProjectName(name: string, untitledLabel: string): string {
  const trimmed = name.trim();
  if (trimmed && trimmed !== DEFAULT_PROJECT_NAME) return trimmed;
  return untitledLabel.trim() || DEFAULT_PROJECT_NAME;
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

/**
 * Normalize a user-entered layer styles file name: keep the user's `.json`
 * suffix, add one when missing, and fall back to the slug-derived name for a
 * blank or dots-only entry.
 *
 * @param name - The name the user typed.
 * @param fallbackSlug - Slug used when the entry has no usable base.
 * @returns A file name ending in `.json`.
 */
export function ensureJsonFileName(name: string, fallbackSlug: string): string {
  const trimmed = name.trim();
  if (!trimmed || /^\.+$/.test(trimmed)) return `${fallbackSlug}.json`;
  return /\.json$/i.test(trimmed) ? trimmed : `${trimmed}.json`;
}
