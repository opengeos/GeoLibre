import {
  DEFAULT_LAYER_STYLE,
  extrusionColorValue,
  extrusionHeightValue,
  isVectorColorExpression,
  vectorCircleColorValue,
  vectorFillColorValue,
  vectorLineColorValue,
  type GeoLibreLayer,
  type LayerStyle,
  type VectorColorValue,
  useAppStore,
} from "@geolibre/core";
import type { PropertyValueSpecification } from "maplibre-gl";
import type { VectorLayerInfo, VectorLayerOptions, VectorLayerStyle } from "maplibre-gl-vector";

export const VECTOR_SOURCE_KIND = "maplibre-gl-vector";

// Upper bound on a restored color expression's serialized size. Generous for a
// real categorized/graduated style (hundreds of stops are well under this) but
// blocks a hand-edited project file from smuggling a large blob into a paint
// property, matching the length caps on restored color strings.
const MAX_COLOR_EXPRESSION_CHARS = 20_000;

/**
 * The slice of the maplibre-gl-vector VectorControl surface the store sync
 * drives. Structural (rather than the concrete class) so tests can pass
 * fakes without touching DuckDB-WASM or a real map.
 */
export type VectorSyncableControl = {
  getState?: () => { collapsed: boolean };
  getLayers: () => VectorLayerInfo[];
  removeLayer: (id: string) => void;
  setLayerOpacity: (id: string, opacity: number) => void;
  setLayerVisibility: (id: string, visible: boolean) => void;
  setLayerStyle: (id: string, style: Partial<VectorLayerStyle>) => void;
};

let syncedControl: VectorSyncableControl | null = null;
let storeUnsubscribe: (() => void) | null = null;
// Guards the store subscriber against re-entrancy: store mutations made by
// syncVectorLayersToStore fire the subscriber synchronously, which would
// otherwise echo removeLayer calls back at the control for layers it
// already dropped from its own list.
let syncingLayersToStore = false;
// Suspends event-driven control->store syncs while this module itself is
// mutating the control (store->control pushes, project restore). The
// control emits layer* events from those calls, and syncing mid-mutation
// would observe a partially restored layer list.
let storeSyncSuspended = 0;

/**
 * Detects a layer panel entry owned by the maplibre-gl-vector control.
 *
 * @param layer - A store layer.
 * @returns True when the layer mirrors a control-managed vector layer.
 */
export function isVectorControlStoreLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.metadata.sourceKind === VECTOR_SOURCE_KIND && layer.metadata.externalNativeLayer === true
  );
}

function hasRestorableVectorUrl(layer: GeoLibreLayer): boolean {
  return typeof layer.source.url === "string" && layer.source.url.trim() !== "";
}

/**
 * Detects an Add Vector Layer layer whose data is local (no fetchable URL) and
 * so *can* be embedded in a saved project — covering a browser-picked file, a
 * desktop path-backed file, and a layer restored from previously embedded
 * GeoJSON. Used to materialize features for both the Embed choice and a Share
 * upload. A desktop path-backed layer is included on purpose: on the same
 * machine it can reload from its path, but a shared/embedded copy still needs
 * its data so it survives on a machine that lacks the file.
 *
 * @param layer - A store layer.
 * @returns True when the layer's data can be embedded.
 */
export function isEmbeddableLocalVectorLayer(layer: GeoLibreLayer): boolean {
  return isVectorControlStoreLayer(layer) && !hasRestorableVectorUrl(layer);
}

/**
 * Builds the store layer mirroring a control vector layer snapshot.
 *
 * The control creates native MapLibre sources/layers and styles them
 * itself, so the store layer registers as an external custom layer:
 * layer-sync manages ordering only (through nativeLayerIds), and
 * wireVectorStoreSync applies panel visibility/opacity back through the
 * control API.
 *
 * @param info - Public layer snapshot from VectorControl.getLayers().
 * @param panelCollapsed - Whether the Add Vector Layer panel is collapsed.
 * @returns The corresponding GeoLibre store layer.
 */
