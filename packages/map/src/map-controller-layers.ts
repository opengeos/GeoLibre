// MapController layer: layer sync, basemap visibility/opacity and story opacity.
// The MapController layer chain is documented in map-controller.ts.

import { mapZoomStepOutputs, styleValue, type GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import * as maplibregl from "maplibre-gl";
import {
  generatorCircleLayerId,
  generatorFillLayerId,
  generatorLineLayerId,
  invertedFillLayerId,
  lineDecorationLayerId,
} from "./geojson-loader";
import {
  externalSourceIdsFor,
  hasPendingExternalNativeFilters,
  hasLineGapLabels,
  hasZoomDependentClusterFilter,
  removeLayerFromMap,
  styleValuesEqual,
  syncLayer,
} from "./layer-sync";
import { blendModeSignature, syncLayerBlendModes } from "./layer-blend-modes";
import { pmtilesLineDecorationLayerIds } from "./pmtiles-layer";
import { getDynamicPaintProperty, setDynamicPaintProperty } from "./dynamic-style-property";
import { STORY_OPACITY_PAINT_PROPERTIES } from "./map-engine";
import { MapControllerStyle } from "./map-controller-style";

const OPACITY_PAINT_PROPERTIES = STORY_OPACITY_PAINT_PROPERTIES;

/** Whether a paint expression reads `["zoom"]` anywhere inside it. */
function expressionReadsZoom(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  if (value[0] === "zoom" && value.length === 1) return true;
  return value.some(expressionReadsZoom);
}

/**
 * Rescale the opacity paint value the layer sync wrote for a layer's own
 * opacity so it shows a story chapter's opacity in its place.
 *
 * A chapter's opacity stands in for the layer opacity (the Layers panel
 * slider), not for the paint property: the sync writes each opacity paint as
 * the style's own value times the layer opacity (`fillOpacity` x opacity for a
 * fill), so a chapter at 1 must draw a fill styled at 0.45 at 0.45, not solid.
 * The base is therefore scaled by `storyOpacity / layerOpacity`.
 *
 * @param base The paint value the layer sync last wrote.
 * @param layerOpacity The store layer's own opacity.
 * @param storyOpacity The chapter's opacity, already clamped to 0-1.
 * @returns The value to write, or `undefined` when the base cannot be rescaled
 *   (unset, a layer opacity of 0 that erased the style's value, or a zoom
 *   expression other than a top-level zoom `step`, since MapLibre only
 *   accepts zoom as the input of a top-level step or interpolate).
 */
export function storyScaledPaintValue(
  base: unknown,
  layerOpacity: number,
  storyOpacity: number,
): unknown {
  if (!Number.isFinite(layerOpacity) || layerOpacity <= 0) return undefined;
  const ratio = storyOpacity / layerOpacity;
  const scale = (value: unknown): unknown => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.min(1, Math.max(0, value * ratio));
    }
    if (Array.isArray(value) && !expressionReadsZoom(value)) {
      return ratio === 1 ? value : ["min", 1, ["*", value, ratio]];
    }
    return undefined;
  };
  if (!Array.isArray(base) || !expressionReadsZoom(base)) return scale(base);
  // A rule's scale range compiles to a top-level `["step", ["zoom"], ...]`
  // (see `scaleByOpacity` in style-mapper.ts); scale its outputs in place.
  if (base[0] !== "step" || !Array.isArray(base[1]) || base[1][0] !== "zoom") return undefined;
  let scalable = true;
  const stepped = mapZoomStepOutputs(base, (output) => {
    const value = scale(output);
    if (value === undefined) scalable = false;
    return value;
  });
  return scalable ? stepped : undefined;
}

/**
 * The paint value a story fade writes for one property of one style layer
 * when the synced value cannot be rescaled (see {@link storyScaledPaintValue}).
 *
 * Fades write absolute opacities, but the geometry generator's fill/circle
 * opacity is the product of the layer opacity and the style's own
 * `geometryGeneratorOpacity` (see `applyGeometryGeneratorLayers`), so a fade
 * back to 1 must not promote a translucent buffer to solid.
 */
