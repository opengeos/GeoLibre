// The message protocol between vector-tool-runner.ts (main thread) and
// vector-tool.worker.ts, plus the worker-side session. The session lives here
// rather than in the worker file so tests can drive it in-process through a fake
// Worker, exercising the same structured-clone boundary without a real thread.
//
// Feature arrays cross in chunks, in both directions. Structured cloning is
// itself main-thread work — ~0.1 s to serialize 20k 32-vertex polygons on the
// way in, as much again to deserialize a result of that size on the way back —
// and one message is one uninterrupted task. Splitting the features over
// several messages bounds each task by the chunk size instead of by the layer.
import type { Feature, FeatureCollection } from "geojson";
import { setActiveEllipsoidId, type GeoLibreLayer } from "@geolibre/core/worker-safe";
import type { ProcessingContext, ResultLayerOptions } from "./types";
import { WORKER_VECTOR_TOOLS } from "./vector-tool-worker-tools";

/** Features per chunk message. */
export const VECTOR_TOOL_CHUNK_FEATURES = 2_000;

/**
 * The part of a layer a Turf vector tool reads. Only these fields cross to the
 * worker, so styling, metadata, and anything else a layer record carries never
 * has to survive a structured clone.
 */
export type VectorToolWorkerLayer = Pick<GeoLibreLayer, "id" | "name" | "type" | "geojson">;

/** The run itself, posted after every input layer has been sent. */
export interface VectorToolRunRequest {
  /** Registry id of the tool; the worker resolves it in `WORKER_VECTOR_TOOLS`. */
  toolId: string;
  parameters: Record<string, unknown>;
  /**
   * The map viewport, read on the main thread when the run starts, since the
   * worker cannot reach the map. Tools that fall back to the view (the grid
   * tool with no extent layer) read it synchronously at the start of their run,
   * so a snapshot taken just before is the value they would have seen.
   */
  viewportBounds: [number, number, number, number] | null;
  /**
   * The active planetary body. Turf is Earth-locked and the tools rescale
   * lengths by the active body's radius, which is module state in
   * `@geolibre/core` — the worker's copy starts at Earth, so it is set from
   * this before the run.
   */
  ellipsoidId: string;
}

/**
 * Main thread → worker. A run is: one `layer` per input layer (its
 * FeatureCollection sent with an empty `features` array), the layer's features
 * in `layer-features` chunks, then a single `run`.
 */
export type VectorToolWorkerRequest =
  | { type: "layer"; layer: VectorToolWorkerLayer }
  | { type: "layer-features"; layerId: string; features: Feature[] }
  | ({ type: "run" } & VectorToolRunRequest);

/**
 * Worker → main thread: `ready` once the worker has loaded, then, in the order
 * the tool produced it: any number of `log`,
 * `fit-bounds` and results (a `result-start`, its features in `result-features`
 * chunks, then `result-end`), then exactly one `done` or `error`.
 */
export type VectorToolWorkerMessage =
  /** Posted once when the worker's module has loaded, before any request. */
  | { type: "ready" }
  | { type: "log"; message: string }
  | {
      type: "result-start";
      name: string;
      /** The result collection with an empty `features` array. */
      collection: FeatureCollection;
      options?: ResultLayerOptions;
    }
  | { type: "result-features"; features: Feature[] }
  | { type: "result-end" }
  | { type: "fit-bounds"; bounds: [number, number, number, number] }
  | { type: "done" }
  | { type: "error"; message: string };

/**
 * Split a collection into a feature-less header and its features in chunks.
 *
 * @param collection The collection to split.
 * @returns The header (every member but `features`, plus an empty array) and
 *   the feature chunks, in order.
 */
export function chunkFeatureCollection(collection: FeatureCollection): {
  header: FeatureCollection;
  chunks: Feature[][];
} {
  const { features, ...rest } = collection;
  const chunks: Feature[][] = [];
  for (let start = 0; start < features.length; start += VECTOR_TOOL_CHUNK_FEATURES) {
    chunks.push(features.slice(start, start + VECTOR_TOOL_CHUNK_FEATURES));
  }
  return { header: { ...rest, features: [] }, chunks };
}

/**
 * Worker-side state: collects the input layers as their chunks arrive, then
 * runs the tool on `run`, posting each callback the tool makes. The layers are
 * dropped when the run ends, so a parked worker starts its next run empty.
 *
 * @param post Sends one message back to the main thread.
 * @returns The handler for each message the main thread posts.
 */
export function createVectorToolSession(
  post: (message: VectorToolWorkerMessage) => void,
): (request: VectorToolWorkerRequest) => Promise<void> {
  const layers = new Map<string, VectorToolWorkerLayer>();

  const postResult = (name: string, geojson: FeatureCollection, options?: ResultLayerOptions) => {
    const { header, chunks } = chunkFeatureCollection(geojson);
    post(
      options === undefined
        ? { type: "result-start", name, collection: header }
        : { type: "result-start", name, collection: header, options },
    );
    for (const features of chunks) post({ type: "result-features", features });
    post({ type: "result-end" });
  };

  return async (request) => {
    // Everything inside the try: a request that throws must still post an
    // `error`, or the main thread would wait for a `done` that never comes.
    try {
      if (request.type === "layer") {
        layers.set(request.layer.id, request.layer);
        return;
      }
      if (request.type === "layer-features") {
        const features = layers.get(request.layerId)?.geojson?.features;
        if (features) for (const feature of request.features) features.push(feature);
        return;
      }
      const runLayers = [...layers.values()] as GeoLibreLayer[];
      layers.clear();
      const tool = WORKER_VECTOR_TOOLS.get(request.toolId);
      if (!tool) throw new Error(`Unknown tool "${request.toolId}"`);
      setActiveEllipsoidId(request.ellipsoidId);
      const ctx: ProcessingContext = {
        layers: runLayers,
        parameters: request.parameters,
        log: (message) => post({ type: "log", message }),
        fitBounds: (bounds) => post({ type: "fit-bounds", bounds }),
        addResultLayer: postResult,
        viewportBounds: () => request.viewportBounds,
      };
      await tool.run(ctx);
      post({ type: "done" });
    } catch (error) {
      post({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };
}