export function createVectorStoreLayer(
  info: VectorLayerInfo,
  panelCollapsed = true,
): GeoLibreLayer {
  const url = info.source.kind === "url" ? info.source.url : undefined;
  // A desktop host echoes the absolute path a local file was read from, so the
  // layer can be re-read from disk on reopen; the browser only knows the file
  // name. Prefer the path, so it (not the bare name) is what gets persisted.
  const localFilePath = info.source.kind === "file" ? info.source.path : undefined;
  const sourcePath =
    url ?? localFilePath ?? (info.source.kind === "file" ? info.source.fileName : undefined);
  return {
    id: info.id,
    name: info.name,
    type: info.renderMode === "tiles" ? "vector-tiles" : "geojson",
    source: {
      type: info.renderMode === "tiles" ? "vector" : "geojson",
      ...(url ? { url } : {}),
    },
    visible: info.visible,
    opacity: info.opacity,
    // Seed the panel style from the control's own style so the Style panel
    // reflects what is actually rendered, and so an edit to one field does
    // not reset the others back to GeoLibre defaults.
    style: { ...DEFAULT_LAYER_STYLE, ...vectorStyleToLayerStyle(info) },
    metadata: {
      customLayerType: vectorCustomLayerType(info.geometryType),
      externalNativeLayer: true,
      // The control owns its layers' paint: GeoLibre pushes style edits through
      // control.setLayerStyle (see wireVectorStoreSync), so the core sync must
      // not also re-apply paint — that would clobber control-only renderers like
      // the cluster bubble's stepped radius.
      controlOwnsPaint: true,
      // The control's own picker popup handles feature inspection; the
      // app-level identify tool does not target these layers.
      identifiable: false,
      // The control creates real MapLibre style layers (fill/outline/
      // line/circle per geometry), so ordering moves reach them directly.
      nativeLayerIds: [...info.layerIds],
      panelCollapsed,
      sourceIds: [info.sourceId],
      sourceKind: VECTOR_SOURCE_KIND,
      // The load and visualization state is persisted so
      // restoreVectorLayers can replay URL-backed layers when a saved
      // project is reopened.
      vectorSource: info.source.kind,
      // Marks a local file the host gave an absolute path for (desktop), so
      // restoreVectorLayers re-reads it from `sourcePath` rather than dropping
      // it. A browser-picked file has no path and so no flag.
      ...(localFilePath ? { localFileReloadable: true } : {}),
      vectorState: serializableVectorState(info),
      ...(info.geometryType !== "unknown" ? { geometryType: info.geometryType } : {}),
      ...(typeof info.featureCount === "number" ? { featureCount: info.featureCount } : {}),
      // Attribute field names, so the Style panel can populate the label field
      // (and other attribute-driven) dropdowns for a control-managed layer,
      // which has no layer.geojson to read property keys from.
      ...(info.fields && info.fields.length > 0 ? { fields: [...info.fields] } : {}),
      ...(info.bbox ? { bounds: [...info.bbox] } : {}),
    },
    ...(sourcePath ? { sourcePath } : {}),
  };
}

/**
 * Diffs the control's layer list into the app store so the layer panel
 * lists control-managed vector layers. Adds new layers, drops store layers
 * whose vector layers are gone, and refreshes changed fields on existing
 * layers. The name is only seeded on creation so renames in the GeoLibre
 * layer panel survive later syncs.
 *
 * @param control - The vector control to mirror.
 */
export function syncVectorLayersToStore(control: VectorSyncableControl): void {
  if (isVectorStoreSyncSuspended()) return;

  const infos = control.getLayers();
  const infoIds = new Set(infos.map((info) => info.id));
  const panelCollapsed = vectorPanelCollapsedFromControl(control);

  syncingLayersToStore = true;
  try {
    for (const storeLayer of useAppStore.getState().layers) {
      if (!isVectorControlStoreLayer(storeLayer)) continue;
      if (!infoIds.has(storeLayer.id)) {
        useAppStore.getState().removeLayer(storeLayer.id);
      }
    }

    for (const info of infos) {
      const layer = createVectorStoreLayer(info, panelCollapsed);
      const existing = useAppStore.getState().layers.find((current) => current.id === layer.id);

      if (!existing) {
        useAppStore.getState().addLayer(layer);
        continue;
      }

      if (
        existing.type !== layer.type ||
        existing.visible !== layer.visible ||
        existing.opacity !== layer.opacity ||
        existing.sourcePath !== layer.sourcePath ||
        !recordsEqual(existing.source, layer.source) ||
        !recordsEqual(existing.metadata, layer.metadata)
      ) {
        useAppStore.getState().updateLayer(layer.id, {
          // Replace metadata wholesale so stale keys (bounds, featureCount,
          // and any embeddedGeoJSON loaded from the project) cannot survive a
          // layer being swapped out under the same id. embeddedGeoJSON is not
          // kept live: the web Save flow re-materializes it fresh from the
          // control (getLayerGeoJSON), so a reopened layer drops its loaded
          // blob here and re-embeds current data on the next save.
          metadata: layer.metadata,
          opacity: layer.opacity,
          source: layer.source,
          sourcePath: layer.sourcePath,
          // A render-mode switch in the panel flips geojson <-> vector-tiles.
          type: layer.type,
          visible: layer.visible,
        });
      }
    }
  } finally {
    syncingLayersToStore = false;
  }
}

