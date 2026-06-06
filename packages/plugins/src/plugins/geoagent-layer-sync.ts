import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  useAppStore,
} from "@geolibre/core";
import type { FeatureCollection } from "geojson";

/**
 * Mirrors the private `Overlay` record kept by MapLibreAgentTools in
 * maplibre-gl-geoagent (verified against v0.4.2). The tools instance exposes
 * these through its `overlays` Map; re-verify the shape when bumping the
 * dependency.
 */
export type GeoAgentOverlayRecord = {
  kind: "geojson" | "raster" | "basemap" | "marker" | "native" | "gee";
  name: string;
  sourceIds: string[];
  layerIds: string[];
  data?: GeoJSON.GeoJSON;
  url?: string;
  style?: Record<string, unknown>;
  attribution?: string;
  layerSpecs?: Array<{
    layer: { id: string; type: string; paint?: Record<string, unknown> };
    beforeId?: string;
  }>;
  geeLayerName?: string;
};

/**
 * The slice of the GeoAgent tools surface the store -> GeoAgent sync needs.
 * Structural (rather than maplibre-gl types) so tests can pass fakes.
 */
export type GeoAgentSyncableTools = {
  map?: {
    getLayer: (id: string) => { type: string } | undefined;
    setLayoutProperty: (id: string, property: string, value: unknown) => unknown;
    setPaintProperty: (id: string, property: string, value: unknown) => unknown;
  };
  removeOverlay?: (name: string) => boolean;
};

const GEOAGENT_SOURCE_KIND = "geoagent-overlay";

const NATIVE_OPACITY_PROPERTIES: Record<string, string[]> = {
  background: ["background-opacity"],
  circle: ["circle-opacity"],
  fill: ["fill-opacity"],
  "fill-extrusion": ["fill-extrusion-opacity"],
  heatmap: ["heatmap-opacity"],
  line: ["line-opacity"],
  raster: ["raster-opacity"],
  symbol: ["icon-opacity", "text-opacity"],
};

let syncedTools: GeoAgentSyncableTools | null = null;
let storeUnsubscribe: (() => void) | null = null;

export function geoAgentStoreLayerId(overlayName: string): string {
  return `geoagent:${overlayName}`;
}

export function isGeoAgentStoreLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.metadata.sourceKind === GEOAGENT_SOURCE_KIND &&
    layer.metadata.externalNativeLayer === true
  );
}

export function geoAgentOverlayName(layer: GeoLibreLayer): string {
  return typeof layer.metadata.geoAgentOverlayName === "string"
    ? layer.metadata.geoAgentOverlayName
    : layer.name;
}

/**
 * Overlays the GeoAgent tools track that should appear in GeoLibre's layer
 * panel. Markers carry no style layers and internal records ("__terrain",
 * "__sky") are map state rather than layers, so both are excluded.
 */
function isSyncableOverlay(overlay: GeoAgentOverlayRecord): boolean {
  return !overlay.name.startsWith("__") && overlay.layerIds.length > 0;
}

