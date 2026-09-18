import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  LineString,
  MultiLineString,
} from "geojson";

/**
 * Pure TypeScript Google Encoded Polyline algorithm codec.
 *
 * Supports arbitrary precision:
 * - precision = 5: Google Maps standard, OSRM, HERE (factor 1e5, ~1.1m precision)
 * - precision = 6: Valhalla, Mapbox, Open Source Routing Machine 6 (factor 1e6, ~0.11m precision)
 *
 * Coordinates are represented as `[lon, lat]` pairs in GeoJSON format.
 */

/**
 * Unescapes backslashes in a polyline string.
 *
 * When polyline strings are copied from JSON payloads, log files, or source code,
 * backslashes are frequently double-escaped as `\\` or formatted with escape sequences.
 *
 * @param str - Input string with potentially escaped backslashes.
 * @returns Cleaned polyline string.
 */
export function unescapePolyline(str: string): string {
  if (!str || typeof str !== "string") return "";
  return str.replace(/\\\\/g, "\\").replace(/\\"/g, '"').replace(/\\'/g, "'");
}

export interface PolylineDecodeResult {
  coordinates: [number, number][];
  complete: boolean;
}

/**
 * Decodes an encoded polyline string into an array of `[lon, lat]` coordinates,
 * along with a `complete` flag indicating whether the entire string was consumed
 * as complete coordinate pairs without truncation or malformed characters.
 *
 * @param encoded - The ASCII-encoded polyline string.
 * @param precision - Number of decimal digits (default: 5).
 * @param unescape - Whether to unescape double-escaped backslashes before decoding (default: false).
 * @returns Object with decoded `coordinates` and `complete` boolean status.
 */
export function decodePolylineDetailed(
  encoded: string,
  precision = 5,
  unescape = false,
): PolylineDecodeResult {
  if (!encoded || typeof encoded !== "string") {
    return { coordinates: [], complete: true };
  }
  const cleanEncoded = unescape ? unescapePolyline(encoded) : encoded;
  const factor = 10 ** precision;
  const len = cleanEncoded.length;
  const coordinates: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < len) {
    let shift = 0;
    let result = 0;
    let byte: number;

    // Decode latitude delta
    let latComplete = false;
    do {
      if (index >= len) return { coordinates, complete: false };
      byte = cleanEncoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) return { coordinates, complete: false };
      if (shift > 30 || (shift === 30 && (byte & 0x1f) > 0x03)) {
        return { coordinates, complete: false };
      }
      result |= (byte & 0x1f) << shift;
      shift += 5;
      if (byte < 0x20) {
        latComplete = true;
        break;
      }
    } while (byte >= 0x20);

    if (!latComplete) return { coordinates, complete: false };

    // Unsigned right shift (>>>) for 32-bit safe zigzag decoding
    lat += result & 1 ? ~(result >>> 1) : result >>> 1;

    shift = 0;
    result = 0;

    // Decode longitude delta
    let lonComplete = false;
    do {
      if (index >= len) return { coordinates, complete: false };
      byte = cleanEncoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) return { coordinates, complete: false };
      if (shift > 30 || (shift === 30 && (byte & 0x1f) > 0x03)) {
        return { coordinates, complete: false };
      }
      result |= (byte & 0x1f) << shift;
      shift += 5;
      if (byte < 0x20) {
        lonComplete = true;
        break;
      }
    } while (byte >= 0x20);

    if (!lonComplete) return { coordinates, complete: false };

    lon += result & 1 ? ~(result >>> 1) : result >>> 1;

    coordinates.push([lon / factor, lat / factor]);
  }

  return { coordinates, complete: true };
}

/**
 * Decodes an encoded polyline string into an array of `[lon, lat]` coordinates.
 *
 * @param encoded - The ASCII-encoded polyline string.
 * @param precision - Number of decimal digits (default: 5).
 * @param unescape - Whether to unescape double-escaped backslashes before decoding (default: false).
 * @returns Array of `[lon, lat]` coordinate pairs in GeoJSON order.
 */
export function decodePolyline(
  encoded: string,
  precision = 5,
  unescape = false,
): [number, number][] {
  return decodePolylineDetailed(encoded, precision, unescape).coordinates;
}

/**
 * Encodes a single integer delta value into polyline character chunks.
 */
function encodeSignedNumber(num: number): string {
  let sgnNum = num < 0 ? ~(num << 1) : num << 1;
  let out = "";
  while (sgnNum >= 0x20) {
    out += String.fromCharCode((0x20 | (sgnNum & 0x1f)) + 63);
    sgnNum >>>= 5;
  }
  out += String.fromCharCode(sgnNum + 63);
  return out;
}

/**
 * Encodes an array of `[lon, lat]` coordinates into a Google Encoded Polyline string.
 *
 * @param coordinates - Array of `[lon, lat]` coordinate pairs.
 * @param precision - Number of decimal digits (default: 5).
 * @returns The encoded polyline string.
 */
