// MapController layer: map handle, layer bookkeeping and style-layer queries.
// The MapController layer chain is documented in map-controller.ts.

import {
  DEFAULT_PROJECT_PREFERENCES,
  type GeoLibreLayer,
  type MapPreferences,
} from "@geolibre/core";
import * as maplibregl from "maplibre-gl";
import {
  circleLayerId,
  clusterCountLayerId,
  clusterLayerId,
  fillExtrusionLayerId,
  fillLayerId,
  heatmapLayerId,
  highlightCircleLayerId,
  highlightFillLayerId,
  highlightLineLayerId,
  labelLayerId,
  lineLayerId,
  markerLayerId,
  sourceId,
  textLayerId,
} from "./geojson-loader";
import { BASEMAP_LABEL_KEY, clearLayerLabels, publishLayerLabels } from "./layer-labels";
import { mbtilesStyleLayerIds, vectorTileStyleLayerIds } from "./layer-sync";
import { EDGE_LENGTH_LAYER_ID } from "./edge-lengths";
import type { ResolvedMapCrs } from "./active-map-crs";
import {
  MAPLIBRE_CAPABILITIES,
  type BuiltInMapControl,
  DEFAULT_BUILT_IN_CONTROL_VISIBILITY,
  DEFAULT_BUILT_IN_CONTROL_POSITIONS,
  type MapEngineCapabilities,
} from "./map-engine";

const NON_BASEMAP_STYLE_LAYER_IDS = [
  highlightFillLayerId(),
  highlightLineLayerId(),
  highlightCircleLayerId(),
  EDGE_LENGTH_LAYER_ID,
];

function nativeLayerSuffix(layerId: string): string | undefined {
  const suffix = layerId.split("-").pop();
  if (!suffix) return undefined;
  return suffix.charAt(0).toUpperCase() + suffix.slice(1);
}

function vectorTileLayerSuffix(layerId: string): string | undefined {
  if (layerId.endsWith("-vector") || layerId.endsWith("-fill")) {
    return "Polygons";
  }
  if (layerId.endsWith("-vector-extrusion") || layerId.endsWith("-extrusion")) {
    return "Extrusions";
  }
  if (layerId.endsWith("-line")) return "Lines";
  if (layerId.endsWith("-circle")) return "Points";
  return nativeLayerSuffix(layerId);
}

/**
 * MapController layer: the map handle, style readiness, layer bookkeeping and
 * the style-layer queries (native ids, sources, basemap layers, insertion
 * points) every other layer builds on.
 */
export class MapControllerBase {
  readonly kind = "maplibre" as const;

  readonly capabilities: MapEngineCapabilities = MAPLIBRE_CAPABILITIES;

  protected map: maplibregl.Map | null = null;

  protected backgroundLabel = "Background";

  protected mapPreferences: MapPreferences = DEFAULT_PROJECT_PREFERENCES.map;

  /** The custom CRS the map is drawn in (map-crs.ts); null on the default map. */
  protected activeCrs: ResolvedMapCrs | null = null;

  protected syncedLayers: GeoLibreLayer[] = [];

  protected layerIds: string[] = [];

  protected styleReady = false;

  protected controlVisibility: Record<BuiltInMapControl, boolean> = {
    ...DEFAULT_BUILT_IN_CONTROL_VISIBILITY,
  };

  protected controlPositions: Record<BuiltInMapControl, maplibregl.ControlPosition> = {
    ...DEFAULT_BUILT_IN_CONTROL_POSITIONS,
  };

  getMap(): maplibregl.Map | null {
    return this.map;
  }

  protected isStyleReady(): boolean {
    return Boolean(this.map && this.styleReady);
  }

  addControl(
    control: maplibregl.IControl,
    position: maplibregl.ControlPosition = "top-right",
  ): boolean {
    if (!this.map) return false;
    // Guard against adding the same control instance twice: MapLibre would call
    // onAdd again and stack a second copy of the control's DOM (e.g. a duplicate
    // GeoEditor toolbar) if a caller re-adds an already-mounted control.
    // `hasControl` is optional-chained so test doubles without it still work.
    if (this.map.hasControl?.(control)) return true;
    this.map.addControl(control, position);
    return true;
  }

  removeControl(control: maplibregl.IControl): void {
    if (!this.map) return;
    try {
      this.map.removeControl(control);
    } catch {
      // MapLibre throws when a control has already been removed.
    }
  }

  getBasemapStyleLayerIds(): string[] {
    return this.getBasemapStyleLayers().map((layer) => layer.id);
  }

