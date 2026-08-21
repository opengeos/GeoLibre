/**
 * Print Layout composer settings that belong to a project.
 *
 * The Print Layout dialog composes a printable page out of the current map:
 * a title block, page size and orientation, the cartographic furniture
 * (legend, scale bar, north arrow), optional data blocks, and an atlas /
 * map-series definition. All of that describes the *project's* map document,
 * so it round-trips through `.geolibre.json` (GeoLibre discussion #1992 —
 * before this, reopening a project lost the title, page format and
 * orientation, and the dialog kept showing the previous project's settings).
 *
 * Deliberately **not** in here: everything that is per-session rather than
 * part of the document — the captured map image, export progress, error and
 * clipboard notices, the current atlas page, and the dialog's own chrome
 * (panel widths, dialog size).
 *
 * The unions below are the storage contract. Their app-side counterparts
 * (`PaperSizeId`, `Orientation`, `BodyCorner`, ... in
 * `apps/geolibre-desktop/src/lib/`) are checked against these by ordinary
 * assignment in the dialog's snapshot/restore paths, so adding a paper size or
 * a corner on one side without the other fails the build.
 */

import { removedLayerIdSet } from "./layer-ref-scrub";

/** A page corner an overlay block can be pinned to. */
export type PrintLayoutCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** Which features a data block covers when the atlas paginates the map. */
export type PrintLayoutPageFilter = "all" | "contained" | "intersecting";

/** One hand-authored swatch in the composer's user-defined legend. */
export interface PrintLayoutLegendEntry {
  id: string;
  label: string;
  color: string;
}

export interface PrintLayoutConfig {
  // Title block
  title: string;
  subtitle: string;
  titlePlacement: "outside" | "inside";
  titleAlign: "left" | "center" | "right";

  // Page
  paperSize:
    | "a4"
    | "a3"
    | "letter"
    | "legal"
    | "tabloid"
    | "fullhd"
    | "hd"
    | "uhd4k"
    | "square"
    | "custom";
  orientation: "portrait" | "landscape";
  customWidth: number;
  customHeight: number;
  customUnit: "mm" | "px";
  pageMargin: "normal" | "narrow" | "none";
  showPageBorder: boolean;
  pageBorderColor: string;
  pageBorderWidth: number;

  // Map frame
  mapBorderColor: string;
  mapBorderWidth: number;
  mapBackground: string;

  // Map elements
  showTitle: boolean;
  showSubtitle: boolean;
  showLegend: boolean;
  showScaleBar: boolean;
  showNorthArrow: boolean;
  navigationGrouped: boolean;
  showFooter: boolean;
  footerText: string;
  showDate: boolean;
  /** Blank means "today", resolved when the page is drawn. */
  dateText: string;
  showAttribution: boolean;

  // Colorbar
  showColorbar: boolean;
  colorbarRamp: string;
  /** Kept as typed text so a half-entered value survives a round trip. */
  colorbarMin: string;
  colorbarMax: string;
  colorbarLabel: string;
  colorbarOrientation: "vertical" | "horizontal";
  colorbarLength: number;
  colorbarPosition: PrintLayoutCorner;

  // User-defined legend
  showCustomLegend: boolean;
  customLegendTitle: string;
  customLegendEntries: PrintLayoutLegendEntry[];
  customLegendPosition: PrintLayoutCorner;

  // Attribute-table block
  showDataTable: boolean;
  tableLayerId: string;
  tableTitle: string;
  tableColumns: string[];
  tableSortField: string;
  tableSortDesc: boolean;
  tableMaxRows: number;
  tableFitRows: boolean;
  tablePosition: PrintLayoutCorner;
  tablePageFilter: PrintLayoutPageFilter;
  tableFilterToAtlasFeature: boolean;

  // Chart block
  showDataChart: boolean;
  chartLayerId: string;
  chartTitle: string;
  chartType: "bar" | "pie" | "line";
  chartCategoryField: string;
  chartAggregation: "count" | "sum" | "mean";
  chartValueField: string;
  chartPosition: PrintLayoutCorner;
  chartPageFilter: PrintLayoutPageFilter;

  // Info block ("title block" / cartouche)
  showInfoBlock: boolean;
  author: string;
  projectNumber: string;
  crs: string;
  revision: string;

