import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { KmlGroundOverlay } from "./kml";
import { isTiffImageName } from "./kml-overlays";
import { tiffBytesToImageBitmap } from "./tiff-image";

const PROTOCOL = "geolibre-kml-super-overlay";
// Terrain drapes raster layers into per-tile textures. A 256 px protocol tile
// looks fine in the flat renderer but becomes visibly soft once that texture is
// projected over a pitched terrain mesh. Serve one 512 px tile composed from
// the next-finer KML pyramid level: it has the same native ground resolution
// as four 256 px children, while giving the terrain texture four times as many
// pixels. MapLibre requests a 512 px source one canonical zoom lower, hence the
// matching zoom offset used below.
const TILE_SIZE = 512;
const SOURCE_ZOOM_OFFSET = 1;
const LATITUDE_STRIPS = 16;
/** Decoded source tiles kept per archive (~256 KB each); see {@link bitmapFor}. */
const MAX_CACHED_BITMAPS = 256;

interface SuperOverlayTile extends KmlGroundOverlay {
  bytes: Uint8Array;
}

interface SuperOverlayArchive {
  tilesByZoom: Map<number, SuperOverlayTile[]>;
  bitmapCache: Map<SuperOverlayTile, Promise<ImageBitmap>>;
}

const archives = new Map<string, SuperOverlayArchive>();
let protocolRegistered = false;
let pruneSubscriptionInstalled = false;

export interface RegisteredKmlSuperOverlay {
  url: string;
  bounds: [number, number, number, number];
  minzoom: number;
  maxzoom: number;
  tileSize: number;
}

export interface KmlSuperOverlayTile {
  overlay: KmlGroundOverlay;
  bytes: Uint8Array;
}

export interface RegisterKmlSuperOverlayOptions {
  /**
   * A stable key identifying the archive's source (an absolute local KMZ path),
   * so the tile URL saved into a project resolves again after the same file is
   * re-read on reopen. Omit for a source that cannot be re-read (a browser
   * File), which gets a session-only key instead.
   */
  key?: string;
}

/**
 * Re-reads a Super-Overlay's tiles from the key it was registered under (an
 * absolute local KMZ path). Installed by the loader that can reach the
 * filesystem; without one — or off the desktop host — a tile URL cannot outlive
 * the session that imported it.
 */
export type KmlSuperOverlayResolver = (key: string) => Promise<KmlSuperOverlayTile[] | null>;

let resolveArchiveTiles: KmlSuperOverlayResolver | null = null;
const pendingResolutions = new Map<string, Promise<SuperOverlayArchive | null>>();
// Ids whose re-read already failed (the KMZ moved, or is unreadable). MapLibre
// asks for many tiles per frame, so without this every one of them would redo
// the whole read-and-unzip and log the same warning again.
const failedResolutions = new Set<string>();
// Ids registered but not yet seen on a live layer. An archive is registered
// before its loader returns and the caller adds the tile layer, so a store
// change in that window must not prune it away.
const unclaimedArchives = new Set<string>();

/** Install (or clear) the resolver used to re-read an archive after a reload. */
export function setKmlSuperOverlayResolver(resolver: KmlSuperOverlayResolver | null): void {
  resolveArchiveTiles = resolver;
}

async function ensureProtocol(): Promise<void> {
  if (protocolRegistered) return;
  // Keep MapLibre out of tauri-io's static module graph. This also lets the
  // DOM-only file-loader tests import tauri-io in Node without pulling the map
  // in. MapLibre v6 is ESM-only with named exports and no default export, so
  // this reads `addProtocol` straight off the namespace.
  const { addProtocol } = await import("maplibre-gl");
  addProtocol(PROTOCOL, handleTileRequest);
  protocolRegistered = true;
}

/**
 * Teach MapLibre this module's tile scheme, mirroring the MBTiles and XYZ
 * protocols the shell registers on mount. A session that imports a KMZ
 * registers it on the way through {@link registerKmlSuperOverlay}, but one that
 * only reopens a saved project never does — and MapLibre would then try to
 * `fetch()` the saved `geolibre-kml-super-overlay://…` tile URLs instead of
 * routing them here, so the pyramid could never be re-read and the layer would
 * render blank. Idempotent.
 */
