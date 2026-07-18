// ArcGIS I3S (Indexed 3D Scene Layer) support, rendered through a deck.gl
// Tile3DLayer + @loaders.gl/i3s I3SLoader in a @deck.gl/mapbox MapboxOverlay.
//
// This mirrors the Google Photorealistic 3D Tiles overlay in maplibre-3d-tiles.ts
// (same lazy mount / store-driven render / mercator-forcing lifecycle) but for
// ArcGIS Scene Layers: mesh scene layers (3D Object + Integrated Mesh) served
// from a SceneServer REST endpoint. The layer is added to the store as a
// `3d-tiles` layer with a distinct source kind so the main Layers panel manages
// its visibility/opacity/removal, which this overlay reflects.

import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, useAppStore } from "@geolibre/core";
import type { Layer } from "@deck.gl/core";
import type { MapboxOverlay } from "@deck.gl/mapbox";
import type { GeoLibreAppAPI, GeoLibreDeckGL } from "../types";
import {
  acquireMercatorProjectionLock,
  releaseMercatorProjectionLock,
} from "./map-projection-utils";

/** Source-kind tag stored on an ArcGIS I3S layer's source + metadata. */
export const ARCGIS_I3S_SOURCE_KIND = "arcgis-i3s";
const ARCGIS_I3S_LAYER_ID_PREFIX = "arcgis-i3s-tiles";

/**
 * Tile detail/memory caps shared by the deck.gl 3D-tiles overlays (this I3S
 * overlay and the Google Photorealistic one) so a large textured-mesh scene
 * doesn't load with deck.gl's unbounded defaults. Kept in one place so the two
 * overlays don't drift apart.
 */
export const THREE_D_TILES_TILESET_LOAD_LIMITS = {
  maximumScreenSpaceError: 20,
  maximumMemoryUsage: 512,
  memoryAdjustedScreenSpaceError: true,
} as const;

/**
 * loaders.gl load options shared by the deck.gl 3D-tiles overlays (this I3S
 * overlay and the Google Photorealistic one).
 *
 * `core.worker: false` parses tile content on the main thread instead of a
 * loaders.gl worker. By default @loaders.gl fetches its worker scripts (the
 * i3s-content worker here, draco/basis-texture workers for glTF content) from
 * the unpkg CDN at runtime, which the Tauri desktop CSP (`worker-src 'self'
 * blob:`, no unpkg in `script-src`) blocks — so tiles never render in the
 * packaged app, and it would fail offline too. Disabling workers removes that
 * external CDN dependency entirely; parsing runs in-process on every platform.
 * The same restrictive `worker-src` applies to the nginx-served web build, so
 * this is applied unconditionally rather than gated to Tauri. `worker` must be
 * nested under `core` — that is the documented loaders.gl option shape; a
 * top-level `worker` only works via a deprecated backwards-compat alias.
 */
export const THREE_D_TILES_DECK_LOAD_OPTIONS = {
  tileset: THREE_D_TILES_TILESET_LOAD_LIMITS,
  core: { worker: false },
} as const;
// ~1s at 60fps, matching GOOGLE_TILES_MAX_MOUNT_RETRIES so a slow project
// restore has the same budget to wait for the map before giving up.
const I3S_MAX_MOUNT_RETRIES = 60;