  protected getBasemapStyleLayers(): maplibregl.LayerSpecification[] {
    if (!this.isStyleReady() || !this.map) return [];
    const map = this.map;

    const userStyleLayerIds = new Set(
      this.syncedLayers.flatMap((layer) => this.getCandidateStyleLayers(layer).map(({ id }) => id)),
    );
    // A control that rebuilds its own render layers (maplibre-gl-vector swaps
    // circle <-> heatmap <-> cluster layers on a point-renderer change) does so
    // asynchronously, so `metadata.nativeLayerIds` can name layers the map no
    // longer has while the live replacements are missing from the set above.
    // Those replacements are still the user's data — always drawn from the
    // layer's own source — so claim every style layer that reads one of the
    // synced layers' sources. Without this the Background pass mistakes them
    // for basemap layers: it pins their opacity to whatever it first saw
    // (breaking the panel's opacity slider) and forces them back to the
    // basemap's visibility (re-showing a hidden heatmap, #1882). Reuse
    // getLayerSourceIds so this stays in step with the rest of the controller:
    // it also covers the singular `metadata.sourceId` some registrations use.
    const userSourceIds = new Set(
      this.syncedLayers.flatMap((layer) => this.getLayerSourceIds(layer)),
    );
    const nonBasemapStyleLayerIds = new Set(NON_BASEMAP_STYLE_LAYER_IDS);

    return (map.getStyle().layers ?? []).filter(
      (layer) =>
        !userStyleLayerIds.has(layer.id) &&
        !nonBasemapStyleLayerIds.has(layer.id) &&
        !("source" in layer && typeof layer.source === "string" && userSourceIds.has(layer.source)),
    );
  }

  protected getNativeLayerIdsByLayerId(layerId: string): string[] {
    const layer = this.syncedLayers.find((item) => item.id === layerId);
    return layer ? this.getNativeLayerIds(layer) : [];
  }

  protected getNativeLayerIds(layer: GeoLibreLayer): string[] {
    return this.getCandidateStyleLayers(layer)
      .map(({ id }) => id)
      .filter((id) => this.map?.getLayer(id));
  }

  protected getLayerSourceBounds(layer: GeoLibreLayer): [number, number, number, number] | null {
    for (const id of this.getLayerSourceIds(layer)) {
      const source = this.map?.getSource(id) as
        | { bounds?: [number, number, number, number] }
        | undefined;
      const bounds = this.normalizeLayerBounds(source?.bounds);
      if (bounds) return bounds;
    }
    return null;
  }

  protected getLayerSourceIds(layer: GeoLibreLayer): string[] {
    const ids = new Set<string>([sourceId(layer.id)]);
    const sourceIds = layer.metadata.sourceIds;
    if (Array.isArray(sourceIds)) {
      for (const id of sourceIds) {
        if (typeof id === "string") ids.add(id);
      }
    }
    if (typeof layer.metadata.sourceId === "string") {
      ids.add(layer.metadata.sourceId);
    }
    return Array.from(ids);
  }

  private normalizeLayerBounds(bounds: unknown): [number, number, number, number] | null {
    if (
      Array.isArray(bounds) &&
      bounds.length === 4 &&
      bounds.every((value) => Number.isFinite(value))
    ) {
      return bounds as [number, number, number, number];
    }
    return null;
  }

  private getNamedStyleLayers(layer: GeoLibreLayer): Array<{
    id: string;
    name: string;
    layer: GeoLibreLayer;
  }> {
    if (!this.map) return [];

    const existingStyleLayers = this.getCandidateStyleLayers(layer).filter(({ id }) =>
      this.map?.getLayer(id),
    );
    return existingStyleLayers.map(({ id, suffix }) => ({
      id,
      name: existingStyleLayers.length > 1 && suffix ? `${layer.name} ${suffix}` : layer.name,
      layer,
    }));
  }

  protected getBeforeStyleLayerId(layers: GeoLibreLayer[], layerIndex: number): string | undefined {
    if (!this.map) return undefined;

    const styleLayerIds =
      this.map.getLayersOrder?.() ?? (this.map.getStyle().layers ?? []).map(({ id }) => id);
    for (const layer of layers.slice(layerIndex + 1)) {
      const candidateIds = new Set(this.getCandidateStyleLayers(layer).map(({ id }) => id));
      // A logical layer can render through several MapLibre style layers. KML
      // icon points, for example, use a symbol companion plus a fallback
      // circle for features without icons. Anchor beneath whichever companion
      // is currently lowest in the real style order so the inserted layer
      // cannot split that logical layer in two.
      const bottommostId = styleLayerIds.find((id) => candidateIds.has(id));
      if (bottommostId) return bottommostId;
    }

    if (layerIndex >= 0) {
      return this.getExternalBeforeStyleLayerId(layers[layerIndex]);
    }

    return undefined;
  }

