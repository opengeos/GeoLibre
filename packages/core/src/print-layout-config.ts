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

/** A furniture element the user can drag and resize on the layout canvas. */
export type PrintLayoutMovableElement = "title" | "legend" | "scaleBar" | "northArrow" | "footer";

/** Every {@link PrintLayoutMovableElement}, for validation. */
export const PRINT_LAYOUT_MOVABLE_ELEMENTS: readonly PrintLayoutMovableElement[] = [
  "title",
  "legend",
  "scaleBar",
  "northArrow",
  "footer",
];

/**
 * How far a furniture element was moved from its automatic position: `dx` /
 * `dy` as fractions of the page width / height, and a uniform `scale` about
 * the element's anchor. Resolution independent, so the preview and every
 * export DPI agree.
 */
export interface PrintLayoutElementOffset {
  dx: number;
  dy: number;
  scale: number;
}

/** A map frame placed on the page: position and size as page fractions. */
export interface PrintLayoutFrameBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How the map-frame coordinate grid labels its ticks. */
export type PrintLayoutGridType = "dms" | "decimal" | "utm" | "mgrs";

/** Basemaps the overview / inset map can draw. */
export const PRINT_LAYOUT_INSET_BASEMAPS = [
  "positron",
  "liberty",
  "bright",
  "dark",
  "fiord",
  "osm",
] as const;
export type PrintLayoutInsetBasemap = (typeof PRINT_LAYOUT_INSET_BASEMAPS)[number];

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
  /** Colour of the page around the map: title block, footer row and margins. */
  pageBackground: string;
  /** Look of the panels over the map: white or dark. */
  panelTheme: "light" | "dark";
  showPageBorder: boolean;
  pageBorderColor: string;
  pageBorderWidth: number;
  /**
   * Resolution PNG and PDF exports rasterize a paper page at. Screen-sized
   * pages are exact pixels and ignore it.
   */
  exportDpi: PrintLayoutExportDpi;

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

  // Overview / inset locator map
  showInset: boolean;
  insetBasemap: PrintLayoutInsetBasemap;
  /** Zoom levels the inset sits out from the main frame's fitted zoom (<= 0). */
  insetZoomOffset: number;
  /** Colour of the main frame's extent rectangle drawn on the inset. */
  insetExtentColor: string;
  /** Where the inset sits on the page; null keeps its automatic corner. */
  insetBox: PrintLayoutFrameBox | null;

  // Map-frame coordinate grid
  showGrid: boolean;
  gridType: PrintLayoutGridType;
  /** Degrees (Lat/Lon) or metres (UTM, MGRS); 0 picks an interval automatically. */
  gridInterval: number;
  /** Label size in typographic points. */
  gridFontSize: number;
  /** Draw grid lines across the map, not only border ticks. */
  gridLines: boolean;

  // Free-form positioning
  /** The main map frame's page box; null keeps the automatic layout. */
  mapFrameBox: PrintLayoutFrameBox | null;
  /** Per-element displacement from the automatic layout; absent = automatic. */
  elementOffsets: Partial<Record<PrintLayoutMovableElement, PrintLayoutElementOffset>>;

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

/** The export resolutions the composer offers, in dots per inch. */
export const PRINT_LAYOUT_EXPORT_DPIS = [72, 150, 300] as const;
export type PrintLayoutExportDpi = (typeof PRINT_LAYOUT_EXPORT_DPIS)[number];

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
  pageBackground: "#ffffff",
  panelTheme: "light",
  showPageBorder: false,
  pageBorderColor: "#111827",
  pageBorderWidth: 2,
  exportDpi: 150,

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

  showInset: false,
  insetBasemap: "positron",
  insetZoomOffset: -4,
  insetExtentColor: "#dc2626",
  insetBox: null,

  showGrid: false,
  gridType: "dms",
  gridInterval: 0,
  gridFontSize: 7,
  gridLines: false,

  mapFrameBox: null,
  elementOffsets: {},

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
    elementOffsets: {},
  };
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** A `#RGB` / `#RRGGBB` colour, or `fallback` for anything else. */
function hexColor(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim())
    ? value.trim()
    : fallback;
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

