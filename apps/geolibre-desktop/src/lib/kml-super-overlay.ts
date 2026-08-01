import type { KmlGroundOverlay } from "./kml";

const PROTOCOL = "geolibre-kml-super-overlay";
const TILE_SIZE = 256;
const LATITUDE_STRIPS = 16;

interface SuperOverlayTile extends KmlGroundOverlay {
  bytes: Uint8Array;
}

interface SuperOverlayArchive {
  tilesByZoom: Map<number, SuperOverlayTile[]>;
  bitmapCache: Map<SuperOverlayTile, Promise<ImageBitmap>>;
}

const archives = new Map<string, SuperOverlayArchive>();

export interface RegisteredKmlSuperOverlay {
  url: string;
  bounds: [number, number, number, number];
  minzoom: number;
  maxzoom: number;
}

export interface KmlSuperOverlayTile {
  overlay: KmlGroundOverlay;
  bytes: Uint8Array;
}

async function ensureProtocol(): Promise<void> {
  // Keep MapLibre out of tauri-io's static module graph. This also lets the
  // DOM-only file-loader tests import tauri-io in Node.
  const { addProtocol, config } = await import("maplibre-gl");
  const registered = (config as { REGISTERED_PROTOCOLS?: Record<string, unknown> })
    .REGISTERED_PROTOCOLS?.[PROTOCOL];
  if (!registered) addProtocol(PROTOCOL, handleTileRequest);
}

/**
 * Register the raster pyramid from one KMZ. The archive stays outside project
 * state: MapLibre asks the protocol only for visible XYZ tiles, and each answer
 * is composed from the KML GroundOverlays at the matching drawOrder/zoom.
 */
export async function registerKmlSuperOverlay(
  tiles: KmlSuperOverlayTile[],
): Promise<RegisteredKmlSuperOverlay> {
  if (!tiles.length) throw new Error("A KML Super-Overlay must contain raster tiles.");
  await ensureProtocol();

  const tilesByZoom = new Map<number, SuperOverlayTile[]>();
  for (const tile of tiles) {
    const zoom = Math.max(0, Math.round(tile.overlay.drawOrder));
    tilesByZoom.set(zoom, [
      ...(tilesByZoom.get(zoom) ?? []),
      { ...tile.overlay, bytes: tile.bytes },
    ]);
  }
  const zooms = [...tilesByZoom.keys()].sort((a, b) => a - b);
  const bounds = tiles.reduce<[number, number, number, number]>(
    (result, tile) => [
      Math.min(result[0], tile.overlay.bounds[0]),
      Math.min(result[1], tile.overlay.bounds[1]),
      Math.max(result[2], tile.overlay.bounds[2]),
      Math.max(result[3], tile.overlay.bounds[3]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
  const id = crypto.randomUUID();
  archives.set(id, { tilesByZoom, bitmapCache: new Map() });
  return {
    url: `${PROTOCOL}://${encodeURIComponent(id)}/{z}/{x}/{y}`,
    bounds,
    minzoom: zooms[0],
    maxzoom: zooms[zooms.length - 1],
  };
}

function mercatorY(latitude: number): number {
  const lat = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const radians = (lat * Math.PI) / 180;
  return (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2;
}

function longitudeAtTileX(z: number, x: number): number {
  return (x / 2 ** z) * 360 - 180;
}

function latitudeAtTileY(z: number, y: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
}

function parseTileUrl(
  url: string,
): { archive: SuperOverlayArchive; z: number; x: number; y: number } | null {
  const path = url.slice(`${PROTOCOL}://`.length);
  const slash = path.indexOf("/");
  if (slash < 0) return null;
  const archive = archives.get(decodeURIComponent(path.slice(0, slash)));
  const [z, x, y] = path
    .slice(slash + 1)
    .split("/")
    .map(Number);
  if (!archive || ![z, x, y].every(Number.isFinite)) return null;
  return { archive, z, x, y };
}

function bitmapFor(archive: SuperOverlayArchive, tile: SuperOverlayTile): Promise<ImageBitmap> {
  let bitmap = archive.bitmapCache.get(tile);
  if (!bitmap) {
    bitmap = createImageBitmap(new Blob([tile.bytes as BlobPart]));
    archive.bitmapCache.set(tile, bitmap);
  }
  return bitmap;
}

async function handleTileRequest(
  request: { url: string },
  abortController?: AbortController,
): Promise<{ data: ArrayBuffer }> {
  const parsed = parseTileUrl(request.url);
  if (!parsed || abortController?.signal.aborted) return { data: new ArrayBuffer(0) };
  const { archive, z, x, y } = parsed;
  const zooms = [...archive.tilesByZoom.keys()];
  const sourceZoom = zooms.reduce(
    (best, candidate) => {
      if (candidate <= z && candidate > best) return candidate;
      return best;
    },
    Math.min(...zooms),
  );
  const west = longitudeAtTileX(z, x);
  const east = longitudeAtTileX(z, x + 1);
  const north = latitudeAtTileY(z, y);
  const south = latitudeAtTileY(z, y + 1);
  const candidates = (archive.tilesByZoom.get(sourceZoom) ?? []).filter(
    (tile) =>
      tile.bounds[2] > west &&
      tile.bounds[0] < east &&
      tile.bounds[3] > south &&
      tile.bounds[1] < north,
  );
  if (!candidates.length) return { data: new ArrayBuffer(0) };

  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
  const context = canvas.getContext("2d");
  if (!context) return { data: new ArrayBuffer(0) };
  const scale = 2 ** z * TILE_SIZE;

  for (const tile of candidates) {
    if (abortController?.signal.aborted) return { data: new ArrayBuffer(0) };
    const bitmap = await bitmapFor(archive, tile);
    const [tileWest, tileSouth, tileEast, tileNorth] = tile.bounds;
    const dx = ((tileWest + 180) / 360) * scale - x * TILE_SIZE;
    const dw = ((tileEast - tileWest) / 360) * scale;
    // KML LatLonBox rasters are linear in latitude, while MapLibre's tile is
    // Web Mercator. Draw narrow horizontal strips to preserve georeferencing.
    for (let strip = 0; strip < LATITUDE_STRIPS; strip += 1) {
      const sourceY = (strip / LATITUDE_STRIPS) * bitmap.height;
      const sourceHeight = bitmap.height / LATITUDE_STRIPS;
      const stripNorth = tileNorth - ((tileNorth - tileSouth) * strip) / LATITUDE_STRIPS;
      const stripSouth = tileNorth - ((tileNorth - tileSouth) * (strip + 1)) / LATITUDE_STRIPS;
      const dy = mercatorY(stripNorth) * scale - y * TILE_SIZE;
      const dh = (mercatorY(stripSouth) - mercatorY(stripNorth)) * scale;
      context.drawImage(bitmap, 0, sourceY, bitmap.width, sourceHeight, dx, dy, dw, dh);
    }
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return { data: await blob.arrayBuffer() };
}
