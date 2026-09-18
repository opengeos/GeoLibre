import { useAppStore, type GeoLibreLayer, type LayerStyle } from "@geolibre/core";
import type * as maplibregl from "maplibre-gl";
import { LayerControl, type CustomLayerAdapter, type LayerState } from "maplibre-gl-layer-control";
import { getLayerBounds } from "./geojson-loader";

/**
 * Engine-neutral host for the on-map layer control (`maplibre-gl-layer-control`).
 *
 * The control itself only speaks the shared style API (`getLayer`, `getStyle`,
 * paint/layout getters and setters, `moveLayer`, `fitBounds`, a `styledata`
 * listener) plus `IControl`, all of which Mapbox GL JS implements too, so the
 * same control can sit on either 2D engine. What used to pin it to MapLibre was
 * GeoLibre's glue around it — the store-backed layer adapter, the rebuild-on-
 * structural-change signature, the in-place state mirroring, and the style-
 * editor round trip — which lived inside `MapController`. This module holds
 * that glue once; `MapController` and `MapboxEngine` each supply a
 * {@link LayerControlHostAdapter} describing their own map, native layer ids,
 * and basemap, and the host does the rest. Cesium has no style document and
 * therefore no host.
 *
 * The host never owns visibility bookkeeping: whether the control *should* be
 * on the map stays with the engine's built-in-control record, which calls
 * {@link LayerControlHost.add} / {@link LayerControlHost.remove}.
 */

/** DOM class the LayerControl gives its container element. */
export const LAYER_CONTROL_SELECTOR = ".maplibregl-ctrl-layer-control";

/**
 * The slice of a MapLibre or Mapbox `Map` the host reads. Both engines satisfy
 * it structurally; keeping it narrow is what lets one host serve both.
 */
export interface LayerControlStyleMap {
  getLayer(id: string): { type: string } | undefined | null;
  getStyle(): { layers?: Array<{ id: string; metadata?: unknown }> } | undefined | null;
  getSource(id: string): unknown;
  getContainer(): HTMLElement;
}

/** What an engine tells the host about itself. */
export interface LayerControlHostAdapter {
  /** The live map, or `null` before init and after destroy. */
  getMap(): LayerControlStyleMap | null;
  /** Mount `control` at `position`; the engine wraps it however its map needs. */
  addControl(control: maplibregl.IControl, position: maplibregl.ControlPosition): void;
  /** Unmount `control`; must tolerate a control that is already gone. */
  removeControl(control: maplibregl.IControl): void;
  /** The layers most recently handed to the engine's `syncLayers`, store order. */
  getLayers(): GeoLibreLayer[];
  /** Style layer ids currently on the map that render `layer`. */
  getNativeLayerIds(layer: GeoLibreLayer): string[];
  /**
   * Every style layer id that *may* render `layer`, present on the map or not.
   * Excluded from the control's basemap group so a layer the engine has not
   * mounted yet is never mistaken for basemap chrome. Defaults to
   * {@link getNativeLayerIds}.
   */
  getCandidateNativeLayerIds?(layer: GeoLibreLayer): string[];
  /** Source ids backing `layer`, for TileJSON `bounds` when zooming to it. */
  getSourceIds(layer: GeoLibreLayer): string[];
  /** Ids of GeoLibre's own chrome (blank background, highlight layers). */
  excludedLayerIds: readonly string[];
  /**
   * A style URL the control may `fetch` to learn which layers are basemap, or
   * `null` when there is none it can reach (blank, GeoLibre sentinel, and
   * `mapbox://` styles). With `null` the host seeds the control from
   * {@link getBasemapLayerIds} instead.
   */
  getBasemapStyleUrl(): string | null;
  /** Style layer ids the engine treats as the basemap right now. */
  getBasemapLayerIds(): string[];
  getBasemapState(): { visible: boolean; opacity: number };
}

interface LayerControlConfig {
  excludeLayers?: string[];
  customLayerAdapters?: CustomLayerAdapter[];
}

