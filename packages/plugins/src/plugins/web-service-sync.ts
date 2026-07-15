import {
  DEFAULT_LAYER_STYLE,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";

/**
 * Shared store-sync engine for the Web Services plugins (FEMA NFHL, NASA
 * Earthdata, US EPA EnviroAtlas, USGS National Map).
 *
 * Each of those packages ships a panel control that adds raster layers
 * directly to the maplibre map. The engine mirrors those native layers into
 * the GeoLibre layer store so they show up in the Layers panel, persist in
 * projects, and survive style reloads (rebuilt by the
 * `syncWebServiceTileRasterLayer` branch in `@geolibre/map`'s layer-sync).
 *
 * Sync is bidirectional:
 * - control events reconcile control state into the store (add/update/remove)
 * - store changes push opacity/visibility/removal back into the control and
 *   adopt restored project layers the control does not know about yet
 */

/**
 * Plugin ids grouped under the Plugins menu's "Web Services" submenu.
 * The corresponding store-layer `metadata.sourceKind` values live in
 * WEB_SERVICE_SOURCE_KINDS in `@geolibre/map`'s layer-sync, which rebuilds
 * these layers after style reloads.
 */
export const WEB_SERVICE_PLUGIN_IDS = [
  "maplibre-gl-fema-wms",
  "maplibre-gl-nasa-earthdata",
  "maplibre-gl-enviroatlas",
  "maplibre-gl-national-map",
  "maplibre-gl-openaerialmap",
  "maplibre-gl-source-coop",
  "maplibre-gl-natural-earth",
] as const;

/** One active layer reported by a web service control. */
export interface WebServiceLayerEntry {
  /** Store layer id. Must equal the control's native maplibre layer id. */
  id: string;
  /** Display name shown in the GeoLibre Layers panel. */
  name: string;
  /** The control's native maplibre source id. */
  sourceId: string;
  /** Raster tile URL template(s) used to rebuild the source on reload. */
  tiles: string[];
  /** Raster opacity between 0 and 1. */
  opacity: number;
  /** Whether the native layer is visible. */
  visible: boolean;
  /** "wms" routes `{bbox-epsg-3857}` tiles through the dev WMS proxy. */
  layerType: "raster" | "wms";
  /** Extra raster source properties (tileSize, maxzoom, bounds, ...). */
  source?: Record<string, unknown>;
  /** Extra metadata persisted so the layer can be re-adopted after reload. */
  metadata?: Record<string, unknown>;
}

/** Adapter mapping one web service control onto the shared sync engine. */
export interface WebServiceAdapter<C> {
  /** Unique `metadata.sourceKind` for store layers owned by this adapter. */
  sourceKind: string;
  /** Wires control events so `listener` runs after every relevant change. */
  attachEvents: (control: C, listener: () => void) => void;
  /** Removes the handlers installed by {@link attachEvents}. */
  detachEvents: (control: C) => void;
  /** Lists the layers currently active in the control. */
  listActive: (control: C) => WebServiceLayerEntry[];
  /** Removes a layer from the control (the user deleted its store layer). */
  removeFromControl: (control: C, entry: WebServiceLayerEntry) => void;
  /** Pushes a store opacity change into the control, when supported. */
  setControlOpacity?: (
    control: C,
    entry: WebServiceLayerEntry,
    opacity: number,
  ) => void;
  /** Pushes a store visibility change into the control, when supported. */
  setControlVisibility?: (
    control: C,
    entry: WebServiceLayerEntry,
    visible: boolean,
  ) => void;
  /**
   * Hands restored store layers (project reload) back to the control so its
   * panel lists them again. May complete asynchronously; the control's own
   * events drive the follow-up reconcile.
   */
  adopt: (control: C, layers: GeoLibreLayer[]) => void;
}

export interface WebServiceStoreSync<C> {
  /** Starts syncing the control. Adopts restored store layers immediately. */
  attach: (control: C) => void;
  /** Stops syncing and forgets tracked state. Store layers are kept. */
  detach: () => void;
}

/**
 * Creates the bidirectional store-sync engine for one web service adapter.
 *
 * @param adapter - The control-specific adapter
 * @returns Attach/detach handles used by the plugin lifecycle
 */
export function createWebServiceStoreSync<C>(
  adapter: WebServiceAdapter<C>,
): WebServiceStoreSync<C> {
  let control: C | null = null;
  let unsubscribeStore: (() => void) | null = null;
  let syncing = false;
  // Last opacity/visibility seen on the control per layer id. Doubles as the
  // record of layers this engine manages: store layers outside this map are
  // either freshly restored (adopt) or not ours to remove.
  const lastControlValues = new Map<
    string,
    { opacity: number; visible: boolean }
  >();
  // Layers handed to adopt() whose control-side registration is pending.
  const pendingAdoptionIds = new Set<string>();
  // Layers handed to removeFromControl() whose control-side removal is
  // pending. Guards against re-adding a just-deleted store layer when a
  // control removes asynchronously and still lists the layer during the
  // reconcile that follows reverseSync.
  const pendingRemovalIds = new Set<string>();

  const handleControlEvent = () => {
    if (syncing || !control) return;
    syncing = true;
    try {
      reconcile(control);
    } finally {
      syncing = false;
    }
  };

  const handleStoreChange = () => {
    if (syncing || !control) return;
    syncing = true;
    try {
      reverseSync(control);
      reconcile(control);
    } finally {
      syncing = false;
    }
  };

  function reconcile(activeControl: C): void {
    const store = useAppStore.getState();
    const entries = adapter.listActive(activeControl);
    const activeIds = new Set(entries.map((entry) => entry.id));

    // A pending removal is finished once the control stops listing the id.
    for (const id of pendingRemovalIds) {
      if (!activeIds.has(id)) pendingRemovalIds.delete(id);
    }

    for (const entry of entries) {
      pendingAdoptionIds.delete(entry.id);
      const nextLayer = createStoreLayer(adapter.sourceKind, entry);
      const existing = store.layers.find((layer) => layer.id === entry.id);
      const last = lastControlValues.get(entry.id);
      if (!existing) {
        // The control may still list a layer whose removal is in flight;
        // re-adding it here would resurrect the deleted store layer.
        if (pendingRemovalIds.has(entry.id)) continue;
        store.addLayer(nextLayer);
      } else {
        if (shouldUpdateStoreLayer(existing, nextLayer)) {
          store.updateLayer(entry.id, {
            metadata: nextLayer.metadata,
            name: nextLayer.name,
            source: nextLayer.source,
            sourcePath: nextLayer.sourcePath,
            type: nextLayer.type,
          });
        }
        // Push opacity/visibility only when the control changed them, so a
        // value set through the Layers panel is not reverted by the next
        // unrelated control event.
        if (
          last &&
          entry.opacity !== last.opacity &&
          entry.opacity !== existing.opacity
        ) {
          store.updateLayer(entry.id, { opacity: entry.opacity });
        }
        if (
          last &&
          entry.visible !== last.visible &&
          entry.visible !== existing.visible
        ) {
          store.updateLayer(entry.id, { visible: entry.visible });
        }
      }
      lastControlValues.set(entry.id, {
        opacity: entry.opacity,
        visible: entry.visible,
      });
    }

    // Remove store layers the control dropped. Restored layers the control
    // has not adopted yet are not in lastControlValues and are kept.
    for (const layer of useAppStore.getState().layers) {
      if (layer.metadata.sourceKind !== adapter.sourceKind) continue;
      if (activeIds.has(layer.id)) continue;
      if (!lastControlValues.has(layer.id)) continue;
      useAppStore.getState().removeLayer(layer.id);
      lastControlValues.delete(layer.id);
      pendingAdoptionIds.delete(layer.id);
    }
  }

  function reverseSync(activeControl: C): void {
    const ownLayers = useAppStore
      .getState()
      .layers.filter(
        (layer) => layer.metadata.sourceKind === adapter.sourceKind,
      );
    const ownById = new Map(ownLayers.map((layer) => [layer.id, layer]));
    const entries = adapter.listActive(activeControl);

    for (const entry of entries) {
      const storeLayer = ownById.get(entry.id);
      if (!storeLayer) {
        // The user removed the layer through the Layers panel.
        if (lastControlValues.has(entry.id)) {
          lastControlValues.delete(entry.id);
          pendingRemovalIds.add(entry.id);
          adapter.removeFromControl(activeControl, entry);
        }
        continue;
      }
      if (adapter.setControlOpacity && storeLayer.opacity !== entry.opacity) {
        adapter.setControlOpacity(activeControl, entry, storeLayer.opacity);
      }
      if (
        adapter.setControlVisibility &&
        storeLayer.visible !== entry.visible
      ) {
        adapter.setControlVisibility(activeControl, entry, storeLayer.visible);
      }
    }

    const knownIds = new Set(entries.map((entry) => entry.id));
    const layersToAdopt = ownLayers.filter(
      (layer) =>
        !knownIds.has(layer.id) &&
        !lastControlValues.has(layer.id) &&
        !pendingAdoptionIds.has(layer.id),
    );
    if (layersToAdopt.length > 0) {
      for (const layer of layersToAdopt) pendingAdoptionIds.add(layer.id);
      adapter.adopt(activeControl, layersToAdopt);
    }
  }

  return {
    attach: (nextControl: C) => {
      control = nextControl;
      adapter.attachEvents(nextControl, handleControlEvent);
      unsubscribeStore = useAppStore.subscribe(handleStoreChange);
      // Adopt layers restored from a project and pick up any state the
      // control already has.
      handleStoreChange();
    },
    detach: () => {
      if (control) adapter.detachEvents(control);
      unsubscribeStore?.();
      unsubscribeStore = null;
      control = null;
      lastControlValues.clear();
      pendingAdoptionIds.clear();
      pendingRemovalIds.clear();
    },
  };
}

/**
 * Builds the GeoLibre store layer for one active web service entry.
 *
 * @param sourceKind - The adapter's `metadata.sourceKind`
 * @param entry - The active layer reported by the control
 * @returns The store layer mirroring the control's native layer
 */
export function createStoreLayer(
  sourceKind: string,
  entry: WebServiceLayerEntry,
): GeoLibreLayer {
  return {
    id: entry.id,
    name: entry.name,
    type: entry.layerType,
    source: {
      type: "raster",
      sourceId: entry.sourceId,
      tiles: entry.tiles,
      tileSize: 256,
      ...(entry.source ?? {}),
    },
    visible: entry.visible,
    opacity: entry.opacity,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      ...(entry.metadata ?? {}),
      // Base fields come after the adapter spread so adapter metadata can
      // never override what the sync engine and layer-sync rely on.
      externalNativeLayer: true,
      identifiable: false,
      nativeLayerIds: [entry.id],
      sourceId: entry.sourceId,
      sourceIds: [entry.sourceId],
      sourceKind,
      tileUrl: entry.tiles[0],
    },
    sourcePath: entry.tiles[0],
  };
}

