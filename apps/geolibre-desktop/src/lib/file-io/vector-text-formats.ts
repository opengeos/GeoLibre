/**
 * Readers for the text vector formats parsed in JS rather than DuckDB:
 * GeoJSON, GPX, encoded polylines and delimited text (CSV/TSV).
 */

import { batchDecodePolylines } from "@geolibre/core";
import { readTextFileLines } from "@tauri-apps/plugin-fs";
import type { FeatureCollection } from "geojson";
import { projectedGeoJsonCrs } from "../crs-utils";
import {
  DELIMITER_CANDIDATES,
  NO_VALID_COORDINATES_MESSAGE,
  countDelimitedTextRows,
  detectCoordinateFields,
  detectDelimitedTextDelimiter,
  firstDelimitedTextLine,
  hasCompleteHeaderLine,
  parseDelimitedTextFields,
  parseDelimitedTextLayer,
} from "../delimited-text";
import { confirmLargeDataset, type DuckDbVectorLoadOptions } from "../duckdb-vector-guard";
import { parseGpxLayer } from "../gpx";
import { isTauri } from "../is-tauri";
import type { LoadedVectorLayer } from "./loaded-layer";
import { browserSafeFileName, fileExtension, pathWithoutExtension } from "./paths";
import { assertFeatureCollection, mergeFeatureCollections } from "./vector-shared";

export async function parseGeoJsonText(text: string): Promise<FeatureCollection> {
  const fc = assertFeatureCollection(JSON.parse(text));
  // A projected GeoJSON declares a non-WGS84 CRS via a legacy top-level `crs`
  // member and carries raw projected coordinates MapLibre cannot render. When
  // one is present, reproject to WGS84 (the heavy DuckDB loader is pulled in
  // only then). A blank/WGS84 member takes the cheap path below and never loads
  // DuckDB, keeping the common case light.
  const sourceCrs = projectedGeoJsonCrs(fc);
  if (sourceCrs) {
    const { reprojectFeatureCollectionToWgs84 } = await import("../duckdb-vector-loader");
    return reprojectFeatureCollectionToWgs84(fc, sourceCrs);
  }
  // Drop the deprecated `crs` member (RFC 7946 mandates WGS84) so it does not
  // linger on an already-WGS84 collection.
  const { crs: _deprecatedCrs, ...stripped } = fc as FeatureCollection & {
    crs?: unknown;
  };
  return stripped as FeatureCollection;
}

export function parseGpxText(text: string): FeatureCollection {
  const result = parseGpxLayer(text);
  return mergeFeatureCollections([result.waypoints, result.tracks, result.routes]);
}

export function parseGpxTextLayers(text: string, path: string): LoadedVectorLayer[] {
  const result = parseGpxLayer(text);
  const baseName = pathWithoutExtension(browserSafeFileName(path)) || "GPX";
  return [
    { data: result.waypoints, label: "Waypoints" },
    { data: result.tracks, label: "Tracks" },
    { data: result.routes, label: "Routes" },
  ]
    .filter((layer) => layer.data.features.length > 0)
    .map((layer) => ({
      data: layer.data,
      name: `${baseName} ${layer.label}`,
      path,
    }));
}

/**
 * Checks whether a decoded polyline FeatureCollection contains valid, non-empty WGS84 coordinates.
 *
 * Rejects collections with no features or 0 total coordinates, non-finite values,
 * or coordinate values falling outside the valid WGS84 domain ([-180, 180] lon, [-90, 90] lat).
 */
function hasValidPolylineCoordinates(fc: FeatureCollection): boolean {
  if (!fc.features || fc.features.length === 0) return false;
  let totalPoints = 0;
  for (const feature of fc.features) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    if (geometry.type === "LineString") {
      for (const coord of geometry.coordinates) {
        const [lon, lat] = coord;
        if (
          !Number.isFinite(lon) ||
          !Number.isFinite(lat) ||
          lon < -180 ||
          lon > 180 ||
          lat < -90 ||
          lat > 90
        ) {
          return false;
        }
        totalPoints++;
      }
    } else if (geometry.type === "MultiLineString") {
      for (const line of geometry.coordinates) {
        for (const coord of line) {
          const [lon, lat] = coord;
          if (
            !Number.isFinite(lon) ||
            !Number.isFinite(lat) ||
            lon < -180 ||
            lon > 180 ||
            lat < -90 ||
            lat > 90
          ) {
            return false;
          }
          totalPoints++;
        }
      }
    }
  }
  return totalPoints > 0;
}

