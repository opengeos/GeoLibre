/**
 * Batch export of vector layers as GeoJSON files packaged into a `.zip`
 * archive (issue #3528). Shared by Project → Export → Export layers as GeoJSON
 * ZIP, the Save layer edits dialog, and the Save project prompt.
 */

import {
  DEFAULT_PROJECT_NAME,
  excludeHiddenFieldsFromGeojson,
  resolveLayerCapabilities,
  useAppStore,
  type AppState,
  type GeoLibreLayer,
} from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  commitPendingAttributeDrafts,
  type PendingAttributeDraftsResult,
} from "./attribute-draft-commit";
import { resolveLayerGeojson, sanitizeExportFileName } from "./vector-export";

/** One resolved vector layer ready to be written as a `.geojson` file. */
export interface ResolvedGeojsonExportItem {
  layer: GeoLibreLayer;
  fileName: string;
  geojson: FeatureCollection;
  /** The layer's `geojson` reference captured before async resolution began. */
  sourceGeojson?: FeatureCollection;
}

/** Outcome of collecting exportable GeoJSON layers from a project. */
export interface CollectedGeojsonExport {
  items: ResolvedGeojsonExportItem[];
  /** Layer names skipped because their pending attribute drafts could not commit. */
  blockedDraftLayers: string[];
  /** Layer names skipped because their feature data could not be resolved. */
  skippedLayers: string[];
  /** True when collection stopped early because the project changed mid-run. */
  aborted: boolean;
}

/** Injectable dependencies for {@link collectGeojsonLayersForExport} (unit tests). */
export interface CollectGeojsonExportDeps {
  commitDrafts?: (layerId: string) => PendingAttributeDraftsResult;
  readLatestLayer?: (layerId: string) => GeoLibreLayer | undefined;
  readProjectGeneration?: () => number;
  resolveGeojson?: (
    layer: GeoLibreLayer,
    map: MapLibreMap | undefined,
  ) => Promise<FeatureCollection | null>;
  materializeEmbeddable?: (layers: GeoLibreLayer[]) => Promise<Map<string, FeatureCollection>>;
}

/**
 * Whether the active deployment and session role both permit exporting data
 * out of the application (`export:data`).
 */
export function isExportDataAllowed(
  state: Pick<AppState, "deploymentCapabilities" | "capabilities"> = useAppStore.getState(),
): boolean {
  return (
    state.deploymentCapabilities.has("export:data") &&
    state.capabilities.privileges.includes("export:data")
  );
}

/**
 * Whether a layer can be exported as a GeoJSON file in a batch export.
 * Matches single-layer GeoJSON export: GeoJSON-backed vector layers whose
 * resolved capabilities allow `export`.
 */
export function isExportableGeojsonLayer(layer: GeoLibreLayer): boolean {
  return layer.type === "geojson" && resolveLayerCapabilities(layer).export;
}

const WINDOWS_RESERVED_SEGMENT_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?=\.|$)/i;

/**
 * Build collision-free `.geojson` file names for a list of layers.
 *
 * Strips a trailing `.geojson` / `.json` suffix already present on a layer name
 * so `"roads.geojson"` does not become `"roads.geojson.geojson"`, escapes
 * Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`,
 * `LPT1`–`LPT9`), and deduplicates case-insensitively (`roads.geojson`,
 * `roads-2.geojson`, …) so archives unzip cleanly on Windows and macOS
 * filesystems.
 */
export function buildUniqueGeojsonZipEntryNames(
  layers: ReadonlyArray<Pick<GeoLibreLayer, "id" | "name">>,
): Map<string, string> {
  const usedLower = new Set<string>();
  const result = new Map<string, string>();
  for (const layer of layers) {
    const stripped = layer.name.trim().replace(/\.(geo)?json$/i, "");
    const rawBase = sanitizeExportFileName(stripped);
    const base = rawBase.replace(WINDOWS_RESERVED_SEGMENT_RE, "$1-layer");
    let candidate = `${base}.geojson`;
    let suffix = 2;
    while (usedLower.has(candidate.toLowerCase())) {
      candidate = `${base}-${suffix}.geojson`;
      suffix += 1;
    }
    usedLower.add(candidate.toLowerCase());
    result.set(layer.id, candidate);
  }
  return result;
}

/**
 * Build a default archive filename slug (without `.zip`) from the project name.
 */
export function buildProjectGeojsonZipSlug(projectName: string): string {
  const base =
    (projectName.trim() || DEFAULT_PROJECT_NAME)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "geolibre-map";
  return `${base}-geojson`;
}

/**
 * Collect and serialize-prepare all exportable GeoJSON layers (or the subset
 * named by `layerIds`). Commits pending attribute drafts first so unsaved table
 * edits are never silently omitted, and strips hidden/excluded fields so egress
 * honours `layer.fieldVisibility`.
 */