/**
 * Watches the store for panel-side changes to control-managed vector
 * layers. Removing a layer in the panel drops the control's layer, and
 * visibility and opacity edits are applied through the control API because
 * the control-owned native layers skip the generic paint sync in
 * layer-sync.
 *
 * Subscribes once; later calls point the sync at the latest control
 * instance.
 *
 * @param control - The vector control to receive store changes.
 */
export function wireVectorStoreSync(control: VectorSyncableControl): void {
  syncedControl = control;
  storeUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    const activeControl = syncedControl;
    if (
      !activeControl ||
      syncingLayersToStore ||
      isVectorStoreSyncSuspended() ||
      state.layers === previous.layers
    ) {
      return;
    }

    // The subscriber fires on every layers change; skip the per-layer scan
    // when the previous snapshot held no control-managed layers at all.
    if (!previous.layers.some(isVectorControlStoreLayer)) return;

    const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));
    runWithVectorStoreSyncSuspended(() => {
      for (const layer of previous.layers) {
        if (!isVectorControlStoreLayer(layer)) continue;

        const current = currentById.get(layer.id);
        if (!current) {
          activeControl.removeLayer(layer.id);
          continue;
        }

        if (current.visible !== layer.visible) {
          activeControl.setLayerVisibility(layer.id, current.visible);
        }
        if (current.opacity !== layer.opacity) {
          activeControl.setLayerOpacity(layer.id, current.opacity);
        }
        const nextStyle = layerStyleToVectorStyle(current.style);
        if (!vectorStylesEqual(layerStyleToVectorStyle(layer.style), nextStyle)) {
          activeControl.setLayerStyle(layer.id, nextStyle);
          // A pointMode change makes the control rebuild its map layers, so the
          // new layer ids replace the old ones. Refresh nativeLayerIds/sourceIds
          // from the control so the core sync orders/toggles the new layers.
          const updated = activeControl.getLayers().find((info) => info.id === layer.id);
          const metadataPatch: Record<string, unknown> = {
            ...current.metadata,
          };
          if (updated) {
            metadataPatch.nativeLayerIds = [...updated.layerIds];
            metadataPatch.sourceIds = [updated.sourceId];
          }
          // Keep the persisted control-seed style in sync so a saved project
          // restores the user-edited colors: restoreVectorLayers seeds the
          // control's addData from metadata.vectorState.style. (The control's
          // layerupdated event would normally refresh this via
          // syncVectorLayersToStore, but the suspension around this push
          // suppresses it.)
          const vectorState = current.metadata.vectorState;
          if (vectorState && typeof vectorState === "object" && !Array.isArray(vectorState)) {
            metadataPatch.vectorState = {
              ...(vectorState as Record<string, unknown>),
              style: nextStyle,
            };
          }
          useAppStore.getState().updateLayer(layer.id, {
            metadata: metadataPatch,
          });
        }
      }
    });
  });
}

/**
 * Stops the store subscription and forgets the synced control. Used when
 * the control is removed from the map.
 */
export function unwireVectorStoreSync(): void {
  storeUnsubscribe?.();
  storeUnsubscribe = null;
  syncedControl = null;
}

/**
 * Removes every control-managed vector layer from the store, without
 * echoing the removals back at the control.
 *
 * Deliberately NOT called from the control's onRemove teardown: the control
 * is removed on map reinitialisation, where the store layers must survive
 * so restoreVectorLayers can replay them into the successor control.
 */
export function removeVectorStoreLayers(): void {
  syncingLayersToStore = true;
  try {
    for (const layer of useAppStore.getState().layers) {
      if (isVectorControlStoreLayer(layer)) {
        useAppStore.getState().removeLayer(layer.id);
      }
    }
  } finally {
    syncingLayersToStore = false;
  }
}