export function registerKmlSuperOverlayProtocol(): Promise<void> {
  return ensureProtocol();
}

function tileUrl(id: string): string {
  return `${PROTOCOL}://${encodeURIComponent(id)}/{z}/{x}/{y}`;
}

/**
 * The pyramid level each `<GroundOverlay>` sits at.
 *
 * Super-Overlay generators (gdal2tiles and friends) write the tile's zoom into
 * `<drawOrder>`, which is why it is the primary signal. The KML spec, though,
 * defines drawOrder only as a stacking hint, and a generator that omits it
 * leaves every overlay at the `0` default — which would collapse the whole
 * pyramid into one bucket and render every zoom from a single upsampled level.
 * So when drawOrder does not discriminate, fall back to the level implied by
 * each tile's own longitude span (a tile at zoom `z` spans `360 / 2**z`
 * degrees), which a regular pyramid always encodes.
 */
function zoomsForTiles(tiles: KmlSuperOverlayTile[]): number[] {
  const drawOrders = tiles.map((tile) => Math.max(0, Math.round(tile.overlay.drawOrder)));
  if (new Set(drawOrders).size > 1) return drawOrders;
  return tiles.map((tile) => zoomFromLongitudeSpan(tile.overlay.bounds));
}

function zoomFromLongitudeSpan(bounds: [number, number, number, number]): number {
  // KML represents an antimeridian-crossing box with east < west.
  const span = bounds[2] >= bounds[0] ? bounds[2] - bounds[0] : bounds[2] + 360 - bounds[0];
  if (!(span > 0)) return 0;
  return Math.max(0, Math.round(Math.log2(360 / span)));
}

function storeArchive(id: string, tiles: KmlSuperOverlayTile[]): SuperOverlayArchive {
  const zooms = zoomsForTiles(tiles);
  const tilesByZoom = new Map<number, SuperOverlayTile[]>();
  tiles.forEach((tile, index) => {
    // Push into the level's existing array: rebuilding it per tile would copy
    // O(N²) elements across a level holding thousands of tiles.
    const entry = { ...tile.overlay, bytes: tile.bytes };
    const bucket = tilesByZoom.get(zooms[index]);
    if (bucket) bucket.push(entry);
    else tilesByZoom.set(zooms[index], [entry]);
  });
  const archive: SuperOverlayArchive = { tilesByZoom, bitmapCache: new Map() };
  freeArchive(id);
  archives.set(id, archive);
  failedResolutions.delete(id);
  unclaimedArchives.add(id);
  ensurePruneSubscription();
  return archive;
}

/**
 * Register the raster pyramid from one KMZ. The archive stays outside project
 * state: MapLibre asks the protocol only for visible XYZ tiles, and each answer
 * is composed from the KML GroundOverlays at the matching pyramid level.
 *
 * Registering the same `key` again (a re-import, or a project reopen re-reading
 * the KMZ from disk) replaces the previous archive rather than pinning its
 * bytes for the session; {@link unregisterKmlSuperOverlay} frees an archive
 * whose layer is gone.
 */
