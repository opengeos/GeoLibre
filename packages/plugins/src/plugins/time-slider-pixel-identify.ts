import { type CogSourceSpec, type MosaicSourceSpec, resolveUrl } from "maplibre-gl-time-slider";
import {
  type BandReading,
  loadGeoTIFF,
  loadMosaic,
  readBandNames,
  readPixelValues,
} from "maplibre-gl-raster";
import { getActiveTimeSliderControl } from "./maplibre-time-slider";

/**
 * Single-pixel Identify for the Time Slider's raster sources.
 *
 * The Layers-panel Identify icon reads band values under the cursor for a COG
 * layer added through Add Raster Layer. A Time Slider COG or mosaic source is
 * the same kind of data — it just resolves to a *different* file per timeline
 * date — so Identify reads it at whichever date the timeline currently sits on.
 *
 * This is deliberately the one-date sibling of `time-slider-pixel-series`: that
 * module walks the whole stack to chart a value over time, this one answers
 * "what is under my cursor right now". Both reuse `maplibre-gl-raster`'s
 * `loadGeoTIFF`/`readPixelValues`, so a read is an HTTP range request for the
 * single tile containing the pixel — no sidecar and no full-file download.
 *
 * Only `cog` and `mosaic` sources are readable. `xyz`/`wms` sources are
 * pre-rendered picture tiles with no source values to recover, and `geojson`
 * sources identify as vector features through the normal map query.
 */

/** A Time Slider source whose pixels can be read. */
export type PixelIdentifiableSpec = CogSourceSpec | MosaicSourceSpec;

/** The band values under one clicked point, at one timeline date. */
export interface TimeSliderPixelIdentifyResult {
  /** Source id (matches the mirrored store layer id). */
  sourceId: string;
  /** ISO date (`YYYY-MM-DD`) of the timeline position that was read. */
  date: string;
  /**
   * The COG the value came from. For a mosaic this is the individual asset
   * covering the click, not the manifest, so the reading is attributable.
   */
  url: string;
  /** Every band's reading at the clicked pixel. Empty is never returned — a
   * pixel with no readable bands resolves to null instead. */
  bands: BandReading[];
}

/** Raised when the click falls outside the data rather than failing to read it.
 * The caller reports "no data here" instead of an error. */
export class PixelOutsideCoverageError extends Error {
  constructor(message = "The clicked point is outside this layer's coverage.") {
    super(message);
    this.name = "PixelOutsideCoverageError";
  }
}

/**
 * Whether a Time Slider source spec exposes readable source pixels.
 *
 * @param type - The spec's `type` discriminant.
 * @returns True for `cog` and `mosaic` sources.
 */
export function isPixelIdentifiableSourceType(type: string | undefined): boolean {
  return type === "cog" || type === "mosaic";
}

/**
 * Look up a Time Slider source by id, when it is pixel-readable.
 *
 * @param sourceId - The source id (equals the mirrored store layer id).
 * @returns The COG or mosaic spec, or null when the dock is closed, the id is
 *   unknown, or the source is an XYZ/WMS/GeoJSON one.
 */
export function getPixelIdentifiableSource(sourceId: string): PixelIdentifiableSpec | null {
  const control = getActiveTimeSliderControl();
  if (!control) return null;
  const spec = control.getSources().find((candidate) => candidate.id === sourceId);
  if (!spec || !isPixelIdentifiableSourceType(spec.type)) return null;
  return spec as PixelIdentifiableSpec;
}

