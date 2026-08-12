import maplibregl, { type RequestParameters } from "maplibre-gl";
import type { GeoTIFF, GeoTIFFImage, TypedArrayWithDimensions } from "geotiff";

const PROTOCOL = "cog-dem";
const TILE_SIZE = 256;
const WEB_MERCATOR_HALF_WORLD = 20_037_508.342789244;
const MAX_MERCATOR_LATITUDE = 85.0511287798066;
/** TIFF NewSubfileType bit 2: the IFD is a transparency mask, not imagery. */
const MASK_SUBFILE_TYPE = 0b100;

type DemProjection = "EPSG:3857" | "EPSG:4326";

interface CogDemDataset {
  tiff: GeoTIFF;
  images: GeoTIFFImage[];
  sourceBounds: [number, number, number, number];
  projection: DemProjection;
  nodata: number | null;
  band: number;
}

export interface CogDemSourceRegistration {
  /** Tile template suitable for a MapLibre raster-dem source. */
  tiles: [string];
  /** Geographic extent reported by the COG, when it can be derived safely. */
  bounds?: [number, number, number, number];
  /** Render one terrain tile. Exposed for diagnostics and integration tests. */
  renderTile: (z: number, x: number, y: number) => Promise<Uint8ClampedArray>;
  /** Release the COG reader after this terrain source is replaced. */
  dispose: () => void;
}

const datasets = new Map<string, CogDemDataset>();
let datasetSequence = 0;
let protocolRegistered = false;

function isMissing(value: number, nodata: number | null): boolean {
  return !Number.isFinite(value) || (nodata !== null && value === nodata);
}

