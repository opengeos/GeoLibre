import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  useAppStore,
} from "@geolibre/core";
import type {
  VectorLayerInfo,
  VectorLayerOptions,
  VectorLayerStyle,
} from "maplibre-gl-vector";

export const VECTOR_SOURCE_KIND = "maplibre-gl-vector";

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
    layer.metadata.sourceKind === VECTOR_SOURCE_KIND &&
    layer.metadata.externalNativeLayer === true
  );
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
  const sourcePath =
    url ?? (info.source.kind === "file" ? info.source.fileName : undefined);
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
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      customLayerType: vectorCustomLayerType(info.geometryType),
      externalNativeLayer: true,
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
      vectorState: serializableVectorState(info),
      ...(info.geometryType !== "unknown"
        ? { geometryType: info.geometryType }
        : {}),
      ...(typeof info.featureCount === "number"
        ? { featureCount: info.featureCount }
        : {}),
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
      const existing = useAppStore
        .getState()
        .layers.find((current) => current.id === layer.id);

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
          // Replace metadata wholesale so stale keys (bounds, featureCount)
          // cannot survive a layer being swapped out under the same id.
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
  if (
    typeof candidate.format === "string" &&
    candidate.format &&
    candidate.format.length <= 50
  ) {
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

  return Object.keys(style).length > 0 ? style : null;
}

function vectorCustomLayerType(
  geometryType: VectorLayerInfo["geometryType"],
): string {
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

function vectorPanelCollapsedFromControl(
  control: VectorSyncableControl,
): boolean {
  try {
    const collapsed = control.getState?.().collapsed;
    return typeof collapsed === "boolean" ? collapsed : true;
  } catch (error) {
    // getState is optional, so only a throwing implementation lands here;
    // surface it instead of letting it look like the method being absent.
    console.warn(
      "[GeoLibre] vectorPanelCollapsedFromControl: getState threw",
      error,
    );
    return true;
  }
}

// Key-order-insensitive deep equality for source/metadata records, matching
// the helper of the same name in raster-layer-sync.ts. JSON.stringify would
// report a difference for semantically equal objects whose keys were built
// in a different order, forcing a spurious updateLayer on every event.
function recordsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
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

function serializableVectorState(
  info: VectorLayerInfo,
): Record<string, unknown> {
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