/**
 * Runs a callback with event-driven control->store syncing (and the
 * store->control subscriber) suspended. Used around control mutations whose
 * intermediate states must not be mirrored.
 *
 * @param callback - The mutation to run while suspended.
 * @returns The callback's return value.
 */
export function runWithVectorStoreSyncSuspended<T>(callback: () => T): T {
  suspendVectorStoreSync();
  try {
    return callback();
  } finally {
    resumeVectorStoreSync();
  }
}

/**
 * Suspends event-driven syncs until the matching resumeVectorStoreSync.
 * Unlike maplibre-gl-raster (whose addRaster registers the raster
 * synchronously), VectorControl.addData only adds a layer to its list
 * after the data has loaded, so project restore must hold the suspension
 * across that async window — a plain synchronous wrapper cannot.
 */
export function suspendVectorStoreSync(): void {
  storeSyncSuspended += 1;
}

/**
 * Lifts one suspension level. Clamped at zero so a resume that races a
 * teardown-triggered reset cannot underflow into permanently suppressed
 * syncs going unnoticed.
 */
export function resumeVectorStoreSync(): void {
  storeSyncSuspended = Math.max(0, storeSyncSuspended - 1);
}

/**
 * Whether sync suppression is currently active.
 *
 * @returns True while a suspension is held.
 */
export function isVectorStoreSyncSuspended(): boolean {
  return storeSyncSuspended > 0;
}

/**
 * Clears the suspension counter. Called on control teardown so a control
 * torn down mid-restore cannot leave its successor permanently suppressing
 * store sync events.
 */
export function resetVectorStoreSyncSuspension(): void {
  storeSyncSuspended = 0;
}

/**
 * Reads the persisted load/visualization state from a store layer's
 * metadata, keeping only well-formed fields so a hand-edited project file
 * cannot crash the control.
 *
 * @param layer - A store layer created by createVectorStoreLayer.
 * @returns The addData options to replay through VectorControl.addData.
 */
export function savedVectorState(
  layer: GeoLibreLayer,
): Pick<
  VectorLayerOptions,
  "format" | "ingestMode" | "picker" | "renderMode" | "sourceLayer" | "style"
> {
  const raw = layer.metadata.vectorState;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const candidate = raw as Record<string, unknown>;
  const state: ReturnType<typeof savedVectorState> = {};

  if (candidate.renderMode === "geojson" || candidate.renderMode === "tiles") {
    state.renderMode = candidate.renderMode;
  }
  if (candidate.ingestMode === "table" || candidate.ingestMode === "stream") {
    state.ingestMode = candidate.ingestMode;
  }
  if (typeof candidate.picker === "boolean") {
    state.picker = candidate.picker;
  }
  // Length caps match the color validator below: legitimate container
  // layer names and format identifiers are short, and a hand-edited
  // project file must not smuggle arbitrary blobs through these fields.
  if (
    typeof candidate.sourceLayer === "string" &&
    candidate.sourceLayer &&
    candidate.sourceLayer.length <= 200
  ) {
    state.sourceLayer = candidate.sourceLayer;
  }
  // Formats are open-ended (any extension the spatial extension's GDAL
  // build reads), so no allowlist here; the control falls back to its own
  // detection for unknown names.
  if (typeof candidate.format === "string" && candidate.format && candidate.format.length <= 50) {
    state.format = candidate.format;
  }
  const style = savedVectorStyle(candidate.style);
  if (style) state.style = style;

  return state;
}

