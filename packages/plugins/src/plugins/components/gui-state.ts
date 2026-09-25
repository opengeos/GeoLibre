// Project-state shapes and normalizers for the Colorbar, Legend and HTML
// GUI controls.
// Split out of maplibre-components.ts (opengeos/GeoLibre#2633).

import type { ColorbarGuiControl, HtmlGuiControl, LegendGuiControl } from "maplibre-gl-components";
import type { GeoLibreMapControlPosition } from "../../types";

export interface ComponentsProjectState {
  colorbar?: ComponentColorbarGuiState;
  legend?: ComponentLegendGuiState;
  html?: ComponentHtmlGuiState;
}

interface ComponentColorbarGuiEntryState {
  mode: "named" | "custom";
  colormap: string;
  customColors: string;
  vmin: number;
  vmax: number;
  label: string;
  units: string;
  orientation: "horizontal" | "vertical";
  colorbarPosition: GeoLibreMapControlPosition;
}

export interface ComponentColorbarGuiState extends ComponentColorbarGuiEntryState {
  visible: boolean;
  collapsed: boolean;
  hasColorbar: boolean;
  selectedColorbarIndex: number;
  colorbars: ComponentColorbarGuiEntryState[];
  stackOrientation: "horizontal" | "vertical";
}

export interface ComponentLegendItem {
  label: string;
  color: string;
  shape?: "square" | "circle" | "line";
  strokeColor?: string;
  icon?: string;
}

export interface ComponentLegendGuiEntryState {
  title: string;
  items: ComponentLegendItem[];
  legendPosition: GeoLibreMapControlPosition;
}

export interface ComponentLegendGuiState extends ComponentLegendGuiEntryState {
  visible: boolean;
  collapsed: boolean;
  hasLegend: boolean;
  selectedLegendIndex: number;
  legends: ComponentLegendGuiEntryState[];
}

interface ComponentHtmlGuiEntryState {
  title: string;
  html: string;
  htmlPosition: GeoLibreMapControlPosition;
  collapsible: boolean;
}

export interface ComponentHtmlGuiState extends ComponentHtmlGuiEntryState {
  visible: boolean;
  collapsed: boolean;
  hasHtmlControl: boolean;
  selectedHtmlIndex: number;
  htmls: ComponentHtmlGuiEntryState[];
}

export type RestorableColorbarGuiControl = ColorbarGuiControl & {
  setState?: (state: ComponentColorbarGuiState) => unknown;
};

export type RestorableLegendGuiControl = LegendGuiControl & {
  setState?: (state: ComponentLegendGuiState) => unknown;
};

export type RestorableHtmlGuiControl = HtmlGuiControl & {
  setState?: (state: ComponentHtmlGuiState) => unknown;
};

type GuiControlStateInternals<TState> = {
  _render?: () => void;
  _state?: TState;
  setState?: (state: TState) => unknown;
};

const CONTROL_POSITIONS = new Set<GeoLibreMapControlPosition>([
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
]);

const LEGEND_ITEM_SHAPES = new Set<ComponentLegendItem["shape"]>(["square", "circle", "line"]);

const DEFAULT_COLORBAR_GUI_ENTRY: ComponentColorbarGuiEntryState = {
  mode: "named",
  colormap: "viridis",
  customColors: "#440154, #31688e, #21918c, #90d743, #fde725",
  vmin: 0,
  vmax: 100,
  label: "",
  units: "",
  orientation: "vertical",
  colorbarPosition: "bottom-right",
};

const DEFAULT_LEGEND_GUI_ENTRY: ComponentLegendGuiEntryState = {
  title: "Legend",
  items: [
    { label: "Category A", color: "#ff6b6b", shape: "square" },
    { label: "Category B", color: "#4ecdc4", shape: "square" },
    { label: "Category C", color: "#95a5a6", shape: "square" },
  ],
  legendPosition: "bottom-left",
};

