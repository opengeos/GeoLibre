/**
 * Pure helpers shared by the Add Data dialog sources: layer construction,
 * URL building, parsing/validation, and PostgreSQL connection persistence.
 */

import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import {
  DELIMITED_TEXT_DELIMITERS,
  GPX_PROXY_PATH,
  MAX_SAVED_POSTGRES_CONNECTIONS,
  POSTGRES_CONNECTIONS_STORAGE_KEY,
} from "./constants";
import type { DelimitedTextDelimiter } from "./types";

export function createLayerId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

export function layerNameFromPath(path: string, fallback: string): string {
  return fileNameFromPath(path).replace(/\.[^.]+$/, "") || fallback;
}

export function createBaseLayer(
  name: string,
  type: GeoLibreLayer["type"],
  source: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): GeoLibreLayer {
  return {
    id: createLayerId(),
    name,
    type,
    source,
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata,
  };
}

export function appendQuery(
  endpoint: string,
  params: Array<[string, string]>,
): string {
  const separator = endpoint.includes("?")
    ? endpoint.endsWith("?") || endpoint.endsWith("&")
      ? ""
      : "&"
    : "?";
  const query = params
    .map(([key, value]) => {
      const encodedValue =
        value === "{bbox-epsg-3857}" ? value : encodeURIComponent(value);
      return `${encodeURIComponent(key)}=${encodedValue}`;
    })
    .join("&");
  return `${endpoint}${separator}${query}`;
}

export function createWmsTileUrl(options: {
  endpoint: string;
  layers: string;
  styles: string;
  format: string;
  transparent: boolean;
  tileSize: number;
}): string {
  return appendQuery(options.endpoint, [
    ["SERVICE", "WMS"],
    ["REQUEST", "GetMap"],
    ["VERSION", "1.1.1"],
    ["LAYERS", options.layers],
    ["STYLES", options.styles],
    ["FORMAT", options.format],
    ["TRANSPARENT", options.transparent ? "TRUE" : "FALSE"],
    ["SRS", "EPSG:3857"],
    ["BBOX", "{bbox-epsg-3857}"],
    ["WIDTH", String(options.tileSize)],
    ["HEIGHT", String(options.tileSize)],
  ]);
}

export function parseRequiredNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Enter a numeric ${label}.`);
  }
  return parsed;
}

export function parseOptionalNumber(
  value: string,
  label: string,
): number | undefined {
  if (!value.trim()) return undefined;
  return parseRequiredNumber(value, label);
}

/** Parse a `"longitude, latitude"` corner string into a [lng, lat] pair. */
export function parseVideoCorner(value: string, label: string): [number, number] {
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length !== 2) {
    throw new Error(`Enter the ${label} corner as "longitude, latitude".`);
  }
  const lng = parseRequiredNumber(parts[0], `${label} longitude`);
  const lat = parseRequiredNumber(parts[1], `${label} latitude`);
  if (lng < -180 || lng > 180) {
    throw new Error(`${label} longitude must be between -180 and 180.`);
  }
  if (lat < -90 || lat > 90) {
    throw new Error(`${label} latitude must be between -90 and 90.`);
  }
  return [lng, lat];
}

export function uniquePostgresConnections(connections: string[]): string[] {
  return Array.from(new Set(connections));
}

export function readSavedPostgresConnections(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const value = window.localStorage.getItem(POSTGRES_CONNECTIONS_STORAGE_KEY);
    if (!value) return [];
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? uniquePostgresConnections(
          parsed.filter((item): item is string => typeof item === "string"),
        )
      : [];
  } catch {
    return [];
  }
}

export function rememberPostgresConnection(connectionString: string): string[] {
  const trimmed = connectionString.trim();
  if (!trimmed || typeof window === "undefined") return [];

  const connections = uniquePostgresConnections([
    trimmed,
    ...readSavedPostgresConnections().filter((value) => value !== trimmed),
  ]).slice(0, MAX_SAVED_POSTGRES_CONNECTIONS);

  try {
    window.localStorage.setItem(
      POSTGRES_CONNECTIONS_STORAGE_KEY,
      JSON.stringify(connections),
    );
  } catch {
    // Best-effort persistence: a quota/private-mode failure must not abort the
    // connect flow (mirrors readSavedPostgresConnections' guard).
  }
  return connections;
}

export function savedPostgresConnectionLabel(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.password) url.password = "****";
    return url.toString();
  } catch {
    return connectionString
      .replace(/(:\/\/[^:\s/@]+:)[^@\s]+@/, "$1****@")
      .replace(/(password\s*=\s*)('[^']*'|[^\s]+)/gi, "$1****");
  }
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

function isViteDevServer(): boolean {
  return Boolean(
    (
      import.meta as ImportMeta & {
        env?: { DEV?: boolean };
      }
    ).env?.DEV,
  );
}

/**
 * Routes a feed request through the dev-server CORS proxy when running under
 * Vite (so a `fetch()` for a remote GPX/GeoRSS file is not blocked by the
 * feed host's missing CORS headers). In production builds the URL is returned
 * unchanged. The proxy is generic; the `GPX_PROXY_PATH` name is historical.
 */
export function proxyFeedRequestUrl(url: string): string {
  return isViteDevServer()
    ? `${GPX_PROXY_PATH}?url=${encodeURIComponent(url)}`
    : url;
}

export function resolveDelimitedTextDelimiter(
  delimiter: DelimitedTextDelimiter,
  customDelimiter: string,
): string {
  if (delimiter !== "custom") return DELIMITED_TEXT_DELIMITERS[delimiter];
  return customDelimiter;
}

export function inferDelimitedTextField(
  fields: string[],
  currentField: string,
  candidates: string[],
): string {
  const current = currentField.trim().toLowerCase();
  const currentMatch = fields.find(
    (field) => field.trim().toLowerCase() === current,
  );
  if (currentMatch) return currentMatch;

  for (const candidate of candidates) {
    const match = fields.find(
      (field) => field.trim().toLowerCase() === candidate,
    );
    if (match) return match;
  }

  return fields[0] ?? currentField;
}

/** Recursively finds the first `[lng, lat]` pair in a GeoJSON coordinate array. */
function firstCoordinate(coords: unknown): [number, number] | null {
  if (!Array.isArray(coords)) return null;
  if (typeof coords[0] === "number" && typeof coords[1] === "number") {
    return [coords[0], coords[1]];
  }
  for (const child of coords) {
    const found = firstCoordinate(child);
    if (found) return found;
  }
  return null;
}

/**
 * Flattens a GeoJSON FeatureCollection into `{ lng, lat, ...properties }` rows
 * so the 3D-model (scenegraph) layer can place a model at each feature. The
 * lon/lat come from each feature's geometry (its first coordinate), while the
 * properties remain available for the optional altitude/bearing/scale columns.
 *
 * @param geojson - The parsed FeatureCollection.
 * @returns One row per feature that has a usable coordinate.
 */
export function geoJsonToPointRows(
  geojson: FeatureCollection | undefined,
): Record<string, unknown>[] {
  if (!geojson) return [];
  const rows: Record<string, unknown>[] = [];
  for (const feature of geojson.features) {
    const coord = firstCoordinate(
      (feature.geometry as { coordinates?: unknown } | null)?.coordinates,
    );
    if (!coord) continue;
    rows.push({
      ...(feature.properties ?? {}),
      lng: coord[0],
      lat: coord[1],
    });
  }
  return rows;
}