  // What the page captures
  captureMode: "viewport" | "extent";
  /** Drawn print extent as `[west, south, east, north]`; null when unset. */
  extentBbox: [number, number, number, number] | null;

  // Atlas / map series
  atlasEnabled: boolean;
  atlasLayerId: string;
  atlasCoverage: "features" | "line";
  atlasSegmentKm: string;
  atlasNameField: string;
  atlasExtentMode: "margin" | "scale";
  atlasMarginPct: number;
  atlasMaskEnabled: boolean;
  atlasScale: string;
  atlasSortField: string;
  atlasSortDescending: boolean;
  atlasFilter: string;
  atlasFilenamePattern: string;
}

const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
const PAGE_FILTERS = ["all", "contained", "intersecting"] as const;

/**
 * Settings a project starts with, and the shape every partial or hand-edited
 * `printLayout` is filled out against. Also the dialog's initial state, so
 * "new project" and "a project saved before this feature" compose identically.
 */
export const DEFAULT_PRINT_LAYOUT: PrintLayoutConfig = {
  title: "",
  subtitle: "",
  titlePlacement: "outside",
  titleAlign: "center",

  paperSize: "a4",
  orientation: "landscape",
  customWidth: 1280,
  customHeight: 720,
  customUnit: "px",
  pageMargin: "normal",
  showPageBorder: false,
  pageBorderColor: "#111827",
  pageBorderWidth: 2,

  mapBorderColor: "#9ca3af",
  mapBorderWidth: 1,
  mapBackground: "#e5e7eb",

  showTitle: true,
  showSubtitle: true,
  showLegend: true,
  showScaleBar: true,
  showNorthArrow: true,
  navigationGrouped: true,
  showFooter: false,
  footerText: "",
  showDate: true,
  dateText: "",
  showAttribution: true,

  showColorbar: false,
  colorbarRamp: "viridis",
  colorbarMin: "0",
  colorbarMax: "100",
  colorbarLabel: "",
  colorbarOrientation: "vertical",
  colorbarLength: 34,
  colorbarPosition: "top-right",

  showCustomLegend: false,
  customLegendTitle: "Legend",
  customLegendEntries: [
    { id: "cl-1", label: "Class 1", color: "#2563eb" },
    { id: "cl-2", label: "Class 2", color: "#16a34a" },
  ],
  customLegendPosition: "top-left",

  showDataTable: false,
  tableLayerId: "",
  tableTitle: "",
  tableColumns: [],
  tableSortField: "",
  tableSortDesc: false,
  tableMaxRows: 10,
  tableFitRows: false,
  tablePosition: "bottom-left",
  tablePageFilter: "contained",
  tableFilterToAtlasFeature: false,

  showDataChart: false,
  chartLayerId: "",
  chartTitle: "",
  chartType: "bar",
  chartCategoryField: "",
  chartAggregation: "count",
  chartValueField: "",
  chartPosition: "top-right",
  chartPageFilter: "contained",

  showInfoBlock: false,
  author: "",
  projectNumber: "",
  crs: "",
  revision: "",

  captureMode: "viewport",
  extentBbox: null,

  atlasEnabled: false,
  atlasLayerId: "",
  atlasCoverage: "features",
  atlasSegmentKm: "20",
  atlasNameField: "",
  atlasExtentMode: "margin",
  atlasMarginPct: 10,
  atlasMaskEnabled: false,
  atlasScale: "50000",
  atlasSortField: "",
  atlasSortDescending: false,
  atlasFilter: "",
  atlasFilenamePattern: "{atlas.pagenumber}-{atlas.name}",
};

/** A fresh copy of the defaults, safe to hand to a store or a component. */
export function createDefaultPrintLayout(): PrintLayoutConfig {
  return {
    ...DEFAULT_PRINT_LAYOUT,
    tableColumns: [],
    customLegendEntries: DEFAULT_PRINT_LAYOUT.customLegendEntries.map((entry) => ({ ...entry })),
  };
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function stringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string");
}

