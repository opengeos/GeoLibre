// High-performance GeoArrow binary vector pipeline for GeoLibre.
//
// Experimental WKB conversion helpers, currently used by tests and benchmarks.
// Hybrid results retain GeoJSON alongside typed arrays, increasing resident memory.
// Worker tiling still reconstructs GeoJSON; only coordinate buffers avoid object cloning.

import {
  computeGeoArrowBBox,
  featureCollectionToGeoArrow,
  geoArrowToFeatureCollection,
  type GeoArrowBatch,
  type GeoArrowGeometryType,
} from "@geolibre/core";
import { normalizePropertyValue } from "./duckdb-geometry";
import { decodeWkb } from "./geometry-wkb";
import type { Feature, FeatureCollection, Geometry } from "geojson";

function wkbCellToBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value.length > 0 ? value : null;
  if (typeof value === "string" && value.length > 0) {
    try {
      return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    } catch {
      return null;
    }
  }
  return null;
}

interface DecodedWkbInfo {
  code: number;
  hasZ: boolean;
  dim: 2 | 3;
}

function inspectWkbHeader(bytes: Uint8Array): DecodedWkbInfo | null {
  if (bytes.length < 5) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = view.getUint8(0) === 1;
  const rawType = view.getUint32(1, little);

  const hasEwkbZ = (rawType & 0x80000000) !== 0;
  const baseType = rawType & 0xffff;
  const isoGroup = Math.floor((baseType % 4000) / 1000);
  const code = baseType % 1000;
  const hasZ = hasEwkbZ || isoGroup === 1 || isoGroup === 3;

  return { code, hasZ, dim: hasZ ? 3 : 2 };
}

/**
 * Decode rows containing raw WKB geometry buffers into a contiguous {@link GeoArrowBatch}.
 *
 * Scans WKB headers to determine geometry type, then decodes coordinates directly
 * into contiguous typed arrays (Float64Array + Int32Array offsets).
 *
 * @param rows Query result rows (e.g. from DuckDB ST_Read with keep_wkb=true, or ST_AsWKB).
 * @param wkbColumn Name of the column carrying WKB bytes.
 * @param preferredType Optional hint if the geometry column type is already known.
 * @returns The optimized GeoArrowBatch.
 */
export function wkbRowsToGeoArrowBatch(
  rows: ReadonlyArray<Record<string, unknown>>,
  wkbColumn: string,
  preferredType?: GeoArrowGeometryType,
  outFeatures?: { features?: Feature<Geometry | null>[] },
): GeoArrowBatch | null {
  const featureCount = rows.length;
  if (featureCount === 0) {
    return {
      geometryType: preferredType ?? "Point",
      coordinates: new Float64Array(0),
      coordDimensions: 2,
      featureCount: 0,
      properties: [],
    };
  }

  // First pass: extract properties and inspect WKB cells
  const properties: Record<string, unknown>[] = new Array(featureCount);
  const wkbBytesList: (Uint8Array | null)[] = new Array(featureCount);

  let hasValidGeom = false;
  let isAllPoints = true;
  let hasZ = false;

  for (let i = 0; i < featureCount; i++) {
    const row = rows[i];
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === wkbColumn || value instanceof Uint8Array) continue;
      props[key] = normalizePropertyValue(value);
    }
    properties[i] = props;

    const bytes = wkbCellToBytes(row[wkbColumn]);
    wkbBytesList[i] = bytes;

    if (bytes) {
      const header = inspectWkbHeader(bytes);
      if (header) {
        hasValidGeom = true;
        if (header.code !== 1) {
          isAllPoints = false;
        }
        if (header.hasZ) hasZ = true;
      }
    }
  }

  const dim: 2 | 3 = hasZ ? 3 : 2;

  // Handle Point geometries only when all non-null geometry headers have code 1
  if (hasValidGeom && isAllPoints) {
    const coordinates = new Float64Array(featureCount * dim);
    for (let i = 0; i < featureCount; i++) {
      const bytes = wkbBytesList[i];
      const o = i * dim;
      if (bytes && bytes.length >= 21) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const little = view.getUint8(0) === 1;
        // WKB Point coordinates start at byte 5 (or byte 9 if EWKB SRID is present)
        const rawType = view.getUint32(1, little);
        const hasSrid = (rawType & 0x20000000) !== 0;
        const coordOffset = hasSrid ? 9 : 5;

        if (coordOffset + 16 <= bytes.length) {
          coordinates[o] = view.getFloat64(coordOffset, little);
          coordinates[o + 1] = view.getFloat64(coordOffset + 8, little);
          if (dim === 3 && inspectWkbHeader(bytes)?.hasZ && coordOffset + 24 <= bytes.length) {
            coordinates[o + 2] = view.getFloat64(coordOffset + 16, little);
          }
        } else {
          coordinates[o] = NaN;
          coordinates[o + 1] = NaN;
        }
      } else {
        coordinates[o] = NaN;
        coordinates[o + 1] = NaN;
        if (dim === 3) coordinates[o + 2] = NaN;
      }
    }

    const batch: GeoArrowBatch = {
      geometryType: "Point",
      coordinates,
      coordDimensions: dim,
      featureCount,
      properties,
    };
    const bbox = computeGeoArrowBBox(batch);
    return bbox ? { ...batch, bbox } : batch;
  }

  // For LineString or Polygon, decode using decodeWkbRowsToFeatures and flatten into GeoArrowBatch
  // This guarantees complete support for holes, MultiPolygons, mixed endianness, and surface types
  const features = decodeWkbRowsToFeatures(rows, wkbColumn);
  if (outFeatures) {
    outFeatures.features = features;
  }

  const fc = { type: "FeatureCollection" as const, features };
  return featureCollectionToGeoArrow(fc as FeatureCollection<Geometry | null>);
}