function shouldUpdateStoreLayer(
  existingLayer: GeoLibreLayer,
  nextLayer: GeoLibreLayer,
): boolean {
  return (
    existingLayer.type !== nextLayer.type ||
    existingLayer.name !== nextLayer.name ||
    existingLayer.sourcePath !== nextLayer.sourcePath ||
    stableStringify(existingLayer.source) !==
      stableStringify(nextLayer.source) ||
    stableStringify(existingLayer.metadata) !==
      stableStringify(nextLayer.metadata)
  );
}

// JSON.stringify is sensitive to key insertion order, and the existing store
// layer may have been deserialized from a project file, so the comparison
// uses a key-sorted form to avoid spurious updates.
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Reads the live raster source spec for a native layer so the persisted
 * store layer rebuilds the source exactly as the control created it.
 *
 * @param map - The maplibre map the control is attached to (or undefined)
 * @param sourceId - The native source id
 * @returns Tile templates plus source properties, or null when unavailable
 */
export function readNativeRasterSource(
  map: { getStyle: () => { sources?: Record<string, unknown> } } | undefined,
  sourceId: string,
): { tiles: string[]; source: Record<string, unknown> } | null {
  if (!map) return null;
  let spec: unknown;
  try {
    spec = map.getStyle()?.sources?.[sourceId];
  } catch {
    return null;
  }
  if (!spec || typeof spec !== "object") return null;
  const raw = spec as Record<string, unknown>;
  if (raw.type !== "raster" || !Array.isArray(raw.tiles)) return null;
  const tiles = raw.tiles
    .filter(
      (tile): tile is string => typeof tile === "string" && tile.length > 0,
    )
    .map(unproxyWmsTileUrl);
  if (tiles.length === 0) return null;

  const source: Record<string, unknown> = {};
  for (const key of [
    "tileSize",
    "minzoom",
    "maxzoom",
    "bounds",
    "attribution",
    "scheme",
  ]) {
    if (raw[key] !== undefined) source[key] = raw[key];
  }
  return { tiles, source };
}

