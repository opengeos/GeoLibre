import type { Feature, FeatureCollection, Polygon } from "geojson";
import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import { getControlMap } from "./style-map";

/**
 * Shared skeleton of the viewport-driven DGGS grid plugins (S2, H3, A5, OLC,
 * Geohash, Tilecode). Each grid supplies only its cell math — how to fill a
 * bounding box, encode a clicked point, find a cell's parent/neighbors — and
 * this factory owns everything else: the map sources and layers, the
 * moveend/click/basemap wiring, the right-hand settings panel, exports, and
 * the persisted project state.
 *
 * Every id, DOM structure and setting key is derived from the configuration
 * exactly as the hand-written plugins spelled them, so projects saved before
 * the factory existed restore unchanged.
 */

/** Settings every grid persists, in their serialized key order. */
export interface GridSettingsBase {
  /** Derive the resolution from the map zoom instead of the manual control. */
  autoResolution: boolean;
  resolution: number;
  fillColor: string;
  fillOpacity: number;
  lineColor: string;
  lineWidth: number;
  showLabels: boolean;
  includeNeighbors: boolean;
}

/** Panel strings every grid translates (see TopToolbar's `set*Labels` calls). */
export interface GridLabelsBase {
  title: string;
  getTitle?: () => string;
  controlTitle: string;
  autoResolution: string;
  resolution: string;
  cellCount: (count: number) => string;
  tooManyCells: (limit: number) => string;
  fillColor: string;
  fillOpacity: string;
  lineColor: string;
  lineWidth: string;
  showLabels: string;
  identifyHint: string;
  selectedCell: string;
  noSelection: string;
  copyId: string;
  parent: string;
  children: string;
  neighbors: string;
  center: string;
  zoomToCell: string;
  addAsLayer: string;
  exportGeoJson: string;
  exportCsv: string;
  includeNeighbors: string;
}

type BooleanKeys<T> = { [K in keyof T]: T[K] extends boolean ? K : never }[keyof T] & string;

/** How the panel picks a resolution and how persisted values are coerced. */
export type GridResolutionControl =
  /** A contiguous integer range, shown as a slider. */
  | { kind: "range"; min: number; max: number }
  /** A sparse set of valid values, shown as a dropdown. */
  | { kind: "select"; options: readonly number[] };

/** An extra, grid-specific overlay (e.g. H3's icosahedron) drawn under the selection layers. */
export interface GridOverlay<S> {
  /** Layer ids, removed after the parent layer and before the grid layers. */
  layerIds: readonly string[];
  /** Source ids, removed after the parent source and before the grid source. */
  sourceIds: readonly string[];
  /** Add the overlay's sources/layers when missing (right after the grid layers). */
  ensure: (map: MapLibreMap, settings: S) => void;
  /** Re-apply settings-dependent paint/layout after a settings change. */
  apply: (map: MapLibreMap, settings: S) => void;
}