/**
 * Parses raw polyline text from a dropped/opened file into a vector layer.
 *
 * Encoded polyline format does not self-describe its precision factor. Auto-detection
 * first attempts standard precision 5 (Google Maps / OSRM standard, factor 1e5).
 * If precision 5 yields coordinates outside valid WGS84 bounds (which occurs when
 * precision 6 data with latitude > 9° or longitude > 18° is scaled up by 10x),
 * it falls back to precision 6 (Valhalla / Mapbox standard, factor 1e6).
 *
 * That bounds check only settles the cases it can: the two decodes of the same
 * bytes differ by exactly a factor of 10, so whenever precision 5 lands in
 * bounds precision 6 necessarily does too, and nothing in the data says which
 * one the author meant. Precision-6 data close to the prime meridian and the
 * equator (|lon| <= 18°, |lat| <= 9°) therefore imports at precision 5, ten
 * times too large, with no error. Drag-and-drop has nowhere to ask, so it takes
 * the more common of the two; Add Data → Encoded Polyline is the path with an
 * explicit precision picker and a preview to check the result against.
 */
export function parsePolylineFileLayers(text: string, path: string): LoadedVectorLayer[] {
  let fc = batchDecodePolylines(text, { precision: 5, unescape: true });
  if (!hasValidPolylineCoordinates(fc)) {
    fc = batchDecodePolylines(text, { precision: 6, unescape: true });
  }
  if (!hasValidPolylineCoordinates(fc)) {
    throw new Error("No valid polyline coordinates could be decoded from this file.");
  }
  const baseName = pathWithoutExtension(browserSafeFileName(path)) || "Polyline";
  return [
    {
      data: fc,
      name: baseName,
      path,
    },
  ];
}

/** Delimited text formats the drag-and-drop / open path loads as points. */
const DELIMITED_TEXT_DROP_EXTENSIONS = ["csv", "tsv"];

/** Whether a filename looks like a delimited text table (CSV/TSV). */
export function isDelimitedTextFileName(path: string): boolean {
  return DELIMITED_TEXT_DROP_EXTENSIONS.includes(fileExtension(path));
}

/**
 * How much of a delimited file to decode when only its header is wanted. Large
 * enough for any realistic header (the widest seen in the wild are a few tens
 * of KB), and the read falls back to the whole file if no line break turns up
 * within it, so an unusual file loses efficiency rather than correctness.
 */
const DELIMITED_TEXT_HEADER_PROBE_BYTES = 1024 * 1024;

/**
 * Reads enough of a delimited file to contain its header row, paired with a
 * reader for the file's whole text.
 *
 * Only a genuine partial probe leaves a full read still to do. Whenever the
 * header text *is* the whole file, which is every file under the probe size,
 * it is handed back for reuse rather than decoded a second time.
 *
 * Decoding a slice can split a multi-byte character at the cut, but the damage
 * is confined to the truncated tail, past the header the caller reads.
 *
 * @param file - The delimited file.
 * @returns The header text and a reader for the full text.
 */
export async function readDelimitedTextSource(file: File): Promise<{
  headerText: string;
  readFullText: () => Promise<string>;
}> {
  const alreadyWhole = (text: string) => ({
    headerText: text,
    readFullText: async () => text,
  });
  if (file.size <= DELIMITED_TEXT_HEADER_PROBE_BYTES) return alreadyWhole(await file.text());
  const probe = await file.slice(0, DELIMITED_TEXT_HEADER_PROBE_BYTES).text();
  // Deliberately not "does the probe contain a line break": blank lines before
  // the header contribute breaks of their own, so a header that overruns the
  // probe would still look terminated and be handed back truncated.
  if (hasCompleteHeaderLine(probe)) return { headerText: probe, readFullText: () => file.text() };
  return alreadyWhole(await file.text());
}

/**
 * Parses dropped/opened delimited text into a point FeatureCollection by
 * auto-detecting the delimiter and the longitude/latitude columns.
 *
 * Returns `null` when no longitude/latitude columns can be identified, so the
 * caller can fall back to the DuckDB path and still load spatial CSV variants
 * (e.g. a CSV with a WKT geometry column). Throws a helpful error (pointing at
 * the Add Data dialog) when the file is empty or the auto-detected columns hold
 * no usable WGS84 coordinates (e.g. a CSV whose `x`/`y` columns are projected).
 *
 * @param source - `headerText` needs only to reach the end of the header row;
 *   `readFullText` is called solely once coordinate columns are confirmed, so a
 *   CSV large enough to have been probed rather than read whole is never
 *   materialized as text just to be handed to the DuckDB fallback.
 * @param path - The file name or path, used in the messages.
 * @param options - Carries the caller's large-dataset guard.
 */