export async function collectGeojsonLayersForExport(
  layers: readonly GeoLibreLayer[],
  map: MapLibreMap | undefined,
  options?: {
    layerIds?: ReadonlySet<string>;
    projectGeneration?: number;
    isCancelled?: () => boolean;
    /**
     * Keep hidden/excluded fields when writing local working copies that will
     * become the layer's own `sourcePath` (Save Project -> Save external copies).
     * Defaults to `false` so exports always strip excluded fields.
     */
    preserveHiddenFields?: boolean;
    deps?: CollectGeojsonExportDeps;
  },
): Promise<CollectedGeojsonExport> {
  const commitDrafts = options?.deps?.commitDrafts ?? commitPendingAttributeDrafts;
  const readLatestLayer =
    options?.deps?.readLatestLayer ??
    ((layerId: string) =>
      useAppStore.getState().layers.find((candidate) => candidate.id === layerId));
  const readProjectGeneration =
    options?.deps?.readProjectGeneration ?? (() => useAppStore.getState().projectGeneration);
  const resolveGeojson = options?.deps?.resolveGeojson ?? resolveLayerGeojson;
  const materializeEmbeddable = options?.deps?.materializeEmbeddable;
  const isStale = () =>
    Boolean(options?.isCancelled?.()) ||
    (options?.projectGeneration !== undefined &&
      readProjectGeneration() !== options.projectGeneration);

  const eligible = layers.filter(
    (layer) =>
      isExportableGeojsonLayer(layer) && (!options?.layerIds || options.layerIds.has(layer.id)),
  );
  const fileNames = buildUniqueGeojsonZipEntryNames(eligible);
  const items: ResolvedGeojsonExportItem[] = [];
  const blockedDraftLayers: string[] = [];
  const skippedLayers: string[] = [];

  for (const layer of eligible) {
    if (isStale()) return { items, blockedDraftLayers, skippedLayers, aborted: true };

    // Validate the live layer before committing its drafts so a layer removed
    // or stripped of export permission while an earlier layer loaded is skipped.
    const liveBeforeCommit = readLatestLayer(layer.id);
    if (!liveBeforeCommit || !isExportableGeojsonLayer(liveBeforeCommit)) continue;

    if (commitDrafts(layer.id) === "blocked") {
      blockedDraftLayers.push(liveBeforeCommit.name);
      continue;
    }
    if (isStale()) return { items, blockedDraftLayers, skippedLayers, aborted: true };

    const current = readLatestLayer(layer.id);
    if (!current || !isExportableGeojsonLayer(current)) continue;
    const capturedSourceGeojson = current.geojson;

    let geojson: FeatureCollection | null = null;
    try {
      geojson = await resolveGeojson(current, map);
    } catch {
      geojson = null;
    }
    if (isStale()) return { items, blockedDraftLayers, skippedLayers, aborted: true };

    if (!geojson) {
      try {
        if (materializeEmbeddable) {
          const materialized = await materializeEmbeddable([current]);
          geojson = materialized.get(current.id) ?? null;
        } else {
          const { isEmbeddableLocalVectorLayer, materializeEmbeddableVectorLayers } =
            await import("@geolibre/plugins");
          if (isEmbeddableLocalVectorLayer(current)) {
            const materialized = await materializeEmbeddableVectorLayers([current]);
            geojson = materialized.get(current.id) ?? null;
          }
        }
      } catch {
        geojson = null;
      }
    }
    if (isStale()) return { items, blockedDraftLayers, skippedLayers, aborted: true };

    // Revalidate live permission after async resolution before emitting data.
    const liveAfterResolve = readLatestLayer(layer.id);
    if (!liveAfterResolve || !isExportableGeojsonLayer(liveAfterResolve)) continue;

    if (!geojson) {
      skippedLayers.push(liveAfterResolve.name);
      continue;
    }
    const egressGeojson =
      !options?.preserveHiddenFields && liveAfterResolve.fieldVisibility
        ? excludeHiddenFieldsFromGeojson(geojson, liveAfterResolve.fieldVisibility)
        : geojson;
    items.push({
      layer: liveAfterResolve,
      fileName:
        fileNames.get(layer.id) ?? `${sanitizeExportFileName(liveAfterResolve.name)}.geojson`,
      geojson: egressGeojson,
      sourceGeojson: capturedSourceGeojson,
    });
  }

  return { items, blockedDraftLayers, skippedLayers, aborted: false };
}

/**
 * Package resolved GeoJSON layers into a `.zip` archive (`Uint8Array`).
 * Each entry is formatted with 2-space indentation to match single-layer
 * GeoJSON export.
 */
export async function buildGeojsonZipArchive(
  entries: ReadonlyArray<Pick<ResolvedGeojsonExportItem, "fileName" | "geojson">>,
): Promise<Uint8Array> {
  const { strToU8, zip } = await import("fflate");
  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    files[entry.fileName] = strToU8(JSON.stringify(entry.geojson, null, 2));
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    zip(files, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}