export function createGeoAgentStoreLayer(
  overlay: GeoAgentOverlayRecord,
): GeoLibreLayer {
  const base: GeoLibreLayer = {
    id: geoAgentStoreLayerId(overlay.name),
    name: overlay.name,
    type: "raster",
    source: {
      type: "raster",
      sourceId: overlay.sourceIds[0],
      ...(overlay.url ? { tiles: [overlay.url] } : {}),
      ...(overlay.attribution ? { attribution: overlay.attribution } : {}),
    },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      externalNativeLayer: true,
      geoAgentOverlayKind: overlay.kind,
      geoAgentOverlayName: overlay.name,
      nativeLayerIds: [...overlay.layerIds],
      sourceId: overlay.sourceIds[0],
      sourceIds: [...overlay.sourceIds],
      sourceKind: GEOAGENT_SOURCE_KIND,
    },
    sourcePath: overlay.url ?? overlay.name,
  };

  if (overlay.kind === "geojson") {
    return {
      ...base,
      type: "geojson",
      source: {
        type: "geojson",
        sourceId: overlay.sourceIds[0],
        ...(overlay.url ? { url: overlay.url } : {}),
      },
      ...(isFeatureCollection(overlay.data) ? { geojson: overlay.data } : {}),
      style: geoJsonOverlayStyle(overlay.style ?? {}),
    };
  }

  if (overlay.kind === "native") {
    // Native overlays replay arbitrary layer specs (clusters, choropleths,
    // 3D buildings, ...) whose paint is agent-authored, often with data-driven
    // expressions. customLayerType makes layer-sync manage ordering only, so
    // the store's generic style never clobbers that paint; the GeoAgent
    // plugin applies visibility/opacity itself.
    return {
      ...base,
      opacity: nativeOverlayOpacity(overlay),
      metadata: {
        ...base.metadata,
        customLayerType: overlay.layerSpecs?.[0]?.layer.type ?? "custom",
        identifiable: false,
      },
    };
  }

  // raster, basemap, and gee overlays are all single raster tile layers.
  return {
    ...base,
    opacity: rasterOverlayOpacity(overlay),
    metadata: {
      ...base.metadata,
      identifiable: false,
      tileType: "raster",
      ...(overlay.url ? { tileUrl: overlay.url } : {}),
      ...(overlay.attribution ? { attribution: overlay.attribution } : {}),
    },
  };
}

/**
 * Diff the GeoAgent tools' overlay registry into the app store so the layer
 * panel lists agent-added layers. Adds new overlays, drops store layers whose
 * overlays are gone, and refreshes native ids when an overlay is re-added,
 * while leaving user-editable fields (name, visibility, opacity, style)
 * untouched on existing layers.
 */
export function syncGeoAgentOverlaysToStore(
  overlays: ReadonlyMap<string, GeoAgentOverlayRecord> | undefined,
): void {
  if (!overlays) return;

  const syncable = Array.from(overlays.values()).filter(isSyncableOverlay);
  const syncableIds = new Set(
    syncable.map((overlay) => geoAgentStoreLayerId(overlay.name)),
  );

  for (const storeLayer of useAppStore.getState().layers) {
    if (!isGeoAgentStoreLayer(storeLayer)) continue;
    if (!syncableIds.has(storeLayer.id)) {
      useAppStore.getState().removeLayer(storeLayer.id);
    }
  }

  for (const overlay of syncable) {
    const layer = createGeoAgentStoreLayer(overlay);
    const existing = useAppStore
      .getState()
      .layers.find((current) => current.id === layer.id);

    if (!existing) {
      useAppStore.getState().addLayer(layer);
      continue;
    }

    // Only structural fields are refreshed here. Name, visibility, opacity,
    // and style are user-editable in the layer panel, so re-syncing them
    // would clobber edits on every agent command.
    if (
      JSON.stringify(existing.metadata.nativeLayerIds) !==
        JSON.stringify(layer.metadata.nativeLayerIds) ||
      JSON.stringify(existing.metadata.sourceIds) !==
        JSON.stringify(layer.metadata.sourceIds) ||
      existing.metadata.tileUrl !== layer.metadata.tileUrl
    ) {
      useAppStore.getState().updateLayer(layer.id, {
        metadata: { ...existing.metadata, ...layer.metadata },
        source: layer.source,
        ...(layer.geojson ? { geojson: layer.geojson } : {}),
      });
    }
  }
}

/**
 * Remove every GeoAgent-registered layer from the store. Used when the plugin
 * deactivates, after the control's teardown has already cleared the overlays
 * from the map.
 */
export function removeGeoAgentStoreLayers(): void {
  for (const layer of useAppStore.getState().layers) {
    if (isGeoAgentStoreLayer(layer)) {
      useAppStore.getState().removeLayer(layer.id);
    }
  }
}

/**
 * Watch the store for panel-side changes to GeoAgent layers. Removing a layer
 * in the panel drops GeoAgent's overlay record (the native layers and sources
 * are already torn down by removeLayerFromMap), so the overlay is not
 * resurrected on the agent's next basemap change and list_layers stays
 * accurate. Custom native layers (clusters, choropleths, 3D buildings) skip
 * the generic visibility/paint sync in layer-sync, so visibility and opacity
 * are applied here directly.
 *
 * Subscribes once; later calls just point the sync at the latest tools
 * instance (the control recreates tools on every onAdd).
 */