/**
 * The upstream control's private state the host reaches into. It mirrors store
 * changes into an already-built panel in place (the control has no public
 * setter for that), and seeds `basemapLayerIds` when no fetchable style URL
 * exists — otherwise the control falls back to "whatever was on the map when
 * I mounted is basemap", which sweeps up GeoLibre's own layers and lets the
 * Background toggle hide them.
 */
interface LayerControlInternalState {
  panel?: HTMLElement;
  basemapLayerIds?: Set<string> | null;
  state?: {
    layerStates?: Record<string, { visible: boolean; opacity: number; name: string }>;
  };
  /** Rebuilds the panel's rows from `state.layerStates`; the control's own refresh path. */
  buildLayerItems?: () => void;
}

/**
 * Member of the seeded basemap-id set that never matches a real layer, so the
 * set stays non-empty (the control only trusts a non-empty set) on a style
 * whose basemap has no root layers, such as Mapbox Standard, where the
 * basemap lives in style imports.
 */
const BASEMAP_ID_SENTINEL = "geolibre:basemap";

function isCustomControllableLayer(layer: GeoLibreLayer): boolean {
  return typeof layer.metadata.customLayerType === "string";
}

/**
 * Restore `refreshed` to just before `anchor` under `parent` after a
 * remove/re-add appended it to the end of its control corner. No-ops safely
 * when the reinsert can't be trusted: no parent, the anchor drifted to a
 * different parent, or `refreshed` is missing / already the anchor.
 *
 * Exported for unit testing; the reorder itself is only observable against a
 * real control DOM (see {@link LayerControlHost.refresh}).
 */
export function restoreControlOrder(
  parent: Element | null,
  anchor: Element | null,
  refreshed: Element | null,
): void {
  if (!parent) return;
  if (anchor !== null && anchor.parentElement !== parent) return;
  if (!refreshed || refreshed === anchor) return;
  parent.insertBefore(refreshed, anchor);
}

/**
 * Translate a paint property edited in the layer control's per-layer style
 * editor into a partial {@link LayerStyle} update for the store, so the
 * floating editor and the right-hand Style sidebar stay in sync (issue #912).
 *
 * Scope is deliberately limited to the raster color adjustments, which map
 * one-to-one to {@link LayerStyle} fields. Vector paint is **not** round-tripped
 * here: GeoLibre renders vector layers through an expression-based style model
 * (opacities are scaled by the layer opacity, and width/radius/colors become
 * `interpolate`/`case` expressions under proportional sizing, the meters width
 * unit, a data-driven `vectorStyleMode`, or simplestyle). The value the control
 * reads back is the *rendered* paint, so storing it verbatim would corrupt
 * those configurations. The control still applies vector edits to the map; the
 * sidebar Style panel remains the canonical editor for vector symbology.
 * Layer-level opacity is handled separately — see
 * {@link LayerControlHost.applyStyleChange}.
 */
export function layerControlPaintToStyle(
  property: string,
  value: unknown,
): Partial<LayerStyle> | null {
  if (typeof value !== "number") return null;

  switch (property) {
    case "raster-brightness-min":
      return { rasterBrightnessMin: value };
    case "raster-brightness-max":
      return { rasterBrightnessMax: value };
    case "raster-saturation":
      return { rasterSaturation: value };
    case "raster-contrast":
      return { rasterContrast: value };
    case "raster-hue-rotate":
      return { rasterHueRotate: value };
    default:
      return null;
  }
}

function normalizeLayerBounds(bounds: unknown): [number, number, number, number] | null {
  if (
    Array.isArray(bounds) &&
    bounds.length === 4 &&
    bounds.every((value) => Number.isFinite(value))
  ) {
    return bounds as [number, number, number, number];
  }
  return null;
}

export class LayerControlHost {
  private control: LayerControl | null = null;
  private signature = "";
  private position: maplibregl.ControlPosition;
  // Debounce timer for refreshing the control on style changes, so a plugin
  // adding/removing native style layers (e.g. ones flagged
  // `metadata["geolibre:internal"]`) updates the control's exclusion list.
  private styleRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  // True while pushing store paint back into the control's open style editor,
  // so onLayerStyleChange callbacks during that refresh are ignored
  // (reentrancy guard against a sync loop). See syncState.
  private refreshingStyleEditor = false;

