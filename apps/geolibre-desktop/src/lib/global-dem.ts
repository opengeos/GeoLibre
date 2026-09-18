import {
  convertRasterDataToCog,
  readRasterData,
  type RasterData,
  type WhiteboxTool,
} from "@geolibre/processing";

export const DOWNLOAD_GLOBAL_DEM_TOOL_ID = "download_global_dem";

const TILE_SIZE = 512;
const MAX_ZOOM = 12;
const MAX_TILES = 64;
const WEB_MERCATOR_LIMIT = 85.051129;
const EARTH_RADIUS = 6378137;
const ORIGIN_SHIFT = Math.PI * EARTH_RADIUS;
const TERRAIN_TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/geotiff/{z}/{x}/{y}.tif";

/** Built-in keyless network tool shown alongside GeoLibre raster tools. */
export const DOWNLOAD_GLOBAL_DEM_TOOL: WhiteboxTool = {
  id: DOWNLOAD_GLOBAL_DEM_TOOL_ID,
  display_name: "Download Global DEM",
  summary:
    "Download a DEM for the current map view or a bounding box drawn on the map. Elevation tiles are fetched from the public AWS Terrain Tiles dataset; no API key is required.",
  category: "Raster",
  taxonomy_category: "Raster",
  source: "geolibre",
  params: [
    {
      name: "bbox",
      description: "WGS84 extent as west,south,east,north.",
      kind: "string",
      required: true,
    },
    {
      name: "bbox_crs",
      description: "Coordinate reference system of the bounding box.",
      kind: "int",
      required: true,
      default: 4326,
    },
  ],
  return_type: "raster",
};

export function withGlobalDemTool(tools: WhiteboxTool[]): WhiteboxTool[] {
  return tools.some((tool) => tool.id === DOWNLOAD_GLOBAL_DEM_TOOL_ID)
    ? tools
    : [...tools, DOWNLOAD_GLOBAL_DEM_TOOL];
}

export interface GlobalDemRequest {
  bbox: string;
  bboxCrs: number;
  signal?: AbortSignal;
}

export class GlobalDemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlobalDemError";
  }
}

interface TileRange {
  zoom: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  westPixel: number;
  eastPixel: number;
  northPixel: number;
  southPixel: number;
}

function mercatorPixelX(longitude: number, zoom: number): number {
  return ((longitude + 180) / 360) * 2 ** zoom * TILE_SIZE;
}

