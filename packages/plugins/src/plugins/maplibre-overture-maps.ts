import {
  DEFAULT_LAYER_STYLE,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";
import {
  DEFAULT_TILES_BASE_URL,
  layerIdsForSourceLayer,
  OvertureMapsControl,
  sourceIdForTheme,
  THEME_IDS,
  THEMES,
  tileUrlForTheme,
  type OvertureMapsControlOptions,
  type OvertureMapsEventHandler,
  type OvertureMapsState,
  type OvertureTheme,
} from "maplibre-gl-overture-maps";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "../types";

let overturePosition: GeoLibreMapControlPosition = "top-left";

const OVERTURE_OPTIONS = {
  collapsed: false,
  title: "Overture Maps",
  panelWidth: 340,
  className: "geolibre-overture-control",
  // Start with only the buildings theme (its "building" and "building_part"
  // source layers) shown, instead of the upstream default that also enables
  // transportation and places.
  visibleThemes: ["buildings"],
} satisfies Omit<OvertureMapsControlOptions, "position">;

/** metadata.sourceKind for store layers that mirror an Overture source layer. */
const SOURCE_KIND = "overture-maps";

let overtureControl: OvertureMapsControl | null = null;
// Holds the panel state while the control is detached so re-activating or
// repositioning it restores the user's release, visibility, and opacity.
let pendingState: Partial<OvertureMapsState> | null = null;

function createOvertureControl(app: GeoLibreAppAPI): OvertureMapsControl {
  // Construct with the static defaults, then let setState restore the full
  // saved state (release, panel size, and per-layer themes). setState alone
  // covers collapsed/panelWidth/release too, so they are not duplicated as
  // constructor options.
  const control = new OvertureMapsControl({
    ...OVERTURE_OPTIONS,
    position: overturePosition,
    // Route the layer GeoJSON export through the host so it works in desktop
    // webviews (Tauri), where the control's built-in anchor download is a
    // no-op. Falls back to the control's browser download when the host has
    // no exporter.
    ...(app.exportTextFile
      ? {
          onExport: (filename, data) =>
            app.exportTextFile?.(filename, JSON.stringify(data)),
        }
      : {}),
  });
  if (pendingState) {
    control.setState(pendingState);
  }
  return control;
}

function isOvertureMapsState(
  value: unknown,
): value is Partial<OvertureMapsState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  // Require at least one distinctive OvertureMapsState field so an unrelated
  // object stored under this plugin's key is not forwarded to setState.
  return (
    "themes" in value || "release" in value || "collapsed" in value
  );
}

export const maplibreOvertureMapsPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-overture-maps",
  name: "Overture Maps",
  version: "0.2.0",
  activate: (app: GeoLibreAppAPI) => {
    if (!overtureControl) {
      overtureControl = createOvertureControl(app);
      attachStoreSync(overtureControl);
    }
    const added = app.addMapControl(overtureControl, overturePosition);
    if (!added) {
      detachStoreSync();
      overtureControl = null;
      return false;
    }
    // Open the panel on activation. Deferring past the current click avoids
    // the menu click that activated the plugin being treated as a
    // click-outside that immediately re-collapses the panel.
    setTimeout(() => overtureControl?.expand(), 0);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    if (!overtureControl) return;
    detachStoreSync();
    pendingState = overtureControl.getState();
    app.removeMapControl(overtureControl);
    overtureControl = null;
  },
  getMapControlPosition: () => overturePosition,
  setMapControlPosition: (
    app: GeoLibreAppAPI,
    position: GeoLibreMapControlPosition,
  ) => {
    overturePosition = position;
    if (!overtureControl) return;
    // Snapshot before detaching from the map so a failed re-add still keeps
    // the latest state, mirroring the ordering used in deactivate.
    pendingState = overtureControl.getState();
    app.removeMapControl(overtureControl);
    const added = app.addMapControl(overtureControl, overturePosition);
    if (!added) {
      detachStoreSync();
      overtureControl = null;
      return false;
    }
    setTimeout(() => overtureControl?.expand(), 0);
  },
  getProjectState: () =>
    overtureControl?.getState() ?? pendingState ?? undefined,
  applyProjectState: (_app: GeoLibreAppAPI, state: unknown) => {
    if (!isOvertureMapsState(state)) return false;
    pendingState = state;
    overtureControl?.setState(state);
  },
};