  private getExternalBeforeStyleLayerId(layer: GeoLibreLayer | undefined): string | undefined {
    if (!this.map || !layer?.beforeId) return undefined;
    if (this.getCandidateStyleLayers(layer).some(({ id }) => id === layer.beforeId)) {
      return undefined;
    }
    return this.map.getLayer(layer.beforeId) ? layer.beforeId : undefined;
  }

  protected getCandidateStyleLayers(layer: GeoLibreLayer): Array<{
    id: string;
    suffix?: string;
  }> {
    const nativeLayerIds = layer.metadata.nativeLayerIds;
    if (Array.isArray(nativeLayerIds) && nativeLayerIds.length > 0) {
      const candidates = nativeLayerIds
        .filter((id): id is string => typeof id === "string")
        .map((id) => ({ id, suffix: nativeLayerSuffix(id) }));
      // KML/KMZ icons loaded through the Vector Layer control render in a
      // GeoLibre-owned companion symbol layer, not one of the control's native
      // layer ids. Include it here so Background visibility/opacity does not
      // mistake the icons for basemap symbols.
      if (layer.metadata.sourceKind === "maplibre-gl-vector") {
        candidates.push({ id: markerLayerId(layer.id), suffix: "Markers" });
      }
      return candidates;
    }

    if (layer.type === "geojson") {
      return [
        { id: fillExtrusionLayerId(layer.id), suffix: "Extrusions" },
        { id: fillLayerId(layer.id), suffix: "Polygons" },
        { id: lineLayerId(layer.id), suffix: "Lines" },
        { id: heatmapLayerId(layer.id), suffix: "Heatmap" },
        { id: clusterLayerId(layer.id), suffix: "Clusters" },
        { id: clusterCountLayerId(layer.id), suffix: "Cluster counts" },
        { id: circleLayerId(layer.id), suffix: "Points" },
        { id: markerLayerId(layer.id), suffix: "Markers" },
        { id: textLayerId(layer.id), suffix: "Text" },
        { id: labelLayerId(layer.id), suffix: "Labels" },
      ];
    }

    if (
      layer.type === "raster" ||
      layer.type === "wms" ||
      layer.type === "wmts" ||
      layer.type === "xyz"
    ) {
      return [{ id: `layer-${layer.id}-raster` }];
    }

    if (layer.type === "video") {
      return [{ id: `layer-${layer.id}-video` }];
    }

    if (layer.type === "image") {
      return [{ id: `layer-${layer.id}-image` }];
    }

    if (layer.type === "vector-tiles") {
      return vectorTileStyleLayerIds(layer).map((id) => ({
        id,
        suffix: vectorTileLayerSuffix(id),
      }));
    }

    if (layer.type === "mbtiles") {
      return mbtilesStyleLayerIds(layer).map((id) => ({
        id,
        suffix: nativeLayerSuffix(id),
      }));
    }

    return [];
  }

  protected publishLayerDisplayNames(layers: GeoLibreLayer[]): void {
    publishLayerLabels([
      ...layers
        .flatMap((layer) => this.getNamedStyleLayers(layer))
        .map(({ id, name }): [string, string] => [id, name]),
      // Deck.gl-rendered COG rasters are custom layers absent from the map
      // style, so getNamedStyleLayers (which filters to existing style layers)
      // skips them. Publish their store id -> name directly so the Layer Swipe
      // panel, which lists them by store id via its COG layerProvider, shows a
      // friendly name instead of the raw id. Scoped to the two kinds that
      // provider lists -- "cog-url" (CogLayerControl) and "maplibre-gl-raster"
      // (RasterControl) -- to match that scope. See opengeos/GeoLibre#1240.
      ...layers
        .filter(
          (layer) =>
            layer.type === "cog" &&
            (layer.metadata.sourceKind === "cog-url" ||
              layer.metadata.sourceKind === "maplibre-gl-raster") &&
            layer.metadata.externalNativeLayer === true,
        )
        .map((layer): [string, string] => [layer.id, layer.name]),
      // The Layer Swipe panel groups all basemap layers under "__basemap__";
      // publish the translated base-layer label last so this synthetic key
      // always wins over a layer that happens to share the id, matching the
      // sidebar. It is published even with no overlay layers, since the panel
      // always lists the basemap entry.
      [BASEMAP_LABEL_KEY, this.backgroundLabel],
    ]);
  }

  /**
   * Clear all published layer display names. Used on teardown so the bridge
   * does not retain stale labels; kept separate from publishLayerDisplayNames,
   * which always re-publishes the basemap entry.
   */
  protected clearLayerDisplayNames(): void {
    clearLayerLabels();
  }
}
