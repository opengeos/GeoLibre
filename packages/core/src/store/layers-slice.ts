/**
 * The layer stack: adding, removing, editing, restyling and reordering layer
 * records, plus the copy/paste style clipboard. `layers` is tracked by undo
 * history. `removeLayer` also scrubs every other slice's references to the
 * deleted layer, so it reads and writes the whole state through `set`.
 */
import type { FeatureCollection } from "geojson";
import { v4 as uuidv4 } from "uuid";
import { isSourceDerivedLayerName, uniqueImportedLayerName } from "../file-name";
import { initialLayerStyle } from "../layer-defaults";
import { normalizeGroupContiguity } from "../layer-groups";
import {
  scrubCommentsForRemovedLayers,
  scrubLegendForRemovedLayers,
  scrubWidgetsForRemovedLayers,
} from "../layer-ref-scrub";
import {
  applyCopiedLayerStyle,
  type CopiedLayerStyle,
  extractCopiedLayerStyle,
} from "../layer-style-clipboard";
import { applyJoinsToLayer, cascadeLayerJoinRefresh } from "../joins";
import { scrubPrintLayoutForRemovedLayers } from "../print-layout-config";
import { identifyStateWithoutLayers } from "./session-slice";
import {
  DEFAULT_LAYER_STYLE,
  type AddTileLayerOptions,
  type AttributeFormConfig,
  type EditorTrackingConfig,
  type GeoLibreLayer,
  type LayerJoin,
  type LayerPopupConfig,
  type LayerQuickFilter,
  type LayerStyle,
  type LayerVirtualField,
} from "../types";
import { hasSimpleStyleProperties } from "../vector-color";
import {
  cascadeJoinRefreshForRemoved,
  scrubSecondaryPaneLayerVisibility,
  scrubStorymapLayerRefs,
} from "./layer-removal";
import type { SliceCreator } from "./types";

/**
 * The layer types {@link AppState.addTileLayer} accepts. Each renders through
 * the raster tile path, which is why the layer's `source.type` is always
 * `"raster"`.
 */
const RASTER_TILE_LAYER_TYPES: ReadonlySet<string> = new Set<
  NonNullable<AddTileLayerOptions["type"]>
>(["xyz", "wms", "wmts", "raster"]);

export interface LayersSlice {
  layers: GeoLibreLayer[];