function storyPaintOpacity(
  layer: GeoLibreLayer,
  nativeId: string,
  prop: string,
  opacity: number,
): number {
  const isGeneratorFill =
    (nativeId === generatorFillLayerId(layer.id) && prop === "fill-opacity") ||
    (nativeId === generatorCircleLayerId(layer.id) && prop === "circle-opacity");
  if (!isGeneratorFill) return opacity;
  const generatorOpacity = styleValue(layer.style, "geometryGeneratorOpacity");
  return opacity * Math.min(1, Math.max(0, generatorOpacity));
}

/**
 * MapController layer: reconciling store layers onto the map, basemap
 * visibility and opacity, and story-map layer opacity.
 */
export class MapControllerLayers extends MapControllerStyle {
  /** Presentation overrides survive ordinary layer syncs without changing project data. */
  protected readonly storyOpacities = new Map<string, number>();

  /**
   * Per style layer and paint property: the value the layer sync wrote (the
   * base a story fade rescales) and the value the fade wrote over it. A
   * current value that no longer matches `written` means a sync has rewritten
   * the base since, so it is captured afresh.
   */
  private readonly storyPaintBases = new Map<string, { base: unknown; written: unknown }>();

  /** This pane's last blend-mode fingerprint; see `blendModeSignature`. */
  private blendSignature = "";

  private clusterZoomHandler: (() => void) | null = null;

  private pendingNativeFilterHandler: (() => void) | null = null;

  /**
   * Resolve a layer's rendered GeoJSON from its live MapLibre source.
   *
   * The store only keeps inline GeoJSON for layers added from in-memory data;
   * URL-backed layers (remote GeoJSON, or Parquet/Shapefile converted in the
   * browser) keep their features only in the MapLibre source. Reading the
   * source lets callers such as the story-map HTML export inline those features
   * even when the layer record carries no `geojson`, so the export renders the
   * same data as the live map (#936).
   *
   * @param layerId GeoLibre store layer id.
   * @returns The source's FeatureCollection, or null when it has none.
   */
  async getLayerGeoJson(layerId: string): Promise<FeatureCollection | null> {
    if (!this.map) return null;
    const map = this.map;
    for (const nativeId of this.getNativeLayerIdsByLayerId(layerId)) {
      const styleLayer = map.getLayer(nativeId);
      const sourceId =
        styleLayer && "source" in styleLayer
          ? (styleLayer as { source?: unknown }).source
          : undefined;
      if (typeof sourceId !== "string") continue;
      const source = map.getSource(sourceId);
      if (source?.type !== "geojson") continue;
      try {
        const data = await (source as maplibregl.GeoJSONSource).getData();
        // `getData()` returns the source's original data spec: the inline
        // FeatureCollection for sources set via setData (in-browser-converted
        // layers), or the raw URL string for URL-backed sources. The `"features"`
        // guard skips the string case so the export omits such a layer rather
        // than embedding a bare URL.
        if (data && typeof data === "object" && "features" in data) {
          return data as FeatureCollection;
        }
      } catch {
        // A source still loading (or a URL that failed) has no usable data;
        // fall through so the export simply omits this layer's features.
      }
    }
    return null;
  }