/** Format a date as `YYYY-MM-DD` in UTC, matching the pixel-series module. */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Whether a WGS84 point falls inside a `[minX, minY, maxX, maxY]` bbox. */
function bboxContains(bbox: [number, number, number, number], lng: number, lat: number): boolean {
  return lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

/**
 * Pick the mosaic asset to read a point from.
 *
 * Mosaic assets overlap at their seams, so a point can fall inside several
 * bboxes. Prefer the smallest matching asset: overlapping tiles in a mosaic are
 * conventionally ordered coarse-to-fine, and the tighter bbox is the one whose
 * centre the point is nearest, so it is the least likely to be reading the
 * feathered edge of a neighbouring scene.
 *
 * @param assets - The parsed mosaic's assets.
 * @param lngLat - The clicked location, `[lng, lat]` in WGS84.
 * @returns The asset URL to read, or null when no asset covers the point.
 */
export function pickMosaicAsset(
  assets: { url: string; bbox: [number, number, number, number] }[],
  lngLat: [number, number],
): string | null {
  const [lng, lat] = lngLat;
  let best: { url: string; area: number } | null = null;
  for (const asset of assets) {
    if (!bboxContains(asset.bbox, lng, lat)) continue;
    const area = (asset.bbox[2] - asset.bbox[0]) * (asset.bbox[3] - asset.bbox[1]);
    if (!best || area < best.area) best = { url: asset.url, area };
  }
  return best?.url ?? null;
}

/**
 * Read every band value at one point for a Time Slider COG or mosaic source, at
 * the timeline's current date.
 *
 * @param sourceId - The source id (equals the mirrored store layer id).
 * @param lngLat - The clicked location, `[lng, lat]` in WGS84.
 * @param options - Optional abort signal.
 * @returns The reading, or null when the pixel falls outside the image grid.
 * @throws {PixelOutsideCoverageError} When a mosaic has no asset covering the
 *   point — a miss in space rather than a failed read.
 * @throws When the source is unknown/not pixel-readable, or the COG cannot be
 *   opened (network, CORS, or a missing file for this date).
 */
export async function identifyTimeSliderPixel(
  sourceId: string,
  lngLat: [number, number],
  options: { signal?: AbortSignal } = {},
): Promise<TimeSliderPixelIdentifyResult | null> {
  const { signal } = options;
  const control = getActiveTimeSliderControl();
  const spec = getPixelIdentifiableSource(sourceId);
  if (!control || !spec) {
    throw new Error("This Time Slider source has no readable pixels.");
  }

  const date = control.getCurrentDate();
  const resolved = await resolveUrl(spec.url, date);
  if (signal?.aborted) return null;

  // A COG source resolves straight to the file; a mosaic resolves to a manifest
  // listing many COGs, so the covering asset has to be found first.
  let url = resolved;
  if (spec.type === "mosaic") {
    const mosaic = await loadMosaic(resolved, signal);
    if (signal?.aborted) return null;
    const assetUrl = pickMosaicAsset(mosaic.assets, lngLat);
    if (!assetUrl) throw new PixelOutsideCoverageError();
    url = assetUrl;
  }

  const tiff = await loadGeoTIFF(url);
  // loadGeoTIFF does not accept the abort signal, so once its header fetch
  // resolves, skip the pixel read if the identify was cancelled meanwhile.
  if (signal?.aborted) return null;
  const reading = await readPixelValues(tiff, lngLat, {
    signal,
    bandNames: readBandNames(tiff),
  });
  if (!reading || reading.bands.length === 0) return null;

  return { sourceId, date: isoDate(date), url, bands: reading.bands };
}

/**
 * The bridge shape consumed by `@geolibre/map` (MapCanvas), which cannot import
 * this package directly.
 */
export interface TimeSliderGlobalBridge {
  identifyPixelAt: typeof identifyTimeSliderPixel;
}

declare global {
  interface Window {
    __GEOLIBRE_TIME_SLIDER__?: TimeSliderGlobalBridge;
  }
}

if (typeof window !== "undefined") {
  // Frozen so its members cannot be swapped out by other scripts after
  // construction, mirroring the DuckDB bridge. Do not widen this API.
  window.__GEOLIBRE_TIME_SLIDER__ = Object.freeze({
    identifyPixelAt: identifyTimeSliderPixel,
  });
}
