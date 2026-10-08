import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from "geojson";
import { fromArrayBuffer } from "geotiff";
import { readRasterData, writeRasterBands } from "./raster-client";
import { runWasmToolInBackground } from "./wasm-tool-runner";

/**
 * Object-based image analysis (OBIA) engine for the Object-Based Analysis
 * workbench (#3053).
 *
 * Wraps the geolibre-wasm OBIA tools (segmentation, polygonization) so the
 * workbench drives typed functions instead of CLI strings. Everything runs in
 * the browser on the WASI tool runner; nothing here touches the store or the
 * map, so the app layer owns layers and UI state.
 */

/** Why an OBIA call refused its input, for the UI to translate. */
export type ObiaErrorCode = "image-too-large" | "no-such-band" | "no-bands";

/**
 * An input the workbench rejects, with a stable `code` and `params` the app
 * maps to a translated message (`message` stays English for logs and scripts).
 */
export class ObiaError extends Error {
  readonly code: ObiaErrorCode;
  readonly params: Record<string, number>;

  constructor(code: ObiaErrorCode, message: string, params: Record<string, number> = {}) {
    super(message);
    this.name = "ObiaError";
    this.code = code;
    this.params = params;
  }
}

/** Object ids are the segment label values the segmentation raster carries. */
export const OBIA_SEGMENT_ID_FIELD = "segment_id";

/** Pixel-count ceiling for a workbench run (about a 4096 x 4096 scene). */
export const OBIA_MAX_PIXELS = 16_777_216;

/** Parameters of the seeded region-growing segmentation. */
export interface RegionGrowingParams {
  /**
   * Growth threshold as a distance in standardized (z-score) band space: a
   * pixel joins a region while its distance to the region seed is at most this
   * value. Larger values give fewer, larger objects.
   */
  threshold: number;
  /** Objects smaller than this many pixels merge into their most similar neighbor. */
  minArea: number;
  /** Number of seed-priority bins (homogeneous pixels seed first). */
  steps: number;
}

export const DEFAULT_REGION_GROWING_PARAMS: RegionGrowingParams = {
  threshold: 0.8,
  minArea: 20,
  steps: 10,
};

/** One band of the source image, written as a single-band GeoTIFF. */
export interface ObiaBand {
  /** 1-based band index in the source image. */
  index: number;
  bytes: Uint8Array;
}

/** A source image split into the single-band rasters the OBIA tools read. */
export interface ObiaImage {
  width: number;
  height: number;
  bandCount: number;
  nodata: number | null;
  bands: ObiaBand[];
}

/** Result of segmenting an image into objects. */
export interface ObiaSegmentation {
  /** Label raster (GeoTIFF): each pixel holds its object's `segment_id`. */
  labels: Uint8Array;
  /** One feature per object in WGS84, `id` and `segment_id` set to the label. */
  objects: FeatureCollection;
  objectCount: number;
  /** Mean object size in pixels. */
  meanObjectArea: number;
  /** Exact tool invocation, for provenance. */
  tool: string;
  args: string[];
}

function toArrayBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Split a (multi-band) GeoTIFF into single-band GeoTIFFs, one per band, keeping
 * the georeferencing and NoData. The OBIA tools take an array of single-band
 * rasters, and the spectral features name their columns by that order.
 *
 * @param bytes GeoTIFF bytes of the source image.
 * @param bandIndexes 1-based bands to keep; all bands when omitted.
 * @returns The image dimensions and one GeoTIFF per kept band.
 */
export async function splitImageBands(
  bytes: ArrayBuffer | Uint8Array,
  bandIndexes?: readonly number[],
): Promise<ObiaImage> {
  const buffer = toArrayBuffer(bytes);
  // Check the size from the header before decoding anything.
  const { width, height, bandCount } = await readImageSummary(buffer);
  if (width * height > OBIA_MAX_PIXELS) {
    throw new ObiaError(
      "image-too-large",
      `This image has ${width} x ${height} pixels, more than the ${OBIA_MAX_PIXELS.toLocaleString("en-US")} the in-browser workbench handles. Clip it to a smaller area first.`,
      { width, height, max: OBIA_MAX_PIXELS },
    );
  }
  const wanted = bandIndexes?.length
    ? [...bandIndexes]
    : Array.from({ length: bandCount }, (_, index) => index + 1);
  const missing = wanted.find(
    (index) => !Number.isInteger(index) || index < 1 || index > bandCount,
  );
  if (missing !== undefined) {
    throw new ObiaError("no-such-band", `The image has no band ${missing}.`, { index: missing });
  }
  // Decode only the chosen bands, in the order asked for.
  const raster = await readRasterData(buffer, { samples: wanted.map((index) => index - 1) });
  const bands = wanted.map((index, i) => {
    const single = writeRasterBands({ ...raster, bands: [raster.bands[i]] });
    return { index, bytes: new Uint8Array(single) };
  });
  return {
    width: raster.width,
    height: raster.height,
    bandCount,
    nodata: raster.nodata,
    bands,
  };
}

/** Size and band count of an image, read from its header only. */
export interface ObiaImageSummary {
  width: number;
  height: number;
  bandCount: number;
}

