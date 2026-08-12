import maplibregl, { type RequestParameters } from "maplibre-gl";
import type { GeoTIFF, TypedArrayWithDimensions } from "geotiff";

const PROTOCOL = "cog-dem";
const TILE_SIZE = 256;
const WEB_MERCATOR_HALF_WORLD = 20_037_508.342789244;
const MAX_MERCATOR_LATITUDE = 85.0511287798066;

type DemProjection = "EPSG:3857" | "EPSG:4326";

interface CogDemDataset {
  tiff: GeoTIFF;
  projection: DemProjection;
  nodata: number | null;
  band: number;
}

export interface CogDemSourceRegistration {
  /** Tile template suitable for a MapLibre raster-dem source. */
  tiles: [string];
  /** Geographic extent reported by the COG, when it can be derived safely. */
  bounds?: [number, number, number, number];
  /** Release the COG reader after this terrain source is replaced. */
  dispose: () => void;
}

const datasets = new Map<string, CogDemDataset>();
let datasetSequence = 0;
let protocolRegistered = false;

/** Encode elevations in metres into Mapzen Terrarium RGB pixels. */
export function encodeTerrariumDem(
  elevations: ArrayLike<number>,
  nodata: number | null = null,
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(elevations.length * 4);
  for (let index = 0; index < elevations.length; index += 1) {
    const elevation = Number(elevations[index]);
    const missing = !Number.isFinite(elevation) || (nodata !== null && elevation === nodata);
    // MapLibre's raster-dem decoder has no missing-data representation. A flat
    // zero-metre pixel is the least surprising fill outside a partial DEM and
    // avoids the extreme spike that encoding NaN would otherwise produce.
    const encoded = Math.min(65_535.99609375, Math.max(0, (missing ? 0 : elevation) + 32_768));
    const red = Math.floor(encoded / 256);
    const greenBlue = encoded - red * 256;
    const offset = index * 4;
    rgba[offset] = red;
    rgba[offset + 1] = Math.floor(greenBlue);
    rgba[offset + 2] = Math.round((greenBlue - Math.floor(greenBlue)) * 256);
    rgba[offset + 3] = 255;
  }
  return rgba;
}

function mercatorTileBounds(z: number, x: number, y: number): [number, number, number, number] {
  const span = (WEB_MERCATOR_HALF_WORLD * 2) / 2 ** z;
  const minX = -WEB_MERCATOR_HALF_WORLD + x * span;
  const maxY = WEB_MERCATOR_HALF_WORLD - y * span;
  return [minX, maxY - span, minX + span, maxY];
}

function mercatorYToLatitude(y: number): number {
  return (Math.atan(Math.sinh(y / 6_378_137)) * 180) / Math.PI;
}

function longitudeFromMercatorX(x: number): number {
  return (x / WEB_MERCATOR_HALF_WORLD) * 180;
}

function geographicBounds(
  sourceBounds: number[],
  projection: DemProjection,
): [number, number, number, number] {
  const bounds =
    projection === "EPSG:3857"
      ? [
          longitudeFromMercatorX(sourceBounds[0]),
          mercatorYToLatitude(sourceBounds[1]),
          longitudeFromMercatorX(sourceBounds[2]),
          mercatorYToLatitude(sourceBounds[3]),
        ]
      : sourceBounds;
  return [
    Math.max(-180, bounds[0]),
    Math.max(-MAX_MERCATOR_LATITUDE, bounds[1]),
    Math.min(180, bounds[2]),
    Math.min(MAX_MERCATOR_LATITUDE, bounds[3]),
  ];
}

function projectionFromGeoKeys(geoKeys: Record<string, unknown> | null): DemProjection | null {
  const projected = Number(geoKeys?.ProjectedCSTypeGeoKey);
  if (projected === 3857 || projected === 900913 || projected === 102100) return "EPSG:3857";
  const geographic = Number(geoKeys?.GeographicTypeGeoKey);
  if (geographic === 4326) return "EPSG:4326";
  return null;
}

