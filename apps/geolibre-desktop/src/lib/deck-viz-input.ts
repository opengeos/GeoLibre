import type { DeckVizFieldMapping, DeckVizFormat, DeckVizRole } from "@geolibre/plugins";
import type { FeatureCollection } from "geojson";
import { parseDelimitedTextRows } from "./delimited-text";

/**
 * A column the user can map to a layer role. `value` is what gets written into
 * the field mapping: a string key for CSV/object data, or a numeric index for
 * JSON tuple arrays.
 */
export interface DeckVizColumn {
  value: string | number;
  label: string;
}

/** Result of detecting and parsing a deck.gl visualization input source. */
export interface DeckVizParsedInput {
  format: DeckVizFormat;
  columns: DeckVizColumn[];
  /** Parsed rows/tuples/objects for non-GeoJSON formats. */
  rows?: unknown[];
  /** Parsed FeatureCollection for the `geojson` format. */
  geojson?: FeatureCollection;
  rowCount: number;
}

const SAMPLE_FEATURE_LIMIT = 500;

/**
 * Detects the format of a text payload (CSV, JSON tuple array, JSON object
 * array, or GeoJSON) and parses it into rows/columns the Deck.gl Layer dialog
 * can map. Throws a user-facing Error when the payload is empty or unsupported.
 *
 * @param text - The raw file/URL contents.
 * @param delimiter - Delimiter for delimited text; sniffed from the header
 *   (comma/tab/semicolon/pipe) when omitted, so .tsv/.txt files parse correctly.
 * @returns The detected format, columns, and parsed data.
 */
export function detectAndParseDeckVizInput(text: string, delimiter?: string): DeckVizParsedInput {
  const trimmed = text.replace(/^﻿/, "").trimStart();
  if (!trimmed) throw new Error("The file is empty.");

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("The file is not valid JSON.");
    }
    return parseJsonInput(parsed);
  }

  const { fields, rows } = parseDelimitedTextRows(text, delimiter ?? sniffDelimiter(trimmed));
  const sample = rows[0];
  return {
    format: "csv-rows",
    columns: fields.map((field) => ({
      value: field,
      label: sampleLabel(field, sample?.[field]),
    })),
    rows,
    rowCount: rows.length,
  };
}

function parseJsonInput(parsed: unknown): DeckVizParsedInput {
  if (isFeatureCollectionLike(parsed)) {
    const geojson = normalizeFeatureCollection(parsed);
    return {
      format: "geojson",
      columns: collectFeatureProperties(geojson),
      geojson,
      rowCount: geojson.features.length,
    };
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Unsupported JSON. Provide a GeoJSON FeatureCollection or a JSON array.");
  }

  const first = parsed[0];
  if (Array.isArray(first)) {
    // Scan the first few rows so optional trailing columns on later rows are
    // still offered in the field-mapping picker.
    const width = Math.max(
      ...parsed.slice(0, 10).map((row) => (Array.isArray(row) ? row.length : 0)),
    );
    return {
      format: "json-array",
      columns: Array.from({ length: width }, (_, index) => ({
        value: index,
        label: sampleLabel(`Column ${index}`, first[index]),
      })),
      rows: parsed,
      rowCount: parsed.length,
    };
  }

  if (first && typeof first === "object") {
    const keys = Object.keys(first as Record<string, unknown>);
    return {
      format: "json-objects",
      columns: keys.map((key) => ({
        value: key,
        label: sampleLabel(key, (first as Record<string, unknown>)[key]),
      })),
      rows: parsed,
      rowCount: parsed.length,
    };
  }

  throw new Error("Unsupported JSON array. Expected an array of objects or [lng, lat] tuples.");
}

/**
 * Auto-maps each layer role to the most likely column. Named columns
 * (CSV/objects) match on the role's detection hints; numeric columns (JSON
 * tuples) fall back to positional assignment. Never assigns one column to two
 * roles.
 *
 * @param roles - The roles declared by the chosen layer type.
 * @param columns - The available columns.
 * @returns A best-effort field mapping (may omit roles with no match).
 */
export function autoDetectFieldMapping(
  roles: DeckVizRole[],
  columns: DeckVizColumn[],
): DeckVizFieldMapping {
  const mapping: DeckVizFieldMapping = {};
  if (columns.length === 0) return mapping;

  const numeric = typeof columns[0].value === "number";
  const used = new Set<string | number>();

  roles.forEach((role, roleIndex) => {
    if (numeric) {
      const column = columns[roleIndex];
      if (column && !used.has(column.value)) {
        mapping[role.key] = column.value;
        used.add(column.value);
      }
      return;
    }

    const match = matchNamedColumn(role, columns, used);
    if (match !== undefined) {
      mapping[role.key] = match;
      used.add(match);
    }
  });

  return mapping;
}