  /**
   * Read the live MapLibre raster source spec backing a project layer.
   *
   * Service-backed raster layers registered by plugins (e.g. Planetary
   * Computer scenes) carry no tile or TileJSON URL in their store record — the
   * plugin builds the source directly on the map. Reading the live source back
   * lets the story-map HTML export inline those layers instead of silently
   * dropping them (#1272). Only http(s) URLs are returned; a source backed by
   * an app-internal protocol (blob:, pmtiles:, geolibre:, …) cannot load in a
   * standalone page.
   *
   * @param layerId GeoLibre store layer id.
   * @returns The serialized raster source spec, or null when the layer has no
   *   embeddable raster source.
   */
  getLayerRasterSource(layerId: string): Record<string, unknown> | null {
    if (!this.map) return null;
    const map = this.map;
    for (const nativeId of this.getNativeLayerIdsByLayerId(layerId)) {
      const styleLayer = map.getLayer(nativeId);
      const sourceId =
        styleLayer && "source" in styleLayer
          ? (styleLayer as { source?: unknown }).source
          : undefined;
      if (typeof sourceId !== "string") continue;
      const source = map.getSource(sourceId);
      if (source?.type !== "raster") continue;
      const spec = (source as maplibregl.RasterTileSource).serialize() as
        | Record<string, unknown>
        | undefined;
      if (!spec || typeof spec !== "object") continue;
      const httpUrl = (value: unknown): value is string =>
        typeof value === "string" && /^https?:\/\//i.test(value);
      // Prefer the TileJSON `url` over `tiles`, mirroring MapLibre's own
      // precedence when a raster source carries both. serialize() returns the
      // constructor options (load() extends the instance, not _options), but
      // if that ever changes, url-first also keeps the export pointing at the
      // stable TileJSON endpoint rather than a resolved tile template that
      // could embed a time-limited token.
      if (httpUrl(spec.url)) {
        const { tiles: _tiles, ...rest } = spec;
        return rest;
      }
      const tiles = Array.isArray(spec.tiles) ? spec.tiles.filter(httpUrl) : [];
      if (tiles.length > 0) {
        const { url: _url, ...rest } = spec;
        return { ...rest, tiles };
      }
    }
    return null;
  }

  /**
   * Fade a project layer in or out for story-map playback.
   *
   * Story chapters change layer opacity as the reader scrolls. The chapter's
   * opacity takes the place of the layer opacity (the Layers panel slider), so
   * a polygon styled with a 0.45 fill draws at 0.45 for a chapter at 1 and at
   * 0.09 for one at 0.2. This writes the MapLibre paint properties directly
   * instead of going through the store, so playback never marks the project
   * dirty or pushes undo history. Call {@link restoreLayerStyles} when
   * playback ends to reset opacities.
   *
   * @param layerId GeoLibre store layer id to fade.
   * @param opacity Target opacity, clamped to the 0-1 range.
   * @param durationMs Optional transition duration in milliseconds. Pass 0 for
   *   an instant change (overriding MapLibre's default 300 ms paint
   *   transition); leave undefined to keep the default fade.
   */
  setStoryLayerOpacity(layerId: string, opacity: number, durationMs?: number): void {
    if (!this.map) return;
    const clamped = Math.min(1, Math.max(0, opacity));
    this.storyOpacities.set(layerId, clamped);
    const layer = this.syncedLayers.find((item) => item.id === layerId);
    if (!layer) return;
    for (const nativeId of this.getStoryStyleLayerIds(layer)) {
      const styleLayer = this.map.getLayer(nativeId);
      if (!styleLayer) continue;
      const props = OPACITY_PAINT_PROPERTIES[styleLayer.type] ?? [];
      for (const prop of props) {
        if (typeof durationMs === "number" && durationMs >= 0) {
          setDynamicPaintProperty(this.map, nativeId, `${prop}-transition`, {
            duration: durationMs,
          });
        }
        setDynamicPaintProperty(
          this.map,
          nativeId,
          prop,
          this.storyPaintValue(layer, nativeId, prop, clamped),
        );
      }
    }
  }

  /**
   * The value a story fade writes for one opacity paint property: the synced
   * value rescaled from the layer's own opacity to the chapter's, so the
   * style's own translucency survives the fade (see
   * {@link storyScaledPaintValue}).
   *
   * @param layer The synced store layer.
   * @param nativeId MapLibre style layer id.
   * @param prop Paint property name.
   * @param opacity The chapter's opacity, clamped to 0-1.
   * @returns The paint value to write.
   */
  private storyPaintValue(
    layer: GeoLibreLayer,
    nativeId: string,
    prop: string,
    opacity: number,
  ): unknown {
    const key = `${nativeId}\u0000${prop}`;
    const current = this.map ? getDynamicPaintProperty(this.map, nativeId, prop) : undefined;
    const entry = this.storyPaintBases.get(key);
    const base = entry && styleValuesEqual(current, entry.written) ? entry.base : current;
    // Only opacities scale with the layer opacity; hillshade exaggeration does not.
    const scaled = prop.endsWith("-opacity")
      ? storyScaledPaintValue(base, layer.opacity, opacity)
      : undefined;
    const value = scaled ?? storyPaintOpacity(layer, nativeId, prop, opacity);
    this.storyPaintBases.set(key, { base, written: value });
    return value;
  }

