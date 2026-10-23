/**
 * State model for the Print Layout composer (`PrintLayoutDialog`).
 *
 * The dialog holds two kinds of state:
 *
 * - `layout`: the project's map document, in exactly the shape the project
 *   file stores (`PrintLayoutConfig` from `@geolibre/core`). The dialog pushes
 *   it into the store on every change, so Save writes it and reopening the
 *   project restores it.
 * - everything else: session-only composer state (the captured map, export
 *   progress, error text, the scale input draft, splitter width, ...). It is
 *   never persisted.
 *
 * Every transition is a pure function of the previous state and an action, so
 * the dialog's multi-field updates (switching a coverage layer drops the old
 * layer's field choices, drawing an extent switches the capture mode, ...) are
 * spelled out once here and unit tested in `tests/print-layout-state.test.ts`.
 * The reducer returns the previous state object when an action changes
 * nothing, so React bails out of the re-render exactly as a `useState` setter
 * called with an unchanged value would.
 */
import type { Dispatch } from "react";
import type { PrintLayoutConfig, PrintLayoutLegendEntry } from "@geolibre/core";
import type { AtlasBounds } from "../../../lib/print-atlas";
import type { PrintExtent } from "../../../lib/print-extent";
import type { CapturedMap } from "../../../lib/print-layout-export";

/** Bounds (px) for the draggable controls column inside the dialog. */
export const CONTROLS_MIN_WIDTH = 260;
export const CONTROLS_MAX_WIDTH = 560;
export const CONTROLS_DEFAULT_WIDTH = 320;

/** Colour a newly added custom-legend swatch starts with. */
export const NEW_CUSTOM_LEGEND_COLOR = "#888888";

/** A complete `#RGB` / `#RRGGBB` hex colour, the only map background committed. */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Session-only composer state: never written to the project. */
export interface PrintLayoutUiState {
  /**
   * Next custom-legend id counter; a new swatch gets `cl-${++seq}`. Seeded
   * past whatever the project restored so a new swatch never collides with a
   * saved one.
   */
  customLegendSeq: number;
  /** The "Import from Dictionary" textarea. */
  legendDict: string;
  legendDictError: string | null;
  /**
   * Draft for the free-form map background hex field; only complete
   * `#RGB` / `#RRGGBB` values are committed to `layout.mapBackground`, so a
   * half-typed "#" never corrupts the layout colour.
   */
  mapBackgroundDraft: string;
  /** True while the dialog is hidden for the user to draw a print extent. */
  drawingExtent: boolean;
  /** Current atlas page (may go stale when a filter shrinks the series). */
  atlasIndex: number;
  /** True while the atlas drives the live map (stepping or exporting). */
  atlasBusy: boolean;
  atlasProgress: { current: number; total: number } | null;
  /** Out-of-range notice from the last fixed-scale atlas capture. */
  atlasScaleNotice: string | null;
  /** The map's visible bounds after the last atlas capture, keyed by page. */
  atlasViewBounds: { index: number; bounds: AtlasBounds } | null;
  captured: CapturedMap | null;
  /** "contain" when a graticule is active so its edge labels are not cropped. */
  mapFit: "cover" | "contain";
  exporting: boolean;
  /** Brief "Copied" confirmation on the clipboard button (GH #773). */
  copied: boolean;
  error: string | null;
  /** The manual 1:N scale input. */
  scaleDraft: string;
  /** Inline notice when a requested scale can't be reached (GH #743). */
  scaleNotice: string | null;
  /** Width of the left controls column, dragged via the splitter. */
  controlsWidth: number;
  /** Explicit dialog size once the corner grip is dragged (null = default). */
  dialogSize: { width: number; height: number } | null;
}

/** Everything the Print Layout composer holds. */
export interface PrintLayoutState extends PrintLayoutUiState {
  /** The persisted map document (the project's `printLayout`). */
  layout: PrintLayoutConfig;
}