function savedVectorStyle(raw: unknown): Partial<VectorLayerStyle> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  const style: Partial<VectorLayerStyle> = {};

  // Length-capped rather than parsed: valid CSS color syntax is broad and
  // MapLibre rejects unparseable values itself, but a hand-edited project
  // file must not smuggle arbitrary multi-kilobyte strings into paint
  // properties.
  const color = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= 100;
  const fraction = (value: unknown): value is number =>
    typeof value === "number" && value >= 0 && value <= 1;
  const positive = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value > 0;

  if (color(candidate.fillColor)) style.fillColor = candidate.fillColor;
  if (fraction(candidate.fillOpacity)) style.fillOpacity = candidate.fillOpacity;
  if (color(candidate.lineColor)) style.lineColor = candidate.lineColor;
  if (positive(candidate.lineWidth)) style.lineWidth = candidate.lineWidth;
  if (color(candidate.circleColor)) style.circleColor = candidate.circleColor;
  if (positive(candidate.circleRadius)) {
    style.circleRadius = candidate.circleRadius;
  }
  if (fraction(candidate.circleOpacity)) {
    style.circleOpacity = candidate.circleOpacity;
  }

  // Restore the data-driven color expressions so a saved categorized/graduated/
  // expression style renders on reload: restoreVectorLayers seeds the control's
  // addData from this style, and the post-load sync does not re-push (the
  // recomputed expression matches the persisted one). Bounded like the color
  // strings above: an array passes only when its serialized form stays small,
  // so a hand-edited project file cannot smuggle a multi-kilobyte (or deeply
  // nested) blob into a paint property. Real categorized/graduated expressions
  // are far under this cap, and MapLibre validates the expression contents.
  const colorExpression = (value: unknown): value is PropertyValueSpecification<string> => {
    if (!Array.isArray(value) || value.length === 0) return false;
    try {
      return JSON.stringify(value).length <= MAX_COLOR_EXPRESSION_CHARS;
    } catch {
      // A circular or pathologically deep array makes JSON.stringify throw;
      // reject it so a hand-edited project file cannot break restore.
      return false;
    }
  };
  if (colorExpression(candidate.fillColorExpression)) {
    style.fillColorExpression = candidate.fillColorExpression;
  }
  if (colorExpression(candidate.lineColorExpression)) {
    style.lineColorExpression = candidate.lineColorExpression;
  }
  if (colorExpression(candidate.circleColorExpression)) {
    style.circleColorExpression = candidate.circleColorExpression;
  }

  // 3D extrusion. Restored so a saved extruded polygon layer renders as an
  // extrusion immediately on reopen (the control is seeded from this style),
  // before the store sync re-pushes. The height can be a flat number or a
  // MapLibre expression array, validated with the same bounded checks as the
  // color expressions so a hand-edited project file cannot smuggle a blob in.
  if (typeof candidate.extrusionEnabled === "boolean") {
    style.extrusionEnabled = candidate.extrusionEnabled;
  }
  if (color(candidate.extrusionColor)) {
    style.extrusionColor = candidate.extrusionColor;
  }
  if (colorExpression(candidate.extrusionColorExpression)) {
    style.extrusionColorExpression = candidate.extrusionColorExpression;
  }
  if (fraction(candidate.extrusionOpacity)) {
    style.extrusionOpacity = candidate.extrusionOpacity;
  }
  // Height and base are meters; MapLibre clamps a negative
  // fill-extrusion-height/base to 0, so reject negatives here (matching the
  // >= 0 dimension guards) rather than restoring a value that renders flat.
  if (
    typeof candidate.extrusionBase === "number" &&
    Number.isFinite(candidate.extrusionBase) &&
    candidate.extrusionBase >= 0
  ) {
    style.extrusionBase = candidate.extrusionBase;
  }
  if (
    typeof candidate.extrusionHeight === "number" &&
    Number.isFinite(candidate.extrusionHeight) &&
    candidate.extrusionHeight >= 0
  ) {
    style.extrusionHeight = candidate.extrusionHeight;
  } else if (colorExpression(candidate.extrusionHeight)) {
    // colorExpression only enforces "a small, well-formed JSON array", which is
    // exactly the bound wanted for a height expression too; the name refers to
    // its first use, not a color-only constraint.
    style.extrusionHeight = candidate.extrusionHeight as VectorLayerStyle["extrusionHeight"];
  }

  // Attribute labels. The field name is length-capped like the color strings
  // (a real attribute name is short); the rest reuse the same color/number
  // guards so a hand-edited project file cannot smuggle blobs into the symbol
  // layer's paint/layout. Only the field-based label fields are persisted —
  // LabelStyle.expression/.minZoom/.maxZoom are not mapped to the control (see
  // layerStyleToVectorStyle), so persisting them here would have no effect.
  if (
    typeof candidate.labelField === "string" &&
    candidate.labelField &&
    candidate.labelField.length <= 200
  ) {
    style.labelField = candidate.labelField;
  }
  if (positive(candidate.labelSize)) style.labelSize = candidate.labelSize;
  if (color(candidate.labelColor)) style.labelColor = candidate.labelColor;
  if (color(candidate.labelHaloColor)) {
    style.labelHaloColor = candidate.labelHaloColor;
  }
  if (
    typeof candidate.labelHaloWidth === "number" &&
    Number.isFinite(candidate.labelHaloWidth) &&
    candidate.labelHaloWidth >= 0
  ) {
    style.labelHaloWidth = candidate.labelHaloWidth;
  }
  if (candidate.labelPlacement === "point" || candidate.labelPlacement === "line") {
    style.labelPlacement = candidate.labelPlacement;
  }
  if (typeof candidate.labelAllowOverlap === "boolean") {
    style.labelAllowOverlap = candidate.labelAllowOverlap;
  }

  return Object.keys(style).length > 0 ? style : null;
}