function legendEntries(
  value: unknown,
  fallback: PrintLayoutLegendEntry[],
): PrintLayoutLegendEntry[] {
  if (!Array.isArray(value)) return fallback.map((entry) => ({ ...entry }));
  const entries: PrintLayoutLegendEntry[] = [];
  // The editor keys its swatch rows by id, so two entries sharing one would
  // make an edit to either apply to both. A hand-edited file can omit an id or
  // repeat one, so ids are made unique here rather than trusted.
  const used = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Partial<PrintLayoutLegendEntry>;
    const given = typeof entry.id === "string" ? entry.id.trim() : "";
    let id = given;
    if (!id || used.has(id)) {
      // Synthesize past whatever is already taken, including ids claimed later
      // in the array, so the fallback cannot collide with an explicit one.
      let candidate = index + 1;
      while (used.has(`cl-${candidate}`) || claimsId(value, index, `cl-${candidate}`)) {
        candidate += 1;
      }
      id = `cl-${candidate}`;
    }
    used.add(id);
    entries.push({
      id,
      label: str(entry.label, ""),
      color: str(entry.color, "#2563eb"),
    });
  }
  return entries;
}

/** Whether any entry after `index` explicitly carries `id`. */
function claimsId(value: unknown[], index: number, id: string): boolean {
  for (let i = index + 1; i < value.length; i += 1) {
    const item = value[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const candidate = (item as Partial<PrintLayoutLegendEntry>).id;
    if (typeof candidate === "string" && candidate.trim() === id) return true;
  }
  return false;
}

function extent(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  if (!value.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const [west, south, east, north] = value as number[];
  // The draw tool orders its corners, so an inverted or zero-area box only
  // reaches here from a hand-edited file; capturing it would produce an empty
  // image, so treat it as unset (mirrors `normalizeBounds` in project.ts).
  if (west >= east || south >= north) return null;
  return [west, south, east, north];
}

/**
 * Coerce an untrusted (possibly hand-edited, possibly partial) `printLayout`
 * into a complete {@link PrintLayoutConfig}, filling every missing or
 * malformed field from {@link DEFAULT_PRINT_LAYOUT}.
 *
 * @param value - The raw `printLayout` value read from a project file.
 * @returns The normalized config, or null when the project carries none, so
 *   callers can tell "absent" from "explicitly default".
 */
export function normalizePrintLayoutConfig(value: unknown): PrintLayoutConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const d = DEFAULT_PRINT_LAYOUT;
  return {
    title: str(raw.title, d.title),
    subtitle: str(raw.subtitle, d.subtitle),
    titlePlacement: oneOf(raw.titlePlacement, ["outside", "inside"] as const, d.titlePlacement),
    titleAlign: oneOf(raw.titleAlign, ["left", "center", "right"] as const, d.titleAlign),

    paperSize: oneOf(
      raw.paperSize,
      ["a4", "a3", "letter", "legal", "tabloid", "fullhd", "hd", "uhd4k", "square", "custom"],
      d.paperSize,
    ),
    orientation: oneOf(raw.orientation, ["portrait", "landscape"] as const, d.orientation),
    customWidth: num(raw.customWidth, d.customWidth, 1, 100000),
    customHeight: num(raw.customHeight, d.customHeight, 1, 100000),
    customUnit: oneOf(raw.customUnit, ["mm", "px"] as const, d.customUnit),
    pageMargin: oneOf(raw.pageMargin, ["normal", "narrow", "none"] as const, d.pageMargin),
    showPageBorder: bool(raw.showPageBorder, d.showPageBorder),
    pageBorderColor: str(raw.pageBorderColor, d.pageBorderColor),
    // A page border is drawn only when `showPageBorder` is on, so a zero width
    // would be an invisible "visible" border; the editor's own floor is 1.
    pageBorderWidth: num(raw.pageBorderWidth, d.pageBorderWidth, 1, 20),

    mapBorderColor: str(raw.mapBorderColor, d.mapBorderColor),
    mapBorderWidth: num(raw.mapBorderWidth, d.mapBorderWidth, 0, 10),
    mapBackground: str(raw.mapBackground, d.mapBackground),

    showTitle: bool(raw.showTitle, d.showTitle),
    showSubtitle: bool(raw.showSubtitle, d.showSubtitle),
    showLegend: bool(raw.showLegend, d.showLegend),
    showScaleBar: bool(raw.showScaleBar, d.showScaleBar),
    showNorthArrow: bool(raw.showNorthArrow, d.showNorthArrow),
    navigationGrouped: bool(raw.navigationGrouped, d.navigationGrouped),
    showFooter: bool(raw.showFooter, d.showFooter),
    footerText: str(raw.footerText, d.footerText),
    showDate: bool(raw.showDate, d.showDate),
    dateText: str(raw.dateText, d.dateText),
    showAttribution: bool(raw.showAttribution, d.showAttribution),

    showColorbar: bool(raw.showColorbar, d.showColorbar),
    colorbarRamp: str(raw.colorbarRamp, d.colorbarRamp),
    colorbarMin: str(raw.colorbarMin, d.colorbarMin),
    colorbarMax: str(raw.colorbarMax, d.colorbarMax),
    colorbarLabel: str(raw.colorbarLabel, d.colorbarLabel),
    colorbarOrientation: oneOf(
      raw.colorbarOrientation,
      ["vertical", "horizontal"] as const,
      d.colorbarOrientation,
    ),
    colorbarLength: num(raw.colorbarLength, d.colorbarLength, 1, 100),
    colorbarPosition: oneOf(raw.colorbarPosition, CORNERS, d.colorbarPosition),

    showCustomLegend: bool(raw.showCustomLegend, d.showCustomLegend),
    customLegendTitle: str(raw.customLegendTitle, d.customLegendTitle),
    customLegendEntries: legendEntries(raw.customLegendEntries, d.customLegendEntries),
    customLegendPosition: oneOf(raw.customLegendPosition, CORNERS, d.customLegendPosition),

    showDataTable: bool(raw.showDataTable, d.showDataTable),
    tableLayerId: str(raw.tableLayerId, d.tableLayerId),
    tableTitle: str(raw.tableTitle, d.tableTitle),
    tableColumns: stringList(raw.tableColumns, d.tableColumns),
    tableSortField: str(raw.tableSortField, d.tableSortField),
    tableSortDesc: bool(raw.tableSortDesc, d.tableSortDesc),
    tableMaxRows: num(raw.tableMaxRows, d.tableMaxRows, 1, 10000),
    tableFitRows: bool(raw.tableFitRows, d.tableFitRows),
    tablePosition: oneOf(raw.tablePosition, CORNERS, d.tablePosition),
    tablePageFilter: oneOf(raw.tablePageFilter, PAGE_FILTERS, d.tablePageFilter),
    tableFilterToAtlasFeature: bool(raw.tableFilterToAtlasFeature, d.tableFilterToAtlasFeature),

    showDataChart: bool(raw.showDataChart, d.showDataChart),
    chartLayerId: str(raw.chartLayerId, d.chartLayerId),
    chartTitle: str(raw.chartTitle, d.chartTitle),
    chartType: oneOf(raw.chartType, ["bar", "pie", "line"] as const, d.chartType),
    chartCategoryField: str(raw.chartCategoryField, d.chartCategoryField),
    chartAggregation: oneOf(
      raw.chartAggregation,
      ["count", "sum", "mean"] as const,
      d.chartAggregation,
    ),
    chartValueField: str(raw.chartValueField, d.chartValueField),
    chartPosition: oneOf(raw.chartPosition, CORNERS, d.chartPosition),
    chartPageFilter: oneOf(raw.chartPageFilter, PAGE_FILTERS, d.chartPageFilter),

    showInfoBlock: bool(raw.showInfoBlock, d.showInfoBlock),
    author: str(raw.author, d.author),
    projectNumber: str(raw.projectNumber, d.projectNumber),
    crs: str(raw.crs, d.crs),
    revision: str(raw.revision, d.revision),

    captureMode: oneOf(raw.captureMode, ["viewport", "extent"] as const, d.captureMode),
    extentBbox: extent(raw.extentBbox),

    atlasEnabled: bool(raw.atlasEnabled, d.atlasEnabled),
    atlasLayerId: str(raw.atlasLayerId, d.atlasLayerId),
    atlasCoverage: oneOf(raw.atlasCoverage, ["features", "line"] as const, d.atlasCoverage),
    atlasSegmentKm: str(raw.atlasSegmentKm, d.atlasSegmentKm),
    atlasNameField: str(raw.atlasNameField, d.atlasNameField),
    atlasExtentMode: oneOf(raw.atlasExtentMode, ["margin", "scale"] as const, d.atlasExtentMode),
    atlasMarginPct: num(raw.atlasMarginPct, d.atlasMarginPct, 0, 100),
    atlasMaskEnabled: bool(raw.atlasMaskEnabled, d.atlasMaskEnabled),
    atlasScale: str(raw.atlasScale, d.atlasScale),
    atlasSortField: str(raw.atlasSortField, d.atlasSortField),
    atlasSortDescending: bool(raw.atlasSortDescending, d.atlasSortDescending),
    atlasFilter: str(raw.atlasFilter, d.atlasFilter),
    atlasFilenamePattern: str(raw.atlasFilenamePattern, d.atlasFilenamePattern),
  };
}

/**
 * Whether a config is still the untouched default, so a project that never
 * opened the composer serializes without a `printLayout` key and stays
 * byte-identical to one saved before this feature.
 */
export function isDefaultPrintLayout(config: PrintLayoutConfig): boolean {
  return printLayoutConfigsEqual(config, DEFAULT_PRINT_LAYOUT);
}

/**
 * Structural equality for two configs. Used to skip no-op store writes, so
 * merely opening the Print Layout dialog never marks a project dirty.
 */
export function printLayoutConfigsEqual(a: PrintLayoutConfig, b: PrintLayoutConfig): boolean {
  if (a === b) return true;
  for (const key of Object.keys(DEFAULT_PRINT_LAYOUT) as (keyof PrintLayoutConfig)[]) {
    const left = a[key];
    const right = b[key];
    if (Array.isArray(left) || Array.isArray(right)) {
      if (JSON.stringify(left) !== JSON.stringify(right)) return false;
    } else if (left !== right) {
      return false;
    }
  }
  return true;
}

/**
 * Clear each data/atlas block whose layer `missing` rejects. Shared by the two
 * entry points below, which differ only in how they decide what is gone.
 *
 * @returns The same object when every block's layer survives.
 */
function clearBlocksForMissingLayers(
  config: PrintLayoutConfig,
  missing: (layerId: string) => boolean,
): PrintLayoutConfig {
  const gone = (id: string) => id !== "" && missing(id);
  if (!gone(config.tableLayerId) && !gone(config.chartLayerId) && !gone(config.atlasLayerId)) {
    return config;
  }
  return {
    ...config,
    ...(gone(config.tableLayerId) ? { tableLayerId: "", showDataTable: false } : {}),
    ...(gone(config.chartLayerId) ? { chartLayerId: "", showDataChart: false } : {}),
    ...(gone(config.atlasLayerId) ? { atlasLayerId: "", atlasEnabled: false } : {}),
  };
}

/**
 * Drop references to layers the project no longer carries, so a composer that
 * pointed at a since-deleted layer opens with the block cleared instead of
 * rendering nothing from a dangling id. Mirrors the widget/comment/legend
 * scrubbing in `applyProjectToStore`.
 *
 * @param config - The config to scrub.
 * @param existingLayerIds - Ids of the layers present in the project.
 * @returns The same object when nothing referenced a missing layer.
 */
export function scrubPrintLayoutForLayers(
  config: PrintLayoutConfig,
  existingLayerIds: ReadonlySet<string>,
): PrintLayoutConfig {
  return clearBlocksForMissingLayers(config, (id) => !existingLayerIds.has(id));
}

/**
 * The delete-time counterpart, matching `scrubLegendForRemovedLayers` and its
 * siblings: called when layers are removed from the open project so the saved
 * file never carries a block pointing at a layer that is already gone.
 *
 * @param config - The config to scrub.
 * @param layerIds - The removed layer id, or ids.
 * @returns The same object when no block referenced a removed layer.
 */
export function scrubPrintLayoutForRemovedLayers(
  config: PrintLayoutConfig,
  layerIds: string | Iterable<string>,
): PrintLayoutConfig {
  const removed = removedLayerIdSet(layerIds);
  if (removed.size === 0) return config;
  return clearBlocksForMissingLayers(config, (id) => removed.has(id));
}
