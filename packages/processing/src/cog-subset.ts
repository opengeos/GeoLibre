// In-browser "export a raster subset" for Cloud Optimized GeoTIFFs and plain
// GeoTIFFs (opengeos/GeoLibre#1155). The layer context menu's whole-file
// "Export GeoTIFF" downloads every byte of a cloud-hosted COG; this reads only
// the pixels inside a drawn map extent and writes them to a smaller GeoTIFF that
// preserves the source's data values (raw, not the rendered colormap).
//
// For a remote COG this opens the file with `fromUrl`, so `readRasters({window})`
// fetches only the tiles overlapping the requested window via HTTP range
// requests rather than the whole file. Local/blob rasters are decoded from bytes
// the caller already has in hand. Everything runs client-side; no Python sidecar.
import { fromArrayBuffer, fromUrl, writeArrayBuffer } from "geotiff";
import proj4 from "proj4";

/** A geographic bounding box as `[west, south, east, north]` in EPSG:4326. */
export type Bbox4326 = [number, number, number, number];

/** The bytes and pixel dimensions of an exported raster subset. */
export interface CogSubsetResult {
  /** Encoded GeoTIFF bytes, ready to save to disk. */
  bytes: ArrayBuffer;
  /** Output width in pixels. */
  width: number;
  /** Output height in pixels. */
  height: number;
}

/**
 * Upper bound on output pixels (64M, e.g. ~8000x8000). A windowed read keeps a
 * tiny drawn box cheap even on a huge COG, but a box drawn over most of a large
 * full-resolution raster could still materialize a buffer big enough to freeze
 * the tab, so reject it with a clear message before allocating. Counted across
 * all bands (width x height x samples) since every band is materialized, and at
 * up to 8 bytes/sample this caps the pixel buffers near 512 MB.
 */
const MAX_SUBSET_CELLS = 64_000_000;

type TypedArray =
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Float32Array
  | Float64Array;

/**
 * geotiff's writer round-trips unsigned-int and float rasters but corrupts
 * signed integers (even with an explicit SampleFormat), so widen signed bands to
 * a float type that represents every source value exactly: int8/int16 fit in
 * Float32, int32 needs Float64. Unsigned and float bands are written as-is.
 *
 * @returns The (possibly widened) array plus its GeoTIFF BitsPerSample and
 *   SampleFormat (1 = unsigned int, 2 = signed int, 3 = IEEE float).
 */
function encodableBand(band: TypedArray): {
  values: TypedArray;
  bits: number;
  format: number;
} {
  if (band instanceof Uint8Array) return { values: band, bits: 8, format: 1 };
  if (band instanceof Uint16Array) return { values: band, bits: 16, format: 1 };
  if (band instanceof Uint32Array) return { values: band, bits: 32, format: 1 };
  if (band instanceof Float32Array) return { values: band, bits: 32, format: 3 };
  if (band instanceof Float64Array) return { values: band, bits: 64, format: 3 };
  if (band instanceof Int32Array) {
    return { values: Float64Array.from(band), bits: 64, format: 3 };
  }
  // Int8Array / Int16Array -> Float32 (exact for both ranges).
  return { values: Float32Array.from(band), bits: 32, format: 3 };
}

/**
 * Build a transform from EPSG:4326 lon/lat to the raster's CRS from its GeoKeys.
 * Returns an identity transform when the raster carries no CRS or is already
 * geographic WGS84 (coordinates are then assumed to be lon/lat). Throws when the
 * raster declares some other CRS that cannot be resolved, rather than silently
 * treating the lon/lat box as native coordinates and exporting the wrong region.
 */
async function makeToRaster(
  geoKeys: Record<string, unknown> | null,
): Promise<(lon: number, lat: number) => [number, number]> {
  const identity = (lon: number, lat: number): [number, number] => [lon, lat];
  const projected = geoKeys?.ProjectedCSTypeGeoKey;
  const geographic = geoKeys?.GeographicTypeGeoKey;
  // No CRS info, or plain geographic WGS84: the drawn box is already in the
  // raster's coordinates.
  if (!geoKeys || (projected == null && (geographic == null || geographic === 4326))) {
    return identity;
  }
  // Loaded on demand: the geokeys->proj4 EPSG database is large, so keep it out
  // of the eager bundle and only pull it in when an export needs it.
  const { toProj4 } = await import("geotiff-geokeys-to-proj4");
  let def: string | undefined;
  try {
    const projection = toProj4(geoKeys as never);
    // Drop `+axis=` (proj4 mishandles it) as the raster panel's parser does.
    def = projection?.proj4?.replace(/\+axis=\w+\s*/g, "");
  } catch {
    def = undefined;
  }
  if (!def) {
    throw new Error(
      "Could not determine this raster's coordinate system to reproject the export area.",
    );
  }
  const converter = proj4("EPSG:4326", def);
  return (lon, lat) => converter.forward([lon, lat]) as [number, number];
}

/**
 * Project a lon/lat bbox into the raster's CRS, sampling along each edge so a
 * curved projection (e.g. a UTM zone viewed at a wide extent) still yields a
 * bounding box that fully contains the drawn area.
 */
