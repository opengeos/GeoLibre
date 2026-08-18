import type {
  AlgorithmParameter,
  ModelToolDescriptor,
  ModelToolPort,
  ProcessingAlgorithm,
  WhiteboxTool,
  WhiteboxToolParameter,
} from "@geolibre/processing";
import { parameterKind } from "./whitebox-param-kind";

/** Palette group for Whitebox tools that arrive without a category. */
const UNCATEGORIZED = "Other";

/**
 * Build the palette key for a tool. Whitebox and the client vector registry both
 * define e.g. `buffer`, so the provider has to be part of the identity.
 *
 * @param provider Which registry the tool comes from.
 * @param toolId The tool's id within that registry.
 * @returns The globally unique key used by the palette and by saved nodes.
 */
export function modelToolKey(provider: "vector" | "whitebox", toolId: string): string {
  return `${provider}:${toolId}`;
}

/**
 * Adapt a client vector algorithm to a Model Builder descriptor.
 *
 * Its `type: "layer"` parameters become input ports (wiring an edge and picking
 * a layer by hand write the same slot, so they keep their parameter ids), and
 * the tool gains the single vector output port the client runner produces.
 *
 * @param algorithm The registry algorithm.
 * @returns The descriptor the canvas and graph runner use.
 */
export function vectorToolDescriptor(algorithm: ProcessingAlgorithm): ModelToolDescriptor {
  const inputs: ModelToolPort[] = [];
  const parameters: AlgorithmParameter[] = [];
  for (const param of algorithm.parameters) {
    if (param.type === "layer") {
      inputs.push({
        id: param.id,
        label: param.label,
        kind: "vector",
        required: param.required,
      });
      // Still offered in the properties panel, so a single-node model can name a
      // project layer without drawing an input node for it.
      parameters.push(param);
      continue;
    }
    parameters.push(param);
  }
  return {
    key: modelToolKey("vector", algorithm.id),
    provider: "vector",
    toolId: algorithm.id,
    name: algorithm.name,
    group: algorithm.group ?? UNCATEGORIZED,
    description: algorithm.description,
    inputs,
    outputs: [{ id: "out", label: "Output", kind: "vector" }],
    parameters,
  };
}

/** Map a Whitebox scalar parameter onto the field type the properties panel renders. */
function whiteboxScalarParameter(
  param: WhiteboxToolParameter,
  kind: string,
): AlgorithmParameter | null {
  const base = {
    id: param.name,
    label: param.name,
    required: param.required,
    description: param.description,
    default: param.default,
  };
  if (kind === "bool") return { ...base, type: "boolean" };
  if (kind === "int" || kind === "double") return { ...base, type: "number" };
  if (kind === "enum") {
    return {
      ...base,
      type: "select",
      options: (param.options ?? []).map((option) => ({ value: option, label: option })),
    };
  }
  if (kind === "string") return { ...base, type: "string" };
  // lidar_in / file_in / file_out and anything unrecognized: a path the user
  // supplies rather than something an edge can carry, since a model value is
  // only ever vector or raster.
  return { ...base, type: "path" };
}

/**
 * Adapt a Whitebox (or GeoLibre-authored WASM) tool manifest to a Model Builder
 * descriptor.
 *
 * `raster_in`/`vector_in` parameters become typed input ports and
 * `raster_out`/`vector_out` become output ports, which is what lets a Whitebox
 * node sit in the same graph as a client vector node. LiDAR and file parameters
 * stay plain fields: a model value is only ever vector or raster, so an edge
 * could not carry them.
 *
 * @param tool The merged catalog/WASM manifest.
 * @returns The descriptor, or `null` for a tool with no output port — nothing
 *   downstream could consume it, so it would be dead weight on the canvas.
 */
export function whiteboxToolDescriptor(tool: WhiteboxTool): ModelToolDescriptor | null {
  const inputs: ModelToolPort[] = [];
  const outputs: ModelToolPort[] = [];
  const parameters: AlgorithmParameter[] = [];
  for (const param of tool.params ?? []) {
    const kind = parameterKind(param);
    if (kind === "raster_in" || kind === "vector_in") {
      inputs.push({
        id: param.name,
        label: param.name,
        kind: kind === "raster_in" ? "raster" : "vector",
        required: param.required,
      });
      continue;
    }
    if (kind === "raster_out" || kind === "vector_out") {
      outputs.push({
        id: param.name,
        label: param.name,
        kind: kind === "raster_out" ? "raster" : "vector",
      });
      continue;
    }
    const mapped = whiteboxScalarParameter(param, kind);
    if (mapped) parameters.push(mapped);
  }
  if (outputs.length === 0) return null;
  const group =
    tool.taxonomy_category?.trim() ||
    tool.category?.trim() ||
    (tool.source ? "GeoLibre" : UNCATEGORIZED);
  return {
    key: modelToolKey("whitebox", tool.id),
    provider: "whitebox",
    toolId: tool.id,
    name: tool.display_name?.trim() || tool.id,
    group,
    description: tool.summary,
    inputs,
    outputs,
    parameters,
    // The WASM runner walks this manifest to build its CLI arguments.
    native: tool,
  };
}

/**
 * Build the combined palette from both registries.
 *
 * Locked ("pro"-tier) Whitebox tools are dropped: they cannot run, so offering
 * them on the canvas would only produce a model that fails at the last step.
 *
 * @param vectorTools The client vector algorithm registry.
 * @param whiteboxTools Merged Whitebox catalog + WASM manifests.
 * @returns Descriptors sorted by group then name, ready for the palette.
 */
export function buildModelToolCatalog(
  vectorTools: ProcessingAlgorithm[],
  whiteboxTools: WhiteboxTool[],
): ModelToolDescriptor[] {
  const descriptors: ModelToolDescriptor[] = vectorTools.map(vectorToolDescriptor);
  for (const tool of whiteboxTools) {
    if (tool.locked) continue;
    const descriptor = whiteboxToolDescriptor(tool);
    if (descriptor) descriptors.push(descriptor);
  }
  descriptors.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  return descriptors;
}

/**
 * Group a descriptor list for the palette's collapsible sections, preserving the
 * sorted order {@link buildModelToolCatalog} produced.
 *
 * @param descriptors The palette entries.
 * @returns One entry per group, in first-seen order.
 */
export function groupModelTools(
  descriptors: ModelToolDescriptor[],
): { group: string; tools: ModelToolDescriptor[] }[] {
  const groups = new Map<string, ModelToolDescriptor[]>();
  for (const descriptor of descriptors) {
    const list = groups.get(descriptor.group) ?? [];
    list.push(descriptor);
    groups.set(descriptor.group, list);
  }
  return [...groups].map(([group, tools]) => ({ group, tools }));
}

/**
 * Filter the palette by a free-text query, matching tool name, id and group so
 * "terrain" finds a slope tool and "buffer" finds it under either provider.
 *
 * @param descriptors The palette entries.
 * @param query The user's search text; blank returns everything.
 * @returns The matching entries, in their original order.
 */
export function searchModelTools(
  descriptors: ModelToolDescriptor[],
  query: string,
): ModelToolDescriptor[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return descriptors;
  return descriptors.filter((descriptor) =>
    `${descriptor.name} ${descriptor.toolId} ${descriptor.group}`.toLowerCase().includes(needle),
  );
}