  addLayer: (layer: GeoLibreLayer, beforeLayerId?: string | null) => void;
  removeLayer: (id: string) => void;
  updateLayer: (id: string, patch: Partial<GeoLibreLayer>) => void;
  setLayerVisibility: (id: string, visible: boolean) => void;
  setLayerOpacity: (id: string, opacity: number) => void;
  setLayerStyle: (id: string, style: Partial<LayerStyle>) => void;
  /**
   * Transient clipboard holding a layer's symbology, captured by
   * {@link copyLayerStyle} and applied by {@link pasteLayerStyle} (copy/paste
   * styles, issue #1339). Runtime-only: excluded from undo history
   * (`partialize` never lists it) and from the saved project. `null` until a
   * style is copied this session. Cleared by `newProject`/`loadProject` so a
   * paste can't apply an entry from a different project; it deliberately
   * survives undo/redo within a project (it holds a deep snapshot, not a live
   * layer reference, so a paste stays valid even if the source layer is undone
   * away — only the displayed source name may then be stale).
   */
  copiedLayerStyle: CopiedLayerStyle | null;
  /**
   * Snapshot the given layer's style into {@link copiedLayerStyle} so it can be
   * pasted onto a compatible layer. No-op when the layer is missing or has no
   * copyable symbology (leaving any prior clipboard entry untouched). Returns
   * `true` when a style was captured, so callers can skip the confirmation on a
   * no-op.
   */
  copyLayerStyle: (id: string) => boolean;
  /**
   * Apply the {@link copiedLayerStyle} clipboard entry onto the given layer.
   * No-op when the clipboard is empty, the layer is missing, or the entry's
   * style family does not match the target layer's. Returns `true` when the
   * style was applied, so callers can skip the confirmation on a no-op.
   */
  pasteLayerStyle: (id: string) => boolean;
  /**
   * Replace a layer's persistent attribute joins and immediately re-derive its
   * joined columns (strip what the previous joins added, apply the new list).
   * Pass an empty array to detach every join and restore the base attributes.
   */
  setLayerJoins: (id: string, joins: LayerJoin[]) => void;
  /**
   * Replace the layer's Attribute Form designer configuration (per-field edit
   * widgets, constraints, conditional visibility). Pass `undefined` to remove
   * the form config entirely.
   */
  setLayerAttributeForm: (id: string, attributeForm: AttributeFormConfig | undefined) => void;
  /**
   * Replace the layer's popup/tooltip design (which fields the Identify popup
   * shows, in what order and under what labels, plus the hover tooltip). Pass
   * `undefined` to restore the default full-property dump.
   */
  setLayerPopup: (id: string, popup: LayerPopupConfig | undefined) => void;
  /**
   * Replace the layer's editor tracking configuration (whether creation/edit
   * author and timestamp columns are maintained, and under which names). Pass
   * `undefined` to drop the configuration entirely.
   */
  setLayerEditorTracking: (id: string, editorTracking: EditorTrackingConfig | undefined) => void;
  /**
   * Replace a layer's virtual fields and immediately re-derive its computed
   * columns (strip what the previous fields added, evaluate the new list).
   * Pass an empty array to detach every virtual field.
   */
  setLayerVirtualFields: (id: string, fields: LayerVirtualField[]) => void;
  /**
   * Replace a layer's quick filters (issue #2114). The controls persist with
   * the project and are compiled to a MapLibre filter at sync time, so this
   * only stores state — nothing re-derives the layer's data. Pass an empty
   * array to remove every control.
   */
  setLayerQuickFilters: (id: string, filters: LayerQuickFilter[]) => void;
  /** Set or clear the project-persisted expression filter for a layer. */
  setLayerFilterExpression: (id: string, expression: unknown[] | null) => void;
  reorderLayer: (id: string, direction: "up" | "down") => void;
  moveLayer: (id: string, targetIndex: number) => void;
  moveLayersRelative: (
    layerIds: string[],
    targetLayerId: string,
    position: "above" | "below",
  ) => void;
  addGeoJsonLayer: (
    name: string,
    geojson: FeatureCollection,
    sourcePath?: string,
    beforeLayerId?: string | null,
  ) => string;
  /**
   * Add a georeferenced image overlay (a MapLibre `image` source rendered as a
   * raster layer) from an image URL and its four corner coordinates, and return
   * its id. Used for KML/KMZ `<GroundOverlay>` imports; the layer persists and
   * renders exactly like a Raster Georeferencer overlay. Corners are `[lng,
   * lat]` in top-left, top-right, bottom-right, bottom-left order.
   */
  addImageOverlayLayer: (
    name: string,
    source: { url: string; coordinates: [number, number][] },
    options?: {
      opacity?: number;
      bounds?: [number, number, number, number];
      sourcePath?: string;
      /** Initial visibility (default true); a time-slider frame past the first
       * starts hidden. */
      visible?: boolean;
      /** Epoch-ms time bounds of a KML `<TimeSpan>`/`<TimeStamp>` frame; the
       * Time Slider toggles this frame's visibility by the current date. */
      timeSpan?: { begin: number | null; end: number | null };
      /**
       * What produced the overlay, e.g. a NetCDF grid baked to pixels. Defaults
       * to the KML ground overlay this was first written for; panels gate their
       * per-source controls on it.
       */
      sourceKind?: string;
      /** Extra metadata merged onto the layer (e.g. a symbology record). */
      metadata?: Record<string, unknown>;
    },
    beforeLayerId?: string | null,
  ) => string;
  /**
   * Add a native raster tile layer (XYZ, WMS, or WMTS) from one or more tile
   * URL templates and return its id. The layer appears in the Layers panel and
   * persists with the project exactly like a layer added through the Add Data
   * dialog, so callers (e.g. an external plugin) do not have to touch MapLibre
   * directly. See {@link AddTileLayerOptions}.
   */
  addTileLayer: (
    name: string,
    options: AddTileLayerOptions,
    beforeLayerId?: string | null,
  ) => string;
}

