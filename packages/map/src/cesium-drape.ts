import type { GeoLibreLayer } from "@geolibre/core";
import { Map as MapLibreMap } from "maplibre-gl";
import {
  CESIUM_IMAGE_BITMAP_OPTIONS,
  ProtocolImageryProvider,
  type DecodedTile,
} from "./cesium-protocol-imagery";
import { createLayerSync, type LayerSync } from "./headless";

// The MapLibre drape (issue #2284): tile-backed vector layers on the globe.
//
// There is no native Cesium renderer for Mapbox Vector Tiles, and deck.gl has
// no Cesium interop, so `vector-tiles`, vector PMTiles, and vector MBTiles
// had no globe representation. Rather than re-implement the Style Spec per
// kind, the globe runs one hidden MapLibre map the size of a single tile,
// hands it the very same store layers through the 2D `syncLayer` path, and
// asks it to draw one Web Mercator tile at a time: `jumpTo` the tile's centre
// at its zoom, wait for `idle`, read the canvas back. Each rendered tile is
// handed to Cesium through the bridged imagery provider, so the globe,
// terrain, and 3D Tiles compose on top as they do for any imagery.
//
// Known limits, by construction: draped content is flat (no extrusion),
// labels are placed per tile (no cross-tile collision), the second map is a
// second WebGL context and render loop, and tiles render one after another.
// Picking on draped content is a follow-up.

type CesiumNs = typeof import("@cesium/engine");

/** The drape renders 512 px tiles, MapLibre's native vector tile size. */
export const DRAPE_TILE_SIZE = 512;

/**
 * Glyphs for symbol layers the draped styles carry. The drape's own style is
 * empty, and MapLibre refuses text without a glyph source; OpenFreeMap's is
 * already on the Tauri CSP allowlist as a basemap host.
 */
export const DRAPE_GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";

/** Longest a tile render waits for `idle` before the frame is read anyway. */
const IDLE_TIMEOUT_MS = 8000;

/** The layer kinds the drape draws. */
const DRAPED_TYPES = new Set(["vector-tiles", "pmtiles", "mbtiles"]);

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isVectorArchive(layer: GeoLibreLayer): boolean {
  return layer.metadata?.tileType !== "raster" && layer.source?.type !== "raster";
}

/**
 * Whether the globe draws `layer` through the drape: a tile-backed vector
 * kind with a source to read. Raster archives take the native imagery bridge
 * instead, and `arcgis` (VectorTileServer) layers are painted by their own
 * control, which the drape has no way to host.
 */
export function isDrapedLayer(layer: GeoLibreLayer): boolean {
  if (!DRAPED_TYPES.has(layer.type)) return false;
  if (layer.type === "vector-tiles") {
    return (
      Boolean(str(layer.source.url)) ||
      (Array.isArray(layer.source.tiles) && layer.source.tiles.length > 0)
    );
  }
  if (!isVectorArchive(layer)) return false;
  if (layer.type === "pmtiles") return Boolean(str(layer.source.url) ?? str(layer.sourcePath));
  return Array.isArray(layer.source.tiles) && layer.source.tiles.length > 0;
}

/**
 * What a change to would have to re-render the drape: the layers' identity,
 * order, visibility, opacity, style, source, and the metadata the 2D sync
 * reads (source layers, native ids). Cesium caches the tiles it has, so any
 * of these rebuilds the imagery layer rather than restyling it in place.
 */
export function drapeSignature(layers: readonly GeoLibreLayer[]): string {
  return JSON.stringify(
    layers.map((layer) => [
      layer.id,
      layer.type,
      layer.visible,
      layer.opacity,
      layer.style,
      layer.source,
      layer.metadata,
      layer.sourcePath,
      layer.quickFilters,
      layer.timeFilter,
      layer.embedFilter,
    ]),
  );
}

/** Centre of a Web Mercator tile, in degrees. */
export function tileCenter(z: number, x: number, y: number): [number, number] {
  const n = 2 ** z;
  const lng = ((x + 0.5) / n) * 360 - 180;
  const mercator = Math.PI - (2 * Math.PI * (y + 0.5)) / n;
  const lat = (Math.atan(Math.sinh(mercator)) * 180) / Math.PI;
  return [lng, lat];
}

/** The slice of a MapLibre map the drape drives (a fake stands in for tests). */
export interface DrapeMap {
  jumpTo(options: { center: [number, number]; zoom: number }): unknown;
  on(type: "error", listener: (event: { error?: Error }) => void): unknown;
  once(type: "idle" | "load", listener: () => void): unknown;
  off(type: "idle" | "load", listener: () => void): unknown;
  isStyleLoaded(): boolean | void;
  getCanvas(): HTMLCanvasElement;
  remove(): void;
}

/** What `MapLibreDrape` is built over: the map, its layer sync, and teardown. */
export interface DrapeHost {
  map: DrapeMap;
  layerSync: LayerSync;
  /** Resolves once the map's style has loaded and layers can be added. */
  ready: Promise<void>;
  dispose(): void;
}