/** Encode elevations in metres into Mapzen Terrarium RGB pixels. */
export function encodeTerrariumDem(
  elevations: ArrayLike<number>,
  nodata: number | null = null,
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(elevations.length * 4);
  for (let index = 0; index < elevations.length; index += 1) {
    const elevation = Number(elevations[index]);
    const missing = isMissing(elevation, nodata);
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

/** Read the GDAL_NODATA tag as a number. Exported for tests. */
export function normalizeNoData(value: unknown): number | null {
  // GDAL writes GDAL_NODATA as a NUL-terminated ASCII field and geotiff.js
  // hands the NUL through, which Number() reads as NaN. parseFloat stops at the
  // terminator, so the sentinel survives and nodata pixels stay detectable.
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = typeof value === "string" ? parseFloat(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** Round a tile-space edge to a whole pixel inside the 256 px tile. */
function clampTileEdge(value: number): number {
  return Math.max(0, Math.min(TILE_SIZE, Math.round(value)));
}

function remapGeographicRows(
  source: Float64Array,
  mercatorBounds: [number, number, number, number],
  nodata: number | null = null,
): Float64Array {
  const output = new Float64Array(TILE_SIZE * TILE_SIZE);
  const [, minY, , maxY] = mercatorBounds;
  const north = mercatorYToLatitude(maxY);
  const south = mercatorYToLatitude(minY);
  const latitudeSpan = north - south;
  for (let row = 0; row < TILE_SIZE; row += 1) {
    const mercatorY = maxY - ((row + 0.5) / TILE_SIZE) * (maxY - minY);
    const latitude = mercatorYToLatitude(mercatorY);
    const sourceY = ((north - latitude) / latitudeSpan) * (TILE_SIZE - 1);
    const y0 = Math.max(0, Math.min(TILE_SIZE - 1, Math.floor(sourceY)));
    const y1 = Math.min(TILE_SIZE - 1, y0 + 1);
    const fraction = sourceY - y0;
    for (let column = 0; column < TILE_SIZE; column += 1) {
      const a = source[y0 * TILE_SIZE + column];
      const b = source[y1 * TILE_SIZE + column];
      // Interpolating across a nodata sentinel (commonly -9999 or -3.4e38)
      // would produce a value near, but not equal to, the sentinel — slipping
      // past the equality check in encodeTerrariumDem and drawing a spike at
      // the DEM edge. Fall back to the nearer sample instead of blending.
      output[row * TILE_SIZE + column] =
        isMissing(a, nodata) || isMissing(b, nodata)
          ? fraction < 0.5
            ? a
            : b
          : a + (b - a) * fraction;
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
  const requestedResolution = Math.max(
    Math.abs(bbox[2] - bbox[0]) / TILE_SIZE,
    Math.abs(bbox[3] - bbox[1]) / TILE_SIZE,
  );
  // Pick the coarsest overview that is still at least as detailed as the
  // requested tile. Using GeoTIFF.readRasters({bbox}) here looks convenient,
  // but on a global 86,400 x 43,200 COG such as GEBCO it may allocate an
  // intermediate array for the base image before resizing it (hundreds of
  // billions of entries). Selecting the IFD and pixel window explicitly keeps
  // memory proportional to one 256 px terrain tile.
  let image = dataset.images[0];
  for (const candidate of dataset.images) {
    const resolution = candidate.getResolution(dataset.images[0]);
    if (Math.max(Math.abs(resolution[0]), Math.abs(resolution[1])) <= requestedResolution) {
      image = candidate;
    } else {
      break;
    }
  }
  const [sourceMinX, sourceMinY, sourceMaxX, sourceMaxY] = dataset.sourceBounds;
  const clipped: [number, number, number, number] = [
    Math.max(sourceMinX, bbox[0]),
    Math.max(sourceMinY, bbox[1]),
    Math.min(sourceMaxX, bbox[2]),
    Math.min(sourceMaxY, bbox[3]),
  ];
  if (clipped[0] >= clipped[2] || clipped[1] >= clipped[3]) {
    return new Float64Array(TILE_SIZE * TILE_SIZE).fill(Number.NaN);
  }
  const width = image.getWidth();
  const height = image.getHeight();
  // On a coarse overview a thin clipped extent can floor and ceil onto the same
  // pixel boundary, which would hand readRasters an empty window. Keep the
  // window at least one pixel wide and tall.
  const left = Math.min(
    width - 1,
    Math.max(0, Math.floor(((clipped[0] - sourceMinX) / (sourceMaxX - sourceMinX)) * width)),
  );
  const top = Math.min(
    height - 1,
    Math.max(0, Math.floor(((sourceMaxY - clipped[3]) / (sourceMaxY - sourceMinY)) * height)),
  );
  const window = [
    left,
    top,
    Math.min(
      width,
      Math.max(
        left + 1,
        Math.ceil(((clipped[2] - sourceMinX) / (sourceMaxX - sourceMinX)) * width),
      ),
    ),
    Math.min(
      height,
      Math.max(
        top + 1,
        Math.ceil(((sourceMaxY - clipped[1]) / (sourceMaxY - sourceMinY)) * height),
      ),
    ),
  ];
  // The window covers whole source pixels, so its own extent — not the extent
  // that was asked for — says where these samples belong in the tile. Resizing
  // the window straight to 256 x 256 would stretch a partial overlap across the
  // whole tile, so read it at the size of the sub-rectangle it really occupies
  // and leave the rest of the tile as nodata.
  const pixelSpanX = (sourceMaxX - sourceMinX) / width;
  const pixelSpanY = (sourceMaxY - sourceMinY) / height;
  const tileColumn = (sourceX: number) =>
    clampTileEdge(((sourceX - bbox[0]) / (bbox[2] - bbox[0])) * TILE_SIZE);
  const tileRow = (sourceY: number) =>
    clampTileEdge(((bbox[3] - sourceY) / (bbox[3] - bbox[1])) * TILE_SIZE);
  const destLeft = tileColumn(sourceMinX + window[0] * pixelSpanX);
  const destTop = tileRow(sourceMaxY - window[1] * pixelSpanY);
  const destWidth = Math.max(1, tileColumn(sourceMinX + window[2] * pixelSpanX) - destLeft);
  const destHeight = Math.max(1, tileRow(sourceMaxY - window[3] * pixelSpanY) - destTop);
  const rasters = await image.readRasters({
    window,
    width: destWidth,
    height: destHeight,
    samples: [dataset.band],
    interleave: true,
    // Nearest, not bilinear: bilinear blends real samples with the nodata
    // sentinel at void/ocean/DEM edges, and the blend lands near — but not on
    // — the sentinel, so encodeTerrariumDem reads it as a real elevation and
    // draws a spike. An overview at least as detailed as the tile is selected
    // above, so the resampling ratio is small either way.
    resampleMethod: "nearest",
    fillValue: Number.NaN,
  });
  const values = rasters as TypedArrayWithDimensions;
  const tile = new Float64Array(TILE_SIZE * TILE_SIZE).fill(Number.NaN);
  for (let row = 0; row < destHeight && destTop + row < TILE_SIZE; row += 1) {
    const target = (destTop + row) * TILE_SIZE + destLeft;
    for (let column = 0; column < destWidth && destLeft + column < TILE_SIZE; column += 1) {
      tile[target + column] = Number(values[row * destWidth + column]);
    }
  }
  return dataset.projection === "EPSG:4326"
    ? remapGeographicRows(tile, bounds, dataset.nodata)
    : tile;
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
    await tiff.close();
    throw new Error(`Band ${band} does not exist in this COG.`);
  }
  const projection = projectionFromGeoKeys(image.getGeoKeys() as Record<string, unknown> | null);
  if (!projection) {
    await tiff.close();
    throw new Error("COG terrain currently supports EPSG:3857 and EPSG:4326 DEMs.");
  }
  ensureCogDemProtocol();
  let images: GeoTIFFImage[];
  try {
    const imageCount = await tiff.getImageCount();
    const allImages = await Promise.all(
      Array.from({ length: imageCount }, (_, index) => tiff.getImage(index)),
    );
    // getImageCount() counts every IFD, transparency masks included. A mask IFD
    // left in this list can win the overview selection in readTile and have its
    // mask samples read as elevations, so keep only the full-resolution image
    // and the reduced-resolution overviews.
    images = allImages.filter((candidate, index) => {
      if (index === 0) return true;
      const subfileType = Number(
        (candidate.getFileDirectory() as unknown as Record<string, unknown>).NewSubfileType ?? 0,
      );
      return (subfileType & MASK_SUBFILE_TYPE) === 0;
    });
  } catch (error) {
    // A truncated or corrupt overview IFD must not leak the open reader.
    await tiff.close();
    throw error;
  }
  const key = String(++datasetSequence);
  const directory = image.getFileDirectory() as unknown as Record<string, unknown>;
  datasets.set(key, {
    tiff,
    images,
    sourceBounds: image.getBoundingBox() as [number, number, number, number],
    projection,
    nodata: normalizeNoData(directory.GDAL_NODATA),
    band: band - 1,
  });
  const sourceBounds = image.getBoundingBox();
  const bounds = geographicBounds(sourceBounds, projection);
  const dataset = datasets.get(key)!;
  return {
    tiles: [`${PROTOCOL}://${key}/{z}/{x}/{y}`],
    bounds,
    renderTile: async (z, x, y) =>
      encodeTerrariumDem(await readTile(dataset, z, x, y), dataset.nodata),
    dispose: () => {
      const dataset = datasets.get(key);
      datasets.delete(key);
      void dataset?.tiff.close();
    },
  };
}