/** Every transition the composer's state can make. */
export type PrintLayoutAction =
  /** Set persisted fields directly (a plain input bound to one field). */
  | { type: "setLayout"; patch: Partial<PrintLayoutConfig> }
  /** Set session-only fields directly. */
  | { type: "setUi"; patch: Partial<Omit<PrintLayoutUiState, "customLegendSeq">> }
  /** Custom page size; each side is floored at 1. */
  | { type: "setCustomSize"; width?: number; height?: number }
  /** Type or pick a map background; complete hex colours are committed. */
  | { type: "commitMapBackground"; value: string }
  /** Toggle the atlas; (re-)enabling starts the series from its first page. */
  | { type: "setAtlasEnabled"; enabled: boolean }
  /** Pick the atlas coverage layer (by hand or by the defaulting effect). */
  | { type: "selectAtlasLayer"; layerId: string }
  /** Switch per-feature / along-a-line coverage; restarts the series. */
  | { type: "setAtlasCoverage"; coverage: PrintLayoutConfig["atlasCoverage"] }
  /** Pick the attribute table's layer; drops the old layer's columns/sort. */
  | { type: "selectTableLayer"; layerId: string }
  /** Pick the chart's layer; drops the old layer's field choices. */
  | { type: "selectChartLayer"; layerId: string }
  | { type: "addCustomLegendEntry" }
  | {
      type: "updateCustomLegendEntry";
      id: string;
      patch: Partial<Pick<PrintLayoutLegendEntry, "label" | "color">>;
    }
  | { type: "removeCustomLegendEntry"; id: string }
  /**
   * Replace the custom legend items from the `{ label: color }` dictionary in
   * `legendDict`; `errorMessage` is shown when it does not parse.
   */
  | { type: "importLegendDict"; errorMessage: string }
  /** A print extent was drawn: capture it from now on. */
  | { type: "extentDrawn"; extent: PrintExtent }
  /** The print extent was cleared: back to the viewport. */
  | { type: "extentCleared" }
  /** Switch between the viewport and the drawn extent. */
  | { type: "setCaptureMode"; mode: PrintLayoutConfig["captureMode"] }
  /** The dialog opened: clear notices left over from the previous session. */
  | { type: "dialogOpened" }
  | { type: "captureSucceeded"; captured: CapturedMap }
  | { type: "captureFailed"; error: string }
  /** An atlas page was driven and captured. */
  | { type: "atlasPageCaptured"; captured: CapturedMap; index: number; bounds: AtlasBounds }
  /** Set the controls column width, clamped to its bounds. */
  | { type: "setControlsWidth"; width: number }
  /** Nudge the controls column width (keyboard splitter), clamped. */
  | { type: "nudgeControlsWidth"; delta: number };

/** Props every per-element editor takes: the persisted layout and the dispatch. */
export interface LayoutEditorProps {
  layout: PrintLayoutConfig;
  dispatch: Dispatch<PrintLayoutAction>;
}

/**
 * The first free custom-legend id counter for a set of saved entries: past
 * every numeric `cl-N` id, and never below the entry count.
 *
 * @param entries - The custom legend entries restored from the project.
 * @returns The counter to seed; the next id is `cl-${counter + 1}`.
 */
export function customLegendSeqFor(entries: readonly PrintLayoutLegendEntry[]): number {
  return entries.reduce((max, entry) => {
    const parsed = Number(/^cl-(\d+)$/.exec(entry.id)?.[1]);
    return Number.isFinite(parsed) && parsed > max ? parsed : max;
  }, entries.length);
}

/**
 * The composer's state for a freshly mounted dialog, seeded from the layout
 * the project was saved with. The `layout` object is kept as-is (not copied),
 * so the first push back to the store is recognised as a no-op.
 *
 * @param layout - The project's stored print layout.
 * @returns The initial state.
 */
export function createPrintLayoutState(layout: PrintLayoutConfig): PrintLayoutState {
  return {
    layout,
    customLegendSeq: customLegendSeqFor(layout.customLegendEntries),
    legendDict: "",
    legendDictError: null,
    mapBackgroundDraft: layout.mapBackground,
    drawingExtent: false,
    atlasIndex: 0,
    atlasBusy: false,
    atlasProgress: null,
    atlasScaleNotice: null,
    atlasViewBounds: null,
    captured: null,
    mapFit: "cover",
    exporting: false,
    copied: false,
    error: null,
    scaleDraft: "",
    scaleNotice: null,
    controlsWidth: CONTROLS_DEFAULT_WIDTH,
    dialogSize: null,
  };
}

/**
 * Parse an "Import from Dictionary" `{ label: color }` object, matching the
 * Controls -> Legend import format.
 *
 * @param text - The raw JSON typed by the user.
 * @returns The `[label, color]` pairs in key order, or null when the text is
 *   not a non-empty JSON object.
 */
export function parseLegendDict(text: string): [string, string][] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const pairs = Object.entries(parsed as Record<string, unknown>).map(
    ([label, color]) => [label, String(color)] as [string, string],
  );
  return pairs.length > 0 ? pairs : null;
}

/** Whether `patch` would change any field of `target`. */
function changes<T extends object>(target: T, patch: Partial<T>): boolean {
  for (const key of Object.keys(patch) as (keyof T)[]) {
    if (!Object.is(target[key], patch[key])) return true;
  }
  return false;
}

/** Apply a persisted-field patch, keeping the state object when nothing changes. */
function patchLayout(state: PrintLayoutState, patch: Partial<PrintLayoutConfig>): PrintLayoutState {
  if (!changes(state.layout, patch)) return state;
  return { ...state, layout: { ...state.layout, ...patch } };
}

/** Apply a session-field patch, keeping the state object when nothing changes. */
function patchUi(state: PrintLayoutState, patch: Partial<PrintLayoutUiState>): PrintLayoutState {
  if (!changes(state, patch as Partial<PrintLayoutState>)) return state;
  return { ...state, ...patch };
}

