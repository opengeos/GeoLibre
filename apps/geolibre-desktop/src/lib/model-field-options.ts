import type { ModelGraphNode, ProcessingModelGraph } from "@geolibre/core";
import type { AlgorithmParameter, ModelToolDescriptor } from "@geolibre/processing";

/**
 * The attribute-column names a Model Builder tool node can offer for one of its
 * `type: "field"` parameters (GeoLibre#2710).
 *
 * The columns come from whatever feeds the parameter's source input: a wired
 * `input` node's project layer, or, with nothing wired, a layer picked in the
 * properties panel (a client vector tool offers its layer parameters there
 * too). A source wired from another tool contributes nothing, because that
 * tool's columns only exist once the model runs; the panel keeps the field
 * editable as free text for exactly that case.
 *
 * Which input is the source: the parameter's `fieldSource` when set. Unset, a
 * client vector tool reads its `"layer"` parameter (the registry convention),
 * while a Whitebox tool whose inputs could not be told apart offers the columns
 * of every vector input rather than guessing one.
 *
 * @param graph The model graph.
 * @param node The tool node being edited.
 * @param descriptor The node's resolved tool descriptor.
 * @param param The field parameter.
 * @param fieldsByLayer Column names per project layer id.
 * @returns The known column names, de-duplicated in first-seen order; empty
 *   when no source layer is known yet.
 */
export function modelFieldOptions(
  graph: ProcessingModelGraph,
  node: ModelGraphNode,
  descriptor: ModelToolDescriptor,
  param: AlgorithmParameter,
  fieldsByLayer: ReadonlyMap<string, string[]>,
): string[] {
  const sources = param.fieldSource
    ? [param.fieldSource]
    : descriptor.provider === "vector"
      ? ["layer"]
      : descriptor.inputs.filter((port) => port.kind === "vector").map((port) => port.id);
  const columns = new Set<string>();
  for (const source of sources) {
    for (const column of sourceColumns(graph, node, source, fieldsByLayer)) columns.add(column);
  }
  return [...columns];
}

/**
 * Column names reaching one input port of a tool node.
 *
 * @param graph The model graph.
 * @param node The tool node.
 * @param portId The input port (for a client vector tool, also its layer
 *   parameter id).
 * @param fieldsByLayer Column names per project layer id.
 * @returns The source layer's columns, or an empty list when the port is fed
 *   by another tool or nothing is chosen yet.
 */
function sourceColumns(
  graph: ProcessingModelGraph,
  node: ModelGraphNode,
  portId: string,
  fieldsByLayer: ReadonlyMap<string, string[]>,
): string[] {
  const edge = graph.edges.find(
    (candidate) => candidate.to === node.id && candidate.toPort === portId,
  );
  if (edge) {
    const from = graph.nodes.find((candidate) => candidate.id === edge.from);
    if (from?.kind !== "input" || !from.layerId) return [];
    return fieldsByLayer.get(from.layerId) ?? [];
  }
  const picked = node.parameters?.[portId];
  return typeof picked === "string" ? (fieldsByLayer.get(picked) ?? []) : [];
}