export async function registerKmlSuperOverlay(
  tiles: KmlSuperOverlayTile[],
  options?: RegisterKmlSuperOverlayOptions,
): Promise<RegisteredKmlSuperOverlay> {
  if (!tiles.length) throw new Error("A KML Super-Overlay must contain raster tiles.");
  await ensureProtocol();

  const id = options?.key ?? crypto.randomUUID();
  const archive = storeArchive(id, tiles);
  const levels = [...archive.tilesByZoom.keys()].sort((a, b) => a - b);
  const bounds = tiles.reduce<[number, number, number, number]>(
    (result, tile) => [
      Math.min(result[0], tile.overlay.bounds[0]),
      Math.min(result[1], tile.overlay.bounds[1]),
      Math.max(result[2], tile.overlay.bounds[2]),
      Math.max(result[3], tile.overlay.bounds[3]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
  return {
    url: tileUrl(id),
    bounds,
    minzoom: Math.max(0, levels[0] - SOURCE_ZOOM_OFFSET),
    maxzoom: Math.max(0, levels[levels.length - 1] - SOURCE_ZOOM_OFFSET),
    tileSize: TILE_SIZE,
  };
}

/**
 * The archive behind a tile URL, re-reading it through the installed resolver
 * when this session has not registered it — the case after a saved project is
 * reopened, since only the tile URL persists, never the pyramid's bytes.
 * Concurrent tile requests for the same archive share one read.
 */
async function archiveFor(id: string): Promise<SuperOverlayArchive | null> {
  const registered = archives.get(id);
  if (registered) return registered;
  const resolver = resolveArchiveTiles;
  if (!resolver || failedResolutions.has(id)) return null;
  let pending = pendingResolutions.get(id);
  if (!pending) {
    pending = (async () => {
      try {
        const tiles = await resolver(id);
        if (tiles && tiles.length > 0) return storeArchive(id, tiles);
      } catch (error) {
        console.warn(`[GeoLibre] Could not re-read the KML Super-Overlay from "${id}".`, error);
      } finally {
        pendingResolutions.delete(id);
      }
      // Re-attempted only if the same key is registered again, which clears it.
      failedResolutions.add(id);
      return null;
    })();
    pendingResolutions.set(id, pending);
  }
  return pending;
}

/**
 * Frees the tile bytes and decoded bitmaps behind a registered Super-Overlay
 * tile URL, so importing and removing pyramids over a long session does not
 * accumulate memory. Returns whether an archive was actually removed.
 */
export function unregisterKmlSuperOverlay(url: string): boolean {
  const id = archiveIdFromUrl(url);
  return id === null ? false : freeArchive(id);
}

/** Whether `url` is a tile URL this module hands out. */
export function isKmlSuperOverlayUrl(url: string): boolean {
  return url.startsWith(`${PROTOCOL}://`);
}

function freeArchive(id: string): boolean {
  const archive = archives.get(id);
  if (!archive) return false;
  for (const bitmap of archive.bitmapCache.values()) {
    // A pending decode still settles; close the bitmap once it does, and
    // swallow a rejection (already handled by whoever awaited the tile).
    void bitmap.then(
      (decoded) => decoded.close(),
      () => {},
    );
  }
  archive.bitmapCache.clear();
  unclaimedArchives.delete(id);
  return archives.delete(id);
}

// A layer can disappear through paths that never touch the layer panel's remove
// flow (scripting API, plugin teardown, New Project resetting `layers`), so a
// store subscription frees archives whose layer is gone whichever path removed
// it — mirroring the PostGIS connection registry. Installed on first register.
function ensurePruneSubscription(): void {
  if (pruneSubscriptionInstalled) return;
  pruneSubscriptionInstalled = true;
  useAppStore.subscribe((state) => {
    if (archives.size === 0) return;
    pruneKmlSuperOverlays(state.layers);
  });
}

/**
 * Free every registered archive no live layer still points a tile URL at. An
 * archive registered since the last live sighting is left alone: the importer
 * registers it before it can add the tile layer, and pruning that window would
 * drop a browser-`File` pyramid that has no path to be re-read from.
 */
export function pruneKmlSuperOverlays(layers: readonly GeoLibreLayer[]): void {
  const live = new Set<string>();
  for (const layer of layers) {
    const tiles = layer.source?.tiles;
    if (!Array.isArray(tiles)) continue;
    for (const tile of tiles) {
      const id = typeof tile === "string" ? archiveIdFromUrl(tile) : null;
      if (id !== null) live.add(id);
    }
  }
  for (const id of live) unclaimedArchives.delete(id);
  for (const id of [...archives.keys()]) {
    if (!live.has(id) && !unclaimedArchives.has(id)) freeArchive(id);
  }
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

function archiveIdFromUrl(url: string): string | null {
  if (!isKmlSuperOverlayUrl(url)) return null;
  const path = url.slice(`${PROTOCOL}://`.length);
  const slash = path.indexOf("/");
  try {
    return decodeURIComponent(slash < 0 ? path : path.slice(0, slash));
  } catch {
    // Invalid percent-encoding (a crafted or corrupted project's tile URL).
    // Reached from the store subscription, where a throw would break every
    // later store update, so treat it as "no archive" instead.
    return null;
  }
}

export function parseTileUrl(url: string): { id: string; z: number; x: number; y: number } | null {
  const id = archiveIdFromUrl(url);
  if (id === null) return null;
  const path = url.slice(`${PROTOCOL}://`.length);
  const slash = path.indexOf("/");
  if (slash < 0) return null;
  const [z, x, y] = path
    .slice(slash + 1)
    .split("/")
    .map(Number);
  if (![z, x, y].every(Number.isFinite)) return null;
  return { id, z, x, y };
}

function bitmapFor(archive: SuperOverlayArchive, tile: SuperOverlayTile): Promise<ImageBitmap> {
  const cached = archive.bitmapCache.get(tile);
  if (cached) {
    // A Map iterates in insertion order, so re-inserting a hit moves it to the
    // end and makes the eviction below least-recently-used.
    archive.bitmapCache.delete(tile);
    archive.bitmapCache.set(tile, cached);
    return cached;
  }
  // No browser decodes TIFF, and gdal2tiles/Global Mapper pyramids are often
  // written as `.tif` tiles, so those go through the geotiff decoder instead.
  const bitmap = isTiffImageName(tile.href)
    ? tiffBytesToImageBitmap(tile.bytes)
    : createImageBitmap(new Blob([tile.bytes as BlobPart]));
  // Never cache a failed decode: a corrupt tile would otherwise keep
  // re-throwing the same rejection for the rest of the session.
  void bitmap.catch(() => archive.bitmapCache.delete(tile));
  archive.bitmapCache.set(tile, bitmap);
  // A decoded 256x256 tile costs ~256 KB, so a pyramid with thousands of tiles
  // would pin gigabytes over a long browsing session. Evicted tiles are simply
  // dropped, not closed: a request may still be compositing one, and the bytes
  // stay in the archive so re-visiting the tile just decodes it again.
  while (archive.bitmapCache.size > MAX_CACHED_BITMAPS) {
    const oldest = archive.bitmapCache.keys().next();
    if (oldest.done) break;
    archive.bitmapCache.delete(oldest.value);
  }
  return bitmap;
}

async function handleTileRequest(
  request: { url: string },
  abortController?: AbortController,
): Promise<{ data: ArrayBuffer }> {
  const parsed = parseTileUrl(request.url);
  if (!parsed || abortController?.signal.aborted) return { data: new ArrayBuffer(0) };
  const { id, z, x, y } = parsed;
  const archive = await archiveFor(id);
  if (!archive || abortController?.signal.aborted) return { data: new ArrayBuffer(0) };
  const zooms = [...archive.tilesByZoom.keys()];
  // A 512 px source tile at canonical z covers the same screen area and native
  // resolution as four 256 px KML tiles at z + 1.
  const requestedSourceZoom = z + SOURCE_ZOOM_OFFSET;
  const sourceZoom = zooms.reduce(
    (best, candidate) => {
      if (candidate <= requestedSourceZoom && candidate > best) return candidate;
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

  // Decode every contributing tile concurrently, then composite them in order.
  // Drawing only after they have all resolved also keeps the whole composite
  // synchronous, so a concurrent request cannot evict one of these mid-draw.
  const decoded = await Promise.all(candidates.map((tile) => bitmapFor(archive, tile)));
  if (abortController?.signal.aborted) return { data: new ArrayBuffer(0) };
  for (const [index, tile] of candidates.entries()) {
    const bitmap = decoded[index];
    const [tileWest, tileSouth, tileEast, tileNorth] = tile.bounds;
    context.globalAlpha = tile.opacity;
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
  context.globalAlpha = 1;

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return { data: await blob.arrayBuffer() };
}