/** One of the offered export resolutions, or `fallback` for anything else. */
function exportDpi(value: unknown, fallback: PrintLayoutExportDpi): PrintLayoutExportDpi {
  return (PRINT_LAYOUT_EXPORT_DPIS as readonly unknown[]).includes(value)
    ? (value as PrintLayoutExportDpi)
    : fallback;
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

/** A page-fraction frame box kept on the page, or null for anything else. */
function frameBox(value: unknown): PrintLayoutFrameBox | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const parts = [raw.x, raw.y, raw.w, raw.h];
  if (!parts.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const [x, y, w, h] = parts as number[];
  if (w < 0.01 || h < 0.01) return null;
  const cw = Math.min(1, w);
  const ch = Math.min(1, h);
  return {
    x: Math.min(1 - cw, Math.max(0, x)),
    y: Math.min(1 - ch, Math.max(0, y)),
    w: cw,
    h: ch,
  };
}

/** Valid element offsets only; unknown elements and malformed entries drop. */
function elementOffsets(value: unknown): PrintLayoutConfig["elementOffsets"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: PrintLayoutConfig["elementOffsets"] = {};
  for (const id of PRINT_LAYOUT_MOVABLE_ELEMENTS) {
    const entry = (value as Record<string, unknown>)[id];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { dx, dy, scale } = entry as Record<string, unknown>;
    if (![dx, dy, scale].every((n) => typeof n === "number" && Number.isFinite(n))) continue;
    out[id] = {
      // An element can be dragged partly off the page but not lost entirely.
      dx: Math.min(1, Math.max(-1, dx as number)),
      dy: Math.min(1, Math.max(-1, dy as number)),
      scale: Math.min(4, Math.max(0.25, scale as number)),
    };
  }
  return out;
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
  const gridInterval = num(raw.gridInterval, d.gridInterval, 0, 10_000_000);
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
    // Drawn behind the page and read for the text contrast, so only a hex
    // colour is kept: a hand-edited name or typo falls back to white.
    pageBackground: hexColor(raw.pageBackground, d.pageBackground),
    panelTheme: oneOf(raw.panelTheme, ["light", "dark"] as const, d.panelTheme),
    showPageBorder: bool(raw.showPageBorder, d.showPageBorder),
    pageBorderColor: str(raw.pageBorderColor, d.pageBorderColor),
    // A page border is drawn only when `showPageBorder` is on, so a zero width
    // would be an invisible "visible" border; the editor's own floor is 1.
    pageBorderWidth: num(raw.pageBorderWidth, d.pageBorderWidth, 1, 20),
    exportDpi: exportDpi(raw.exportDpi, d.exportDpi),

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

    showInset: bool(raw.showInset, d.showInset),
    insetBasemap: oneOf(raw.insetBasemap, PRINT_LAYOUT_INSET_BASEMAPS, d.insetBasemap),
    insetZoomOffset: num(raw.insetZoomOffset, d.insetZoomOffset, -12, 0),
    insetExtentColor: hexColor(raw.insetExtentColor, d.insetExtentColor),
    insetBox: frameBox(raw.insetBox),

    showGrid: bool(raw.showGrid, d.showGrid),
    gridType: oneOf(raw.gridType, ["dms", "decimal", "utm", "mgrs"] as const, d.gridType),
    gridInterval:
      raw.gridType === "mgrs" && gridInterval > 0
        ? Math.ceil(gridInterval / 1000) * 1000
        : gridInterval,
    gridFontSize: num(raw.gridFontSize, d.gridFontSize, 3, 36),
    gridLines: bool(raw.gridLines, d.gridLines),

    mapFrameBox: frameBox(raw.mapFrameBox),
    elementOffsets: elementOffsets(raw.elementOffsets),

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
    if (
      (left !== null && typeof left === "object") ||
      (right !== null && typeof right === "object")
    ) {
      if (stableJson(left) !== stableJson(right)) return false;
    } else if (left !== right) {
      return false;
    }
  }
  return true;
}

/** JSON with object keys sorted, so key order never reads as a change. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
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
