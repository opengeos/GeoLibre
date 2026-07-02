// ArcGIS I3S (Indexed 3D Scene Layer) support, rendered through a deck.gl
// Tile3DLayer + @loaders.gl/i3s I3SLoader in a @deck.gl/mapbox MapboxOverlay.
//
// This mirrors the Google Photorealistic 3D Tiles overlay in maplibre-3d-tiles.ts
// (same lazy mount / store-driven render / mercator-forcing lifecycle) but for
// ArcGIS Scene Layers: mesh scene layers (3D Object + Integrated Mesh) served
// from a SceneServer REST endpoint. The layer is added to the store as a
// `3d-tiles` layer with a distinct source kind so the main Layers panel manages
// its visibility/opacity/removal, which this overlay reflects.

import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  useAppStore,
} from "@geolibre/core";
import type { Layer } from "@deck.gl/core";
import type { MapboxOverlay } from "@deck.gl/mapbox";
import type { GeoLibreAppAPI, GeoLibreDeckGL } from "../types";
import { ensureMercatorProjection } from "./map-projection-utils";

/** Source-kind tag stored on an ArcGIS I3S layer's source + metadata. */
export const ARCGIS_I3S_SOURCE_KIND = "arcgis-i3s";
const ARCGIS_I3S_LAYER_ID_PREFIX = "arcgis-i3s-tiles";
const I3S_MAX_MOUNT_RETRIES = 30;

// A Scene Layer service endpoint: ".../SceneServer" optionally followed by
// "/layers/<n>". Covers ArcGIS Online (*.arcgis.com), ArcGIS Enterprise
// portals, and hosted feature/scene services.
const I3S_SCENE_SERVER_RE = /\/SceneServer(\/|$|\?)/i;

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
let i3sPreviousProjection: "globe" | "mercator" | null = null;
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

/** Whether a store layer is an ArcGIS I3S tileset layer. */
export function isArcgisI3sTilesLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "3d-tiles" &&
    layer.metadata.sourceKind === ARCGIS_I3S_SOURCE_KIND
  );
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

  i3sFlyToRequested.add(id);
  if (!options.flyTo) i3sFlyToRequested.delete(id);
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

/** Tear down all I3S overlay state (plugin deactivation / map teardown). */
export function teardownArcgisI3sTilesOverlay(app: GeoLibreAppAPI): void {
  if (i3sOverlay && i3sOverlayMounted) {
    try {
      app.removeMapControl(i3sOverlay);
    } catch {
      /* stale map: best effort */
    }
  }
  i3sStoreUnsubscribe?.();
  i3sStoreUnsubscribe = null;
  i3sOverlay = null;
  i3sOverlayMounted = false;
  i3sBoundMap = null;
  lastI3sLayerSignature = null;
  i3sMountRetries = 0;
  i3sMountGaveUp = false;
  i3sFlyToRequested.clear();
}

function ensureArcgisI3sTilesOverlay(app: GeoLibreAppAPI): Promise<void> {
  if (i3sEnsureInFlight) return i3sEnsureInFlight;
  i3sEnsureInFlight = runEnsureArcgisI3sTilesOverlay(app).finally(() => {
    i3sEnsureInFlight = null;
  });
  return i3sEnsureInFlight;
}

async function runEnsureArcgisI3sTilesOverlay(
  app: GeoLibreAppAPI,
): Promise<void> {
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
      const currentIds = new Set(
        state.layers.filter(isArcgisI3sTilesLayer).map(({ id }) => id),
      );
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
  i3sLoaderPromise ??= import("@loaders.gl/i3s").then((m) => m.I3SLoader);
  return i3sLoaderPromise;
}

function renderArcgisI3sTilesLayers(): void {
  if (!i3sOverlay || !i3sDeckGL || !i3sApp) return;

  const layers = useAppStore
    .getState()
    .layers.filter(isArcgisI3sTilesLayer);

  // Tear the overlay down once the last I3S layer is gone, so an empty deck.gl
  // overlay is not left attached for the rest of the session.
  if (layers.length === 0) {
    if (i3sOverlayMounted) {
      try {
        i3sApp.removeMapControl(i3sOverlay);
      } catch (error) {
        console.warn(
          "[GeoLibre] Failed to remove the empty ArcGIS I3S overlay",
          error,
        );
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
  if (
    i3sMountRetryScheduled ||
    i3sMountGaveUp ||
    typeof requestAnimationFrame === "undefined"
  ) {
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

function buildArcgisI3sTilesDeckLayer(layer: GeoLibreLayer): Layer | null {
  if (!i3sDeckGL || !i3sLoader) return null;
  const url = typeof layer.source.url === "string" ? layer.source.url : "";
  if (!url) return null;

  const Tile3DLayer = i3sDeckGL.geoLayers.Tile3DLayer as unknown as new (
    props: Record<string, unknown>,
  ) => Layer;

  return new Tile3DLayer({
    id: `${layer.id}-deck`,
    data: url,
    loader: i3sLoader,
    opacity: layer.opacity,
    pickable: false,
    operation: "draw",
    onTilesetLoad: (tileset: unknown) => flyToI3sTileset(layer.id, tileset),
    // @loaders.gl/i3s tags mesh content with a numeric coordinateSystem
    // (METER_OFFSETS = 2), but deck.gl 9 expects the string form
    // ("meter-offsets"); remap it on load so getShaderCoordinateSystem accepts
    // it instead of throwing "Invalid coordinateSystem: 2".
    onTileLoad: (tile: unknown) => normalizeI3sTileCoordinateSystem(tile),
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
  const content = (tile as { content?: { coordinateSystem?: unknown } } | null)
    ?.content;
  if (
    content &&
    typeof content.coordinateSystem === "number" &&
    content.coordinateSystem in COORDINATE_SYSTEM_STRINGS
  ) {
    content.coordinateSystem =
      COORDINATE_SYSTEM_STRINGS[content.coordinateSystem];
  }
}

/** Fly to a freshly-loaded tileset the first time, if the add requested it. */
function flyToI3sTileset(layerId: string, tileset: unknown): void {
  if (!i3sFlyToRequested.has(layerId) || !i3sApp) return;
  i3sFlyToRequested.delete(layerId);
  const info = tileset as {
    cartographicCenter?: [number, number, number];
    zoom?: number;
  } | null;
  const center = info?.cartographicCenter;
  const map = i3sApp.getMap?.() as
    | { flyTo?: (opts: Record<string, unknown>) => void }
    | undefined;
  if (!center || !map?.flyTo) return;
  map.flyTo({
    center: [center[0], center[1]],
    zoom: typeof info?.zoom === "number" ? Math.max(0, info.zoom - 1) : 15,
  });
}

function forceI3sMercatorProjection(app: GeoLibreAppAPI): void {
  if (i3sPreviousProjection === null) {
    // Only capture "globe" as worth restoring (never a value we forced), so a
    // reopened I3S-only project isn't left stuck in mercator. Mirrors the
    // Google Photorealistic overlay.
    const current = app.getMapProjection?.() ?? null;
    i3sPreviousProjection = current === "globe" ? "globe" : null;
  }
  app.setMapProjection?.("mercator");
  ensureMercatorProjection(app.getMap?.());
}

function restoreI3sPreviousProjection(): void {
  if (!i3sApp || i3sPreviousProjection === null) return;
  i3sApp.setMapProjection?.(i3sPreviousProjection);
  i3sPreviousProjection = null;
}