export interface GridPluginConfig<S extends GridSettingsBase, L extends GridLabelsBase> {
  id: string;
  name: string;
  /** Short grid key for DOM/map ids: `geolibre-<slug>-panel`, `geolibre-<slug>-grid-source`, … */
  slug: string;
  /**
   * The selected-cell parent toggle's settings key. Its singular/plural form
   * also names the parent source/layer (`-parent-` vs `-parents-`).
   */
  parentKey: "includeParent" | "includeParents";
  /** Further boolean settings persisted after `parentKey`, in order. */
  extraBooleanKeys?: readonly BooleanKeys<S>[];
  /** Checkbox rows after "Show cell IDs" and the neighbor/parent toggles. */
  extraToggles?: ReadonlyArray<{ key: BooleanKeys<S>; label: (labels: L) => string }>;
  defaultSettings: S;
  defaultLabels: L;
  resolutionControl: GridResolutionControl;
  /** Viewport safety cap shown in the "too many cells" message. */
  viewportCellLimit: number;
  /** The automatic zoom→resolution rule. */
  resolutionForZoom: (zoom: number) => number;
  /** The zoom from which cell-ID labels show for a resolution. */
  labelMinZoom: (resolution: number) => number;
  /** Fill [west, south, east, north] with cells; throws a RangeError past the cap. */
  gridForBounds: (
    bounds: [number, number, number, number],
    resolution: number,
  ) => FeatureCollection<Polygon>;
  /** A cell id as a GeoJSON polygon whose properties include `idProperty`. */
  cellFeature: (cell: string) => Feature<Polygon>;
  /** The cell containing a clicked point. */
  cellAtLngLat: (lng: number, lat: number, resolution: number) => string;
  /** The cell at another resolution under this cell's center (explicit resolution changes). */
  reindexCell: (cell: string, resolution: number) => string;
  /** Edge neighbors, excluding the cell itself. */
  neighborCells: (cell: string) => string[];
  /** The cell's parent(s) at the next coarser resolution (empty at the root). */
  parentCells: (cell: string) => string[];
  /** [west, south, east, north] to fit the camera to, or null when the cell is invalid. */
  cellBounds: (cell: string) => [number, number, number, number] | null;
  /**
   * Detail rows shown between "ID" and the neighbor count for the selected
   * cell; null shows the empty-selection placeholder instead.
   */
  cellDetails: (cell: string, labels: L) => Array<[string, string]> | null;
  /** Feature property holding the cell id (label text). */
  idProperty: string;
  /** CSV export columns, read from feature properties. */
  csvColumns: readonly string[];
  /** Name of the layer "Add grid as layer" creates. */
  layerName: (resolution: number) => string;
  /** Export file name without extension. */
  exportBaseName: (resolution: number) => string;
  overlay?: GridOverlay<S>;
}

export interface GridPlugin<S extends GridSettingsBase, L extends GridLabelsBase> {
  plugin: GeoLibrePlugin;
  setLabels: (next: Partial<L>) => void;
  getSettings: () => S;
  setSettings: (patch: Partial<S>) => void;
  normalizeSettings: (value: unknown) => S;
}