const DEFAULT_HTML_GUI_ENTRY: ComponentHtmlGuiEntryState = {
  title: "Info",
  html: '<div style="padding: 4px;">\n  <h4 style="margin: 0 0 8px 0;">Welcome</h4>\n  <p style="margin: 0; color: #666;">This is a custom HTML control.</p>\n</div>',
  htmlPosition: "top-left",
  collapsible: true,
};

export function restoreGuiControlState<
  TState extends ComponentColorbarGuiState | ComponentLegendGuiState | ComponentHtmlGuiState,
>(
  control: RestorableColorbarGuiControl | RestorableLegendGuiControl | RestorableHtmlGuiControl,
  state: TState,
): void {
  const internals = control as unknown as GuiControlStateInternals<TState>;
  if (internals.setState) {
    internals.setState(state);
    return;
  }

  internals._state = state;
  internals._render?.();
}

export function normalizeComponentsProjectState(state: unknown): ComponentsProjectState | null {
  if (!state || typeof state !== "object") return null;
  const candidate = state as Partial<ComponentsProjectState>;
  return {
    colorbar: normalizeColorbarState(candidate.colorbar),
    legend: normalizeLegendState(candidate.legend),
    html: normalizeHtmlState(candidate.html),
  };
}

/** @internal Exported only so the project-state normalizer can be unit-tested. */
export function normalizeColorbarState(state: unknown): ComponentColorbarGuiState | undefined {
  if (!state || typeof state !== "object") return undefined;
  const candidate = state as Partial<ComponentColorbarGuiState>;
  const formEntry = normalizeColorbarEntry(candidate);
  const colorbars = Array.isArray(candidate.colorbars)
    ? candidate.colorbars.map(normalizeColorbarEntry)
    : [];
  const selectedColorbarIndex = selectedIndex(candidate.selectedColorbarIndex, colorbars.length);
  return {
    ...formEntry,
    visible: typeof candidate.visible === "boolean" ? candidate.visible : true,
    collapsed: typeof candidate.collapsed === "boolean" ? candidate.collapsed : false,
    hasColorbar: colorbars.length > 0,
    selectedColorbarIndex,
    colorbars,
    stackOrientation: candidate.stackOrientation === "horizontal" ? "horizontal" : "vertical",
  };
}

export function normalizeLegendState(state: unknown): ComponentLegendGuiState | undefined {
  if (!state || typeof state !== "object") return undefined;
  const candidate = state as Partial<ComponentLegendGuiState>;
  const formEntry = normalizeLegendEntry(candidate);
  const legends = Array.isArray(candidate.legends)
    ? candidate.legends.map(normalizeLegendEntry)
    : [];
  return {
    ...formEntry,
    visible: typeof candidate.visible === "boolean" ? candidate.visible : true,
    collapsed: typeof candidate.collapsed === "boolean" ? candidate.collapsed : false,
    hasLegend: legends.length > 0,
    selectedLegendIndex: selectedIndex(candidate.selectedLegendIndex, legends.length),
    legends,
  };
}

export function normalizeHtmlState(state: unknown): ComponentHtmlGuiState | undefined {
  if (!state || typeof state !== "object") return undefined;
  const candidate = state as Partial<ComponentHtmlGuiState>;
  const formEntry = normalizeHtmlEntry(candidate);
  const htmls = Array.isArray(candidate.htmls) ? candidate.htmls.map(normalizeHtmlEntry) : [];
  return {
    ...formEntry,
    visible: typeof candidate.visible === "boolean" ? candidate.visible : true,
    collapsed: typeof candidate.collapsed === "boolean" ? candidate.collapsed : false,
    hasHtmlControl: htmls.length > 0,
    selectedHtmlIndex: selectedIndex(candidate.selectedHtmlIndex, htmls.length),
    htmls,
  };
}