function mercatorPixelY(latitude: number, zoom: number): number {
  const rad = (latitude * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** zoom * TILE_SIZE;
}

/** Select the highest available zoom whose decoded mosaic stays browser-safe. */
export function globalDemTileRange(bounds: [number, number, number, number]): TileRange {
  const [west, south, east, north] = bounds;
  for (let zoom = MAX_ZOOM; zoom >= 0; zoom -= 1) {
    const westPixel = mercatorPixelX(west, zoom);
    const eastPixel = mercatorPixelX(east, zoom);
    const northPixel = mercatorPixelY(north, zoom);
    const southPixel = mercatorPixelY(south, zoom);
    const minX = Math.floor(westPixel / TILE_SIZE);
    const maxX = Math.ceil(eastPixel / TILE_SIZE) - 1;
    const minY = Math.floor(northPixel / TILE_SIZE);
    const maxY = Math.ceil(southPixel / TILE_SIZE) - 1;
    const count = (maxX - minX + 1) * (maxY - minY + 1);
    if (count <= MAX_TILES) {
      return { zoom, minX, maxX, minY, maxY, westPixel, eastPixel, northPixel, southPixel };
    }
  }
  throw new GlobalDemError("The selected extent is too large to download in the browser.");
}

export function globalDemTileUrl(zoom: number, x: number, y: number): string {
  return TERRAIN_TILE_URL.replace("{z}", String(zoom))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
}

/** Download, mosaic, and crop public keyless AWS Terrain Tiles into memory. */
export async function buildGlobalDemRaster(request: GlobalDemRequest): Promise<RasterData> {
  if (request.bboxCrs !== 4326) throw new GlobalDemError("The DEM extent must use EPSG:4326.");
  const boundParts = request.bbox.split(",").map((value) => value.trim());
  const bounds = boundParts.map(Number);
  if (
    bounds.length !== 4 ||
    boundParts.some((value) => value === "") ||
    bounds.some((value) => !Number.isFinite(value)) ||
    bounds[0] < -180 ||
    bounds[2] > 180 ||
    bounds[1] < -WEB_MERCATOR_LIMIT ||
    bounds[3] > WEB_MERCATOR_LIMIT ||
    bounds[0] >= bounds[2] ||
    bounds[1] >= bounds[3]
  ) {
    throw new GlobalDemError(
      `Enter a valid WGS84 extent between ±${WEB_MERCATOR_LIMIT}° latitude.`,
    );
  }

  const range = globalDemTileRange(bounds as [number, number, number, number]);
  const tilesWide = range.maxX - range.minX + 1;
  const tilesTall = range.maxY - range.minY + 1;
  const mosaicWidth = tilesWide * TILE_SIZE;
  const mosaicHeight = tilesTall * TILE_SIZE;
  const mosaic = new Float32Array(mosaicWidth * mosaicHeight).fill(-32768);
  let loaded = 0;

  const requests: Promise<void>[] = [];
  for (let y = range.minY; y <= range.maxY; y += 1) {
    for (let x = range.minX; x <= range.maxX; x += 1) {
      requests.push(
        (async () => {
          const response = await fetch(globalDemTileUrl(range.zoom, x, y), {
            signal: request.signal,
          });
          if (response.status === 404) return;
          if (!response.ok) {
            throw new GlobalDemError(`Terrain tile download failed (HTTP ${response.status}).`);
          }
          const tile = await readRasterData(await response.arrayBuffer());
          if (
            tile.width !== TILE_SIZE ||
            tile.height !== TILE_SIZE ||
            tile.bands[0]?.length !== TILE_SIZE * TILE_SIZE
          ) {
            throw new GlobalDemError("The terrain service returned an unexpected GeoTIFF tile.");
          }
          loaded += 1;
          const tileX = x - range.minX;
          const tileY = y - range.minY;
          const tileNodata = tile.nodata;
          for (let row = 0; row < TILE_SIZE; row += 1) {
            const source = row * TILE_SIZE;
            const target = (tileY * TILE_SIZE + row) * mosaicWidth + tileX * TILE_SIZE;
            const sourceRow = tile.bands[0].subarray(source, source + TILE_SIZE);
            // The public source currently declares -32768 on every tile. If a
            // future tile omits the tag, preserve its samples: inventing a
            // different sentinel would be less correct than the documented
            // source convention shared by our output.
            if (tileNodata == null || tileNodata === -32768) {
              mosaic.set(sourceRow, target);
            } else {
              for (let column = 0; column < TILE_SIZE; column += 1) {
                const value = sourceRow[column];
                mosaic[target + column] = value === tileNodata ? -32768 : value;
              }
            }
          }
        })(),
      );
    }
  }
  await Promise.all(requests);
  if (loaded === 0) throw new GlobalDemError("No elevation tiles are available for this extent.");

  const mosaicPixelX = range.minX * TILE_SIZE;
  const mosaicPixelY = range.minY * TILE_SIZE;
  const left = Math.max(0, Math.floor(range.westPixel - mosaicPixelX));
  const right = Math.min(mosaicWidth, Math.ceil(range.eastPixel - mosaicPixelX));
  const top = Math.max(0, Math.floor(range.northPixel - mosaicPixelY));
  const bottom = Math.min(mosaicHeight, Math.ceil(range.southPixel - mosaicPixelY));
  const width = right - left;
  const height = bottom - top;
  if (width < 2 || height < 2) throw new GlobalDemError("The selected extent is too small.");

  const values = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const source = (top + row) * mosaicWidth + left;
    values.set(mosaic.subarray(source, source + width), row * width);
  }

  const resolution = (2 * ORIGIN_SHIFT) / (2 ** range.zoom * TILE_SIZE);
  const raster: RasterData = {
    bands: [values],
    width,
    height,
    originX: -ORIGIN_SHIFT + (mosaicPixelX + left) * resolution,
    originY: ORIGIN_SHIFT - (mosaicPixelY + top) * resolution,
    resX: resolution,
    resY: resolution,
    nodata: -32768,
    geoKeys: {
      GTModelTypeGeoKey: 1,
      GTRasterTypeGeoKey: 1,
      ProjectedCSTypeGeoKey: 3857,
    },
  };
  return raster;
}

/** Download a bbox and encode the result directly as a numerically safe COG. */
export async function downloadGlobalDem(request: GlobalDemRequest): Promise<Uint8Array> {
  return convertRasterDataToCog(await buildGlobalDemRaster(request));
}