/** Build the hidden map: a one-tile canvas with an empty style and glyphs. */
export function createDrapeHost(): DrapeHost {
  const container = document.createElement("div");
  container.setAttribute("aria-hidden", "true");
  container.setAttribute("data-geolibre-cesium-drape", "");
  Object.assign(container.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    width: `${DRAPE_TILE_SIZE}px`,
    height: `${DRAPE_TILE_SIZE}px`,
    pointerEvents: "none",
  });
  document.body.appendChild(container);
  const map = new MapLibreMap({
    container,
    style: { version: 8, sources: {}, layers: [], glyphs: DRAPE_GLYPHS },
    interactive: false,
    attributionControl: false,
    // One CSS pixel per canvas pixel, so the canvas is exactly one tile.
    pixelRatio: 1,
    // No cross-fades: an `idle` frame must be the final frame.
    fadeDuration: 0,
    canvasContextAttributes: { preserveDrawingBuffer: true },
  });
  const ready = new Promise<void>((resolve) => {
    if (map.isStyleLoaded()) resolve();
    else map.once("load", () => resolve());
  });
  observeDrapeErrors(map);
  return {
    map,
    layerSync: createLayerSync(map),
    ready,
    dispose() {
      map.remove();
      container.remove();
    },
  };
}

/** A tile fetch MapLibre cut short when the drape jumped to the next tile. */
export function isTransientDrapeError(error: Error | undefined): boolean {
  return /failed to fetch|abort/i.test(error?.message ?? "");
}

/**
 * Keep MapLibre's unhandled `error` events off the console: with no listener
 * it logs each one, and jumping tile to tile cancels in-flight tile fetches,
 * which surface as "Failed to fetch". Anything else is still worth a warning.
 */
export function observeDrapeErrors(map: Pick<DrapeMap, "on">): void {
  map.on("error", (event) => {
    if (!isTransientDrapeError(event.error)) console.warn("[cesium-drape]", event.error);
  });
}

async function snapshotCanvas(map: DrapeMap): Promise<DecodedTile> {
  return createImageBitmap(map.getCanvas(), CESIUM_IMAGE_BITMAP_OPTIONS);
}

/**
 * One hidden MapLibre map rendering the globe's draped layers a tile at a
 * time. Tile requests are serialised — the map has one camera — and the
 * provider it hands Cesium is rebuilt whenever the draped layers change.
 */
export class MapLibreDrape {
  private queue: Promise<unknown> = Promise.resolve();
  private inFlight = 0;
  private destroyed = false;
  private generation = 0;

  constructor(
    private readonly host: DrapeHost,
    private readonly snapshot: (map: DrapeMap) => Promise<DecodedTile> = snapshotCanvas,
  ) {}

  /** Build a drape over a real hidden map; `null` when the map cannot be created. */
  static create(): MapLibreDrape | null {
    try {
      return new MapLibreDrape(createDrapeHost());
    } catch {
      return null;
    }
  }

  /** Tiles being rendered or waiting to render, for readiness reporting. */
  get pending(): number {
    return this.inFlight;
  }

  /** Give the drape a new layer list; bumps the generation so stale tiles are dropped. */
  sync(layers: GeoLibreLayer[]): void {
    this.generation++;
    void this.host.ready.then(() => {
      if (!this.destroyed) this.host.layerSync.sync(layers);
    });
  }

  /**
   * Render one tile. Serialised behind every earlier request; resolves `null`
   * when the drape was destroyed or re-synced before this tile's turn came,
   * so a stale frame never reaches the globe.
   */
  requestTile(x: number, y: number, z: number, signal?: AbortSignal): Promise<DecodedTile | null> {
    const generation = this.generation;
    this.inFlight++;
    const run = async (): Promise<DecodedTile | null> => {
      try {
        if (this.destroyed || signal?.aborted || generation !== this.generation) return null;
        await this.host.ready;
        if (this.destroyed || signal?.aborted || generation !== this.generation) return null;
        const { map } = this.host;
        await new Promise<void>((resolve) => {
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            map.off("idle", done);
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(done, IDLE_TIMEOUT_MS);
          map.once("idle", done);
          map.jumpTo({ center: tileCenter(z, x, y), zoom: z });
        });
        if (this.destroyed || signal?.aborted || generation !== this.generation) return null;
        return await this.snapshot(map);
      } finally {
        this.inFlight--;
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** A Cesium imagery provider whose tiles this drape renders. */
  createProvider(Cesium: CesiumNs): ProtocolImageryProvider {
    return new ProtocolImageryProvider(Cesium, {
      template: `geolibre-drape://${this.generation}/{z}/{x}/{y}`,
      tileWidth: DRAPE_TILE_SIZE,
      tileHeight: DRAPE_TILE_SIZE,
      // MapLibre's vector tiles stop at the source's maxzoom; past it the
      // drape still renders (over-zoomed), so no cap is needed here.
      maxConcurrentRequests: 4,
      loadImage: (url, signal) => {
        const [z, x, y] = url
          .slice(url.indexOf("//") + 2)
          .split("/")
          .slice(1)
          .map(Number);
        return this.requestTile(x, y, z, signal);
      },
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation++;
    this.host.dispose();
  }
}
