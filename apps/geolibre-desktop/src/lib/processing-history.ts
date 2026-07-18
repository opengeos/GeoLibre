import { useAppStore, type ProcessingRunKind, type ProcessingRunStatus } from "@geolibre/core";

/** Prefix the Whitebox dialog uses for layer-reference parameter values. */
const LAYER_TOKEN_PREFIX = "layer:";

/**
 * Cap on per-job history trackers the job-based dialogs (Whitebox, Raster)
 * retain; oldest entries are evicted once exceeded. Shared here so the two
 * dialogs cannot drift apart.
 */
export const MAX_TRACKED_HISTORY_JOBS = 50;

/**
 * Tracks one in-flight processing run for the Processing History panel
 * (issue #1292). Created by {@link beginProcessingRun} when a dialog dispatches
 * a tool; the dialog reports produced layers via `addOutputLayer` and seals the
 * record with `finish`. Layers reported after `finish` (e.g. a sidecar job's
 * outputs imported asynchronously) are patched into the already-recorded entry.
 */
export interface ProcessingRunTracker {
  /** Id of the history entry this tracker writes. */
  id: string;
  /** Report a layer the run added to the map. Safe to call after `finish`. */
  addOutputLayer: (name: string) => void;
  /** Record the run. Idempotent: only the first call writes the entry. */
  finish: (status: ProcessingRunStatus, error?: string) => void;
}

function makeRunId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `run-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/**
 * Snapshot the names of layers referenced by parameter values. Parameter values
 * reference layers by id (the Whitebox dialog prefixes them with `layer:`), and
 * a layer can be renamed or removed before the History panel renders, so the
 * names are captured at run time.
 */
function snapshotInputLayerNames(
  parameters: Record<string, unknown>,
): Record<string, string> | undefined {
  const layers = useAppStore.getState().layers;
  const names: Record<string, string> = {};
  for (const value of Object.values(parameters)) {
    if (typeof value !== "string" || !value) continue;
    const layerId = value.startsWith(LAYER_TOKEN_PREFIX)
      ? value.slice(LAYER_TOKEN_PREFIX.length)
      : value;
    const layer = layers.find((item) => item.id === layerId);
    if (layer) names[layerId] = layer.name;
  }
  return Object.keys(names).length > 0 ? names : undefined;
}

/**
 * Start tracking a processing run for the History panel.
 *
 * @param entry - The run's identity: dialog family, tool, engine, and the
 *   parameter values exactly as dispatched (layer parameters hold layer ids).
 * @param paths - Optional input/output file paths for file-based tools.
 * @returns A tracker the caller finishes when the run completes.
 */
export function beginProcessingRun(
  entry: {
    kind: ProcessingRunKind;
    toolId: string;
    toolName: string;
    engine: string;
    parameters: Record<string, unknown>;
  },
  paths?: { inputPath?: string; outputPath?: string },
): ProcessingRunTracker {
  const startedAt = Date.now();
  const id = makeRunId();
  const outputs: string[] = [];
  let finished = false;
  const inputLayerNames = snapshotInputLayerNames(entry.parameters);

  return {
    id,
    addOutputLayer: (name) => {
      if (!finished) {
        outputs.push(name);
        return;
      }
      // The run is already recorded (e.g. an async job import): patch the entry.
      const state = useAppStore.getState();
      const run = state.processingHistory.find((item) => item.id === id);
      state.updateProcessingRun(id, {
        outputLayerNames: [...(run?.outputLayerNames ?? []), name],
      });
    },
    finish: (status, error) => {
      if (finished) return;
      finished = true;
      useAppStore.getState().addProcessingRun({
        id,
        kind: entry.kind,
        toolId: entry.toolId,
        toolName: entry.toolName,
        engine: entry.engine,
        parameters: { ...entry.parameters },
        ...(inputLayerNames ? { inputLayerNames } : {}),
        ...(outputs.length > 0 ? { outputLayerNames: [...outputs] } : {}),
        ...(paths?.inputPath ? { inputPath: paths.inputPath } : {}),
        ...(paths?.outputPath ? { outputPath: paths.outputPath } : {}),
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        status,
        ...(error ? { error } : {}),
      });
    },
  };
}