  constructor(
    private readonly adapter: LayerControlHostAdapter,
    position: maplibregl.ControlPosition = "top-right",
  ) {
    this.position = position;
  }

  /** Whether a control is currently on the map. */
  get mounted(): boolean {
    return this.control !== null;
  }

  getPosition(): maplibregl.ControlPosition {
    return this.position;
  }

  /** Remember `position`, moving the control there if it is mounted. */
  setPosition(position: maplibregl.ControlPosition): void {
    this.position = position;
    if (!this.control) return;
    this.remove();
    this.add();
  }

  /**
   * Mount the control at `position` (default: the last position given).
   * Returns `true` when a control was mounted by this call; `false` when there
   * is no map yet or one is already mounted.
   */
  add(position: maplibregl.ControlPosition = this.position): boolean {
    this.position = position;
    const map = this.adapter.getMap();
    if (!map || this.control) return false;
    const config = this.createConfig(this.adapter.getLayers());
    this.signature = this.createSignature(config);
    const basemapStyleUrl = this.adapter.getBasemapStyleUrl();
    const control = new LayerControl({
      // The control fetches this URL to introspect the basemap's layers; a
      // basemap it cannot fetch is seeded below instead.
      basemapStyleUrl: basemapStyleUrl ?? undefined,
      collapsed: true,
      panelWidth: 340,
      panelMinWidth: 240,
      panelMaxWidth: 450,
      ...config,
      // The control toggles the basemap internally; mirror the change into the
      // store (the source of truth) so external basemap UI — e.g. the left
      // layer panel's visibility icon and opacity slider — stays in sync.
      // Placed after the spread so these wired callbacks always win.
      onBackgroundVisibilityChange: (visible) => {
        useAppStore.getState().setBasemapVisible(visible);
      },
      onBackgroundOpacityChange: (opacity) => {
        useAppStore.getState().setBasemapOpacity(opacity);
      },
      // The per-layer style editor edits paint directly; mirror those edits
      // into the store (the source of truth) so the right-hand Style sidebar
      // stays in sync and the change survives the next layer sync.
      onLayerStyleChange: (layerId, property, value) => {
        this.applyStyleChange(layerId, property, value);
      },
    });
    if (basemapStyleUrl === null) {
      (control as unknown as LayerControlInternalState).basemapLayerIds = new Set([
        ...this.adapter.getBasemapLayerIds(),
        BASEMAP_ID_SENTINEL,
      ]);
    }
    // The control reads the style in onAdd, and both engines' getStyle() throws
    // while a style is still loading. A mount requested in that window (a
    // control toggled on mid style swap) must not surface as an exception;
    // the engine remounts on style.load anyway.
    try {
      this.adapter.addControl(control, this.position);
    } catch (error) {
      console.warn("Layer control could not mount yet:", error);
      this.adapter.removeControl(control);
      return false;
    }
    this.control = control;
    this.syncState();
    setTimeout(() => this.syncState(), 100);
    return true;
  }

  remove(): void {
    if (!this.control) return;
    const control = this.control;
    this.control = null;
    this.adapter.removeControl(control);
  }

  /** {@link remove}, plus cancel any pending style-change refresh. */
  destroy(): void {
    this.remove();
    if (this.styleRefreshTimer !== null) {
      clearTimeout(this.styleRefreshTimer);
      this.styleRefreshTimer = null;
    }
  }

  /**
   * Rebuild the control if the set of controllable layers, their names or
   * symbols, or the exclusion list changed. The control's layer list is fixed
   * at construction, so a structural change means remove + re-add; anything
   * else is mirrored in place by {@link syncState}.
   */
  refresh(): void {
    const map = this.adapter.getMap();
    if (!map || !this.control) return;

    const config = this.createConfig(this.adapter.getLayers());
    const nextSignature = this.createSignature(config);
    if (nextSignature === this.signature) return;

    // Capture the control's spot in its corner before the remove/re-add.
    // addControl re-appends to the end of the corner, which would drop the
    // control below any controls inserted after it (e.g. a terrain control the
    // user enabled post-load), visibly reordering the stack on every
    // basemap/style change. Re-anchor it to its old sibling.
    const container = map.getContainer();
    const previous = container.querySelector(LAYER_CONTROL_SELECTOR);
    const anchor = previous?.nextElementSibling ?? null;
    const parent = previous?.parentElement ?? null;

    this.remove();
    this.add();

    restoreControlOrder(parent, anchor, container.querySelector(LAYER_CONTROL_SELECTOR));
  }