// Mirrors WMS_PROXY_PATH in @geolibre/map's layer-sync. In dev the map's
// native sources can carry proxied tile URLs; those must be unwrapped before
// they are persisted into store layers, or project files would record
// dev-only proxy URLs (and re-proxying would nest them).
const WMS_PROXY_PREFIX = "/__geolibre_wms_proxy?url=";

function unproxyWmsTileUrl(tile: string): string {
  if (!tile.startsWith(WMS_PROXY_PREFIX)) return tile;
  try {
    return decodeURIComponent(tile.slice(WMS_PROXY_PREFIX.length));
  } catch {
    return tile;
  }
}

/**
 * Picks the GeoLibre layer type for a set of tile templates. Templates with
 * a `{bbox-epsg-3857}` placeholder are WMS-style exports that need the dev
 * proxy; everything else is a plain XYZ raster.
 *
 * @param tiles - Raster tile URL templates
 * @returns The store layer type
 */
export function layerTypeForTiles(tiles: string[]): "raster" | "wms" {
  return tiles.some((tile) => tile.includes("{bbox-epsg-3857}"))
    ? "wms"
    : "raster";
}

/**
 * Reads a string metadata value from a store layer.
 *
 * @param value - The raw metadata value
 * @returns The string, or undefined when absent or not a string
 */
export function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