export async function parseDelimitedTextFile(
  source: { headerText: string; readFullText: () => Promise<string> },
  path: string,
  options?: DuckDbVectorLoadOptions,
): Promise<FeatureCollection | null> {
  const name = browserSafeFileName(path);
  const pickColumns = `Use Add Data → Delimited Text to choose the coordinate columns for ${name}.`;
  // Detect the delimiter and the coordinate columns from the header alone, so
  // this preflight neither parses nor even reads the body. parseDelimitedText-
  // Layer re-reads the header internally, so recovering the column names by
  // parsing the whole file here would double the work.
  //
  // A header cell containing a quoted newline is cut short here (see
  // firstDelimitedTextLine for why that cannot be resolved before the delimiter
  // is known). That only ever costs auto-detection, never correctness: the
  // column names below are resolved against a full, quote-aware parse of the
  // file, so the worst case is that lon/lat columns past the cut go unnoticed
  // and the file falls through to DuckDB, whose failure points at Add Data ->
  // Delimited Text, where the user picks the columns by hand.
  const headerLine = firstDelimitedTextLine(source.headerText);
  if (!headerLine) {
    throw new Error(`${name} appears to be empty. ${pickColumns}`);
  }
  const delimiter = detectDelimitedTextDelimiter(headerLine);
  const fields = parseDelimitedTextFields(headerLine, delimiter);
  const coordinateFields = detectCoordinateFields(fields);
  if (!coordinateFields) return null;

  const text = await source.readFullText();
  // Delimited text is the one vector path that never reaches the DuckDB loader
  // (which has no lon/lat column detection), so it was also the one path with
  // no oversized-import guard at all. Counting is a scan that allocates
  // nothing, unlike the materialization it guards, so it runs for every file
  // rather than only past some size: a CSV of short rows can clear the warn
  // threshold on row count while staying far below any byte threshold.
  if (options?.onLargeDataset) {
    await confirmLargeDataset(
      { name, featureCount: countDelimitedTextRows(text, delimiter) },
      options.onLargeDataset,
    );
  }
  try {
    return parseDelimitedTextLayer(text, {
      delimiter,
      longitudeField: coordinateFields.longitudeField,
      latitudeField: coordinateFields.latitudeField,
    }).data;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Only the "no valid coordinates" failure points to the wrong columns
    // (e.g. the auto-detected columns are actually projected x/y); append the
    // column-picker hint just for that case. Other errors (e.g. a header with
    // no data rows) are already self-explanatory, so surface them unchanged.
    const isCoordinateError = detail === NO_VALID_COORDINATES_MESSAGE;
    throw new Error(isCoordinateError ? `${detail} ${pickColumns}` : detail);
  }
}

/** Split a CSV/TSV header line into trimmed column names. */
export function parseCsvHeaderLine(line: string): string[] {
  const header = line.replace(/^﻿/, "").replace(/[\r\n]+$/, "");
  if (!header) return [];
  // Reuse the project's quote-aware delimited-text parser for each candidate
  // delimiter and keep the one that yields the most columns. The candidate set
  // is shared with the drag-and-drop loader so both detect the same formats
  // (comma, tab, semicolon, pipe). Quoting is respected, so a quoted field
  // containing the delimiter (e.g. "city,state") neither skews detection nor
  // splits the header.
  let best: string[] = [];
  for (const delimiter of DELIMITER_CANDIDATES) {
    try {
      const fields = parseDelimitedTextFields(header, delimiter).filter(
        (name) => name.trim().length > 0,
      );
      if (fields.length > best.length) best = fields;
    } catch {
      // No header row for this delimiter; try the next candidate.
    }
  }
  return best.map((name) => name.trim()).filter((name) => name.length > 0);
}

/**
 * Read the header column names of a CSV from a browser File or a desktop path.
 * Reads only the first line so large CSVs are not loaded into memory.
 */
export async function readCsvHeaderColumns(source: File | string): Promise<string[]> {
  try {
    if (typeof source !== "string") {
      // Browser File: decode just the leading slice that holds the header.
      const text = await source.slice(0, 65536).text();
      return parseCsvHeaderLine(text.split(/\r?\n/, 1)[0] ?? "");
    }
    if (!isTauri()) return [];
    const lines = await readTextFileLines(source);
    for await (const line of lines) {
      return parseCsvHeaderLine(line);
    }
    return [];
  } catch (error) {
    console.warn("Could not read CSV header", error);
    return [];
  }
}