function projectBbox(
  bbox: Bbox4326,
  toRaster: (lon: number, lat: number) => [number, number],
): [number, number, number, number] {
  const [west, south, east, north] = bbox;
  const steps = 16;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const consider = (lon: number, lat: number) => {
    const [x, y] = toRaster(lon, lat);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    consider(west + (east - west) * t, south);
    consider(west + (east - west) * t, north);
    consider(west, south + (north - south) * t);
    consider(east, south + (north - south) * t);
  }
  return [minX, minY, maxX, maxY];
}

/**
 * Clip a GeoTIFF/COG to a drawn map extent and encode the result as a GeoTIFF.
 *
 * @param source - A remote COG URL (opened with range requests) or the raster's
 *   bytes for a local/blob-backed file.
 * @param bbox - The export extent as `[west, south, east, north]` in EPSG:4326
 *   (the map's CRS); reprojected into the raster's CRS internally.
 * @returns The clipped GeoTIFF bytes and its pixel dimensions.
 * @throws If the extent does not overlap the raster or the subset is too large
 *   for the in-browser engine.
 */
export async function exportCogSubset(
  source: string | ArrayBuffer,
  bbox: Bbox4326,
): Promise<CogSubsetResult> {
  const tiff =
    typeof source === "string"
      ? await fromUrl(source)
      : await fromArrayBuffer(source);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const [originX, originY] = image.getOrigin();
  const [resolutionX, resolutionY] = image.getResolution();
  const resX = Math.abs(resolutionX);
  const resY = Math.abs(resolutionY);
  const geoKeys = (image.getGeoKeys() as Record<string, unknown>) ?? null;

  const toRaster = await makeToRaster(geoKeys);
  const [minX, minY, maxX, maxY] = projectBbox(bbox, toRaster);

  // World coordinates -> pixel window, clamped to the raster's extent. Rows grow
  // southward from the north-up origin, so the northern edge (maxY) is row 0.
  const col0 = clamp(Math.floor((minX - originX) / resX), 0, width);
  const col1 = clamp(Math.ceil((maxX - originX) / resX), 0, width);
  const row0 = clamp(Math.floor((originY - maxY) / resY), 0, height);
  const row1 = clamp(Math.ceil((originY - minY) / resY), 0, height);
  const outW = col1 - col0;
  const outH = row1 - row0;
  if (outW <= 0 || outH <= 0) {
    throw new Error("The selected area does not overlap this raster.");
  }
  // Count cells across every band since all are materialized (a wide multiband
  // window is what actually blows up memory, not the per-band pixel count).
  if (outW * outH * image.getSamplesPerPixel() > MAX_SUBSET_CELLS) {
    throw new Error(
      "The selected area is too large to export in the browser. Zoom in or draw a smaller box.",
    );
  }

  const read = await image.readRasters({
    window: [col0, row0, col1, row1],
    interleave: false,
  });
  const bands = (Array.isArray(read) ? read : [read]) as TypedArray[];

  let encoded = bands.map(encodableBand);
  const bandCount = encoded.length;
  const pixels = outW * outH;
  // Bands must share one sample type to interleave into a single buffer. They
  // normally do, but a mixed-dtype file would truncate later bands when copied
  // into the first band's array type -- promote every band to Float64 (exact for
  // all integer/float sample types in play) rather than silently corrupt pixels.
  if (
    encoded.some((band) => band.values.constructor !== encoded[0].values.constructor)
  ) {
    encoded = encoded.map((band) => ({
      values: Float64Array.from(band.values),
      bits: 64,
      format: 3,
    }));
  }
  // Interleave into the flat pixel-major array the writer expects (it infers the
  // band count from values.length / (width * height)).
  const Ctor = encoded[0].values.constructor as new (n: number) => TypedArray;
  let values: TypedArray;
  if (bandCount === 1) {
    values = encoded[0].values;
  } else {
    values = new Ctor(pixels * bandCount);
    for (let p = 0; p < pixels; p += 1) {
      for (let b = 0; b < bandCount; b += 1) {
        values[p * bandCount + b] = encoded[b].values[p];
      }
    }
  }

  const metadata: Record<string, unknown> = {
    width: outW,
    height: outH,
    BitsPerSample: encoded.map((band) => band.bits),
    SampleFormat: encoded.map((band) => band.format),
    ModelPixelScale: [resX, resY, 0],
    // Tie pixel (0, 0)'s top-left corner to the window's north-west world corner.
    ModelTiepoint: [
      0,
      0,
      0,
      originX + col0 * resX,
      originY - row0 * resY,
      0,
    ],
  };
  const nodata = image.getGDALNoData();
  if (nodata != null && Number.isFinite(nodata)) {
    metadata.GDAL_NODATA = String(nodata);
  }
  if (geoKeys) {
    // Copy only the numeric GeoKeys. They fully describe the CRS, and geotiff's
    // writer emits the ASCII citation GeoKeys (the *CitationGeoKey strings) in a
    // form GDAL rejects, which poisons the whole CRS on read (a subset that then
    // opens with no CRS is useless for further processing).
    for (const [key, value] of Object.entries(geoKeys)) {
      if (typeof value === "number") metadata[key] = value;
    }
  }

  const bytes: ArrayBuffer = writeArrayBuffer(
    values,
    metadata as Parameters<typeof writeArrayBuffer>[1],
  );
  return { bytes, width: outW, height: outH };
}

/** Clamp `value` to the inclusive `[min, max]` range. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