// A Scene Layer service endpoint: ".../SceneServer" optionally followed by
// "/layers/<n>". Covers ArcGIS Online (*.arcgis.com), ArcGIS Enterprise
// portals, and hosted feature/scene services.
const I3S_SCENE_SERVER_RE = /\/SceneServer(\/|$|\?|#)/i;

let i3sOverlay: MapboxOverlay | null = null;
let i3sOverlayMounted = false;
let i3sDeckGL: GeoLibreDeckGL | null = null;
let i3sApp: GeoLibreAppAPI | null = null;
let i3sBoundMap: unknown;
let i3sStoreUnsubscribe: (() => void) | null = null;
let i3sEnsureInFlight: Promise<void> | null = null;
let lastI3sLayerSignature: string | null = null;
let i3sMountRetryScheduled = false;
let i3sMountRetries = 0;
let i3sMountGaveUp = false;
/** Ref-counted mercator lock key for this overlay (see map-projection-utils). */
const I3S_PROJECTION_LOCK_KEY = ARCGIS_I3S_SOURCE_KIND;
// I3SLoader is loaded lazily (it pulls in a fair amount of parsing code) the
// first time an I3S layer is rendered, and cached here.
let i3sLoaderPromise: Promise<unknown> | null = null;
let i3sLoader: unknown = null;

/**
 * Whether a URL points at an ArcGIS I3S Scene Layer service.
 *
 * @param url The URL entered in the 3D Tiles panel.
 * @returns True for a `.../SceneServer[/layers/N]` endpoint.
 */
export function isArcgisI3sSceneLayerUrl(url: string): boolean {
  return I3S_SCENE_SERVER_RE.test(url.trim());
}

/**
 * A friendly default layer name for an I3S URL: the service name (the path
 * segment right before `/SceneServer`), e.g. `.../SF_Bldgs/SceneServer/layers/0`
 * → `SF_Bldgs`. Falls back to `null` so callers can use their generic naming.
 *
 * @param url The Scene Layer URL.
 * @returns The service name, or null if it can't be extracted.
 */
export function arcgisI3sSceneLayerName(url: string): string | null {
  const match = url.trim().match(/\/([^/?#]+)\/SceneServer(?:\/|$|\?|#)/i);
  if (!match) return null;
  try {
    // A malformed percent-escape makes decodeURIComponent throw URIError; fall
    // back to the raw segment so a bad URL doesn't abort the add flow.
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** Whether a store layer is an ArcGIS I3S tileset layer. */
export function isArcgisI3sTilesLayer(layer: GeoLibreLayer): boolean {
  return layer.type === "3d-tiles" && layer.metadata.sourceKind === ARCGIS_I3S_SOURCE_KIND;
}

/**
 * Add an ArcGIS I3S scene layer to the store and ensure the deck.gl overlay is
 * mounted. Managed thereafter from the main Layers panel.
 *
 * @param app The GeoLibre app API.
 * @param options Scene Layer URL, display name, opacity, visibility, flyTo.
 * @returns The new store layer id.
 */
export function addArcgisI3sTilesLayer(
  app: GeoLibreAppAPI,
  options: {
    url: string;
    name: string;
    opacity: number;
    visible: boolean;
    flyTo: boolean;
  },
): string {
  const id = `${ARCGIS_I3S_LAYER_ID_PREFIX}-${crypto.randomUUID()}`;
  const deckLayerId = `${id}-deck`;
  const url = options.url.trim();

  useAppStore.getState().addLayer({
    id,
    name: options.name,
    type: "3d-tiles",
    source: {
      sourceId: id,
      type: ARCGIS_I3S_SOURCE_KIND,
      url,
    },
    visible: options.visible,
    opacity: options.opacity,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      customLayerType: ARCGIS_I3S_SOURCE_KIND,
      externalDeckLayer: true,
      externalNativeLayer: true,
      identifiable: false,
      nativeLayerIds: [deckLayerId],
      sourceId: id,
      sourceKind: ARCGIS_I3S_SOURCE_KIND,
    },
    sourcePath: url,
  });

  if (options.flyTo) i3sFlyToRequested.add(id);
  void ensureArcgisI3sTilesOverlay(app);
  return id;
}

// Layer ids awaiting an initial flyTo once their tileset metadata loads.
const i3sFlyToRequested = new Set<string>();

/**
 * Re-mount the overlay for any ArcGIS I3S layers present in the store, e.g.
 * after a project is reopened.
 */
export function restoreArcgisI3sTilesLayers(app: GeoLibreAppAPI): void {
  if (useAppStore.getState().layers.some(isArcgisI3sTilesLayer)) {
    void ensureArcgisI3sTilesOverlay(app);
  }
}

function ensureArcgisI3sTilesOverlay(app: GeoLibreAppAPI): Promise<void> {
  if (i3sEnsureInFlight) return i3sEnsureInFlight;
  // Both call sites are fire-and-forget, so log any failure here rather than
  // leaving it as an unhandled rejection with no clue why the layer never
  // rendered.
  i3sEnsureInFlight = runEnsureArcgisI3sTilesOverlay(app)
    .catch((error) => {
      console.error("[GeoLibre] Failed to initialize the ArcGIS I3S overlay", error);
    })
    .finally(() => {
      i3sEnsureInFlight = null;
    });
  return i3sEnsureInFlight;
}

async function runEnsureArcgisI3sTilesOverlay(app: GeoLibreAppAPI): Promise<void> {
  i3sApp = app;
  if (!app.getDeckGL) return;
  i3sDeckGL ??= await app.getDeckGL();
  i3sLoader ??= await loadI3sLoader();

  const map = app.getMap?.() ?? null;
  if (i3sOverlay && i3sBoundMap === map) {
    renderArcgisI3sTilesLayers();
    return;
  }

  if (i3sOverlay && i3sOverlayMounted) {
    try {
      app.removeMapControl(i3sOverlay);
    } catch (error) {
      console.warn(
        "[GeoLibre] Failed to detach the ArcGIS I3S overlay from the previous map",
        error,
      );
    }
  }
  i3sBoundMap = map;
  // Overlaid (not interleaved): I3S mesh tiles use the METER_OFFSETS coordinate
  // system, which the interleaved MapboxOverlay renderer rejects ("Invalid
  // coordinateSystem: 2"). Overlaid mode renders deck on its own canvas above
  // the map and supports it; buildings are not depth-composited with the
  // basemap, which is fine for a scene-layer overlay.
  i3sOverlay = new i3sDeckGL.mapbox.MapboxOverlay({
    interleaved: false,
    layers: [],
  });
  i3sOverlayMounted = false;
  lastI3sLayerSignature = null;
  i3sMountRetries = 0;
  i3sMountGaveUp = false;
  i3sStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    if (state.layers !== previous.layers) {
      const currentIds = new Set(state.layers.filter(isArcgisI3sTilesLayer).map(({ id }) => id));
      for (const layer of previous.layers) {
        if (isArcgisI3sTilesLayer(layer) && !currentIds.has(layer.id)) {
          i3sFlyToRequested.delete(layer.id);
        }
      }
      renderArcgisI3sTilesLayers();
    }
  });
  renderArcgisI3sTilesLayers();
}

/** Lazily import the I3SLoader from @loaders.gl/i3s. */
function loadI3sLoader(): Promise<unknown> {
  // Clear the cache on failure so a transient chunk-load error (flaky network,
  // stale CDN after a deploy, ad blocker) doesn't permanently break the feature
  // — the next add/restore can retry instead of awaiting a rejected promise.
  i3sLoaderPromise ??= import("@loaders.gl/i3s")
    .then((m) => m.I3SLoader)
    .catch((error) => {
      i3sLoaderPromise = null;
      throw error;
    });
  return i3sLoaderPromise;
}

function renderArcgisI3sTilesLayers(): void {
  if (!i3sOverlay || !i3sDeckGL || !i3sApp) return;

  const layers = useAppStore.getState().layers.filter(isArcgisI3sTilesLayer);

  // Tear the overlay down once the last I3S layer is gone, so an empty deck.gl
  // overlay is not left attached for the rest of the session.
  if (layers.length === 0) {
    if (i3sOverlayMounted) {
      try {
        i3sApp.removeMapControl(i3sOverlay);
      } catch (error) {
        console.warn("[GeoLibre] Failed to remove the empty ArcGIS I3S overlay", error);
      }
      i3sOverlayMounted = false;
    }
    lastI3sLayerSignature = null;
    i3sMountRetries = 0;
    i3sMountGaveUp = false;
    restoreI3sPreviousProjection();
    return;
  }

  forceI3sMercatorProjection(i3sApp);

  if (!i3sOverlayMounted) {
    if (!i3sApp.addMapControl(i3sOverlay, "top-left")) {
      scheduleI3sMountRetry();
      return;
    }
    i3sOverlayMounted = true;
    i3sMountRetries = 0;
    i3sMountGaveUp = false;
    i3sBoundMap = i3sApp.getMap?.() ?? null;
    lastI3sLayerSignature = null;
  }

  // The store subscription fires on ANY layer-set change; skip rebuilding the
  // deck layers (which would re-fetch the tileset) when nothing about the I3S
  // layers themselves changed.
  const signature = i3sLayerSignature(layers);
  if (signature === lastI3sLayerSignature) return;
  lastI3sLayerSignature = signature;

  const deckLayers = layers
    .filter((layer) => layer.visible)
    .map((layer) => buildArcgisI3sTilesDeckLayer(layer))
    .filter((layer): layer is Layer => layer !== null)
    .reverse();

  i3sOverlay.setProps({ layers: deckLayers });
}

function scheduleI3sMountRetry(): void {
  if (i3sMountRetryScheduled || i3sMountGaveUp || typeof requestAnimationFrame === "undefined") {
    return;
  }
  if (i3sMountRetries >= I3S_MAX_MOUNT_RETRIES) {
    i3sMountGaveUp = true;
    console.warn(
      "[GeoLibre] Gave up mounting the ArcGIS I3S overlay after repeated addMapControl failures.",
    );
    return;
  }
  i3sMountRetries += 1;
  i3sMountRetryScheduled = true;
  requestAnimationFrame(() => {
    i3sMountRetryScheduled = false;
    renderArcgisI3sTilesLayers();
  });
}

function i3sLayerSignature(layers: GeoLibreLayer[]): string {
  return layers
    .map(
      (layer) =>
        `${layer.id}:${layer.visible ? 1 : 0}:${layer.opacity}:${
          typeof layer.source.url === "string" ? layer.source.url : ""
        }`,
    )
    .join("|");
}

// The deck.gl class + I3SLoader are injectable so a unit test can assert the
// constructed Tile3DLayer's props (e.g. the CSP-critical loadOptions) without a
// live map/overlay. Defaults are evaluated per call, so production callers pick
// up the lazily-populated module globals.
export function buildArcgisI3sTilesDeckLayer(
  layer: GeoLibreLayer,
  deps: { deckGL: GeoLibreDeckGL | null; loader: unknown } = {
    deckGL: i3sDeckGL,
    loader: i3sLoader,
  },
): Layer | null {
  const { deckGL, loader } = deps;
  if (!deckGL || !loader) return null;
  const url = typeof layer.source.url === "string" ? layer.source.url : "";
  if (!url) return null;

  const Tile3DLayer = deckGL.geoLayers.Tile3DLayer as unknown as new (
    props: Record<string, unknown>,
  ) => Layer;

  return new Tile3DLayer({
    id: `${layer.id}-deck`,
    data: url,
    loader,
    // Tile detail/memory caps + main-thread parsing, shared with the Google
    // overlay. See THREE_D_TILES_DECK_LOAD_OPTIONS for why workers are disabled.
    // Spread into a fresh object per layer (matching the Google call site) so no
    // two layers share one loadOptions reference.
    loadOptions: { ...THREE_D_TILES_DECK_LOAD_OPTIONS },
    opacity: layer.opacity,
    pickable: false,
    operation: "draw",
    onTilesetLoad: (tileset: unknown) => {
      warnOnUnsupportedI3sSceneLayerType(url, tileset);
      persistI3sTilesetCenter(layer.id, tileset);
      flyToI3sTileset(layer.id, tileset);
    },
    // @loaders.gl/i3s tags mesh content with a numeric coordinateSystem
    // (METER_OFFSETS = 2), but deck.gl 9 expects the string form
    // ("meter-offsets"); remap it on load so getShaderCoordinateSystem accepts
    // it instead of throwing "Invalid coordinateSystem: 2".
    onTileLoad: (tile: unknown) => normalizeI3sTileCoordinateSystem(tile),
    // The user types an arbitrary Scene Layer URL, so surface failures (bad
    // URL, CORS-blocked portal, expired token, a service that isn't I3S)
    // instead of letting the layer just never render with no explanation.
    // @loaders.gl Tileset3D calls this as (tile, message, url) — note the deck.gl
    // typings mislabel the order as (tile, url, message).
    onTileError: (_tile: unknown, message: string, tileUrl: string) =>
      console.error(`[GeoLibre] ArcGIS I3S tile failed to load: ${message} (${tileUrl})`),
  });
}

/** deck.gl 9 numeric coordinate-system codes → their string equivalents. */
const COORDINATE_SYSTEM_STRINGS: Record<number, string> = {
  [-1]: "default",
  0: "cartesian",
  1: "lnglat",
  2: "meter-offsets",
  3: "lnglat-offsets",
};

/** Coerce a tile's numeric content coordinateSystem to deck.gl's string form. */
function normalizeI3sTileCoordinateSystem(tile: unknown): void {
  const content = (tile as { content?: { coordinateSystem?: unknown } } | null)?.content;
  if (
    content &&
    typeof content.coordinateSystem === "number" &&
    content.coordinateSystem in COORDINATE_SYSTEM_STRINGS
  ) {
    content.coordinateSystem = COORDINATE_SYSTEM_STRINGS[content.coordinateSystem];
  }
}

/** Scene-layer types this mesh-only Tile3DLayer + I3SLoader pipeline renders. */
const SUPPORTED_I3S_LAYER_TYPES = new Set(["3DObject", "IntegratedMesh"]);

/**
 * Warn when a loaded tileset is a scene-layer type this overlay can't render
 * (e.g. an I3S PointCloud layer), which the mesh pipeline would otherwise fail
 * to display with no explanation.
 *
 * @param url The Scene Layer URL, for context in the warning.
 * @param tileset The tileset object passed to `onTilesetLoad`.
 */
function warnOnUnsupportedI3sSceneLayerType(url: string, tileset: unknown): void {
  // @loaders.gl exposes the parsed SceneLayer under Tileset3D.tileset, but read
  // the top level too in case a future version surfaces layerType directly. If
  // neither is present the check just does nothing (the warning is best-effort).
  const header = tileset as {
    layerType?: unknown;
    tileset?: { layerType?: unknown };
  } | null;
  const layerType = header?.tileset?.layerType ?? header?.layerType;
  if (typeof layerType === "string" && !SUPPORTED_I3S_LAYER_TYPES.has(layerType)) {
    console.warn(
      `[GeoLibre] ArcGIS I3S scene layer type "${layerType}" is not supported ` +
        "(only 3DObject and IntegratedMesh mesh layers render); this layer may " +
        `not display: ${url}`,
    );
  }
}

/** Read a tileset's cartographic center as an [lng, lat] pair, if present. */
export function i3sTilesetLngLat(tileset: unknown): [number, number] | null {
  const center = (tileset as { cartographicCenter?: [number, number, number] } | null)
    ?.cartographicCenter;
  if (
    !center ||
    typeof center[0] !== "number" ||
    typeof center[1] !== "number" ||
    !Number.isFinite(center[0]) ||
    !Number.isFinite(center[1]) ||
    // Reject non-WGS84 / garbage centers so a buggy SceneServer response can't
    // drive flyTo/fitLayer somewhere nonsensical (mirrors lngLatPairValue).
    Math.abs(center[0]) > 180 ||
    Math.abs(center[1]) > 90
  ) {
    return null;
  }
  return [center[0], center[1]];
}

/**
 * Persist a loaded tileset's center into the layer metadata so the main Layers
 * panel's "Zoom to layer" (MapController.fitLayer) works — an I3S layer has no
 * geojson or MapLibre source, so `metadata.center` is its only bounds hint.
 */
export function persistI3sTilesetCenter(layerId: string, tileset: unknown): void {
  const center = i3sTilesetLngLat(tileset);
  if (!center) return;
  const layer = useAppStore.getState().layers.find(({ id }) => id === layerId);
  if (!layer || !isArcgisI3sTilesLayer(layer)) return;
  // onTilesetLoad can fire more than once; skip the store write when unchanged.
  const existing = layer.metadata.center;
  if (Array.isArray(existing) && existing[0] === center[0] && existing[1] === center[1]) {
    return;
  }
  useAppStore.getState().updateLayer(layerId, {
    metadata: { ...layer.metadata, center },
  });
}

/** Fly to a freshly-loaded tileset the first time, if the add requested it. */
function flyToI3sTileset(layerId: string, tileset: unknown): void {
  if (!i3sFlyToRequested.has(layerId) || !i3sApp) return;
  const info = tileset as {
    cartographicCenter?: [number, number, number];
    zoom?: number;
  } | null;
  const center = info?.cartographicCenter;
  const map = i3sApp.getMap?.() as { flyTo?: (opts: Record<string, unknown>) => void } | undefined;
  // Only consume the fly-to request once we can actually fly, so a transient
  // missing map/flyTo doesn't permanently drop it.
  if (!center || !map?.flyTo) return;
  i3sFlyToRequested.delete(layerId);
  map.flyTo({
    center: [center[0], center[1]],
    zoom: typeof info?.zoom === "number" ? Math.max(0, info.zoom - 1) : 15,
  });
}

function forceI3sMercatorProjection(app: GeoLibreAppAPI): void {
  acquireMercatorProjectionLock(I3S_PROJECTION_LOCK_KEY, app, app.getMap?.());
}

function restoreI3sPreviousProjection(): void {
  if (!i3sApp) return;
  releaseMercatorProjectionLock(I3S_PROJECTION_LOCK_KEY, i3sApp);
}