function matchNamedColumn(
  role: DeckVizRole,
  columns: DeckVizColumn[],
  used: Set<string | number>,
): string | undefined {
  const candidates = columns
    .filter((column) => !used.has(column.value))
    .map((column) => ({
      value: String(column.value),
      lower: String(column.value).toLowerCase(),
    }));

  // Exact match wins, including short tokens like "x"/"y".
  for (const detect of role.detect) {
    const exact = candidates.find((candidate) => candidate.lower === detect);
    if (exact) return exact.value;
  }

  // Prefix match only for multi-character tokens, so "y" cannot grab "city".
  for (const detect of role.detect) {
    if (detect.length < 3) continue;
    const prefix = candidates.find((candidate) => candidate.lower.startsWith(detect));
    if (prefix) return prefix.value;
  }

  return undefined;
}

/**
 * Computes a `[west, south, east, north]` bounding box from inline row data so
 * the map can fit a freshly added deck.gl layer (GeoJSON layers fit via the
 * store layer's geometry instead). Scans whichever position roles are mapped:
 * point (`lng`/`lat`), origin-destination, and Trips `path` arrays.
 *
 * @param rows - The parsed rows/tuples/objects.
 * @param mapping - The role→column mapping.
 * @returns The bounding box, or null when no finite coordinates are found.
 */
export function computeDeckVizBounds(
  rows: unknown[],
  mapping: DeckVizFieldMapping,
): [number, number, number, number] | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  const extend = (lng: unknown, lat: unknown): void => {
    const x = Number(lng);
    const y = Number(lat);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < west) west = x;
    if (x > east) east = x;
    if (y < south) south = y;
    if (y > north) north = y;
  };

  for (const row of rows) {
    const record = row as Record<string | number, unknown>;
    if (mapping.lng !== undefined && mapping.lat !== undefined) {
      extend(record[mapping.lng], record[mapping.lat]);
    }
    if (mapping.sourceLng !== undefined && mapping.sourceLat !== undefined) {
      extend(record[mapping.sourceLng], record[mapping.sourceLat]);
    }
    if (mapping.targetLng !== undefined && mapping.targetLat !== undefined) {
      extend(record[mapping.targetLng], record[mapping.targetLat]);
    }
    if (mapping.path !== undefined) {
      const path = record[mapping.path];
      if (Array.isArray(path)) {
        for (const point of path) {
          if (Array.isArray(point)) extend(point[0], point[1]);
        }
      }
    }
  }

  if (west > east || south > north) return null;
  return [west, south, east, north];
}

/**
 * Picks the most likely delimiter for tabular text by counting candidates in
 * the header line. Lets `.tsv`/`.txt`/semicolon files parse without the caller
 * knowing the format up front; defaults to a comma.
 */
export function sniffDelimiter(text: string): string {
  const header = text.split(/\r?\n/, 1)[0] ?? "";
  const candidates = [",", "\t", ";", "|"];
  let best = ",";
  let bestCount = 0;
  for (const candidate of candidates) {
    const count = header.split(candidate).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }
  return best;
}

function sampleLabel(name: string, sample: unknown): string {
  if (sample === undefined || sample === null || sample === "") return name;
  const text = String(sample);
  const preview = text.length > 16 ? `${text.slice(0, 16)}…` : text;
  return `${name} (${preview})`;
}

function isFeatureCollectionLike(value: unknown): value is { type: string; features?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "FeatureCollection"
  );
}

function normalizeFeatureCollection(value: { features?: unknown }): FeatureCollection {
  const features = Array.isArray(value.features) ? value.features : [];
  return { type: "FeatureCollection", features } as FeatureCollection;
}

function collectFeatureProperties(geojson: FeatureCollection): DeckVizColumn[] {
  // Keep the first value seen per key so the picker can show a sample preview,
  // matching the CSV/JSON-object columns.
  const firstValues = new Map<string, unknown>();
  for (const feature of geojson.features.slice(0, SAMPLE_FEATURE_LIMIT)) {
    const properties = feature.properties;
    if (properties && typeof properties === "object") {
      for (const [key, value] of Object.entries(properties)) {
        if (!firstValues.has(key)) firstValues.set(key, value);
      }
    }
  }
  return Array.from(firstValues, ([key, value]) => ({
    value: key,
    label: sampleLabel(key, value),
  }));
}