  /**
   * Every MapLibre style layer a story fade must reach for a project layer:
   * its primary render layers plus the companion symbology `syncLayers` draws
   * beside them (inverted fill, line decorations, geometry-generator output).
   * The companions are internal (`geolibre:internal`) and so deliberately
   * absent from `getCandidateStyleLayers`, which feeds identify and the
   * layer control; without them a chapter that fades a layer out leaves its
   * centroids or buffers on screen (discussion #2326).
   */
  private getStoryStyleLayerIds(layer: GeoLibreLayer): string[] {
    const ids = this.getNativeLayerIds(layer);
    if (layer.type === "pmtiles") {
      // Vector archives draw their own line decorations, one per source layer.
      const seen = new Set(ids);
      for (const id of pmtilesLineDecorationLayerIds(layer)) {
        if (!seen.has(id) && this.map?.getLayer(id)) ids.push(id);
      }
      return ids;
    }
    if (layer.type !== "geojson") return ids;
    const seen = new Set(ids);
    for (const id of [
      invertedFillLayerId(layer.id),
      lineDecorationLayerId(layer.id),
      generatorFillLayerId(layer.id),
      generatorLineLayerId(layer.id),
      generatorCircleLayerId(layer.id),
    ]) {
      if (!seen.has(id) && this.map?.getLayer(id)) ids.push(id);
    }
    return ids;
  }

  /**
   * Re-apply layer styles from the last synced layers, undoing any direct paint
   * changes made during story-map playback by {@link setStoryLayerOpacity}.
   */
  restoreLayerStyles(): void {
    this.stopStoryCamera();
    this.storyOpacities.clear();
    this.storyPaintBases.clear();
    // Clear any opacity transitions left over from playback first, otherwise the
    // restored values animate back in (potentially over a multi-second fade).
    if (this.map) {
      for (const layer of this.syncedLayers) {
        for (const nativeId of this.getStoryStyleLayerIds(layer)) {
          const styleLayer = this.map.getLayer(nativeId);
          if (!styleLayer) continue;
          for (const prop of OPACITY_PAINT_PROPERTIES[styleLayer.type] ?? []) {
            setDynamicPaintProperty(this.map, nativeId, `${prop}-transition`, {
              duration: 0,
            });
          }
        }
      }
    }
    this.syncLayers(this.syncedLayers);
  }

  /** Token guarding deferred arrival and rotation against later chapter changes. */
  protected storyCameraToken = 0;

  /**
   * The arrival/rotate-on-settle listener currently awaiting its move, kept so
   * it can be detached deterministically (on the next chapter or on presenter
   * exit) instead of relying solely on self-removal after an eventual moveend.
   */
  protected pendingRotateHandler:
    | ((event: maplibregl.MapLibreEvent & { storyCameraToken?: number }) => void)
    | null = null;

  stopStoryCamera(): void {
    this.storyCameraToken++;
    if (this.pendingRotateHandler) {
      this.map?.off("moveend", this.pendingRotateHandler);
      this.pendingRotateHandler = null;
    }
    this.map?.stop();
  }

