/**
 * geoBoundaries (https://www.geoboundaries.org) administrative boundaries for
 * the Add Data → Administrative Boundaries dialog (GeoLibre discussion #2997).
 *
 * The gbOpen release covers ~230 countries at ADM0 through ADM5 under open
 * licenses (CC0 / CC BY / ODbL, per boundary), and its API sends
 * `Access-Control-Allow-Origin: *`, so every build (desktop, web, Jupyter) can
 * read it directly. GADM, the source the discussion asked about, sends no CORS
 * headers and forbids redistribution, so it is not used.
 *
 * This module is pure (no React, no DOM) so the parsers stay testable under the
 * node test runner.
 */

export const GEOBOUNDARIES_API_BASE = "https://www.geoboundaries.org/api/current/gbOpen";

/** Pseudo-ISO code that asks the API for every country at one level. */
const ALL_COUNTRIES = "ALL";

export interface GeoBoundariesCountry {
  /** ISO 3166-1 alpha-3 code, e.g. `PRT`. */
  iso: string;
  name: string;
}

/** One country's boundary at one admin level, as the API describes it. */
export interface GeoBoundariesLevel {
  iso: string;
  countryName: string;
  /** `ADM0` through `ADM5`. */
  level: string;
  /** Local name of the unit type (e.g. `Freguesias`), when the API gives one. */
  canonicalName?: string;
  unitCount?: number;
  license?: string;
  source?: string;
  geojsonUrl: string;
  simplifiedGeojsonUrl?: string;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  // The API writes pandas' missing marker for absent text fields.
  return trimmed && trimmed.toLowerCase() !== "nan" ? trimmed : undefined;
}

function asRecords(json: unknown): Record<string, unknown>[] {
  const items = Array.isArray(json) ? json : [json];
  return items.filter(
    (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
  );
}

/**
 * Parses the `ALL/ADM0` response into a country list sorted by name, dropping
 * entries without an ISO code and duplicate codes.
 *
 * @param json Parsed API response.
 * @returns Countries sorted by display name.
 */
export function parseGeoBoundariesCountries(json: unknown): GeoBoundariesCountry[] {
  const byIso = new Map<string, GeoBoundariesCountry>();
  for (const record of asRecords(json)) {
    const iso = stringField(record, "boundaryISO")?.toUpperCase();
    if (!iso || byIso.has(iso)) continue;
    byIso.set(iso, { iso, name: stringField(record, "boundaryName") ?? iso });
  }
  return [...byIso.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Drops the API's placeholder unit-type names: `Unknown`, and the release name
 * (`gbOpen`, ...) that some boundaries carry instead of a real type.
 */
function canonicalName(name: string | undefined): string | undefined {
  if (!name || /^unknown$/i.test(name) || /^gb(open|humanitarian|authoritative)$/i.test(name)) {
    return undefined;
  }
  return name;
}

/**
 * Parses a `<ISO>/ALL` (or single-level) response into the country's available
 * admin levels, sorted ADM0 first. Entries without a GeoJSON download are
 * dropped since they cannot be loaded.
 *
 * @param json Parsed API response.
 * @returns The available levels, coarsest first.
 */
export function parseGeoBoundariesLevels(json: unknown): GeoBoundariesLevel[] {
  const levels: GeoBoundariesLevel[] = [];
  for (const record of asRecords(json)) {
    const iso = stringField(record, "boundaryISO")?.toUpperCase();
    const level = stringField(record, "boundaryType")?.toUpperCase();
    const geojsonUrl = stringField(record, "gjDownloadURL");
    if (!iso || !level || !geojsonUrl) continue;
    const unitCount = Number(stringField(record, "admUnitCount"));
    levels.push({
      iso,
      countryName: stringField(record, "boundaryName") ?? iso,
      level,
      canonicalName: canonicalName(stringField(record, "boundaryCanonical")),
      unitCount: Number.isFinite(unitCount) && unitCount > 0 ? unitCount : undefined,
      license: stringField(record, "boundaryLicense"),
      source: stringField(record, "boundarySource"),
      geojsonUrl,
      simplifiedGeojsonUrl: stringField(record, "simplifiedGeometryGeoJSON"),
    });
  }
  return levels.sort((a, b) => a.level.localeCompare(b.level));
}

/**
 * Rewrites a `github.com/wmgeolab/geoBoundaries/raw/<ref>/<path>` link to its
 * `media.githubusercontent.com` target. geoBoundaries stores its GeoJSON in Git
 * LFS, and the github.com redirect in front of it fails a browser's CORS check,
 * while the media host answers with `Access-Control-Allow-Origin: *`. Any other
 * URL is returned unchanged.
 *
 * @param url A download URL from the API.
 * @returns A URL the browser can fetch cross-origin.
 */
export function corsGeoBoundariesUrl(url: string): string {
  // Only geoBoundaries' own repository is rewritten, so an unexpected API value
  // cannot point the fetch at another repository's LFS media.
  const match = /^https:\/\/github\.com\/wmgeolab\/geoBoundaries\/raw\/(.+)$/.exec(url.trim());
  if (!match) return url;
  return `https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/${match[1]}`;
}

/**
 * Picks the download URL for a level, preferring the simplified geometry when
 * asked for and available.
 *
 * @param level The selected level.
 * @param simplified Whether to load the simplified geometry.
 * @returns The CORS-safe GeoJSON URL.
 */
export function geoBoundariesDownloadUrl(level: GeoBoundariesLevel, simplified: boolean): string {
  const url =
    simplified && level.simplifiedGeojsonUrl ? level.simplifiedGeojsonUrl : level.geojsonUrl;
  return corsGeoBoundariesUrl(url);
}

/**
 * Attribution for the map's attribution control, crediting geoBoundaries and
 * the boundary's own source and license.
 *
 * @param level The loaded level.
 * @returns The attribution string.
 */
export function geoBoundariesAttribution(level: GeoBoundariesLevel): string {
  const parts = [level.source, level.license].filter(Boolean);
  const credit =
    '<a href="https://www.geoboundaries.org" target="_blank" rel="noreferrer">geoBoundaries</a>';
  // Sources often already name geoBoundaries ("geoBoundaries, DG Territory").
  const extra = parts.join(", ").replace(/^geoBoundaries,?\s*/i, "");
  // MapLibre renders attribution as HTML; the API text must not inject markup.
  return extra ? `${credit} (${escapeHtml(extra)})` : credit;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** URL of the country list. */
export function geoBoundariesCountriesUrl(): string {
  return `${GEOBOUNDARIES_API_BASE}/${ALL_COUNTRIES}/ADM0/`;
}

/**
 * URL listing every admin level the API has for one country.
 *
 * @param iso ISO 3166-1 alpha-3 code.
 * @returns The API URL.
 */
export function geoBoundariesLevelsUrl(iso: string): string {
  return `${GEOBOUNDARIES_API_BASE}/${encodeURIComponent(iso.toUpperCase())}/${ALL_COUNTRIES}/`;
}
