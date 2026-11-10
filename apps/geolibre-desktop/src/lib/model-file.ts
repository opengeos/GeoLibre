// Reading and writing the `.model.json` files Model Builder imports, exports
// and loads as sample workflows. Kept apart from the panel so the same checks
// guard a file picked from disk and a sample fetched from the network.
import { normalizeModelGraph, type ProcessingModelGraph } from "@geolibre/core";

/** Identifies an exported Model Builder file, so a stray JSON is rejected. */
export const MODEL_SCHEMA = "https://geolibre.app/schemas/model-graph-v1.json";
export const MODEL_VERSION = "1.0.0";

/** Sanity bounds on an imported file; a hand-built model is nowhere near these. */
export const MAX_IMPORT_NODES = 2000;
export const MAX_IMPORT_EDGES = 4000;
/**
 * Byte cap checked before the file is read, mirroring how the other importers
 * in this app bound size (`MAX_CIM_BYTES` in `arcgis-project-import.ts`). The
 * node/edge caps above can only fire once the whole file has been decoded and
 * parsed, so a pathological file would be fully loaded before anything could
 * reject it. A model at the node/edge caps serializes well under this.
 */
export const MAX_IMPORT_BYTES = 16 * 1024 * 1024;

/** Why a model file was rejected; each maps to one catalog message. */
export type ModelFileError = "tooLarge" | "unsupported" | "invalid";

/** The outcome of {@link parseModelFile}. */
export type ParsedModelFile =
  | { ok: true; name: string; graph: ProcessingModelGraph }
  | { ok: false; error: ModelFileError };

/**
 * Parse the text of a `.model.json` file into a usable graph.
 *
 * `normalizeModelGraph` is the same coercion the project loader applies: it
 * drops nodes without a usable id or kind and edges that do not connect two
 * surviving nodes, so a hand-edited file cannot reach the canvas with (say) a
 * missing `edges` array that would then throw out of render into the panel's
 * error boundary.
 *
 * @param text The raw file contents.
 * @returns The model's name and graph, or the reason it was rejected.
 */
export function parseModelFile(text: string): ParsedModelFile {
  let parsed: { $schema?: unknown; name?: unknown; graph?: unknown } | null;
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return { ok: false, error: "invalid" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, error: "invalid" };
  if (parsed.$schema !== undefined && parsed.$schema !== MODEL_SCHEMA) {
    return { ok: false, error: "unsupported" };
  }
  const graph = normalizeModelGraph(parsed.graph);
  if (!graph) return { ok: false, error: "invalid" };
  // A canvas is hand-built; anything this large is a corrupt or crafted file,
  // and laying it out would stall the panel before the user could even see
  // what went wrong.
  if (graph.nodes.length > MAX_IMPORT_NODES || graph.edges.length > MAX_IMPORT_EDGES) {
    return { ok: false, error: "tooLarge" };
  }
  return { ok: true, name: typeof parsed.name === "string" ? parsed.name : "", graph };
}

/**
 * Serialize a model to the `.model.json` format {@link parseModelFile} reads.
 *
 * @param name The model name.
 * @param graph The model graph.
 * @returns Pretty-printed JSON text.
 */
export function serializeModelFile(name: string, graph: ProcessingModelGraph): string {
  return JSON.stringify({ $schema: MODEL_SCHEMA, version: MODEL_VERSION, name, graph }, null, 2);
}

/**
 * Read a response body as text, giving up once it passes `maxBytes`.
 *
 * `response.text()` buffers the whole body before its size can be checked, so
 * an oversized file (or one served chunked, with no `Content-Length`) would be
 * held in memory in full just to be rejected. Streaming with a running byte
 * count stops at the cap instead.
 *
 * @param response The fetch response.
 * @param maxBytes The largest body accepted, in bytes.
 * @returns The decoded text, or `null` when the body is larger than `maxBytes`.
 */
export async function readTextCapped(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) {
    const text = await response.text();
    return new TextEncoder().encode(text).byteLength > maxBytes ? null : text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