export const createLayersSlice: SliceCreator<LayersSlice> = (set, get) => ({
  layers: [],
  copiedLayerStyle: null,

  addLayer: (layer, beforeLayerId = null) =>
    set((s) => {
      const layers = [...s.layers];
      // Plugin source identifiers (for example pmtiles://) are not local files.
      const { sourcePath } = layer;
      const localSource =
        sourcePath &&
        (!/^[a-z][a-z0-9+.-]*:\/\//i.test(sourcePath) || /^(content|file):\/\//i.test(sourcePath));
      // Only filename-derived names are deduplicated; an explicit name (an
      // embedded document title, a tool output label, a user-typed name)
      // is kept as supplied.
      if (localSource && isSourceDerivedLayerName(layer.name, sourcePath)) {
        layer = {
          ...layer,
          name: uniqueImportedLayerName(
            layer.name,
            layers.map((item) => item.name),
          ),
        };
      }
      const beforeIndex = beforeLayerId ? layers.findIndex((l) => l.id === beforeLayerId) : -1;
      const layerWithBeforeId =
        beforeLayerId && beforeIndex < 0
          ? { ...layer, beforeId: beforeLayerId }
          : { ...layer, beforeId: layer.beforeId };
      if (beforeIndex >= 0) {
        layers.splice(beforeIndex, 0, layerWithBeforeId);
      } else {
        layers.push(layerWithBeforeId);
      }
      return {
        layers,
        selectedLayerId: layer.id,
        isDirty: true,
      };
    }),

  removeLayer: (id) =>
    set((s) => ({
      // Re-derive any layer whose joins consumed the removed layer: with
      // the source gone the join resolves to nothing, so its previously
      // materialized columns strip away instead of staying frozen (the
      // join definition itself stays, shown as missing in the Joins UI).
      layers: cascadeJoinRefreshForRemoved(
        s.layers.filter((l) => l.id !== id),
        id,
      ),
      secondaryMapViews: scrubSecondaryPaneLayerVisibility(s.secondaryMapViews, id),
      // Drop storymap chapter enter/exit opacity rows that pointed at the
      // removed layer so they do not keep a dangling id across save/reload.
      storymap: scrubStorymapLayerRefs(s.storymap, id),
      widgets: scrubWidgetsForRemovedLayers(s.widgets, id),
      comments: scrubCommentsForRemovedLayers(s.comments, id),
      legend: scrubLegendForRemovedLayers(s.legend, id),
      // Clear a Print Layout data/atlas block built on the removed layer,
      // so a save that follows the delete cannot write a dangling id.
      printLayout: scrubPrintLayoutForRemovedLayers(s.printLayout, id),
      selectedLayerId:
        s.selectedLayerId === id
          ? (s.layers.find((l) => l.id !== id)?.id ?? null)
          : s.selectedLayerId,
      selectedFeatureId: s.selectedLayerId === id ? null : s.selectedFeatureId,
      selectedFeatureIds: s.selectedLayerId === id ? [] : s.selectedFeatureIds,
      ...identifyStateWithoutLayers(s, new Set([id])),
      ui: {
        ...s.ui,
        selectByExpressionLayerId:
          s.ui.selectByExpressionLayerId === id ? null : s.ui.selectByExpressionLayerId,
        selectByLocationLayerId:
          s.ui.selectByLocationLayerId === id ? null : s.ui.selectByLocationLayerId,
        loadEditorFeaturesLayerId:
          s.ui.loadEditorFeaturesLayerId === id ? null : s.ui.loadEditorFeaturesLayerId,
      },
      isDirty: true,
    })),

  updateLayer: (id, patch) =>
    set((s) => {
      let layers = s.layers.map((l) => (l.id === id ? { ...l, ...patch } : l));
      // A geojson replacement re-derives the layer's derived columns
      // (persistent joins, then virtual fields): on the layer itself
      // (file reload, attribute edits, processing writes — derived
      // columns stay derived, QGIS-style), then transitively on every
      // layer whose joins consume the updated one, so editing a join
      // table refreshes its targets and their dependents in turn. The
      // `patch.joins`/`patch.virtualFields` guard exists for external
      // callers of this public store API (plugins, programmatic loads):
      // a patch that carries `geojson` alongside the definitions is taken
      // verbatim as already-derived state — no in-repo caller does this
      // today.
      if (patch.geojson !== undefined) {
        if (patch.joins === undefined && patch.virtualFields === undefined) {
          layers = layers.map((l) =>
            l.id === id && (l.joins?.length || l.virtualFields?.length)
              ? applyJoinsToLayer(l, layers)
              : l,
          );
        }
        layers = cascadeLayerJoinRefresh(layers, id);
      }
      return { layers, isDirty: true };
    }),

  setLayerJoins: (id, joins) =>
    set((s) => {
      let layers = s.layers.map((l) => (l.id === id ? applyJoinsToLayer(l, s.layers, joins) : l));
      // Changing this layer's joins changes its materialized columns, so
      // layers joining against it (directly or transitively) re-derive too.
      layers = cascadeLayerJoinRefresh(layers, id);
      return { layers, isDirty: true };
    }),

  setLayerAttributeForm: (id, attributeForm) => get().updateLayer(id, { attributeForm }),
  setLayerPopup: (id, popup) => get().updateLayer(id, { popup }),

  setLayerEditorTracking: (id, editorTracking) => get().updateLayer(id, { editorTracking }),

  setLayerVirtualFields: (id, fields) =>
    set((s) => {
      let layers = s.layers.map((l) =>
        l.id === id ? applyJoinsToLayer(l, s.layers, undefined, fields) : l,
      );
      // Virtual columns are ordinary materialized properties, so a layer
      // joining against this one (directly or transitively) sees them and
      // must re-derive too.
      layers = cascadeLayerJoinRefresh(layers, id);
      return { layers, isDirty: true };
    }),

  setLayerQuickFilters: (id, filters) =>
    get().updateLayer(id, { quickFilters: filters.length > 0 ? filters : undefined }),

  setLayerFilterExpression: (id, expression) =>
    get().updateLayer(id, { filterExpression: expression ?? undefined }),

  setLayerVisibility: (id, visible) => get().updateLayer(id, { visible }),

  setLayerOpacity: (id, opacity) => get().updateLayer(id, { opacity }),

  setLayerStyle: (id, style) =>
    set((s) => ({
      layers: s.layers.map((l) => (l.id === id ? { ...l, style: { ...l.style, ...style } } : l)),
      isDirty: true,
    })),

  copyLayerStyle: (id) => {
    const layer = get().layers.find((l) => l.id === id);
    if (!layer) return false;
    const copied = extractCopiedLayerStyle(layer);
    // Leave any prior clipboard entry in place when this layer is not
    // copyable, so opening a non-stylable layer's menu never clears it.
    if (!copied) return false;
    set({ copiedLayerStyle: copied });
    return true;
  },

  pasteLayerStyle: (id) => {
    const s = get();
    const copied = s.copiedLayerStyle;
    if (!copied) return false;
    const layer = s.layers.find((l) => l.id === id);
    if (!layer) return false;
    const patch = applyCopiedLayerStyle(layer, copied);
    if (!patch) return false;
    // Go through updateLayer so the paste picks up any cross-cutting layer
    // update logic (it also sets isDirty); the patch never carries geojson,
    // so the join-cascade branch is a no-op.
    get().updateLayer(id, patch);
    return true;
  },

  reorderLayer: (id, direction) =>
    set((s) => {
      const idx = s.layers.findIndex((l) => l.id === id);
      if (idx < 0) return s;
      const target = direction === "up" ? idx + 1 : idx - 1;
      if (target < 0 || target >= s.layers.length) return s;
      const next = [...s.layers];
      const [item] = next.splice(idx, 1);
      next.splice(target, 0, item);
      return { layers: next, isDirty: true };
    }),

  moveLayer: (id, targetIndex) =>
    set((s) => {
      const currentIndex = s.layers.findIndex((layer) => layer.id === id);
      if (currentIndex < 0) return s;
      const next = [...s.layers];
      const [layer] = next.splice(currentIndex, 1);
      const nextIndex = Math.min(Math.max(targetIndex, 0), next.length);
      next.splice(nextIndex, 0, layer);
      if (next.every((item, index) => item.id === s.layers[index]?.id)) {
        return s;
      }
      return { layers: next, isDirty: true };
    }),

  moveLayersRelative: (layerIds, targetLayerId, position) =>
    set((s) => {
      const requestedIds = new Set(layerIds);
      if (requestedIds.has(targetLayerId)) return s;
      const target = s.layers.find((layer) => layer.id === targetLayerId);
      if (!target) return s;
      const targetGroupId = target.groupId ?? null;
      // This is a pure reorder — `groupId` is never touched — so a requested
      // layer from another group can only be lifted out of its own block,
      // and `normalizeGroupContiguity` would then drag that group's
      // untouched members along to reunite it. Move only the layers that
      // already sit in the target's group.
      const moving = s.layers.filter(
        (layer) => requestedIds.has(layer.id) && (layer.groupId ?? null) === targetGroupId,
      );
      if (moving.length === 0) return s;
      const movingIds = new Set(moving.map((layer) => layer.id));
      const without = s.layers.filter((layer) => !movingIds.has(layer.id));
      const targetIndex = without.findIndex((layer) => layer.id === targetLayerId);
      if (targetIndex < 0) return s;
      // Store order is the reverse of panel display order, so "above" is
      // immediately after the target in this array.
      const insertIndex = position === "above" ? targetIndex + 1 : targetIndex;
      const next = [...without];
      next.splice(insertIndex, 0, ...moving);
      const normalized = normalizeGroupContiguity(next);
      if (normalized.every((layer, index) => layer.id === s.layers[index]?.id)) return s;
      return { layers: normalized, isDirty: true };
    }),

  addGeoJsonLayer: (name, geojson, sourcePath, beforeLayerId = null) => {
    const id = uuidv4();
    const layer: GeoLibreLayer = {
      id,
      name,
      type: "geojson",
      source: { type: "geojson" },
      visible: true,
      opacity: 1,
      // Its own palette color and geometry-appropriate sizing (#1519), so a
      // stack of freshly added layers is legible without restyling each one.
      style: initialLayerStyle({
        geojson,
        layers: get().layers,
        overrides: {
          simpleStyleEnabled: hasSimpleStyleProperties(geojson),
        },
      }),
      metadata: {},
      geojson,
      sourcePath,
    };
    get().addLayer(layer, beforeLayerId);
    return id;
  },

  addImageOverlayLayer: (name, source, options, beforeLayerId = null) => {
    const id = uuidv4();
    const layer: GeoLibreLayer = {
      id,
      name,
      type: "image",
      source: {
        type: "image",
        url: source.url,
        coordinates: source.coordinates,
      },
      visible: options?.visible ?? true,
      opacity: options?.opacity ?? 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {
        sourceKind: options?.sourceKind ?? "kml-ground-overlay",
        ...(options?.bounds ? { bounds: options.bounds } : {}),
        ...(options?.timeSpan ? { timeSpan: options.timeSpan } : {}),
        ...(options?.metadata ?? {}),
      },
      ...(options?.sourcePath ? { sourcePath: options.sourcePath } : {}),
    };
    get().addLayer(layer, beforeLayerId);
    return id;
  },

  addTileLayer: (name, options, beforeLayerId = null) => {
    // Every layer this builds carries a raster source, so a non-raster
    // `type` from an untyped JS caller (e.g. "vector-tiles") would persist
    // a layer whose `type` and `source.type` disagree. Reject it instead of
    // silently mislabelling the source; vector tiles need their own style
    // layers and go through the vector-tile path, not this one.
    const type = options.type ?? "xyz";
    if (!RASTER_TILE_LAYER_TYPES.has(type)) {
      throw new Error(
        `addTileLayer: unsupported type "${String(type)}"; expected one of ` +
          `${[...RASTER_TILE_LAYER_TYPES].join(", ")}. Only raster tile layers are supported.`,
      );
    }
    const id = uuidv4();
    // Trim each template and drop blanks, then reject a registration that
    // sanitizes down to nothing: syncRasterTileLayer returns early on an
    // empty tile list, so without this the store would persist and select a
    // layer that can never render.
    const tiles = options.tiles
      .filter((tile): tile is string => typeof tile === "string")
      .map((tile) => tile.trim())
      .filter((tile) => tile !== "");
    if (tiles.length === 0) {
      throw new Error("addTileLayer requires at least one non-empty tile URL template.");
    }
    // MapLibre's addSource throws synchronously when maxzoom < minzoom, and
    // syncRasterTileLayer does not catch it, which would strand a layer in
    // the store with no rendered source. Reject the bad range up front.
    if (
      options.minzoom !== undefined &&
      options.maxzoom !== undefined &&
      options.minzoom > options.maxzoom
    ) {
      throw new Error(
        `addTileLayer: minzoom (${options.minzoom}) must be <= maxzoom (${options.maxzoom}).`,
      );
    }
    const layer: GeoLibreLayer = {
      id,
      name,
      type,
      source: {
        // Extra source fields (e.g. WMS layers/styles) merge first so the
        // required raster descriptor below always wins. `type` above is
        // validated as a raster kind, so "raster" here always agrees with it.
        ...(options.source ?? {}),
        type: "raster",
        tiles,
        tileSize: options.tileSize ?? 256,
        ...(options.url !== undefined ? { url: options.url } : {}),
        ...(options.attribution !== undefined ? { attribution: options.attribution } : {}),
        ...(options.bounds !== undefined ? { bounds: options.bounds } : {}),
        ...(options.minzoom !== undefined ? { minzoom: options.minzoom } : {}),
        ...(options.maxzoom !== undefined ? { maxzoom: options.maxzoom } : {}),
        ...(options.scheme !== undefined ? { scheme: options.scheme } : {}),
      },
      visible: options.visible ?? true,
      opacity: options.opacity ?? 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: { ...(options.metadata ?? {}) },
    };
    get().addLayer(layer, beforeLayerId);
    return id;
  },
});