function normalizeColorbarEntry(entry: unknown): ComponentColorbarGuiEntryState {
  const candidate = (
    entry && typeof entry === "object" ? entry : {}
  ) as Partial<ComponentColorbarGuiEntryState>;
  const vmin = finiteNumber(candidate.vmin, DEFAULT_COLORBAR_GUI_ENTRY.vmin);
  const vmax = finiteNumber(candidate.vmax, DEFAULT_COLORBAR_GUI_ENTRY.vmax);
  return {
    mode: candidate.mode === "custom" ? "custom" : "named",
    colormap:
      typeof candidate.colormap === "string" && candidate.colormap.trim()
        ? candidate.colormap
        : DEFAULT_COLORBAR_GUI_ENTRY.colormap,
    customColors:
      typeof candidate.customColors === "string" && candidate.customColors.trim()
        ? candidate.customColors
        : DEFAULT_COLORBAR_GUI_ENTRY.customColors,
    vmin,
    vmax: vmax === vmin ? vmin + 1 : vmax,
    label: typeof candidate.label === "string" ? candidate.label : "",
    units: typeof candidate.units === "string" ? candidate.units : "",
    orientation: candidate.orientation === "horizontal" ? "horizontal" : "vertical",
    colorbarPosition: normalizeControlPosition(
      candidate.colorbarPosition,
      DEFAULT_COLORBAR_GUI_ENTRY.colorbarPosition,
    ),
  };
}

function normalizeLegendEntry(entry: unknown): ComponentLegendGuiEntryState {
  const candidate = (
    entry && typeof entry === "object" ? entry : {}
  ) as Partial<ComponentLegendGuiEntryState>;
  const items = Array.isArray(candidate.items)
    ? candidate.items
        .map(normalizeLegendItem)
        .filter((item): item is ComponentLegendItem => item !== null)
    : DEFAULT_LEGEND_GUI_ENTRY.items;
  return {
    title: typeof candidate.title === "string" ? candidate.title : DEFAULT_LEGEND_GUI_ENTRY.title,
    items,
    legendPosition: normalizeControlPosition(
      candidate.legendPosition,
      DEFAULT_LEGEND_GUI_ENTRY.legendPosition,
    ),
  };
}

function normalizeHtmlEntry(entry: unknown): ComponentHtmlGuiEntryState {
  const candidate = (
    entry && typeof entry === "object" ? entry : {}
  ) as Partial<ComponentHtmlGuiEntryState>;
  return {
    title: typeof candidate.title === "string" ? candidate.title : DEFAULT_HTML_GUI_ENTRY.title,
    html: typeof candidate.html === "string" ? candidate.html : DEFAULT_HTML_GUI_ENTRY.html,
    htmlPosition: normalizeControlPosition(
      candidate.htmlPosition,
      DEFAULT_HTML_GUI_ENTRY.htmlPosition,
    ),
    collapsible:
      typeof candidate.collapsible === "boolean"
        ? candidate.collapsible
        : DEFAULT_HTML_GUI_ENTRY.collapsible,
  };
}

function normalizeLegendItem(item: unknown): ComponentLegendItem | null {
  if (!item || typeof item !== "object") return null;
  const candidate = item as Partial<ComponentLegendItem>;
  if (typeof candidate.label !== "string" || !candidate.label.trim()) {
    return null;
  }
  if (typeof candidate.color !== "string" || !candidate.color.trim()) {
    return null;
  }

  return {
    label: candidate.label,
    color: candidate.color,
    ...(isLegendItemShape(candidate.shape) ? { shape: candidate.shape } : {}),
    ...(typeof candidate.strokeColor === "string" ? { strokeColor: candidate.strokeColor } : {}),
    ...(typeof candidate.icon === "string" ? { icon: candidate.icon } : {}),
  };
}

function isLegendItemShape(value: unknown): value is ComponentLegendItem["shape"] {
  return LEGEND_ITEM_SHAPES.has(value as ComponentLegendItem["shape"]);
}

function normalizeControlPosition(
  value: unknown,
  fallback: GeoLibreMapControlPosition,
): GeoLibreMapControlPosition {
  return typeof value === "string" && CONTROL_POSITIONS.has(value as GeoLibreMapControlPosition)
    ? (value as GeoLibreMapControlPosition)
    : fallback;
}

export function selectedIndex(value: unknown, length: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < length) {
    return value;
  }
  return length > 0 ? length - 1 : -1;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