export function encodePolyline(coordinates: [number, number][], precision = 5): string {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return "";
  const factor = 10 ** precision;
  let output = "";
  let prevLat = 0;
  let prevLon = 0;

  for (const [lon, lat] of coordinates) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const roundLat = Math.round(lat * factor);
    const roundLon = Math.round(lon * factor);

    const deltaLat = roundLat - prevLat;
    const deltaLon = roundLon - prevLon;

    output += encodeSignedNumber(deltaLat);
    output += encodeSignedNumber(deltaLon);

    prevLat = roundLat;
    prevLon = roundLon;
  }

  return output;
}

/**
 * Decodes an encoded polyline string into a GeoJSON `Feature<LineString>`.
 *
 * @param encoded - The polyline string.
 * @param precision - Coordinate precision (default: 5).
 * @param properties - Optional feature properties.
 * @returns A GeoJSON LineString Feature.
 */
export function polylineStrToGeoJSON(
  encoded: string,
  precision = 5,
  properties: GeoJsonProperties = {},
): Feature<LineString> {
  return {
    type: "Feature",
    properties: { ...properties },
    geometry: {
      type: "LineString",
      coordinates: decodePolyline(encoded, precision),
    },
  };
}

/**
 * Encodes a GeoJSON LineString, MultiLineString, Feature, or FeatureCollection into encoded polyline string(s).
 *
 * @param geojson - The GeoJSON input geometry or feature.
 * @param precision - Coordinate precision (default: 5).
 * @returns An encoded polyline string for LineString, or an array of strings for MultiLineString / FeatureCollection.
 */
export function geoJSONToPolylineStr(
  geojson:
    | LineString
    | MultiLineString
    | Feature<LineString | MultiLineString>
    | FeatureCollection<LineString | MultiLineString>,
  precision = 5,
): string | string[] {
  if (!geojson) return "";

  // Handle Feature wrapper
  if (geojson.type === "Feature") {
    return geoJSONToPolylineStr(geojson.geometry, precision);
  }

  // Handle FeatureCollection
  if (geojson.type === "FeatureCollection") {
    const results: string[] = [];
    for (const feature of geojson.features) {
      const res = geoJSONToPolylineStr(feature.geometry, precision);
      if (Array.isArray(res)) results.push(...res);
      else if (res) results.push(res);
    }
    return results;
  }

  // Handle LineString
  if (geojson.type === "LineString") {
    return encodePolyline(geojson.coordinates as [number, number][], precision);
  }

  // Handle MultiLineString
  if (geojson.type === "MultiLineString") {
    return geojson.coordinates.map((lineCoords) =>
      encodePolyline(lineCoords as [number, number][], precision),
    );
  }

  return "";
}

export interface PolylineBatchOptions {
  /** Coordinate precision (default: 5) */
  precision?: number;
  /** Whether to unescape `\\` backslashes (default: true) */
  unescape?: boolean;
  /** Custom delimiter string or RegExp separating individual polylines (default: newline) */
  delimiter?: string | RegExp;
  /** Whether to merge lines into a single MultiLineString feature (default: false) */
  asMultiLine?: boolean;
  /** Optional base properties to assign to output features */
  baseProperties?: GeoJsonProperties;
}

/**
 * Parses and batch-decodes multiple polylines from a text block or file content.
 *
 * @param input - Multiline string or delimited text containing encoded polylines.
 * @param options - Decoding and parsing configuration.
 * @returns A FeatureCollection containing LineString (or MultiLineString) features.
 */
export function batchDecodePolylines(
  input: string,
  options: PolylineBatchOptions = {},
): FeatureCollection<LineString | MultiLineString> {
  if (!input || typeof input !== "string") {
    return { type: "FeatureCollection", features: [] };
  }

  const {
    precision = 5,
    unescape = true,
    delimiter = /\r?\n/,
    asMultiLine = false,
    baseProperties = {},
  } = options;

  const rawChunks = input.split(delimiter);
  const validLineCoords: [number, number][][] = [];
  const features: Feature<LineString>[] = [];

  for (let i = 0; i < rawChunks.length; i++) {
    const raw = rawChunks[i].trim();
    if (!raw) continue;
    // Strip optional surrounding quotes (e.g. from CSV or JSON extract)
    const cleaned = raw.replace(/^["']|["']$/g, "").trim();
    if (!cleaned) continue;

    const decodeResult = decodePolylineDetailed(cleaned, precision, unescape);
    if (decodeResult.complete && decodeResult.coordinates.length >= 2) {
      const coords = decodeResult.coordinates;
      validLineCoords.push(coords);
      features.push({
        type: "Feature",
        properties: {
          ...baseProperties,
          line_index: features.length + 1,
          point_count: coords.length,
        },
        geometry: {
          type: "LineString",
          coordinates: coords,
        },
      });
    }
  }

  if (asMultiLine && validLineCoords.length > 0) {
    const multiFeature: Feature<MultiLineString> = {
      type: "Feature",
      properties: {
        ...baseProperties,
        line_count: validLineCoords.length,
        point_count: validLineCoords.reduce((acc, c) => acc + c.length, 0),
      },
      geometry: {
        type: "MultiLineString",
        coordinates: validLineCoords,
      },
    };
    return {
      type: "FeatureCollection",
      features: [multiFeature],
    };
  }

  return {
    type: "FeatureCollection",
    features,
  };
}
