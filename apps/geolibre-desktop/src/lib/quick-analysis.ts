import {
  DEFAULT_LAYER_STYLE,
  useAppStore,
  type GeoLibreLayer,
  type MapScaleUnit,
} from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  getNetworkTool,
  getVectorTool,
  runAlgorithmCapture,
  type ProcessingAlgorithm,
} from "@geolibre/processing";
import type { Feature, FeatureCollection } from "geojson";
import { beginProcessingRun } from "./processing-history";

/**
 * Quick analysis (issue #1523): run the most-asked-for processing tools straight
 * from the map's right-click menu and the layer actions menu, with defaults
 * already filled in.
 *
 * These add **no new algorithms**. Every action resolves a tool from the
 * existing vector/network registries and runs it through `runAlgorithmCapture`,
 * so the result is identical to running the same tool from the Processing
 * dialog — and it lands in the Processing History panel like any other run,
 * re-runnable and copyable as Python.
 */

/** Synthetic layer id for the clicked point fed to a point-input tool. */
const CLICKED_POINT_LAYER_ID = "__geolibre_quick_analysis_point";

/**
 * Travel-time contours (minutes) offered by the drive/walk-time actions, in the
 * comma-separated form the isochrone tool parses.
 */
export const QUICK_TRAVEL_CONTOURS = "5,10,15";

/** The same contours spaced for menu labels ("5, 10, 15"). */
export const QUICK_TRAVEL_CONTOURS_LABEL = QUICK_TRAVEL_CONTOURS.split(",").join(", ");

/** One buffer entry in the Quick analysis menu. */
export interface QuickBufferPreset {
  /** Distance in `units`, passed verbatim to the buffer tool. */
  distance: number;
  /** A unit the buffer tool declares, so the equivalent Processing run matches. */
  units: "meters" | "kilometers" | "miles";
}

/**
 * Buffer distances offered per scale-bar unit system, so the menu speaks in
 * whatever units the map is already labelled in rather than a hardcoded metric
 * ladder.
 *
 * `nautical` reuses the metric ladder deliberately: the buffer tool's unit list
 * is meters/kilometers/miles, and a preset has to stay inside it for "Open in
 * Processing…" to reproduce the same run. A nautical scale bar describes
 * distance *across* water, which says nothing about the units someone wants a
 * landward buffer in.
 */
export const QUICK_BUFFER_PRESETS: Record<MapScaleUnit, QuickBufferPreset[]> = {
  metric: [
    { distance: 500, units: "meters" },
    { distance: 1, units: "kilometers" },
    { distance: 5, units: "kilometers" },
  ],
  imperial: [
    { distance: 0.25, units: "miles" },
    { distance: 1, units: "miles" },
    { distance: 5, units: "miles" },
  ],
  nautical: [
    { distance: 500, units: "meters" },
    { distance: 1, units: "kilometers" },
    { distance: 5, units: "kilometers" },
  ],
};

/** Resolve the buffer ladder for the active scale-bar unit preference. */
export function bufferPresetsFor(unit: MapScaleUnit): QuickBufferPreset[] {
  return QUICK_BUFFER_PRESETS[unit] ?? QUICK_BUFFER_PRESETS.metric;
}

/**
 * Render a preset for a menu label ("500 m", "0.25 mi"), localizing both the
 * number and the unit. Shared by every menu that offers the ladder so the two
 * entry points cannot drift apart.
 *
 * @param preset - The buffer preset to label.
 * @param language - Active i18next language, for number formatting.
 * @param t - Translator, for the unit abbreviation. Typed to the three unit
 *   keys rather than `string` so it accepts i18next's key-checked `TFunction`.
 */
export function formatBufferDistance(
  preset: QuickBufferPreset,
  language: string,
  t: (key: `quickAnalysis.unit.${QuickBufferPreset["units"]}`) => string,
): string {
  const value = new Intl.NumberFormat(language).format(preset.distance);
  return `${value} ${t(`quickAnalysis.unit.${preset.units}`)}`;
}

/** Wrap a clicked coordinate as a one-feature layer a tool can consume. */
export function clickedPointLayer(lng: number, lat: number): GeoLibreLayer {
  const feature: Feature = {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lng, lat] },
    properties: {},
  };
  return {
    id: CLICKED_POINT_LAYER_ID,
    name: "Clicked point",
    type: "geojson",
    source: { type: "geojson" },
    visible: false,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: { type: "FeatureCollection", features: [feature] },
  };
}

/* -------------------------------------------------------------------------- */
/* Run status                                                                  */
/* -------------------------------------------------------------------------- */

/** What the Quick analysis banner is currently reporting. */
export type QuickAnalysisStatus =
  | { phase: "idle" }
  | { phase: "running"; toolName: string }
  | { phase: "error"; toolName: string; message: string };

let status: QuickAnalysisStatus = { phase: "idle" };
const listeners = new Set<() => void>();
/**
 * Monotonic id of the most recently started run. Nothing stops a user firing a
 * fast buffer while a slow drive-time is still in flight, and the banner shows
 * one thing at a time — without this, the quick run's success would reset the
 * banner to idle under the slow one, and the slow one's later error would
 * resurrect a banner for a run the user has moved on from. Only the newest run
 * may write status; older runs still record their outcome in the Processing
 * History, which is the durable record.
 */
let latestRun = 0;