/**
 * Maps GeoLibre's shared LayerStyle onto the control's per-geometry
 * VectorLayerStyle. GeoLibre exposes one fillColor/strokeColor/fillOpacity/
 * strokeWidth for every geometry, so the fill fields also drive point circles
 * and the stroke fields drive lines and polygon outlines; the control applies
 * only the fields relevant to each layer's actual geometry.
 *
 * The collapse is intentionally lossy: circleColor/circleOpacity always track
 * fillColor/fillOpacity. Single-geometry layers round-trip cleanly; a "mixed"
 * layer's point circles unify with its fill from the first panel edit onward,
 * since GeoLibre has no separate point-fill control.
 *
 * Categorized/graduated/expression style modes produce a data-driven MapLibre
 * color expression that a flat color cannot represent, so it is carried in the
 * control's optional *ColorExpression fields (the flat colors remain the
 * fallback). The expression fields are always set — to the expression in a
 * data-driven mode, or to undefined in `single` mode — so reverting to a single
 * color clears any previously pushed expression on the control.
 *
 * @param style - The GeoLibre layer style.
 * @returns The equivalent control style patch.
 */
function layerStyleToVectorStyle(style: LayerStyle): VectorLayerStyle {
  return {
    fillColor: style.fillColor,
    fillOpacity: style.fillOpacity,
    lineColor: style.strokeColor,
    lineWidth: style.strokeWidth,
    // circleColor/circleOpacity intentionally track fillColor/fillOpacity (see
    // the doc comment): one fill edit drives both polygon fills and point
    // circles on mixed layers. Pure polygon/line layers ignore these fields;
    // pure point layers ignore fillColor/fillOpacity instead.
    circleColor: style.fillColor,
    circleOpacity: style.fillOpacity,
    circleRadius: style.circleRadius,
    fillColorExpression: colorExpressionField(vectorFillColorValue(style)),
    lineColorExpression: colorExpressionField(vectorLineColorValue(style)),
    circleColorExpression: colorExpressionField(vectorCircleColorValue(style)),
    // 3D extrusion. The control renders a fill-extrusion layer for polygons
    // when extrusionEnabled; height and color reuse GeoLibre's shared resolvers
    // so a control-managed layer extrudes identically to the core fill-extrusion
    // path. extrusionColorExpression carries the data-driven color (the flat
    // extrusionColor is the fallback), matching the fill color contract above.
    extrusionEnabled: style.extrusionEnabled,
    extrusionColor: style.extrusionColor,
    extrusionColorExpression: colorExpressionField(extrusionColorValue(style)),
    extrusionOpacity: style.extrusionOpacity,
    extrusionHeight: extrusionHeightValue(style) as VectorLayerStyle["extrusionHeight"],
    extrusionBase: style.extrusionBase,
    // Point renderer: GeoLibre's "single" maps to the control's "circle".
    pointMode:
      (style.pointRenderer ?? "single") === "single"
        ? "circle"
        : (style.pointRenderer as "heatmap" | "cluster"),
    heatmapRadius: style.heatmapRadius,
    heatmapIntensity: style.heatmapIntensity,
    clusterRadius: style.clusterRadius,
    clusterMaxZoom: style.clusterMaxZoom,
    // Attribute labels: GeoLibre's LabelStyle maps onto the control's flat
    // label fields. The control renders the field's value as a symbol layer;
    // an empty labelField clears it.
    //
    // Only field-based labeling is wired here. LabelStyle.expression,
    // .minZoom, and .maxZoom have no maplibre-gl-vector@0.8.0 equivalent, so
    // they are intentionally left out of this mapping, out of vectorStylesEqual,
    // and out of savedVectorStyle. The shared Style panel still shows those
    // controls, but for a control-managed layer they are no-ops; adding them
    // here later means also wiring the equality check, persistence, and the
    // upstream control option.
    labelField: style.labels.enabled && style.labels.field.trim() !== "" ? style.labels.field : "",
    labelSize: style.labels.size,
    labelColor: style.labels.color,
    labelHaloColor: style.labels.haloColor,
    labelHaloWidth: style.labels.haloWidth,
    labelPlacement: style.labels.placement,
    labelAllowOverlap: style.labels.allowOverlap,
  };
}