  /**
   * Call from the map's `styledata` event. Debounced (trailing edge) because
   * styledata fires frequently, and {@link refresh} no-ops when the computed
   * signature is unchanged. Resetting the timer on each event waits until the
   * burst of style updates quiets so the control never rebuilds against a
   * half-built style.
   */
  scheduleStyleRefresh(): void {
    if (this.styleRefreshTimer !== null) clearTimeout(this.styleRefreshTimer);
    this.styleRefreshTimer = setTimeout(() => {
      this.styleRefreshTimer = null;
      this.refresh();
    }, 200);
  }

  /** Mirror store visibility, opacity and names into the mounted control. */
  syncState(): void {
    if (!this.control) return;
    this.syncBackgroundState();
    this.syncLayerStates(this.adapter.getLayers());
    // Push the latest paint (already applied to the map by the engine) into
    // the control's open style editor so edits made elsewhere — e.g. the
    // right-hand Style sidebar — are reflected there too (issue #912). No-op
    // when no editor is open; skips the input the user is actively dragging.
    //
    // Invariant: refreshStyleEditor() must NOT fire onLayerStyleChange. If it
    // did, this path would loop forever (sync → refresh → onLayerStyleChange →
    // applyStyleChange → setLayerStyle → sync → ...). The upstream library
    // guarantees this by setting input values programmatically, which does
    // not dispatch an input event. The reentrancy guard below is a cheap
    // defense in case a future upstream version regresses that guarantee.
    this.refreshingStyleEditor = true;
    try {
      this.control.refreshStyleEditor();
    } finally {
      this.refreshingStyleEditor = false;
    }
  }

  /**
   * Mirror a paint property edited via the control's per-layer style editor
   * into the store. The per-type opacities that GeoLibre derives directly from
   * the layer-level opacity (raster/line/text/icon) map to
   * `setLayerOpacity`; raster color adjustments map to {@link LayerStyle} via
   * {@link layerControlPaintToStyle}. Other properties (vector paint) are
   * ignored — see that helper for why.
   */
  private applyStyleChange(layerId: string, property: string, value: unknown): void {
    // Ignore callbacks that fire while we are pushing store values back into
    // the editor; otherwise a misbehaving refresh could create a sync loop.
    if (this.refreshingStyleEditor) return;
    const store = useAppStore.getState();
    // These paint properties equal the layer-level opacity in the engines'
    // layer sync (raster/heatmap/line paint use it directly; symbol layers set
    // text-opacity/icon-opacity to it), so an edit to them is an edit to the
    // layer's opacity and round-trips losslessly. fill-opacity/circle-opacity
    // are deliberately not here: the sync scales them by the layer opacity, so
    // the rendered value the control reports is not the raw style value.
    if (
      property === "raster-opacity" ||
      property === "heatmap-opacity" ||
      property === "line-opacity" ||
      property === "text-opacity" ||
      property === "icon-opacity"
    ) {
      if (typeof value === "number") store.setLayerOpacity(layerId, value);
      return;
    }
    const styleUpdate = layerControlPaintToStyle(property, value);
    if (styleUpdate) store.setLayerStyle(layerId, styleUpdate);
  }

  /** The live style's layers, or none while the style is still loading. */
  private styleLayers(): Array<{ id: string; metadata?: unknown }> {
    try {
      return this.adapter.getMap()?.getStyle()?.layers ?? [];
    } catch {
      return [];
    }
  }

  private candidateNativeLayerIds(layer: GeoLibreLayer): string[] {
    return this.adapter.getCandidateNativeLayerIds
      ? this.adapter.getCandidateNativeLayerIds(layer)
      : this.adapter.getNativeLayerIds(layer);
  }