/**
 * Claim the banner for a quick action that is not a registry tool -- the
 * viewshed, which computes a raster rather than running a registered vector
 * tool -- so it can report running and failed like every other entry in that
 * menu instead of failing silently.
 *
 * Unlike `runQuickAnalysis` this records **no Processing History entry**: the
 * caller is not a registry tool, so there is no algorithm id and parameter set
 * to replay or copy as Python. The module docstring's claim that every quick
 * action lands in the History covers the registry-tool actions; this is the
 * exception, so History is not a complete audit trail of the menu.
 *
 * Returns a setter bound to this run's id, so it goes through the same
 * {@link latestRun} guard `runQuickAnalysis` uses. Without that, a slow
 * viewshed resolving after the user has fired a quick buffer would clobber the
 * buffer's status with its own -- exactly the "resurrect a banner for a run the
 * user has moved on from" case the counter exists to prevent.
 */
export function beginQuickAnalysisRun(toolName: string): (next: QuickAnalysisStatus) => void {
  const run = ++latestRun;
  setStatus({ phase: "running", toolName });
  return (next) => {
    if (run === latestRun) setStatus(next);
  };
}

function setStatus(next: QuickAnalysisStatus): void {
  status = next;
  for (const listener of listeners) listener();
}

/** Subscribe to run status, for `useSyncExternalStore`. */
export function subscribeQuickAnalysisStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Current run status snapshot (stable identity between changes). */
export function getQuickAnalysisStatus(): QuickAnalysisStatus {
  return status;
}

/** Dismiss a reported failure, returning the banner to idle. */
export function clearQuickAnalysisStatus(): void {
  if (status.phase !== "idle") setStatus({ phase: "idle" });
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                      */
/* -------------------------------------------------------------------------- */

export interface QuickAnalysisRequest {
  /** Tool id in the vector or network registry (e.g. `"buffer"`). */
  toolId: string;
  /** Parameter values, exactly as the Processing dialog would dispatch them. */
  parameters: Record<string, unknown>;
  /** Name for the layer the result is added as. */
  resultName: string;
  /**
   * Extra layers the tool can resolve by id on top of the project's own —
   * used to hand a point-input tool the clicked coordinate without first
   * adding a throwaway layer to the map.
   */
  extraLayers?: GeoLibreLayer[];
  /** Live map controller, used to frame the result. */
  mapControllerRef: { current: MapController | null };
}

/** Resolve a tool id against the registries Quick analysis draws from. */
export function resolveQuickTool(toolId: string): ProcessingAlgorithm | undefined {
  return getVectorTool(toolId) ?? getNetworkTool(toolId);
}

/**
 * Run one quick action and add its output to the map.
 *
 * Failures are deliberately not thrown at the caller: a menu item has nowhere
 * to render an exception. Instead the run is recorded in the Processing History
 * panel (with the tool, its parameters, and the error) and surfaced on the
 * Quick analysis banner, whose "View details" opens that panel.
 *
 * @param request - The tool, its parameters, and where to put the result.
 * @returns The new layer's id, or `null` when the run produced nothing.
 */
export async function runQuickAnalysis(request: QuickAnalysisRequest): Promise<string | null> {
  const { toolId, parameters, resultName, extraLayers = [], mapControllerRef } = request;
  const tool = resolveQuickTool(toolId);
  if (!tool) {
    setStatus({ phase: "error", toolName: toolId, message: `Unknown tool "${toolId}"` });
    return null;
  }

  const run = ++latestRun;
  const setRunStatus = (next: QuickAnalysisStatus): void => {
    if (run === latestRun) setStatus(next);
  };

  setRunStatus({ phase: "running", toolName: tool.name });
  const tracker = beginProcessingRun({
    kind: "vector",
    toolId: tool.id,
    toolName: tool.name,
    engine: "client",
    parameters,
  });

  // The client tools report failure by logging an "Error: ..." line rather than
  // throwing, so the log is the only signal that an apparently empty result was
  // actually a failure. Mirror how VectorToolsDialog reads it.
  const logLines: string[] = [];
  let softError: string | null = null;
  const log = (message: string): void => {
    logLines.push(message);
    if (!softError && message.startsWith("Error: ")) softError = message.slice("Error: ".length);
  };

  try {
    const captured = await runAlgorithmCapture(tool, parameters, {
      layers: [...useAppStore.getState().layers, ...extraLayers],
      log,
      viewportBounds: () => {
        const map = mapControllerRef.current?.getMap();
        if (!map) return null;
        const bounds = map.getBounds();
        return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
      },
    });

    if (softError) {
      tracker.finish("error", softError);
      setRunStatus({ phase: "error", toolName: tool.name, message: softError });
      return null;
    }
    const features = (captured as FeatureCollection | null)?.features ?? [];
    if (!features.length) {
      const message = logLines.at(-1) ?? "The tool produced no features";
      tracker.finish("error", message);
      setRunStatus({ phase: "error", toolName: tool.name, message });
      return null;
    }

    const layerId = useAppStore
      .getState()
      .addGeoJsonLayer(resultName, captured as FeatureCollection);
    tracker.addOutputLayer(resultName);
    tracker.finish("success");
    const layer = useAppStore.getState().layers.find((item) => item.id === layerId);
    if (layer) mapControllerRef.current?.fitLayer(layer);
    setRunStatus({ phase: "idle" });
    return layerId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    tracker.finish("error", message);
    setRunStatus({ phase: "error", toolName: tool.name, message });
    return null;
  }
}
