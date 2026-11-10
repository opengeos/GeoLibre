// Sample workflows offered by Model Builder's Samples menu. The list is a small
// static manifest (`sample-models.json`) of `.model.json` files hosted in
// opengeos/geolibre-assets under https://assets.geolibre.app/models/, so it
// ships with the app and needs no request to render; only loading a sample
// (its model file and its sample data) touches the network.
//
// A sample's input nodes name placeholder layer ids (`sample-dem`, ...) rather
// than ids from any real project. Each placeholder is listed under the
// sample's `data`, which says where to fetch a layer for it, so loading a
// sample adds (or reuses) that layer and rewrites the placeholder to its id.
import type { GeoLibreLayer, ProcessingModelGraph } from "@geolibre/core";
import manifest from "./sample-models.json";

/** One dataset a sample's input node reads. */
export interface SampleModelData {
  /** The placeholder layer id the model's input nodes use for this dataset. */
  layerId: string;
  /** Layer name given to the dataset when it is added to the map. */
  name: string;
  /** Absolute https URL of the dataset (a COG for rasters, GeoJSON for vectors). */
  url: string;
  kind: "raster" | "vector";
}

/** One curated sample workflow. */
export interface SampleModel {
  /** Stable id (the model file's slug). */
  id: string;
  /** Display title. Sample titles are content, shown untranslated. */
  title: string;
  /** One-line description of what the workflow does. */
  description: string;
  /** Absolute https URL of the `.model.json` file. */
  modelUrl: string;
  /** Sample datasets bound to the model's input nodes when it loads. */
  data: SampleModelData[];
}

const REQUIRED_FIELDS = ["id", "title", "description", "modelUrl"] as const;
const DATA_FIELDS = ["layerId", "name", "url"] as const;

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Validate a raw sample-model manifest, returning the problems found. An empty
 * array means every entry is usable.
 *
 * @param raw The parsed manifest JSON (`{ samples: [...] }`).
 * @returns Human-readable problems, one per offending field or entry.
 */
export function validateSampleModelManifest(raw: unknown): string[] {
  const samples = (raw as { samples?: unknown } | null)?.samples;
  if (!Array.isArray(samples)) return ["manifest has no `samples` array"];
  const problems: string[] = [];
  const seen = new Set<string>();
  samples.forEach((entry: unknown, index) => {
    if (!entry || typeof entry !== "object") {
      problems.push(`samples[${index}] is not an object`);
      return;
    }
    const record = entry as Record<string, unknown>;
    for (const field of REQUIRED_FIELDS) {
      if (!isNonEmptyString(record[field])) {
        problems.push(`samples[${index}].${field} is missing or empty`);
      }
    }
    if (isNonEmptyString(record.modelUrl) && !isHttpsUrl(record.modelUrl)) {
      problems.push(`samples[${index}].modelUrl is not an https URL`);
    }
    if (typeof record.id === "string") {
      if (seen.has(record.id)) problems.push(`samples[${index}].id "${record.id}" is duplicated`);
      seen.add(record.id);
    }
    if (!Array.isArray(record.data)) {
      problems.push(`samples[${index}].data is not an array`);
      return;
    }
    record.data.forEach((item: unknown, dataIndex) => {
      const where = `samples[${index}].data[${dataIndex}]`;
      if (!item || typeof item !== "object") {
        problems.push(`${where} is not an object`);
        return;
      }
      const data = item as Record<string, unknown>;
      for (const field of DATA_FIELDS) {
        if (!isNonEmptyString(data[field])) problems.push(`${where}.${field} is missing or empty`);
      }
      if (isNonEmptyString(data.url) && !isHttpsUrl(data.url)) {
        problems.push(`${where}.url is not an https URL`);
      }
      if (data.kind !== "raster" && data.kind !== "vector") {
        problems.push(`${where}.kind must be "raster" or "vector"`);
      }
    });
  });
  return problems;
}

/** The bundled sample workflows, in menu order. */
export const SAMPLE_MODELS: readonly SampleModel[] = (manifest as { samples: SampleModel[] })
  .samples;

/**
 * Find a project layer already holding a sample dataset, so loading a second
 * sample (or the same one twice) reuses it rather than stacking duplicates.
 *
 * @param layers The project layers.
 * @param url The dataset URL.
 * @returns The matching layer's id, or undefined.
 */
export function findSampleDataLayer(layers: GeoLibreLayer[], url: string): string | undefined {
  return layers.find((layer) => {
    if (layer.sourcePath === url) return true;
    const source = layer.source as { url?: unknown } | undefined;
    return source?.url === url;
  })?.id;
}

/**
 * Rewrite a sample's placeholder layer ids to the project layers bound to them.
 *
 * Input nodes carry the placeholder in `layerId`; a tool or control node can
 * also name one in a parameter (an unwired layer input), so string parameter
 * values equal to a placeholder are rewritten too. A placeholder with no
 * binding is cleared from input nodes, leaving them for the user to pick
 * rather than pointing at a layer that does not exist.
 *
 * @param graph The sample graph.
 * @param bindings Placeholder id to project layer id.
 * @param placeholders Every placeholder id the sample declares.
 * @returns A new graph; the input is not mutated.
 */
export function bindSampleModelInputs(
  graph: ProcessingModelGraph,
  bindings: ReadonlyMap<string, string>,
  placeholders: ReadonlySet<string> = new Set(bindings.keys()),
): ProcessingModelGraph {
  const rebind = (value: string) => bindings.get(value);
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      let next = node;
      if (node.layerId && placeholders.has(node.layerId)) {
        const bound = rebind(node.layerId);
        next = { ...next, layerId: bound };
        if (!bound) delete next.layerId;
      }
      if (node.parameters) {
        let changed = false;
        const parameters: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(node.parameters)) {
          if (typeof value === "string" && placeholders.has(value)) {
            parameters[key] = rebind(value) ?? "";
            changed = true;
          } else {
            parameters[key] = value;
          }
        }
        if (changed) next = { ...next, parameters };
      }
      return next;
    }),
  };
}