/** Clamp a controls column width to its bounds. */
function clampControlsWidth(width: number): number {
  return Math.max(CONTROLS_MIN_WIDTH, Math.min(CONTROLS_MAX_WIDTH, width));
}

/**
 * The Print Layout composer's reducer: a pure function of the previous state
 * and an action.
 *
 * @param state - The current state.
 * @param action - The transition to apply.
 * @returns The next state, or `state` itself when nothing changed.
 */
export function printLayoutReducer(
  state: PrintLayoutState,
  action: PrintLayoutAction,
): PrintLayoutState {
  switch (action.type) {
    case "setLayout":
      return patchLayout(state, action.patch);
    case "setUi":
      return patchUi(state, action.patch);
    case "setCustomSize": {
      const patch: Partial<PrintLayoutConfig> = {};
      if (action.width !== undefined) patch.customWidth = Math.max(1, action.width);
      if (action.height !== undefined) patch.customHeight = Math.max(1, action.height);
      return patchLayout(state, patch);
    }
    case "commitMapBackground": {
      const value = action.value;
      const next = patchUi(state, { mapBackgroundDraft: value });
      return HEX_COLOR.test(value.trim())
        ? patchLayout(next, { mapBackground: value.trim() })
        : next;
    }
    case "setAtlasEnabled": {
      const next = patchLayout(state, { atlasEnabled: action.enabled });
      return action.enabled ? patchUi(next, { atlasIndex: 0 }) : next;
    }
    case "selectAtlasLayer":
      // Field choices belong to the previous layer, and the new series starts
      // from its first page.
      return patchUi(
        patchLayout(state, {
          atlasLayerId: action.layerId,
          atlasNameField: "",
          atlasSortField: "",
        }),
        { atlasIndex: 0 },
      );
    case "setAtlasCoverage":
      return patchUi(patchLayout(state, { atlasCoverage: action.coverage }), { atlasIndex: 0 });
    case "selectTableLayer":
      // Column/sort choices belong to the previous layer.
      return patchLayout(state, {
        tableLayerId: action.layerId,
        tableColumns: [],
        tableSortField: "",
      });
    case "selectChartLayer":
      return patchLayout(state, {
        chartLayerId: action.layerId,
        chartCategoryField: "",
        chartValueField: "",
      });
    case "addCustomLegendEntry": {
      const seq = state.customLegendSeq + 1;
      return {
        ...state,
        customLegendSeq: seq,
        layout: {
          ...state.layout,
          customLegendEntries: [
            ...state.layout.customLegendEntries,
            { id: `cl-${seq}`, label: "", color: NEW_CUSTOM_LEGEND_COLOR },
          ],
        },
      };
    }
    case "updateCustomLegendEntry":
      return patchLayout(state, {
        customLegendEntries: state.layout.customLegendEntries.map((entry) =>
          entry.id === action.id ? { ...entry, ...action.patch } : entry,
        ),
      });
    case "removeCustomLegendEntry":
      return patchLayout(state, {
        customLegendEntries: state.layout.customLegendEntries.filter(
          (entry) => entry.id !== action.id,
        ),
      });
    case "importLegendDict": {
      const pairs = parseLegendDict(state.legendDict);
      if (!pairs) return patchUi(state, { legendDictError: action.errorMessage });
      let seq = state.customLegendSeq;
      const entries = pairs.map(([label, color]) => ({ id: `cl-${++seq}`, label, color }));
      return {
        ...state,
        customLegendSeq: seq,
        legendDictError: null,
        layout: { ...state.layout, customLegendEntries: entries },
      };
    }
    case "extentDrawn":
      return patchLayout(state, { extentBbox: action.extent, captureMode: "extent" });
    case "extentCleared":
      return patchLayout(state, { extentBbox: null, captureMode: "viewport" });
    case "setCaptureMode": {
      if (action.mode === state.layout.captureMode) return state;
      // The scale control is disabled in extent mode, so a stale out-of-range
      // notice from a viewport scale attempt must not linger (GH #743).
      const next = action.mode === "extent" ? patchUi(state, { scaleNotice: null }) : state;
      return patchLayout(next, { captureMode: action.mode });
    }
    case "dialogOpened":
      // The dialog is hidden (not unmounted) on close, so notices from the
      // previous session would otherwise persist into this one (GH #743,
      // GH #773).
      return patchUi(state, { error: null, scaleNotice: null, copied: false });
    case "captureSucceeded":
      return patchUi(state, { captured: action.captured, error: null });
    case "captureFailed":
      return patchUi(state, { error: action.error, captured: null });
    case "atlasPageCaptured":
      return patchUi(state, {
        captured: action.captured,
        atlasViewBounds: { index: action.index, bounds: action.bounds },
        atlasIndex: action.index,
      });
    case "setControlsWidth":
      return patchUi(state, { controlsWidth: clampControlsWidth(action.width) });
    case "nudgeControlsWidth":
      return patchUi(state, {
        controlsWidth: clampControlsWidth(state.controlsWidth + action.delta),
      });
  }
}