function normalizeNoData(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function remapGeographicRows(
  source: TypedArrayWithDimensions,
  mercatorBounds: [number, number, number, number],
): Float64Array {
  const output = new Float64Array(TILE_SIZE * TILE_SIZE);
  const [, minY, , maxY] = mercatorBounds;
  const north = mercatorYToLatitude(maxY);
  const south = mercatorYToLatitude(minY);
  const latitudeSpan = north - south;
  for (let row = 0; row < TILE_SIZE; row += 1) {
    const mercatorY = maxY - ((row + 0.5) / TILE_SIZE) * (maxY - minY);
    const latitude = mercatorYToLatitude(mercatorY);
    const sourceY = ((north - latitude) / latitudeSpan) * (source.height - 1);
    const y0 = Math.max(0, Math.min(source.height - 1, Math.floor(sourceY)));
    const y1 = Math.min(source.height - 1, y0 + 1);
    const fraction = sourceY - y0;
    for (let column = 0; column < TILE_SIZE; column += 1) {
      const a = Number(source[y0 * source.width + column]);
      const b = Number(source[y1 * source.width + column]);
      output[row * TILE_SIZE + column] = a + (b - a) * fraction;
    }
  }
  return output;
}

async function readTile(
  dataset: CogDemDataset,
  z: number,
  x: number,
  y: number,
): Promise<ArrayLike<number>> {
  const bounds = mercatorTileBounds(z, x, y);
  const bbox =
    dataset.projection === "EPSG:3857"
      ? bounds
      : [
          longitudeFromMercatorX(bounds[0]),
          mercatorYToLatitude(bounds[1]),
          longitudeFromMercatorX(bounds[2]),
          mercatorYToLatitude(bounds[3]),
        ];
  const rasters = await dataset.tiff.readRasters({
    bbox,
    width: TILE_SIZE,
    height: TILE_SIZE,
    samples: [dataset.band],
    interleave: true,
    resampleMethod: "bilinear",
    fillValue: Number.NaN,
  });
  const values = rasters as TypedArrayWithDimensions;
  return dataset.projection === "EPSG:4326" ? remapGeographicRows(values, bounds) : values;
}

async function rgbaToPng(rgba: Uint8ClampedArray): Promise<ArrayBuffer> {
  const imageData = new ImageData(
    new Uint8ClampedArray(
      rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength) as ArrayBuffer,
    ),
    TILE_SIZE,
    TILE_SIZE,
  );
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create a canvas for the COG DEM tile.");
    context.putImageData(imageData, 0, 0);
    return (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer();
  }
  if (typeof document === "undefined") {
    throw new Error("COG DEM tiles require a browser canvas.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = TILE_SIZE;
  canvas.height = TILE_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create a canvas for the COG DEM tile.");
  context.putImageData(imageData, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error("Could not encode DEM PNG."))),
      "image/png",
    ),
  );
  return blob.arrayBuffer();
}

function parseTileRequest(request: RequestParameters): {
  key: string;
  z: number;
  x: number;
  y: number;
} {
  const match = /^cog-dem:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)$/.exec(request.url);
  if (!match) throw new Error(`Invalid COG DEM tile URL: ${request.url}`);
  return { key: match[1], z: Number(match[2]), x: Number(match[3]), y: Number(match[4]) };
}

function ensureCogDemProtocol(): void {
  if (protocolRegistered) return;
  maplibregl.addProtocol(PROTOCOL, async (request) => {
    const { key, z, x, y } = parseTileRequest(request);
    const dataset = datasets.get(key);
    if (!dataset) throw new Error("The COG DEM source is no longer available.");
    const elevations = await readTile(dataset, z, x, y);
    return { data: await rgbaToPng(encodeTerrariumDem(elevations, dataset.nodata)) };
  });
  protocolRegistered = true;
}

/** Open and validate a single-band COG for use as a MapLibre terrain source. */
export async function registerCogDemSource(
  source: string | Blob,
  band = 1,
): Promise<CogDemSourceRegistration> {
  const normalizedSource = typeof source === "string" ? source.trim() : source;
  if (
    !normalizedSource ||
    (typeof Blob !== "undefined" && source instanceof Blob && source.size === 0)
  ) {
    throw new Error("Choose a local COG DEM or enter its URL.");
  }
  const { fromBlob, fromUrl } = await import("geotiff");
  const tiff =
    typeof normalizedSource === "string"
      ? await fromUrl(normalizedSource)
      : await fromBlob(normalizedSource);
  const image = await tiff.getImage();
  if (band < 1 || band > image.getSamplesPerPixel()) {
    throw new Error(`Band ${band} does not exist in this COG.`);
  }
  const projection = projectionFromGeoKeys(image.getGeoKeys() as Record<string, unknown> | null);
  if (!projection) {
    await tiff.close();
    throw new Error("COG terrain currently supports EPSG:3857 and EPSG:4326 DEMs.");
  }
  ensureCogDemProtocol();
  const key = String(++datasetSequence);
  const directory = image.getFileDirectory() as unknown as Record<string, unknown>;
  datasets.set(key, {
    tiff,
    projection,
    nodata: normalizeNoData(directory.GDAL_NODATA),
    band: band - 1,
  });
  const sourceBounds = image.getBoundingBox();
  const bounds = geographicBounds(sourceBounds, projection);
  return {
    tiles: [`${PROTOCOL}://${key}/{z}/{x}/{y}`],
    bounds,
    dispose: () => {
      const dataset = datasets.get(key);
      datasets.delete(key);
      void dataset?.tiff.close();
    },
  };
}