/**
 * Narrows a computed vector color to the control's expression field: the
 * expression when the style mode is data-driven, or undefined when it resolves
 * to a flat color (so the control falls back to fillColor/lineColor/circleColor).
 *
 * @param value - A color value from the @geolibre/core color builders.
 * @returns The expression, or undefined for a flat color.
 */
function colorExpressionField(
  value: VectorColorValue,
): PropertyValueSpecification<string> | undefined {
  return isVectorColorExpression(value) ? (value as PropertyValueSpecification<string>) : undefined;
}

/**
 * Seeds a GeoLibre LayerStyle from the control's VectorLayerStyle so the Style
 * panel reflects what the control actually rendered. Collapses the control's
 * per-geometry colors onto GeoLibre's shared fields, choosing the fill source
 * by geometry (point circles use the circle fill; everything else the polygon
 * fill).
 *
 * @param info - The control layer snapshot.
 * @returns A partial GeoLibre style to overlay on the defaults.
 */
function vectorStyleToLayerStyle(info: VectorLayerInfo): Partial<LayerStyle> {
  const style = info.style;
  // Only emit fields the control actually provided; otherwise a missing value
  // would spread an explicit `undefined` over DEFAULT_LAYER_STYLE at the seed
  // site and clobber a valid default.
  const seed: Partial<LayerStyle> = {};
  if (style.lineColor !== undefined) seed.strokeColor = style.lineColor;
  if (style.lineWidth !== undefined) seed.strokeWidth = style.lineWidth;
  if (style.circleRadius !== undefined) seed.circleRadius = style.circleRadius;

  const [fillColor, fillOpacity] =
    info.geometryType === "point"
      ? [style.circleColor, style.circleOpacity]
      : [style.fillColor, style.fillOpacity];
  if (fillColor !== undefined) seed.fillColor = fillColor;
  if (fillOpacity !== undefined) seed.fillOpacity = fillOpacity;

  // Reflect the control's point render mode in the panel ("circle" -> "single").
  if (style.pointMode !== undefined) {
    seed.pointRenderer = style.pointMode === "circle" ? "single" : style.pointMode;
  }
  if (typeof style.heatmapRadius === "number") seed.heatmapRadius = style.heatmapRadius;
  if (typeof style.heatmapIntensity === "number") {
    seed.heatmapIntensity = style.heatmapIntensity;
  }
  if (typeof style.clusterRadius === "number") seed.clusterRadius = style.clusterRadius;
  if (typeof style.clusterMaxZoom === "number") {
    seed.clusterMaxZoom = style.clusterMaxZoom;
  }

  // Reflect the control's attribute labels in the panel, so a restored project
  // (whose label state was seeded into the control via savedVectorState) shows
  // the Show-labels controls populated rather than reset to the defaults.
  if (typeof style.labelField === "string" && style.labelField.trim() !== "") {
    const defaults = DEFAULT_LAYER_STYLE.labels;
    seed.labels = {
      ...defaults,
      enabled: true,
      field: style.labelField,
      // Guard with > 0 to match savedVectorStyle's positive() check, so a
      // (never expected) labelSize of 0 from the control does not round-trip
      // to an invisible-then-reset size.
      size:
        typeof style.labelSize === "number" && style.labelSize > 0
          ? style.labelSize
          : defaults.size,
      color: style.labelColor ?? defaults.color,
      haloColor: style.labelHaloColor ?? defaults.haloColor,
      haloWidth:
        typeof style.labelHaloWidth === "number" ? style.labelHaloWidth : defaults.haloWidth,
      placement: style.labelPlacement === "line" ? "line" : "point",
      allowOverlap: style.labelAllowOverlap ?? defaults.allowOverlap,
    };
  }

  return seed;
}