/**
 * Decode an array of SQL/DuckDB row records into standard GeoJSON features.
 * Shared between the GeoArrow conversion pipeline and the GeoJSON fallback.
 */
export function decodeWkbRowsToFeatures(
  rows: ReadonlyArray<Record<string, unknown>>,
  wkbColumn: string,
): Feature<Geometry | null>[] {
  const featureCount = rows.length;
  const features: Feature<Geometry | null>[] = new Array(featureCount);
  for (let i = 0; i < featureCount; i++) {
    const row = rows[i];
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === wkbColumn || value instanceof Uint8Array) continue;
      props[key] = normalizePropertyValue(value);
    }
    const bytes = wkbCellToBytes(row[wkbColumn]);
    let geometry: Geometry | null = null;
    if (bytes) {
      try {
        geometry = decodeWkb(bytes);
      } catch (err) {
        console.warn("[GeoLibre] Skipped an undecodable WKB geometry in GeoArrow pipeline", err);
      }
    }
    features[i] = {
      type: "Feature",
      geometry,
      properties: props,
    };
  }
  return features;
}

/**
 * Build a hybrid layer result that holds both a fast binary {@link GeoArrowBatch}
 * and a standard GeoJSON {@link FeatureCollection}.
 *
 * Retains the decoded GeoJSON for attribute tables, selection and other renderers.
 * The binary representation is additional storage, not a replacement for GeoJSON.
 */
export function createOptimizedVectorLayerData(
  rows: ReadonlyArray<Record<string, unknown>>,
  wkbColumn: string,
): { geoarrow?: GeoArrowBatch; geojson: FeatureCollection<Geometry | null> } {
  const cached: { features?: Feature<Geometry | null>[] } = {};
  const geoarrow = wkbRowsToGeoArrowBatch(rows, wkbColumn, undefined, cached);
  if (geoarrow) {
    const geojson: FeatureCollection<Geometry | null> = cached.features
      ? { type: "FeatureCollection", features: cached.features }
      : geoArrowToFeatureCollection(geoarrow);
    return { geoarrow, geojson };
  }

  // If GeoArrow conversion returned null (e.g. unsupported geometry or failure),
  // retain already-decoded features from the non-Point attempt or decode rows once.
  const features = cached.features ?? decodeWkbRowsToFeatures(rows, wkbColumn);
  return { geojson: { type: "FeatureCollection", features } };
}