// --- Layers-panel store sync -------------------------------------------------
//
// The control adds Overture PMTiles layers directly to the map. This mirrors
// each visible Overture source layer (e.g. "building", "building_part") into
// the GeoLibre layer store as a single external-native "custom" layer so it
// appears in the Layers panel and persists in projects. Each entry combines the
// source layer's fill/line/circle native layers into one row, matching the
// per-source-layer structure of the Overture Maps control.
//
// The control owns rendering (visibility, opacity, color, draw order), so the
// store layers carry `customLayerType`, which tells `@geolibre/map`'s layer
// sync to track and reorder them without overwriting the control's paint.
//
// Sync is bidirectional:
// - control `statechange` events mirror source-layer visibility/opacity into
//   the store
// - Layers-panel edits push visibility/opacity back into the control, and
//   removing an entry hides its source layer.
//
// Entries persist across visibility toggles: hiding a source layer keeps its
// (hidden) Layers-panel entry rather than dropping it.

/** Identifies one Overture source layer within a theme. */
interface OvertureUnit {
  theme: OvertureTheme;
  sourceLayer: string;
}

let storeUnsubscribe: (() => void) | null = null;
let controlEventHandler: OvertureMapsEventHandler | null = null;
let syncing = false;
// Last visibility/opacity observed on the control per source layer. Doubles as
// the record of source layers this sync manages, so a panel deletion can be
// told apart from a source layer that was never mirrored.
const lastControlValues = new Map<
  string,
  { visible: boolean; opacity: number }
>();

const OVERTURE_UNITS: OvertureUnit[] = THEME_IDS.flatMap((theme) =>
  THEMES[theme].layers.map((layer) => ({
    theme,
    sourceLayer: layer.sourceLayer,
  })),
);

function unitKey(unit: OvertureUnit): string {
  return `${unit.theme}/${unit.sourceLayer}`;
}

function storeLayerId(unit: OvertureUnit): string {
  return `overture-maps-${unit.theme}-${unit.sourceLayer}`;
}

