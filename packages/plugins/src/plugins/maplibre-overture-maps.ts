import { DEFAULT_LAYER_STYLE, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  DEFAULT_TILES_BASE_URL,
  defaultSizeForGeometry,
  layerIdsForSourceLayer,
  OvertureMapsControl,
  sourceIdForTheme,
  THEME_IDS,
  THEMES,
  tileUrlForTheme,
  type OvertureGeometry,
  type OvertureMapsControlOptions,
  type OvertureMapsEventHandler,
  type OvertureMapsState,
  type OvertureLayerState,
  type OvertureThemeState,
  type OvertureTheme,
} from "maplibre-gl-overture-maps";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition, GeoLibrePlugin } from "../types";

let overturePosition: GeoLibreMapControlPosition = "top-left";

const OVERTURE_OPTIONS = {
  collapsed: false,
  title: "Overture Maps",
  panelWidth: 340,
  inspect: true,
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
let pendingState: OvertureMapsState | null = null;

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
          onExport: (filename, data) => app.exportTextFile?.(filename, JSON.stringify(data)),
        }
      : {}),
  });
  if (pendingState) {
    control.setState(pendingState);
  }
  return control;
}

type OvertureStatePatch = Partial<
  Pick<OvertureMapsState, "collapsed" | "inspect" | "panelWidth" | "release">
> & {
  themes?: Partial<
    Record<
      OvertureTheme,
      Partial<Omit<OvertureThemeState, "layers">> & {
        layers?: Record<string, Partial<OvertureLayerState>>;
      }
    >
  >;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isLayerStatePatch(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (value.visible === undefined || typeof value.visible === "boolean") &&
    (value.opacity === undefined ||
      (typeof value.opacity === "number" && Number.isFinite(value.opacity))) &&
    (value.color === undefined || typeof value.color === "string") &&
    (value.size === undefined || (typeof value.size === "number" && Number.isFinite(value.size)))
  );
}

function isThemeStatePatch(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.expanded !== undefined && typeof value.expanded !== "boolean") return false;
  if (value.layers === undefined) return true;
  if (!isRecord(value.layers)) return false;
  return Object.values(value.layers).every(isLayerStatePatch);
}

function isOvertureMapsState(value: unknown): value is OvertureStatePatch {
  if (!isRecord(value)) return false;
  if (!["collapsed", "inspect", "panelWidth", "release", "themes"].some((key) => key in value)) {
    return false;
  }
  if (value.collapsed !== undefined && typeof value.collapsed !== "boolean") return false;
  if (value.inspect !== undefined && typeof value.inspect !== "boolean") return false;
  if (
    value.panelWidth !== undefined &&
    (typeof value.panelWidth !== "number" || !Number.isFinite(value.panelWidth))
  ) {
    return false;
  }
  if (value.release !== undefined && typeof value.release !== "string") return false;
  if (value.themes === undefined) return true;
  if (!isRecord(value.themes)) return false;
  return Object.values(value.themes).every(isThemeStatePatch);
}

function defaultOvertureState(): OvertureMapsState {
  const visibleThemes = new Set<OvertureTheme>(OVERTURE_OPTIONS.visibleThemes);
  const themes = Object.fromEntries(
    THEME_IDS.map((theme) => [
      theme,
      {
        expanded: false,
        layers: Object.fromEntries(
          THEMES[theme].layers.map((layer) => [
            layer.sourceLayer,
            {
              visible: visibleThemes.has(theme),
              opacity: 0.8,
              color: THEMES[theme].color,
              size: defaultSizeForGeometry(layer.geometry),
            },
          ]),
        ),
      },
    ]),
  ) as OvertureMapsState["themes"];
  return {
    collapsed: OVERTURE_OPTIONS.collapsed,
    panelWidth: OVERTURE_OPTIONS.panelWidth,
    release: "",
    releases: [],
    themes,
    inspect: OVERTURE_OPTIONS.inspect,
    error: null,
  };
}

interface OvertureStateMergeResult {
  state: OvertureMapsState;
  applied: boolean;
}

function mergeOvertureMapsStateWithResult(
  base: OvertureMapsState,
  patch: OvertureStatePatch,
): OvertureStateMergeResult {
  const themes = Object.fromEntries(
    Object.entries(base.themes).map(([theme, state]) => [
      theme,
      {
        ...state,
        layers: Object.fromEntries(
          Object.entries(state.layers).map(([sourceLayer, layer]) => [sourceLayer, { ...layer }]),
        ),
      },
    ]),
  ) as OvertureMapsState["themes"];
  const state: OvertureMapsState = { ...base, themes };
  let applied = false;

  if (patch.collapsed !== undefined && patch.collapsed !== state.collapsed) {
    state.collapsed = patch.collapsed;
    applied = true;
  }
  if (patch.inspect !== undefined && patch.inspect !== state.inspect) {
    state.inspect = patch.inspect;
    applied = true;
  }
  if (patch.panelWidth !== undefined && patch.panelWidth !== state.panelWidth) {
    state.panelWidth = patch.panelWidth;
    applied = true;
  }
  if (patch.release && patch.release !== state.release) {
    state.release = patch.release;
    applied = true;
  }

  for (const [theme, themePatch] of Object.entries(patch.themes ?? {}) as Array<
    [OvertureTheme, NonNullable<OvertureStatePatch["themes"]>[OvertureTheme]]
  >) {
    const currentTheme = state.themes[theme];
    if (!currentTheme || !themePatch) continue;
    if (themePatch.expanded !== undefined && themePatch.expanded !== currentTheme.expanded) {
      currentTheme.expanded = themePatch.expanded;
      applied = true;
    }
    for (const [sourceLayer, layerPatch] of Object.entries(themePatch.layers ?? {})) {
      const layer = currentTheme.layers[sourceLayer];
      if (!layer) continue;
      if (layerPatch.visible !== undefined && layerPatch.visible !== layer.visible) {
        layer.visible = layerPatch.visible;
        applied = true;
      }
      if (layerPatch.opacity !== undefined && layerPatch.opacity !== layer.opacity) {
        layer.opacity = layerPatch.opacity;
        applied = true;
      }
      if (layerPatch.color !== undefined && layerPatch.color !== layer.color) {
        layer.color = layerPatch.color;
        applied = true;
      }
      if (layerPatch.size !== undefined && layerPatch.size !== layer.size) {
        layer.size = layerPatch.size;
        applied = true;
      }
    }
  }

  return { state, applied };
}