export function wireGeoAgentStoreSync(tools: GeoAgentSyncableTools): void {
  syncedTools = tools;
  storeUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    const activeTools = syncedTools;
    if (!activeTools || state.layers === previous.layers) return;

    const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));
    for (const layer of previous.layers) {
      if (!isGeoAgentStoreLayer(layer)) continue;

      const current = currentById.get(layer.id);
      if (!current) {
        activeTools.removeOverlay?.(geoAgentOverlayName(layer));
        continue;
      }

      if (
        typeof current.metadata.customLayerType === "string" &&
        (current.visible !== layer.visible ||
          current.opacity !== layer.opacity)
      ) {
        applyGeoAgentCustomLayerState(activeTools.map, current);
      }
    }
  });
}

export function unwireGeoAgentStoreSync(): void {
  storeUnsubscribe?.();
  storeUnsubscribe = null;
  syncedTools = null;
}

function applyGeoAgentCustomLayerState(
  map: GeoAgentSyncableTools["map"],
  layer: GeoLibreLayer,
): void {
  if (!map) return;

  const nativeLayerIds = Array.isArray(layer.metadata.nativeLayerIds)
    ? layer.metadata.nativeLayerIds
    : [];
  for (const nativeLayerId of nativeLayerIds) {
    if (typeof nativeLayerId !== "string") continue;
    const nativeLayer = map.getLayer(nativeLayerId);
    if (!nativeLayer) continue;

    try {
      map.setLayoutProperty(
        nativeLayerId,
        "visibility",
        layer.visible ? "visible" : "none",
      );
    } catch {
      // Custom layers from external controls may not accept layout updates.
    }
    for (const property of NATIVE_OPACITY_PROPERTIES[nativeLayer.type] ?? []) {
      try {
        map.setPaintProperty(nativeLayerId, property, layer.opacity);
      } catch {
        // Ignore paint properties a heterogeneous native layer rejects.
      }
    }
  }
}

/**
 * Map a GeoAgent geojson overlay style onto GeoLibre's LayerStyle using the
 * same keys and defaults as geojsonLayerPaint in maplibre-gl-geoagent, so the
 * store-driven repaint reproduces what the agent drew.
 */
function geoJsonOverlayStyle(
  style: Record<string, unknown>,
): GeoLibreLayer["style"] {
  const color =
    stringValue(style.color) ?? stringValue(style["line-color"]) ?? "#1c7ed6";
  const fillColor =
    stringValue(style["fill-color"]) ?? stringValue(style.fillColor) ?? color;
  const strokeColor =
    stringValue(style["line-color"]) ?? stringValue(style.lineColor) ?? color;
  const fillOpacity = clamp01(
    numberValue(style.opacity) ?? numberValue(style["fill-opacity"]) ?? 0.35,
  );

  return {
    ...DEFAULT_LAYER_STYLE,
    fillColor,
    strokeColor,
    fillOpacity,
    strokeWidth:
      numberValue(style["line-width"]) ?? numberValue(style.lineWidth) ?? 2,
    circleRadius:
      numberValue(style["circle-radius"]) ?? numberValue(style.radius) ?? 6,
  };
}

function rasterOverlayOpacity(overlay: GeoAgentOverlayRecord): number {
  return clamp01(numberValue(overlay.style?.opacity) ?? 1);
}

function nativeOverlayOpacity(overlay: GeoAgentOverlayRecord): number {
  for (const spec of overlay.layerSpecs ?? []) {
    const opacity = numberValue(spec.layer.paint?.[`${spec.layer.type}-opacity`]);
    if (opacity !== undefined) return clamp01(opacity);
  }
  return 1;
}

function isFeatureCollection(
  data: GeoJSON.GeoJSON | undefined,
): data is FeatureCollection {
  return data?.type === "FeatureCollection";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  const numeric =
    typeof value === "number" || typeof value === "string"
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(numeric) ? numeric : undefined;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