  private createConfig(layers: GeoLibreLayer[]): LayerControlConfig {
    const nativeStyleLayerIds = layers.flatMap((layer) => this.candidateNativeLayerIds(layer));
    // Hide style layers a plugin marks as internal chrome (e.g. selection
    // footprints, draw/highlight helpers) so they don't clutter the control.
    const internalStyleLayerIds = this.styleLayers()
      .filter((styleLayer) =>
        Boolean(
          (styleLayer.metadata as Record<string, unknown> | undefined)?.["geolibre:internal"],
        ),
      )
      .map((styleLayer) => styleLayer.id)
      // Sort so a plugin reordering an already-hidden internal layer (which
      // shuffles live style order) doesn't change the exclusion signature and
      // force an unnecessary control rebuild.
      .sort();
    const excludeLayers = Array.from(
      new Set([...this.adapter.excludedLayerIds, ...nativeStyleLayerIds, ...internalStyleLayerIds]),
    );
    const controllableLayers = layers.filter(
      (layer) =>
        this.adapter.getNativeLayerIds(layer).length > 0 || isCustomControllableLayer(layer),
    );

    if (controllableLayers.length === 0) {
      return { excludeLayers };
    }

    return {
      excludeLayers,
      customLayerAdapters: [this.createGeoLibreLayerAdapter(controllableLayers)],
    };
  }

  private createSignature(config: LayerControlConfig): string {
    // Only structural attributes belong in the signature. Opacity and
    // visibility are managed in place by the control and persisted to the
    // store; including them here would destroy and recreate the control
    // (collapsing it and interrupting the drag) on every slider or checkbox
    // interaction.
    return JSON.stringify({
      excluded: config.excludeLayers ?? [],
      layers: config.customLayerAdapters?.flatMap((adapter) =>
        adapter.getLayerIds().map((id) => {
          const state = adapter.getLayerState(id);
          return {
            id,
            name: state?.name,
            symbol: adapter.getSymbolType?.(id),
          };
        }),
      ),
    });
  }

  private syncBackgroundState(): void {
    if (!this.control) return;
    const control = this.control as unknown as LayerControlInternalState;
    const { visible, opacity } = this.adapter.getBasemapState();

    // Only touch the control's state once it has mounted (onAdd builds the
    // panel). Seeding `Background` earlier would make the control skip its own
    // layer detection, which is keyed on the state being empty at mount.
    if (!control.panel || !control.state?.layerStates) return;

    let backgroundState = control.state.layerStates.Background;
    if (!backgroundState) {
      // The control only creates a Background row when it finds basemap
      // layers in the root style. A style whose basemap lives in imports
      // (Mapbox Standard) has none, so a project with no layers would show an
      // empty panel. GeoLibre always has a basemap to toggle (the store drives
      // it through onBackgroundVisibilityChange), so add the row ourselves.
      backgroundState = control.state.layerStates.Background = {
        visible,
        opacity,
        name: "Background",
      };
      control.buildLayerItems?.();
    }
    backgroundState.visible = visible;
    backgroundState.opacity = opacity;

    const backgroundItem = this.getItem("Background");
    if (!backgroundItem) return;

    this.updateItem(backgroundItem, { name: "Background", visible, opacity });
  }

  private syncLayerStates(layers: GeoLibreLayer[]): void {
    if (!this.control) return;
    const control = this.control as unknown as LayerControlInternalState;

    for (const layer of layers) {
      const layerState = control.state?.layerStates?.[layer.id];
      if (layerState) {
        layerState.visible = layer.visible;
        layerState.opacity = layer.opacity;
        layerState.name = layer.name;
      }

      const layerItem = this.getItem(layer.id);
      if (!layerItem) continue;
      this.updateItem(layerItem, {
        name: layer.name,
        visible: layer.visible,
        opacity: layer.opacity,
      });
    }
  }

  private getItem(layerId: string): HTMLElement | null {
    const control = this.control as unknown as LayerControlInternalState;
    const items = control.panel?.querySelectorAll(".layer-control-item") ?? [];
    return (
      (Array.from(items).find((item) => (item as HTMLElement).dataset.layerId === layerId) as
        | HTMLElement
        | undefined) ?? null
    );
  }