function humanizeSourceLayer(sourceLayer: string): string {
  const spaced = sourceLayer.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function attachStoreSync(control: OvertureMapsControl): void {
  controlEventHandler = () => handleControlEvent(control);
  control.on("statechange", controlEventHandler);
  // Only react to layer changes; the store also updates on unrelated mutations
  // (basemap, UI state) that cannot affect the Overture mirror.
  storeUnsubscribe = useAppStore.subscribe((state, prev) => {
    if (state.layers === prev.layers) return;
    handleStoreChange(control);
  });
  // Mirror the control's current source layers and adopt any layers restored
  // from a project, pushing their state back into the control.
  handleStoreChange(control);
}

function detachStoreSync(): void {
  if (overtureControl && controlEventHandler) {
    overtureControl.off("statechange", controlEventHandler);
  }
  controlEventHandler = null;
  storeUnsubscribe?.();
  storeUnsubscribe = null;
  lastControlValues.clear();
  removeOvertureStoreLayers();
}

function handleControlEvent(control: OvertureMapsControl): void {
  if (syncing) return;
  syncing = true;
  try {
    reconcileStore(control);
  } finally {
    syncing = false;
  }
}

function handleStoreChange(control: OvertureMapsControl): void {
  if (syncing) return;
  syncing = true;
  try {
    reverseSync(control);
    reconcileStore(control);
  } finally {
    syncing = false;
  }
}

/** Mirrors the control's source-layer state into the store (control -> store). */
function reconcileStore(control: OvertureMapsControl): void {
  const state = control.getState();
  const store = useAppStore.getState();

  for (const unit of OVERTURE_UNITS) {
    const layerState = state.themes[unit.theme]?.layers[unit.sourceLayer];
    if (!layerState) continue;
    const { visible, opacity } = layerState;
    const id = storeLayerId(unit);
    const existing = store.layers.find((layer) => layer.id === id);
    const last = lastControlValues.get(unitKey(unit));

    // A source layer that has never been shown is not mirrored until it appears.
    if (!visible && !existing) {
      lastControlValues.set(unitKey(unit), { visible, opacity });
      continue;
    }

    const nextLayer = createOvertureStoreLayer(unit, {
      visible,
      opacity,
      release: state.release,
    });

    if (!existing) {
      store.addLayer(nextLayer);
    } else {
      if (shouldUpdateStoreLayer(existing, nextLayer)) {
        store.updateLayer(id, {
          name: nextLayer.name,
          type: nextLayer.type,
          source: nextLayer.source,
          sourcePath: nextLayer.sourcePath,
          metadata: nextLayer.metadata,
        });
      }
      // Push opacity/visibility only when the control changed them, so a value
      // set through the Layers panel is not reverted by an unrelated event.
      if (last && opacity !== last.opacity && opacity !== existing.opacity) {
        store.updateLayer(id, { opacity });
      }
      if (last && visible !== last.visible && visible !== existing.visible) {
        store.updateLayer(id, { visible });
      }
    }
    lastControlValues.set(unitKey(unit), { visible, opacity });
  }
}

/** Pushes Layers-panel edits back into the control (store -> control). */
function reverseSync(control: OvertureMapsControl): void {
  const store = useAppStore.getState();
  const state = control.getState();

  for (const unit of OVERTURE_UNITS) {
    const layerState = state.themes[unit.theme]?.layers[unit.sourceLayer];
    if (!layerState) continue;
    const key = unitKey(unit);
    const storeLayer = store.layers.find(
      (layer) => layer.id === storeLayerId(unit),
    );

    if (!storeLayer) {
      // The entry was removed from the Layers panel: hide the source layer.
      // Source layers we never mirrored (no last value) are left untouched.
      if (lastControlValues.has(key) && layerState.visible) {
        control.setLayerVisible(unit.theme, unit.sourceLayer, false);
      }
      lastControlValues.delete(key);
      continue;
    }

    if (storeLayer.visible !== layerState.visible) {
      control.setLayerVisible(unit.theme, unit.sourceLayer, storeLayer.visible);
    }
    // Forward opacity even while hidden so the value persists for the next
    // time the source layer is shown.
    if (Math.abs(storeLayer.opacity - layerState.opacity) > 1e-6) {
      control.setLayerOpacity(unit.theme, unit.sourceLayer, storeLayer.opacity);
    }
  }
}

function createOvertureStoreLayer(
  unit: OvertureUnit,
  options: { visible: boolean; opacity: number; release: string },
): GeoLibreLayer {
  const sourceId = sourceIdForTheme(unit.theme);
  const tileUrl = options.release
    ? tileUrlForTheme(DEFAULT_TILES_BASE_URL, options.release, unit.theme)
    : undefined;
  return {
    id: storeLayerId(unit),
    name: `Overture ${humanizeSourceLayer(unit.sourceLayer)}`,
    type: "vector-tiles",
    source: {
      type: "vector",
      sourceId,
      ...(tileUrl ? { url: tileUrl } : {}),
    },
    visible: options.visible,
    opacity: options.opacity,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      // The control renders and styles these layers; GeoLibre only tracks and
      // reorders them. customLayerType opts into that control-managed path.
      customLayerType: SOURCE_KIND,
      externalNativeLayer: true,
      identifiable: false,
      nativeLayerIds: layerIdsForSourceLayer(unit.theme, unit.sourceLayer),
      overtureTheme: unit.theme,
      overtureSourceLayer: unit.sourceLayer,
      sourceId,
      sourceIds: [sourceId],
      sourceKind: SOURCE_KIND,
    },
    sourcePath: tileUrl,
  };
}

function shouldUpdateStoreLayer(
  existing: GeoLibreLayer,
  next: GeoLibreLayer,
): boolean {
  return (
    existing.name !== next.name ||
    existing.type !== next.type ||
    existing.sourcePath !== next.sourcePath ||
    stableStringify(existing.source) !== stableStringify(next.source) ||
    stableStringify(existing.metadata) !== stableStringify(next.metadata)
  );
}

// Key-order-insensitive stringify: an existing layer deserialized from a
// project file may carry the same source/metadata with a different key order
// than the factory output, which a plain JSON.stringify would flag as changed.
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

function removeOvertureStoreLayers(): void {
  const store = useAppStore.getState();
  for (const unit of OVERTURE_UNITS) {
    const id = storeLayerId(unit);
    if (store.layers.some((layer) => layer.id === id)) {
      store.removeLayer(id);
    }
  }
}