/**
 * Read an image's dimensions and band count without decoding its pixels, so
 * the workbench can list bands before the user commits to a run.
 *
 * @param bytes GeoTIFF bytes.
 */
export async function readImageSummary(bytes: ArrayBuffer | Uint8Array): Promise<ObiaImageSummary> {
  const tiff = await fromArrayBuffer(toArrayBuffer(bytes));
  const image = await tiff.getImage();
  return {
    width: image.getWidth(),
    height: image.getHeight(),
    bandCount: image.getSamplesPerPixel(),
  };
}

/** Stage the bands under /work and return their paths and the input map. */
export function stageBands(bands: readonly ObiaBand[]): {
  paths: string[];
  input: Record<string, Uint8Array>;
} {
  const input: Record<string, Uint8Array> = {};
  const paths = bands.map((band) => {
    const file = `band_${band.index}.tif`;
    input[file] = band.bytes;
    return `/work/${file}`;
  });
  return { paths, input };
}

/** CLI args for `image_segmentation` (seeded region growing). */
export function regionGrowingArgs(
  bandPaths: readonly string[],
  params: RegionGrowingParams,
  output = "/work/segments.tif",
): string[] {
  return [
    `--inputs=${bandPaths.join(",")}`,
    `--threshold=${params.threshold}`,
    `--steps=${Math.max(1, Math.round(params.steps))}`,
    `--min_area=${Math.max(1, Math.round(params.minArea))}`,
    `--output=${output}`,
  ];
}

function toolFailure(tool: string, stdout: readonly string[]): Error {
  const detail = stdout
    .filter((line) => line.trim())
    .slice(-3)
    .join(" ");
  return new Error(`${tool} failed${detail ? `: ${detail}` : ""}`);
}

async function runTool(
  tool: string,
  args: string[],
  input: Record<string, Uint8Array>,
): Promise<Record<string, Uint8Array>> {
  const result = await runWasmToolInBackground({ tool, args, input });
  if (result.exitCode !== 0) throw toolFailure(tool, result.stdout);
  return result.files;
}

/**
 * Group polygonized pieces by segment label into one feature per object. A
 * label can come back as several polygons (pixels joined only diagonally are
 * separate rings in the 4-connected trace), which become one MultiPolygon so
 * each object has exactly one feature and one id.
 *
 * @param pieces Polygonizer output, the label in `idProperty`.
 * @param idProperty Property holding the label (`VALUE` for segments_to_polygons).
 */
export function dissolveSegmentPolygons(
  pieces: FeatureCollection,
  idProperty = "VALUE",
): FeatureCollection {
  const rings = new Map<number, Position[][][]>();
  for (const feature of pieces.features) {
    const raw = feature.properties?.[idProperty];
    const id = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(id) || id <= 0) continue;
    const geometry = feature.geometry;
    let polygons: Position[][][];
    if (geometry?.type === "Polygon") polygons = [geometry.coordinates];
    else if (geometry?.type === "MultiPolygon") polygons = geometry.coordinates;
    else continue;
    const list = rings.get(id);
    if (list) list.push(...polygons);
    else rings.set(id, [...polygons]);
  }
  const features: Feature[] = [...rings.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, polygons]) => {
      const geometry: Polygon | MultiPolygon =
        polygons.length === 1
          ? { type: "Polygon", coordinates: polygons[0] }
          : { type: "MultiPolygon", coordinates: polygons };
      return {
        type: "Feature",
        id,
        properties: { [OBIA_SEGMENT_ID_FIELD]: id },
        geometry,
      };
    });
  return { type: "FeatureCollection", features };
}

/**
 * Segment an image into objects with seeded region growing and polygonize the
 * labels. Runs entirely in the browser.
 *
 * @param image Bands from {@link splitImageBands}.
 * @param params Region-growing parameters.
 */
export async function segmentImage(
  image: ObiaImage,
  params: RegionGrowingParams,
): Promise<ObiaSegmentation> {
  if (!image.bands.length) {
    throw new ObiaError("no-bands", "Choose at least one band to segment.");
  }
  const { paths, input } = stageBands(image.bands);
  const tool = "image_segmentation";
  const args = regionGrowingArgs(paths, params);
  const files = await runTool(tool, args, input);
  const labels = files["segments.tif"];
  if (!labels) throw new Error(`${tool} did not write a segment raster.`);

  const polygonFiles = await runTool(
    "segments_to_polygons",
    ["--segments=/work/segments.tif", "--output=/work/segments.geojson"],
    { "segments.tif": labels },
  );
  const geojson = polygonFiles["segments.geojson"];
  if (!geojson) throw new Error("segments_to_polygons did not write polygons.");
  const pieces = JSON.parse(new TextDecoder().decode(geojson)) as FeatureCollection;
  const objects = dissolveSegmentPolygons(pieces);
  const objectCount = objects.features.length;
  return {
    labels,
    objects,
    objectCount,
    meanObjectArea: objectCount ? (image.width * image.height) / objectCount : 0,
    tool,
    args,
  };
}