const SELECTED_LINE_WIDTH = 3;

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function color(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
    ? value.toLowerCase()
    : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Snap an arbitrary number to the nearest option (the first wins a tie). */
export function snapToOption<T extends number>(
  value: unknown,
  options: readonly T[],
  fallback: T,
): T {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  let best: T = options[0];
  for (const option of options) {
    if (Math.abs(option - number) < Math.abs(best - number)) best = option;
  }
  return best;
}

/** "lat, lng" with six decimals, as every grid's Center row shows it. */
export function formatCenter(lat: number, lng: number): string {
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

/**
 * The bounding box of an (antimeridian-unwrapped) ring. Unwrapped rings stay
 * contiguous, so min/max longitudes never span the world.
 */
export function ringBounds(ring: [number, number][]): [number, number, number, number] {
  const lons = ring.map(([lng]) => lng);
  const lats = ring.map(([, lat]) => lat);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

const emptyCollection = (): FeatureCollection<Polygon> => ({
  type: "FeatureCollection",
  features: [],
});

/**
 * Build a viewport-driven grid plugin from a grid's cell math. See the module
 * comment for what the factory owns.
 */
export function createGridPlugin<S extends GridSettingsBase, L extends GridLabelsBase>(
  config: GridPluginConfig<S, L>,
): GridPlugin<S, L> {
  const prefix = `geolibre-${config.slug}`;
  const parentSlug = config.parentKey === "includeParents" ? "parents" : "parent";
  const PANEL_ID = `${prefix}-panel`;
  const SOURCE_ID = `${prefix}-grid-source`;
  const FILL_LAYER_ID = `${prefix}-grid-fill`;
  const LINE_LAYER_ID = `${prefix}-grid-line`;
  const LABEL_LAYER_ID = `${prefix}-grid-label`;
  const SELECTED_SOURCE_ID = `${prefix}-selected-source`;
  const SELECTED_FILL_LAYER_ID = `${prefix}-selected-fill`;
  const SELECTED_LINE_LAYER_ID = `${prefix}-selected-line`;
  const NEIGHBORS_SOURCE_ID = `${prefix}-neighbors-source`;
  const NEIGHBORS_FILL_LAYER_ID = `${prefix}-neighbors-fill`;
  const NEIGHBORS_LINE_LAYER_ID = `${prefix}-neighbors-line`;
  const PARENT_SOURCE_ID = `${prefix}-${parentSlug}-source`;
  const PARENT_LINE_LAYER_ID = `${prefix}-${parentSlug}-line`;

  const defaults = config.defaultSettings;
  const booleanKeys: readonly string[] = [config.parentKey, ...(config.extraBooleanKeys ?? [])];

  let labels: L = { ...config.defaultLabels };
  let settings: S = { ...defaults };
  let map: MapLibreMap | null = null;
  let appRef: GeoLibreAppAPI | null = null;
  let unregisterPanel: (() => void) | null = null;
  let moveHandler: (() => void) | null = null;
  let clickHandler: ((event: MapMouseEvent) => void) | null = null;
  let unsubscribeBasemap: (() => void) | null = null;
  let panelContainer: HTMLElement | null = null;
  let selectedCell: string | null = null;
  let currentGrid: FeatureCollection<Polygon> = emptyCollection();
  let currentError: string | null = null;
  let cachedTextFont: string[] | null = null;
  let pendingRefresh: number | null = null;

  const parentEnabled = (): boolean =>
    (settings as unknown as Record<string, boolean>)[config.parentKey];

  /**
   * Coalesce viewport-driven rebuilds. Inertial pans emit `moveend` in bursts,
   * and each rebuild materializes up to the viewport cell limit on the main
   * thread.
   */
  function scheduleRefresh(): void {
    if (pendingRefresh !== null) return;
    pendingRefresh = requestAnimationFrame(() => {
      pendingRefresh = null;
      refresh();
    });
  }

  function cancelScheduledRefresh(): void {
    if (pendingRefresh === null) return;
    cancelAnimationFrame(pendingRefresh);
    pendingRefresh = null;
  }

  /** Reuse a font already present in the active basemap to avoid glyph 404s. */
  function pickTextFont(activeMap: MapLibreMap): string[] {
    if (cachedTextFont) return cachedTextFont;
    let fallback: string[] | null = null;
    for (const layer of activeMap.getStyle()?.layers ?? []) {
      if (layer.id === LABEL_LAYER_ID || layer.type !== "symbol") continue;
      const font = (layer.layout as { "text-font"?: string[] } | undefined)?.["text-font"];
      if (!Array.isArray(font) || font.length === 0) continue;
      if (font.every((name) => !/italic|bold/i.test(name))) return (cachedTextFont = font);
      fallback ??= font;
    }
    return (cachedTextFont = fallback ?? ["Open Sans Regular", "Arial Unicode MS Regular"]);
  }

  function normalizeResolution(value: unknown): number {
    const control = config.resolutionControl;
    return control.kind === "select"
      ? snapToOption(value, control.options, defaults.resolution)
      : Math.round(clampNumber(value, control.min, control.max, defaults.resolution));
  }

  function normalizeSettings(value: unknown): S {
    const candidate = (value ?? {}) as Record<string, unknown>;
    const normalized: Record<string, unknown> = {
      autoResolution: bool(candidate.autoResolution, defaults.autoResolution),
      resolution: normalizeResolution(candidate.resolution),
      fillColor: color(candidate.fillColor, defaults.fillColor),
      fillOpacity: clampNumber(candidate.fillOpacity, 0, 1, defaults.fillOpacity),
      lineColor: color(candidate.lineColor, defaults.lineColor),
      lineWidth: clampNumber(candidate.lineWidth, 0.1, 8, defaults.lineWidth),
      showLabels: bool(candidate.showLabels, defaults.showLabels),
      includeNeighbors: bool(candidate.includeNeighbors, defaults.includeNeighbors),
    };
    for (const key of booleanKeys) {
      normalized[key] = bool(candidate[key], (defaults as unknown as Record<string, boolean>)[key]);
    }
    return normalized as unknown as S;
  }

  /** The resolution actually rendered: zoom-derived when automatic, else manual. */
  function effectiveResolution(): number {
    return settings.autoResolution && map
      ? config.resolutionForZoom(map.getZoom())
      : settings.resolution;
  }

  function setLabels(next: Partial<L>): void {
    labels = { ...labels, ...next };
    if (panelContainer) renderPanel(panelContainer);
  }

  function getSettings(): S {
    return { ...settings };
  }

  function setSettings(patch: Partial<S>): void {
    const previousResolution = effectiveResolution();
    // Leaving automatic mode adopts the current zoom-derived resolution as the
    // fixed one, so the grid stays put instead of jumping to the stale control.
    if (
      settings.autoResolution &&
      patch.autoResolution === false &&
      patch.resolution === undefined
    ) {
      patch = { ...patch, resolution: previousResolution };
    }
    settings = normalizeSettings({ ...settings, ...patch });
    const resolution = effectiveResolution();
    // Re-derive the selection only for an explicit resolution change; toggling
    // automatic resolution (like zooming in automatic mode) keeps the clicked
    // cell and its neighbors/parent as they are.
    if (selectedCell && patch.resolution !== undefined && resolution !== previousResolution) {
      selectedCell = config.reindexCell(selectedCell, resolution);
    }
    // Only the rendered resolution changes the geometry, so a paint/layout-only
    // edit skips rebuilding up to the viewport cell limit.
    if (resolution !== previousResolution) {
      refresh();
    } else {
      applyStyle();
      updateSelectedSource();
    }
    if (panelContainer) renderPanel(panelContainer);
  }

  function removeLayers(activeMap: MapLibreMap): void {
    for (const id of [
      SELECTED_LINE_LAYER_ID,
      SELECTED_FILL_LAYER_ID,
      NEIGHBORS_LINE_LAYER_ID,
      NEIGHBORS_FILL_LAYER_ID,
      PARENT_LINE_LAYER_ID,
      ...(config.overlay?.layerIds ?? []),
      LABEL_LAYER_ID,
      LINE_LAYER_ID,
      FILL_LAYER_ID,
    ]) {
      if (activeMap.getLayer(id)) activeMap.removeLayer(id);
    }
    for (const id of [
      SELECTED_SOURCE_ID,
      NEIGHBORS_SOURCE_ID,
      PARENT_SOURCE_ID,
      ...(config.overlay?.sourceIds ?? []),
      SOURCE_ID,
    ]) {
      if (activeMap.getSource(id)) activeMap.removeSource(id);
    }
  }

  function ensureLayers(): void {
    if (!map) return;
    if (!map.getSource(SOURCE_ID)) {
      map.addSource(SOURCE_ID, { type: "geojson", data: currentGrid });
      map.addLayer({
        id: FILL_LAYER_ID,
        type: "fill",
        source: SOURCE_ID,
        paint: {
          "fill-color": settings.fillColor,
          "fill-opacity": settings.fillOpacity,
        },
      });
      map.addLayer({
        id: LINE_LAYER_ID,
        type: "line",
        source: SOURCE_ID,
        paint: {
          "line-color": settings.lineColor,
          "line-width": settings.lineWidth,
        },
      });
      map.addLayer({
        id: LABEL_LAYER_ID,
        type: "symbol",
        source: SOURCE_ID,
        minzoom: config.labelMinZoom(effectiveResolution()),
        layout: {
          "text-field": ["get", config.idProperty],
          "text-font": pickTextFont(map),
          "text-size": 10,
          visibility: settings.showLabels ? "visible" : "none",
        },
        paint: {
          "text-color": settings.lineColor,
          "text-halo-color": "#ffffff",
          "text-halo-width": 1,
        },
      });
    }
    config.overlay?.ensure(map, settings);
    // Parent and neighbors are added before the selected layers so the clicked
    // cell stays on top of its (larger) parent and neighbor outlines.
    if (!map.getSource(PARENT_SOURCE_ID)) {
      map.addSource(PARENT_SOURCE_ID, { type: "geojson", data: emptyCollection() });
      map.addLayer({
        id: PARENT_LINE_LAYER_ID,
        type: "line",
        source: PARENT_SOURCE_ID,
        paint: {
          "line-color": "#b45309",
          "line-width": SELECTED_LINE_WIDTH * 2,
          "line-dasharray": [2, 2],
        },
      });
    }
    if (!map.getSource(NEIGHBORS_SOURCE_ID)) {
      map.addSource(NEIGHBORS_SOURCE_ID, { type: "geojson", data: emptyCollection() });
      map.addLayer({
        id: NEIGHBORS_FILL_LAYER_ID,
        type: "fill",
        source: NEIGHBORS_SOURCE_ID,
        paint: { "fill-color": "#f59e0b", "fill-opacity": 0.15 },
      });
      map.addLayer({
        id: NEIGHBORS_LINE_LAYER_ID,
        type: "line",
        source: NEIGHBORS_SOURCE_ID,
        paint: {
          "line-color": "#f59e0b",
          "line-width": SELECTED_LINE_WIDTH,
          "line-dasharray": [2, 2],
        },
      });
    }
    if (!map.getSource(SELECTED_SOURCE_ID)) {
      map.addSource(SELECTED_SOURCE_ID, { type: "geojson", data: emptyCollection() });
      map.addLayer({
        id: SELECTED_FILL_LAYER_ID,
        type: "fill",
        source: SELECTED_SOURCE_ID,
        paint: { "fill-color": "#f59e0b", "fill-opacity": 0.25 },
      });
      map.addLayer({
        id: SELECTED_LINE_LAYER_ID,
        type: "line",
        source: SELECTED_SOURCE_ID,
        paint: { "line-color": "#f59e0b", "line-width": SELECTED_LINE_WIDTH },
      });
    }
  }

  function applyStyle(): void {
    if (!map) return;
    ensureLayers();
    map.setPaintProperty(FILL_LAYER_ID, "fill-color", settings.fillColor);
    map.setPaintProperty(FILL_LAYER_ID, "fill-opacity", settings.fillOpacity);
    map.setPaintProperty(LINE_LAYER_ID, "line-color", settings.lineColor);
    map.setPaintProperty(LINE_LAYER_ID, "line-width", settings.lineWidth);
    map.setPaintProperty(LABEL_LAYER_ID, "text-color", settings.lineColor);
    map.setLayoutProperty(LABEL_LAYER_ID, "visibility", settings.showLabels ? "visible" : "none");
    map.setLayerZoomRange(LABEL_LAYER_ID, config.labelMinZoom(effectiveResolution()), 24);
    config.overlay?.apply(map, settings);
  }

  function refresh(): void {
    if (!map) return;
    const resolution = effectiveResolution();
    // The selected cell (and its neighbors/parent) deliberately stays at the
    // resolution it was clicked at: in automatic mode a zoom or pan changes the
    // rendered grid, but re-deriving the selection would silently replace the
    // cell the user identified. Only an explicit settings change re-indexes it
    // (see setSettings).
    try {
      const bounds = map.getBounds();
      currentGrid = config.gridForBounds(
        [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
        resolution,
      );
      currentError = null;
    } catch (error) {
      currentGrid = emptyCollection();
      currentError =
        error instanceof RangeError ? labels.tooManyCells(config.viewportCellLimit) : String(error);
    }
    applyStyle();
    (map.getSource(SOURCE_ID) as GeoJSONSource | undefined)?.setData(currentGrid);
    updateSelectedSource();
    if (panelContainer) renderPanel(panelContainer);
  }

  function updateSelectedSource(): void {
    const toFeatures = (cells: string[]): Feature<Polygon>[] =>
      cells.map((cell) => config.cellFeature(cell));
    (map?.getSource(SELECTED_SOURCE_ID) as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: selectedCell ? toFeatures([selectedCell]) : [],
    });
    (map?.getSource(NEIGHBORS_SOURCE_ID) as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features:
        settings.includeNeighbors && selectedCell
          ? toFeatures(config.neighborCells(selectedCell))
          : [],
    });
    (map?.getSource(PARENT_SOURCE_ID) as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: parentEnabled() && selectedCell ? toFeatures(config.parentCells(selectedCell)) : [],
    });
  }

  function gridCsv(grid: FeatureCollection<Polygon>): string {
    const rows = grid.features.map((feature) => {
      const properties = feature.properties!;
      return config.csvColumns.map((column) => properties[column]).join(",");
    });
    return [config.csvColumns.join(","), ...rows].join("\n");
  }

  function fitSelected(): void {
    if (!selectedCell || !appRef) return;
    const bounds = config.cellBounds(selectedCell);
    if (bounds) appRef.fitBounds?.(bounds);
  }

  function renderPanel(container: HTMLElement): void {
    panelContainer = container;
    container.replaceChildren();
    container.style.font = "13px/1.4 system-ui, sans-serif";

    const section = document.createElement("div");
    section.style.display = "grid";
    section.style.gap = "10px";
    section.style.padding = "12px";
    container.appendChild(section);

    const row = (text: string, input: HTMLElement): void => {
      const label = document.createElement("label");
      label.style.display = "flex";
      label.style.alignItems = "center";
      label.style.justifyContent = "space-between";
      label.style.gap = "12px";
      const span = document.createElement("span");
      span.textContent = text;
      label.append(span, input);
      section.appendChild(label);
    };
    const button = (text: string, action: () => void, disabled = false): HTMLButtonElement => {
      const element = document.createElement("button");
      element.type = "button";
      element.textContent = text;
      element.disabled = disabled;
      element.style.padding = "6px 8px";
      element.style.border = "1px solid hsl(var(--border))";
      element.style.borderRadius = "6px";
      element.style.background = "hsl(var(--background))";
      element.style.color = "inherit";
      element.style.cursor = disabled ? "not-allowed" : "pointer";
      element.style.opacity = disabled ? "0.5" : "1";
      element.style.transition = "background-color 120ms ease, border-color 120ms ease";
      element.addEventListener("mouseenter", () => {
        if (!element.disabled) element.style.background = "hsl(var(--muted))";
      });
      element.addEventListener("mouseleave", () => {
        element.style.background = "hsl(var(--background))";
      });
      element.addEventListener("click", action);
      return element;
    };
    const update = (patch: Record<string, unknown>): void => setSettings(patch as Partial<S>);

    const autoResolution = document.createElement("input");
    autoResolution.type = "checkbox";
    autoResolution.checked = settings.autoResolution;
    autoResolution.addEventListener("change", () =>
      update({ autoResolution: autoResolution.checked }),
    );
    row(labels.autoResolution, autoResolution);

    // In automatic mode the resolution control becomes a read-only indicator
    // of the zoom-derived resolution; refresh() re-renders the panel on every
    // moveend, so it tracks zoom gestures.
    const shownResolution = effectiveResolution();
    const control = config.resolutionControl;
    if (control.kind === "select") {
      // Valid values are not contiguous (OLC: …8, 10, 11…), so a dropdown
      // replaces the range slider.
      const resolutionSelect = document.createElement("select");
      for (const value of control.options) {
        const option = document.createElement("option");
        option.value = String(value);
        option.textContent = String(value);
        resolutionSelect.appendChild(option);
      }
      resolutionSelect.value = String(shownResolution);
      resolutionSelect.disabled = settings.autoResolution;
      resolutionSelect.style.padding = "4px 6px";
      resolutionSelect.style.border = "1px solid hsl(var(--border))";
      resolutionSelect.style.borderRadius = "6px";
      resolutionSelect.style.background = "hsl(var(--background))";
      resolutionSelect.style.color = "inherit";
      resolutionSelect.style.opacity = settings.autoResolution ? "0.6" : "1";
      resolutionSelect.addEventListener("change", () =>
        update({ resolution: Number(resolutionSelect.value) }),
      );
      row(labels.resolution, resolutionSelect);
    } else {
      const resolution = document.createElement("input");
      resolution.type = "range";
      resolution.min = String(control.min);
      resolution.max = String(control.max);
      resolution.value = String(shownResolution);
      resolution.title = String(shownResolution);
      resolution.disabled = settings.autoResolution;
      resolution.addEventListener("input", () => {
        resolution.title = resolution.value;
      });
      resolution.addEventListener("change", () => update({ resolution: Number(resolution.value) }));
      const resolutionWrap = document.createElement("span");
      resolutionWrap.style.display = "flex";
      resolutionWrap.style.alignItems = "center";
      resolutionWrap.style.gap = "6px";
      resolutionWrap.style.opacity = settings.autoResolution ? "0.6" : "1";
      const resolutionValue = document.createElement("strong");
      resolutionValue.textContent = String(shownResolution);
      resolution.addEventListener("input", () => {
        resolutionValue.textContent = resolution.value;
      });
      resolutionWrap.append(resolution, resolutionValue);
      row(labels.resolution, resolutionWrap);
    }

    for (const [text, key] of [
      [labels.fillColor, "fillColor"],
      [labels.lineColor, "lineColor"],
    ] as const) {
      const input = document.createElement("input");
      input.type = "color";
      input.value = settings[key];
      // `change` (not `input`): setSettings re-renders the panel, which would
      // destroy the picker mid-drag.
      input.addEventListener("change", () => update({ [key]: input.value }));
      row(text, input);
    }
    for (const [text, key, min, max, step] of [
      [labels.fillOpacity, "fillOpacity", 0, 1, 0.05],
      [labels.lineWidth, "lineWidth", 0.1, 8, 0.1],
    ] as const) {
      const input = document.createElement("input");
      input.type = "number";
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(settings[key]);
      input.style.width = "72px";
      input.addEventListener("change", () => update({ [key]: Number(input.value) }));
      row(text, input);
    }
    const labelsByKey = labels as unknown as Record<string, string>;
    for (const [text, key] of [
      [labels.showLabels, "showLabels"],
      [labels.includeNeighbors, "includeNeighbors"],
      [labelsByKey[config.parentKey], config.parentKey],
      ...(config.extraToggles ?? []).map(({ key, label }) => [label(labels), key] as const),
    ] as const) {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = (settings as unknown as Record<string, boolean>)[key];
      input.addEventListener("change", () => update({ [key]: input.checked }));
      row(text, input);
    }

    const status = document.createElement("div");
    status.textContent = currentError ?? labels.cellCount(currentGrid.features.length);
    status.style.color = currentError ? "#dc2626" : "";
    section.appendChild(status);

    const hint = document.createElement("div");
    hint.textContent = labels.identifyHint;
    hint.style.color = "var(--muted-foreground, #6b7280)";
    section.appendChild(hint);

    const selectedHeading = document.createElement("strong");
    selectedHeading.textContent = labels.selectedCell;
    section.appendChild(selectedHeading);

    const detailRows = selectedCell ? config.cellDetails(selectedCell, labels) : null;
    if (selectedCell && detailRows) {
      const details = document.createElement("dl");
      details.style.margin = "0";
      details.style.display = "grid";
      details.style.gridTemplateColumns = "auto 1fr";
      details.style.gap = "4px 10px";
      const addDetail = (term: string, value: string): void => {
        const dt = document.createElement("dt");
        dt.textContent = term;
        dt.style.color = "var(--muted-foreground, #6b7280)";
        const dd = document.createElement("dd");
        dd.textContent = value;
        dd.style.margin = "0";
        dd.style.overflowWrap = "anywhere";
        details.append(dt, dd);
      };
      addDetail("ID", selectedCell);
      for (const [term, value] of detailRows) addDetail(term, value);
      addDetail(labels.neighbors, String(config.neighborCells(selectedCell).length));
      section.appendChild(details);
    } else {
      const empty = document.createElement("div");
      empty.textContent = labels.noSelection;
      empty.style.color = "var(--muted-foreground, #6b7280)";
      section.appendChild(empty);
    }

    const actions = document.createElement("div");
    actions.style.display = "grid";
    actions.style.gridTemplateColumns = "1fr 1fr";
    actions.style.gap = "6px";
    const noCells = currentGrid.features.length === 0;
    actions.append(
      button(
        labels.copyId,
        () => {
          if (selectedCell) void navigator.clipboard?.writeText(selectedCell);
        },
        !selectedCell,
      ),
      button(labels.zoomToCell, fitSelected, !selectedCell),
      button(
        labels.addAsLayer,
        () => {
          if (currentGrid.features.length) {
            appRef?.addGeoJsonLayer(config.layerName(effectiveResolution()), currentGrid);
          }
        },
        noCells,
      ),
      button(
        labels.exportGeoJson,
        () => {
          appRef?.exportTextFile?.(
            `${config.exportBaseName(effectiveResolution())}.geojson`,
            JSON.stringify(currentGrid, null, 2),
            {
              description: "GeoJSON",
              extensions: ["geojson"],
              mimeType: "application/geo+json",
              promptName: true,
            },
          );
        },
        noCells,
      ),
      button(
        labels.exportCsv,
        () => {
          appRef?.exportTextFile?.(
            `${config.exportBaseName(effectiveResolution())}.csv`,
            gridCsv(currentGrid),
            {
              description: "CSV",
              extensions: ["csv"],
              mimeType: "text/csv",
              promptName: true,
            },
          );
        },
        noCells,
      ),
    );
    section.appendChild(actions);
  }

  function settingsEqual(a: S, b: S): boolean {
    return Object.keys(a).every((key) => a[key as keyof S] === b[key as keyof S]);
  }

  const plugin: GeoLibrePlugin = {
    id: config.id,
    name: config.name,
    version: "1.0.0",
    // Draws the grid through the Style Spec surface both 2D engines share
    // (GeoJSON sources, fill/line/symbol layers, camera and pointer events),
    // read through getControlMap so the Mapbox renderer hosts it as well. On
    // ArcGIS the host draws the same GeoJSON layers as its own graphics.
    engines: ["maplibre", "mapbox", "arcgis"],
    activate: (app) => {
      const activeMap = getControlMap(app);
      if (!activeMap) return false;
      map = activeMap;
      appRef = app;
      moveHandler = () => scheduleRefresh();
      clickHandler = (event) => {
        selectedCell = config.cellAtLngLat(
          event.lngLat.lng,
          event.lngLat.lat,
          effectiveResolution(),
        );
        updateSelectedSource();
        if (panelContainer) renderPanel(panelContainer);
      };
      activeMap.on("moveend", moveHandler);
      activeMap.on("click", clickHandler);
      unsubscribeBasemap = app.onBasemapChange(() => {
        cachedTextFont = null;
        activeMap.once("idle", refresh);
      });
      unregisterPanel =
        app.registerRightPanel?.({
          id: PANEL_ID,
          title: () => labels.getTitle?.() ?? labels.title,
          dock: "right-of-style",
          defaultWidth: 340,
          render: (container) => renderPanel(container),
          // Closing the panel ends the identify session: drop the clicked cell
          // and, with it, the neighbor/parent overlays derived from it.
          onClose: () => {
            selectedCell = null;
            updateSelectedSource();
            if (panelContainer) renderPanel(panelContainer);
          },
        }) ?? null;
      refresh();
      app.openRightPanel?.(PANEL_ID);
    },
    deactivate: (app) => {
      cancelScheduledRefresh();
      if (map && moveHandler) map.off("moveend", moveHandler);
      if (map && clickHandler) map.off("click", clickHandler);
      unsubscribeBasemap?.();
      unregisterPanel?.();
      // A renderer swap deactivates this plugin after the old map was removed;
      // a removed mapbox-gl map throws from getLayer (its style is gone), and
      // there is nothing left to remove.
      try {
        if (map) removeLayers(map);
      } catch {
        // Already torn down with the map.
      }
      moveHandler = null;
      clickHandler = null;
      unsubscribeBasemap = null;
      unregisterPanel = null;
      panelContainer = null;
      selectedCell = null;
      currentGrid = emptyCollection();
      currentError = null;
      cachedTextFont = null;
      map = null;
      appRef = null;
      app.closeRightPanel?.(PANEL_ID);
    },
    getProjectState: () => (settingsEqual(settings, defaults) ? undefined : { ...settings }),
    applyProjectState: (_app, state) => {
      const next = normalizeSettings(state);
      if (settingsEqual(settings, next)) return false;
      settings = next;
      refresh();
    },
  };

  return { plugin, setLabels, getSettings, setSettings, normalizeSettings };
}