  syncLayers(layers: GeoLibreLayer[]): void {
    if (!this.isStyleReady() || !this.map) return;
    const map = this.map;

    const nextIds = layers.map((l) => l.id);
    const nextIdSet = new Set(nextIds);
    for (const id of this.storyOpacities.keys()) {
      if (!nextIdSet.has(id)) this.storyOpacities.delete(id);
    }
    const previousLayers = new Map(this.syncedLayers.map((layer) => [layer.id, layer]));
    // Built once for the whole pass: every removal below asks the same question of the same list.
    const survivingSourceIds = externalSourceIdsFor(layers);
    for (const id of this.layerIds) {
      if (!nextIdSet.has(id)) {
        removeLayerFromMap(map, id, previousLayers.get(id), survivingSourceIds);
      }
    }

    // Top-down (`layers` is bottom-to-top, so the last entry is the topmost).
    // Each layer is placed *beneath* the first style layer belonging to a layer
    // above it, so every anchor must already sit where this pass wants it.
    // Walking bottom-up would anchor a layer to a neighbour that has not been
    // moved yet, which mis-stacks the whole map for one pass whenever a layer's
    // native style layers appear out of band. An Add Vector Layer restore does
    // exactly that: its control adds the layers on top of the style once the
    // data has loaded, long after the first sync pass ran. A later sync would
    // converge, but a map-only embed (`?maponly`) has no panels to trigger one,
    // so the wrong stack is what the viewer keeps looking at. See
    // opengeos/GeoLibre#1404.
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      syncLayer(map, layers[index], this.getBeforeStyleLayerId(layers, index));
    }
    this.layerIds = nextIds;
    this.syncedLayers = layers;
    // Saving a presentation annotation (or changing another layer) syncs the
    // whole stack. Preserve chapter fades on the original layers, including
    // companion symbology and plugin-owned native layers. Keep syncedLayers
    // unmodified so exiting can restore the actual project opacity.
    for (const [id, opacity] of this.storyOpacities) this.setStoryLayerOpacity(id, opacity);
    // Blend modes are read inside the render loop rather than from a paint
    // property, so a mode that changed without any other paint change still
    // needs a frame asking for it. The repaint is gated on THIS controller's
    // own view of the modes, not on whether the shared registry changed: the
    // registry is module-level, so in a split view the first pane to sync would
    // otherwise win the diff and leave the other panes on the previous mode
    // until an unrelated event forced them to redraw.
    syncLayerBlendModes(layers);
    const blendSignature = blendModeSignature(layers);
    if (blendSignature !== this.blendSignature) {
      this.blendSignature = blendSignature;
      map.triggerRepaint();
    }
    this.applyBasemapVisibility();
    this.applyBasemapOpacity();
    this.publishLayerDisplayNames(layers);
    this.refreshLayerControl();
    this.syncLayerControlState();
    this.syncClusterZoomListener(layers);
    this.syncPendingNativeFilterListener(layers);
  }

  /**
   * Sync again once a control's native layers reach the map.
   *
   * See {@link hasPendingExternalNativeFilters}: a control-owned layer's
   * MapLibre layers can arrive after the sync pass that should have filtered
   * them, and a restore that reproduces the saved store layer exactly leaves no
   * store change to trigger another pass. Without this, reopening a project
   * whose vector layer carries a persisted filter renders the full dataset.
   *
   * @param layers The layers just synced.
   */
  private syncPendingNativeFilterListener(layers: GeoLibreLayer[]): void {
    const map = this.map;
    const wanted = map !== null && hasPendingExternalNativeFilters(map, layers);
    if (wanted === (this.pendingNativeFilterHandler !== null)) return;
    if (!wanted || !map) {
      this.removePendingNativeFilterListener();
      return;
    }
    const handler = () => {
      if (this.pendingNativeFilterHandler !== handler || !this.map) return;
      // Style events also fire for the control's own intermediate work, so wait
      // until every pending layer is actually there before spending a sync.
      if (hasPendingExternalNativeFilters(this.map, this.syncedLayers)) return;
      this.removePendingNativeFilterListener();
      this.syncLayers(this.syncedLayers);
    };
    this.pendingNativeFilterHandler = handler;
    map.on("styledata", handler);
  }

  protected removePendingNativeFilterListener(): void {
    if (!this.pendingNativeFilterHandler) return;
    this.map?.off("styledata", this.pendingNativeFilterHandler);
    this.pendingNativeFilterHandler = null;
  }

  /**
   * Keep a `zoomend` resync attached exactly while some clustered layer holds a
   * zoom-dependent authored filter, or some layer draws contour-style gap labels.
   *
   * MapLibre clusters at the source, so such a filter is pre-applied to the
   * source data once per sync rather than re-evaluated by the renderer with the
   * live camera. Without this the layer would keep whatever the filter said at
   * the zoom it was last synced at — a `[">=", ["zoom"], 8]` filter would hide
   * the layer forever. Nothing is attached for the ordinary layer, and the
   * pre-filter returns its previous collection when a zoom changes no outcome,
   * so an attached listener does not re-cluster on every step either.
   *
   * @param layers The layers just synced.
   */
  private syncClusterZoomListener(layers: GeoLibreLayer[]): void {
    // Contour-style gap labels are placed for one zoom bucket, so they need
    // the same resync to re-place (and re-cut) when the zoom changes.
    const wanted = hasZoomDependentClusterFilter(layers) || hasLineGapLabels(layers);
    if (wanted === (this.clusterZoomHandler !== null)) return;
    if (!wanted) {
      this.removeClusterZoomListener();
      return;
    }
    const handler = () => {
      if (this.clusterZoomHandler !== handler) return;
      this.syncLayers(this.syncedLayers);
    };
    this.clusterZoomHandler = handler;
    this.map?.on("zoomend", handler);
  }

  protected removeClusterZoomListener(): void {
    if (!this.clusterZoomHandler) return;
    this.map?.off("zoomend", this.clusterZoomHandler);
    this.clusterZoomHandler = null;
  }

  private styleLoadHandler: (() => void) | null = null;

  private styleReloadHandler: (() => void) | null = null;

  waitAndSyncLayers(layers: GeoLibreLayer[]): void {
    if (!this.map) return;

    if (!this.styleReloadHandler) {
      this.styleReloadHandler = () => {
        if (!this.styleLoadHandler) this.syncLayers(this.syncedLayers);
      };
      this.map.on("style.load", this.styleReloadHandler);
    }

    if (this.styleLoadHandler) {
      this.map.off("style.load", this.styleLoadHandler);
      this.map.off("load", this.styleLoadHandler);
    }

    const run = () => {
      if (this.styleLoadHandler !== run) return;
      this.map?.off("load", run);
      this.map?.off("style.load", run);
      this.styleLoadHandler = null;
      this.syncLayers(layers);
    };
    this.styleLoadHandler = run;

    if (this.isStyleReady()) {
      run();
    } else {
      this.map.once("load", run);
      this.map.once("style.load", run);
    }
  }

  protected applyBasemapVisibility(): void {
    if (!this.isStyleReady() || !this.map) return;
    const map = this.map;
    const visibility = this.basemapVisible ? "visible" : "none";

    for (const layer of this.getBasemapStyleLayers()) {
      try {
        const current = map.getLayoutProperty(layer.id, "visibility");
        if (current !== visibility && !(current === undefined && visibility === "visible")) {
          map.setLayoutProperty(layer.id, "visibility", visibility);
        }
      } catch {
        // Some third-party custom style layers may not expose layout properties.
      }
    }
  }

  protected applyBasemapOpacity(): void {
    if (!this.isStyleReady()) return;

    for (const layer of this.getBasemapStyleLayers()) {
      const properties = OPACITY_PAINT_PROPERTIES[layer.type] ?? [];
      for (const property of properties) {
        this.setBasemapPaintOpacity(layer.id, property);
      }
    }
  }

  private setBasemapPaintOpacity(layerId: string, property: string): void {
    if (!this.map) return;

    let originalPaintValues = this.basemapOriginalPaintValues.get(layerId);
    if (!originalPaintValues) {
      originalPaintValues = new Map<string, unknown>();
      this.basemapOriginalPaintValues.set(layerId, originalPaintValues);
    }
    if (!originalPaintValues.has(property)) {
      originalPaintValues.set(property, getDynamicPaintProperty(this.map, layerId, property));
    }

    const original = originalPaintValues.get(property);
    const opacity =
      this.basemapOpacity >= 1
        ? original
        : typeof original === "number"
          ? original * this.basemapOpacity
          : this.basemapOpacity;
    try {
      const current = getDynamicPaintProperty(this.map, layerId, property);
      if (styleValuesEqual(current, opacity)) return;
      setDynamicPaintProperty(this.map, layerId, property, opacity);
    } catch {
      // Some third-party custom style layers may not expose paint properties.
    }
  }
}