/**
 * Shallow equality over the control style fields, so a no-op style change in
 * the store does not push a redundant setLayerStyle at the control.
 *
 * @param left - First control style.
 * @param right - Second control style.
 * @returns True when every field matches.
 */
function vectorStylesEqual(left: VectorLayerStyle, right: VectorLayerStyle): boolean {
  return (
    left.fillColor === right.fillColor &&
    left.fillOpacity === right.fillOpacity &&
    left.lineColor === right.lineColor &&
    left.lineWidth === right.lineWidth &&
    left.circleColor === right.circleColor &&
    left.circleOpacity === right.circleOpacity &&
    left.circleRadius === right.circleRadius &&
    // Color expressions are arrays (or undefined), so compare them deeply: a
    // categorized/graduated stop change reuses the same flat colors but yields
    // a different expression, which must still register as a style change.
    valuesEqual(left.fillColorExpression, right.fillColorExpression) &&
    valuesEqual(left.lineColorExpression, right.lineColorExpression) &&
    valuesEqual(left.circleColorExpression, right.circleColorExpression) &&
    // Extrusion: a toggle, an opacity/base change, or a height/color change
    // (the height is an array expression, so compare it deeply) must register
    // so it is pushed to the control, which rebuilds or repaints accordingly.
    left.extrusionEnabled === right.extrusionEnabled &&
    left.extrusionColor === right.extrusionColor &&
    left.extrusionOpacity === right.extrusionOpacity &&
    left.extrusionBase === right.extrusionBase &&
    valuesEqual(left.extrusionHeight, right.extrusionHeight) &&
    valuesEqual(left.extrusionColorExpression, right.extrusionColorExpression) &&
    // Point renderer fields: a pointMode/heatmap/cluster change must register so
    // it is pushed to the control (which rebuilds the layers structurally).
    left.pointMode === right.pointMode &&
    left.heatmapRadius === right.heatmapRadius &&
    left.heatmapIntensity === right.heatmapIntensity &&
    left.clusterRadius === right.clusterRadius &&
    left.clusterMaxZoom === right.clusterMaxZoom &&
    // Label fields: a Show-labels toggle or any label restyle must register as
    // a change so it is pushed to the control (which adds/updates/removes the
    // symbol layer).
    left.labelField === right.labelField &&
    left.labelSize === right.labelSize &&
    left.labelColor === right.labelColor &&
    left.labelHaloColor === right.labelHaloColor &&
    left.labelHaloWidth === right.labelHaloWidth &&
    left.labelPlacement === right.labelPlacement &&
    left.labelAllowOverlap === right.labelAllowOverlap
  );
}

function vectorCustomLayerType(geometryType: VectorLayerInfo["geometryType"]): string {
  switch (geometryType) {
    case "point":
      return "circle";
    case "line":
      return "line";
    case "polygon":
      return "fill";
    default:
      return "custom";
  }
}

function vectorPanelCollapsedFromControl(control: VectorSyncableControl): boolean {
  try {
    const collapsed = control.getState?.().collapsed;
    return typeof collapsed === "boolean" ? collapsed : true;
  } catch (error) {
    // getState is optional, so only a throwing implementation lands here;
    // surface it instead of letting it look like the method being absent.
    console.warn("[GeoLibre] vectorPanelCollapsedFromControl: getState threw", error);
    return true;
  }
}

// Key-order-insensitive deep equality for source/metadata records, matching
// the helper of the same name in raster-layer-sync.ts. JSON.stringify would
// report a difference for semantically equal objects whose keys were built
// in a different order, forcing a spurious updateLayer on every event.
function recordsEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!valuesEqual(left[key], right[key])) return false;
  }
  return true;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((value, index) => valuesEqual(value, right[index]));
  }

  if (isRecord(left) || isRecord(right)) {
    return isRecord(left) && isRecord(right) && recordsEqual(left, right);
  }

  return Object.is(left, right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializableVectorState(info: VectorLayerInfo): Record<string, unknown> {
  // visible and opacity live on the top-level layer fields (the panel edits
  // them there); persisting copies here would leave two competing values in
  // a saved project file, so they are omitted.
  return {
    format: info.format,
    ingestMode: info.ingestMode,
    picker: info.picker,
    renderMode: info.renderMode,
    style: { ...info.style },
    ...(info.sourceLayer ? { sourceLayer: info.sourceLayer } : {}),
  };
}