  private updateItem(
    item: HTMLElement,
    state: { name: string; visible: boolean; opacity: number },
  ): void {
    const checkbox = item.querySelector(".layer-control-checkbox") as HTMLInputElement | null;
    if (checkbox) checkbox.checked = state.visible;

    const opacity = item.querySelector(".layer-control-opacity") as HTMLInputElement | null;
    if (opacity) {
      opacity.value = String(state.opacity);
      opacity.title = `Opacity: ${Math.round(state.opacity * 100)}%`;
    }

    const name = item.querySelector(".layer-control-name") as HTMLElement | null;
    if (name) {
      name.textContent = state.name;
      name.title = state.name;
    }
  }

  private createGeoLibreLayerAdapter(layers: GeoLibreLayer[]): CustomLayerAdapter {
    const layerById = new Map(layers.map((layer) => [layer.id, layer]));
    const nativeIdsById = (layerId: string): string[] => {
      const layer = this.adapter.getLayers().find((item) => item.id === layerId);
      return layer ? this.adapter.getNativeLayerIds(layer) : [];
    };

    return {
      type: "geolibre",
      getLayerIds: () => layers.map((layer) => layer.id),
      getLayerState: (layerId) => {
        const layer = layerById.get(layerId);
        if (!layer) return null;
        return {
          visible: layer.visible,
          opacity: layer.opacity,
          name: layer.name,
          isCustomLayer: true,
          customLayerType: this.getLayerSymbolType(layer),
        } satisfies LayerState;
      },
      setVisibility: (layerId, visible) => {
        // Update the store (the source of truth) and let the layer sync
        // pass apply the visibility change to the map, so it is not undone
        // by the next syncLayers.
        useAppStore.getState().setLayerVisibility(layerId, visible);
      },
      setOpacity: (layerId, opacity) => {
        // Persist opacity to the layer model; the sync derives paint from
        // layer.opacity, so updating the store keeps the map and UI in sync.
        useAppStore.getState().setLayerOpacity(layerId, opacity);
      },
      getName: (layerId) => layerById.get(layerId)?.name ?? layerId,
      getSymbolType: (layerId) => {
        const layer = layerById.get(layerId);
        return layer ? this.getLayerSymbolType(layer) : "custom";
      },
      getBounds: (layerId) => {
        const layer = layerById.get(layerId);
        if (!layer) return null;
        // GeoJSON-backed layers derive bounds from their features; other
        // layer types fall back to their source bounds (TileJSON) when
        // advertised, and return null (no zoom-to-bounds) otherwise.
        return (
          getLayerBounds(layer) ?? getLayerMetadataBounds(layer) ?? this.getLayerSourceBounds(layer)
        );
      },
      getNativeLayerIds: nativeIdsById,
      removeLayer: (layerId) => {
        // Remove the logical layer from the store; syncLayers then tears
        // down the native sources/layers, keeping project state in sync.
        useAppStore.getState().removeLayer(layerId);
      },
    };
  }

  private getLayerSymbolType(layer: GeoLibreLayer): string {
    const map = this.adapter.getMap();
    const nativeLayer = this.adapter
      .getNativeLayerIds(layer)
      .map((id) => map?.getLayer(id))
      .find((item) => Boolean(item));

    return (
      nativeLayer?.type ??
      (typeof layer.metadata.customLayerType === "string"
        ? layer.metadata.customLayerType
        : "custom")
    );
  }

  private getLayerSourceBounds(layer: GeoLibreLayer): [number, number, number, number] | null {
    const map = this.adapter.getMap();
    for (const id of this.adapter.getSourceIds(layer)) {
      const source = map?.getSource(id) as
        | { bounds?: [number, number, number, number] }
        | undefined;
      const bounds = normalizeLayerBounds(source?.bounds);
      if (bounds) return bounds;
    }
    return null;
  }
}

/** Bounds a layer advertises about itself, from its source or metadata. */
export function getLayerMetadataBounds(
  layer: GeoLibreLayer,
): [number, number, number, number] | null {
  return normalizeLayerBounds(layer.source.bounds) ?? normalizeLayerBounds(layer.metadata.bounds);
}