/** Deep-merge a partial Overture state patch without dropping other themes. */
export function mergeOvertureMapsState(
  base: OvertureMapsState,
  patch: OvertureStatePatch,
): OvertureMapsState {
  return mergeOvertureMapsStateWithResult(base, patch).state;
}

function applyOvertureMapsState(control: OvertureMapsControl, patch: OvertureStatePatch): boolean {
  const current = control.getState();
  const { state: next, applied } = mergeOvertureMapsStateWithResult(current, patch);
  if (!applied) return false;

  if (next.release !== current.release) {
    control.setRelease(next.release);
  }
  if (patch.inspect !== undefined && next.inspect !== current.inspect) {
    control.setInspect(next.inspect);
  }
  for (const [theme, themePatch] of Object.entries(patch.themes ?? {}) as Array<
    [OvertureTheme, NonNullable<OvertureStatePatch["themes"]>[OvertureTheme]]
  >) {
    if (!themePatch) continue;
    const currentTheme = current.themes[theme];
    const nextTheme = next.themes[theme];
    if (!currentTheme || !nextTheme) continue;
    if (themePatch.expanded !== undefined && nextTheme.expanded !== currentTheme.expanded) {
      control.setThemeExpanded(theme, nextTheme.expanded);
    }
    for (const [sourceLayer, layerPatch] of Object.entries(themePatch.layers ?? {})) {
      const before = currentTheme.layers[sourceLayer];
      const after = nextTheme.layers[sourceLayer];
      if (!before || !after) continue;
      if (layerPatch.visible !== undefined && after.visible !== before.visible) {
        control.setLayerVisible(theme, sourceLayer, after.visible);
      }
      if (layerPatch.opacity !== undefined && after.opacity !== before.opacity) {
        control.setLayerOpacity(theme, sourceLayer, after.opacity);
      }
      if (layerPatch.color !== undefined && after.color !== before.color) {
        control.setLayerColor(theme, sourceLayer, after.color);
      }
      if (layerPatch.size !== undefined && after.size !== before.size) {
        control.setLayerSize(theme, sourceLayer, after.size);
      }
    }
  }
  if (patch.panelWidth !== undefined) {
    control.setState({ panelWidth: next.panelWidth });
  }
  if (patch.collapsed !== undefined && next.collapsed !== current.collapsed) {
    if (next.collapsed) control.collapse();
    else control.expand();
  }
  return true;
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
  setMapControlPosition: (app: GeoLibreAppAPI, position: GeoLibreMapControlPosition) => {
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
  getProjectState: () => overtureControl?.getState() ?? pendingState ?? undefined,
  applyProjectState: (_app: GeoLibreAppAPI, state: unknown) => {
    if (!isOvertureMapsState(state)) return false;
    if (overtureControl) {
      if (!applyOvertureMapsState(overtureControl, state)) return false;
      pendingState = overtureControl.getState();
    } else {
      const { state: next, applied } = mergeOvertureMapsStateWithResult(
        pendingState ?? defaultOvertureState(),
        state,
      );
      if (!applied) return false;
      pendingState = next;
    }
    return true;
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
  geometry: OvertureGeometry;
}

let storeUnsubscribe: (() => void) | null = null;
let controlEventHandler: OvertureMapsEventHandler | null = null;
let syncing = false;
// Last visibility/opacity observed on the control per source layer. Doubles as
// the record of source layers this sync manages, so a panel deletion can be
// told apart from a source layer that was never mirrored.
const lastControlValues = new Map<string, { visible: boolean; opacity: number }>();

const OVERTURE_UNITS: OvertureUnit[] = THEME_IDS.flatMap((theme) =>
  THEMES[theme].layers.map((layer) => ({
    theme,
    sourceLayer: layer.sourceLayer,
    geometry: layer.geometry,
  })),
);

// Numeric Overture schema fields worth extruding by, offered as the Style
// panel's height-attribute options. The tiles carry no field listing, so
// without these the picker has nothing to choose from and the user is stuck on
// the default. Only the buildings theme defines height in the Overture schema.
const BUILDING_HEIGHT_FIELDS: Partial<Record<OvertureTheme, string[]>> = {
  buildings: ["height", "min_height", "num_floors", "min_floor", "roof_height"],
};

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
    const storeLayer = store.layers.find((layer) => layer.id === storeLayerId(unit));

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
      // The control has no extrusion concept, so polygon themes hand 3D
      // extrusion back to GeoLibre's layer sync, which re-renders the control's
      // native fill as a fill-extrusion. Without this the Style panel's 3D mode
      // is offered but never takes effect.
      ...(unit.geometry === "polygon" ? { nativeFillExtrusion: true } : {}),
      ...(BUILDING_HEIGHT_FIELDS[unit.theme] ? { fields: BUILDING_HEIGHT_FIELDS[unit.theme] } : {}),
    },
    sourcePath: tileUrl,
  };
}

function shouldUpdateStoreLayer(existing: GeoLibreLayer, next: GeoLibreLayer): boolean {
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
