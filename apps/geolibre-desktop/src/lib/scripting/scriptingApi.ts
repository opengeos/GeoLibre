import { useAppStore } from "@geolibre/core";
import {
  ALGORITHMS,
  VECTOR_TOOLS,
  H3_TOOLS,
  STATISTICS_TOOLS,
  fetchRemoteWhiteboxCatalogSnapshot,
  listWasmToolManifests,
  mergeWasmToolManifests,
  runWhiteboxToolWasm,
  type ProcessingAlgorithm,
  type ProcessingContext,
  type WhiteboxLayerInput,
  type WhiteboxTool,
} from "@geolibre/processing";
import { SKETCHES_SOURCE_KIND } from "@geolibre/plugins";
import type { Feature, FeatureCollection } from "geojson";
import type { MapController } from "@geolibre/map";
import { beginProcessingRun } from "../processing-history";
import { captureMapImage } from "../print-layout-export";
import { styleParamPatch } from "./style-params";
import { parameterKind } from "../whitebox-param-kind";

// The scripting command surface, shared by every programmatic entry point: the
// Jupyter widget's postMessage bridge (useCommandBridge) and the in-app Python
// console (pyodide-console). Each handler maps a params object to a (possibly
// async) value. Keeping one implementation here means the notebook API and the
// console expose identical behaviour.

/** A single command handler: params object in, value (or promise) out. */
export type ScriptingHandler = (params: Record<string, unknown>) => unknown | Promise<unknown>;

export type ScriptingHandlers = Record<string, ScriptingHandler>;

export interface ScriptingDeps {
  /** Lazily resolve the live map controller (it is created asynchronously). */
  getController: () => MapController | null;
  /** Add an in-browser Whitebox raster result to the map, returning its layer id. */
  addRasterOutput?: (bytes: Uint8Array, name: string, fileName: string) => Promise<string>;
}

function whiteboxToolName(tool: WhiteboxTool): string {
  return tool.display_name || tool.id.replace(/_/g, " ");
}

async function whiteboxTools(): Promise<WhiteboxTool[]> {
  // Settled, not all: the catalog snapshot is an HTTP fetch, so an offline or
  // blocked deployment must not take down the locally bundled WASM manifests
  // (the GeoLibre-authored tools) with it. Mirrors ProcessingDialog's local mode.
  const [catalogResult, manifestResult] = await Promise.allSettled([
    fetchRemoteWhiteboxCatalogSnapshot(),
    listWasmToolManifests(),
  ]);
  if (catalogResult.status === "rejected") {
    console.warn("[GeoLibre] Could not load Whitebox catalog snapshot:", catalogResult.reason);
  }
  if (manifestResult.status === "rejected") {
    console.warn("[GeoLibre] Could not enumerate WASM tool manifests:", manifestResult.reason);
  }
  // Hide locked ("pro"-tier) tools: they cannot run in the browser.
  const catalog =
    catalogResult.status === "fulfilled" ? catalogResult.value.filter((tool) => !tool.locked) : [];
  const manifests = manifestResult.status === "fulfilled" ? manifestResult.value : [];
  return mergeWasmToolManifests(catalog, manifests);
}

async function fetchLayerInputBytes(
  layer: ReturnType<typeof useAppStore.getState>["layers"][number],
): Promise<Uint8Array | null> {
  const source = layer.source as Record<string, unknown>;
  const tiles = Array.isArray(source.tiles) ? source.tiles : [];
  const candidates = [layer.metadata.localBytesUrl, source.url, tiles[0], layer.sourcePath];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !/^(https?:|blob:|data:)/i.test(candidate)) continue;
    try {
      const response = await fetch(candidate);
      if (!response.ok) continue;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length && bytes[0] !== 0x3c) return bytes;
    } catch {
      // Try the next persisted source URL.
    }
  }
  return null;
}

/**
 * Combined client-side algorithm registry, matching the in-app dialogs. This
 * is the list `runAlgorithm` (and thus the Python API's `m.run_algorithm`)
 * resolves tool ids against; the Processing History panel imports it so its
 * "Copy as Python" eligibility can never drift from what actually runs.
 */
export function allAlgorithms(): ProcessingAlgorithm[] {
  return [...ALGORITHMS, ...VECTOR_TOOLS, ...H3_TOOLS, ...STATISTICS_TOOLS];
}

/** Validate a required string `layerId` param, with a clear error if missing. */
function requireLayerId(params: Record<string, unknown>): string {
  const id = params.layerId;
  if (typeof id !== "string" || !id) {
    throw new Error("layerId must be a non-empty string");
  }
  return id;
}

/**
 * Build the scripting command handlers over the live store + map controller.
 *
 * @param deps - Accessors for the runtime dependencies (the map controller).
 * @returns A map of command name to handler.
 */
export function createScriptingHandlers(deps: ScriptingDeps): ScriptingHandlers {
  const { getController, addRasterOutput } = deps;

  return {
    // -- view / camera ------------------------------------------------------
    getView: () => getController()?.readView() ?? null,
    getCenter: () => getController()?.readView().center ?? null,
    getBounds: () => getController()?.readView().bbox ?? null,
    flyTo: (params) => {
      getController()?.flyTo(params as Parameters<MapController["flyTo"]>[0]);
      return null;
    },
    fitBounds: (params) => {
      getController()?.fitBounds(params.bounds as [number, number, number, number]);
      return null;
    },
    setView: (params) => {
      useAppStore
        .getState()
        .setMapView(params as Parameters<ReturnType<typeof useAppStore.getState>["setMapView"]>[0]);
      return null;
    },

    // -- queries ------------------------------------------------------------
    identify: (params) => {
      const lngLat = params.lngLat as [number, number];
      const layerId = typeof params.layerId === "string" ? params.layerId : undefined;
      return getController()?.identifyFeatures(lngLat, layerId) ?? [];
    },
    getLayerFeatures: (params) => {
      const layerId = requireLayerId(params);
      const layer = useAppStore.getState().layers.find((item) => item.id === layerId);
      if (!layer) throw new Error(`No layer with id "${layerId}"`);
      return layer.geojson?.features ?? [];
    },
    getSelectedFeatures: () => {
      // Selection is a single layer+feature pair in the store; return it as a
      // (0-or-1 element) list so the shape is forward-compatible with
      // multi-select and matches getLayerFeatures/getDrawnFeatures.
      const state = useAppStore.getState();
      const { selectedLayerId, selectedFeatureId } = state;
      if (!selectedLayerId || !selectedFeatureId) return [];
      const layer = state.layers.find((item) => item.id === selectedLayerId);
      const features = layer?.geojson?.features ?? [];
      // Mirror the controller's id convention (String(feature.id ?? index)) so a
      // selectedFeatureId derived from an index still resolves.
      const match = features.find(
        (feature, index) => String(feature.id ?? index) === selectedFeatureId,
      );
      return match ? [match] : [];
    },
    getDrawnFeatures: () => {
      // Features the user drew with the Geo Editor land in store layers tagged
      // with the Sketches source kind; gather every such layer's features.
      const features: Feature[] = [];
      for (const layer of useAppStore.getState().layers) {
        if (layer.metadata.sourceKind === SKETCHES_SOURCE_KIND) {
          features.push(...(layer.geojson?.features ?? []));
        }
      }
      return features;
    },
    listLayers: () =>
      useAppStore.getState().layers.map((layer) => ({
        id: layer.id,
        name: layer.name,
        type: layer.type,
        visible: layer.visible,
        opacity: layer.opacity,
      })),

    // -- mutations ----------------------------------------------------------
    addGeoJsonLayer: (params) => {
      const name = String(params.name ?? "GeoJSON");
      const geojson = params.geojson as FeatureCollection;
      const layerId = useAppStore.getState().addGeoJsonLayer(name, geojson);
      const style = styleParamPatch(params.style);
      if (style) {
        useAppStore.getState().setLayerStyle(layerId, style);
      }
      return layerId;
    },
    removeLayer: (params) => {
      useAppStore.getState().removeLayer(requireLayerId(params));
      return null;
    },
    setVisibility: (params) => {
      useAppStore.getState().setLayerVisibility(requireLayerId(params), Boolean(params.visible));
      return null;
    },
    setOpacity: (params) => {
      const layerId = requireLayerId(params);
      const raw = Number(params.opacity);
      if (!Number.isFinite(raw)) {
        throw new Error("setOpacity: opacity must be a finite number");
      }
      useAppStore.getState().setLayerOpacity(layerId, Math.min(1, Math.max(0, raw)));
      return null;
    },
    setStyle: (params) => {
      useAppStore
        .getState()
        .setLayerStyle(requireLayerId(params), params.style as Record<string, unknown>);
      return null;
    },
    setBasemap: (params) => {
      // Validate the scheme: reject undefined/non-string (would store the literal
      // "undefined") and non-http(s) schemes like javascript:/data: that would
      // be persisted into project state and snapshots.
      const url = params.url;
      if (typeof url !== "string" || (!/^https?:\/\//i.test(url) && !url.startsWith("/"))) {
        throw new Error("setBasemap: url must be an http(s) or root-relative URL string");
      }
      useAppStore.getState().setBasemapStyleUrl(url);
      return null;
    },
    zoomToLayer: (params) => {
      const layerId = requireLayerId(params);
      const layer = useAppStore.getState().layers.find((item) => item.id === layerId);
      if (!layer) throw new Error(`No layer with id "${layerId}"`);
      getController()?.fitLayer(layer);
      return null;
    },

    // -- processing ---------------------------------------------------------
    listAlgorithms: () =>
      allAlgorithms().map((algo) => ({
        id: algo.id,
        name: algo.name,
        group: algo.group,
        description: algo.description,
        parameters: algo.parameters,
      })),
    runAlgorithm: async (params) => {
      const id = params.id as string;
      const algo = allAlgorithms().find((item) => item.id === id);
      if (!algo) throw new Error(`Unknown algorithm "${id}"`);
      const logs: string[] = [];
      const resultLayerIds: string[] = [];
      // Track the run for the Processing History panel (#1292), so notebook /
      // console runs document themselves alongside dialog runs.
      const tracker = beginProcessingRun({
        kind: "algorithm",
        toolId: algo.id,
        toolName: algo.name,
        engine: "client",
        parameters: (params.params as Record<string, unknown>) ?? {},
      });
      // Registry tools report validation failures via ctx.log("Error: ...")
      // plus a plain return rather than throwing; capture the last such line
      // so the run is recorded as failed in the Processing History.
      let softError: string | null = null;
      // Everything after beginProcessingRun runs inside one try so setup
      // failures (the lazy import, DuckDB capability) are recorded too.
      try {
        // duckdb-wasm is browser-only and heavy; import it only when an
        // algorithm actually runs (also keeps this module importable in plain
        // Node tests).
        const { createDuckDbCapability } = await import("../duckdb-processing");
        const ctx: ProcessingContext = {
          layers: useAppStore.getState().layers,
          parameters: (params.params as Record<string, unknown>) ?? {},
          log: (message) => {
            if (message.startsWith("Error:")) {
              softError = message.slice("Error:".length).trim();
            }
            logs.push(message);
          },
          fitBounds: (bounds) => getController()?.fitBounds(bounds),
          addResultLayer: (name: string, fc: FeatureCollection) => {
            if (!fc.features.length) {
              logs.push(`No features produced for "${name}"`);
              return;
            }
            const layerId = useAppStore.getState().addGeoJsonLayer(name, fc);
            tracker.addOutputLayer(name);
            resultLayerIds.push(layerId);
            const layer = useAppStore.getState().layers.find((item) => item.id === layerId);
            if (layer) getController()?.fitLayer(layer);
          },
          duckdb: createDuckDbCapability(),
          viewportBounds: () => {
            const map = getController()?.getMap();
            if (!map) return null;
            const b = map.getBounds();
            return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
          },
        };
        await algo.run(ctx);
      } catch (error) {
        tracker.finish("error", error instanceof Error ? error.message : String(error));
        throw error;
      }
      if (softError) tracker.finish("error", softError);
      else tracker.finish("success");
      return { logs, resultLayerIds };
    },
    listWhiteboxTools: async () =>
      (await whiteboxTools()).map((tool) => ({
        id: tool.id,
        name: whiteboxToolName(tool),
        category: tool.category ?? tool.taxonomy_category ?? "General",
        description: tool.summary ?? "",
        parameters: tool.params ?? [],
      })),
    runWhiteboxTool: async (params) => {
      const id = String(params.id ?? "");
      const tool = (await whiteboxTools()).find((item) => item.id === id);
      if (!tool) throw new Error(`Unknown Whitebox tool "${id}"`);
      const supplied = (params.params as Record<string, unknown>) ?? {};
      const parameters: Record<string, unknown> = { ...supplied };
      const layerInputs: Record<string, WhiteboxLayerInput> = {};
      const layers = useAppStore.getState().layers;

      for (const param of tool.params ?? []) {
        const kind = parameterKind(param);
        if (!kind.endsWith("_in")) continue;
        const value = supplied[param.name];
        if (typeof value !== "string") continue;
        const layer = layers.find((item) => item.id === value);
        if (!layer) continue;
        delete parameters[param.name];
        if (kind === "vector_in") {
          if (!layer.geojson) {
            throw new Error(`Layer "${layer.name}" has no in-memory GeoJSON for "${param.name}"`);
          }
          layerInputs[param.name] = { name: layer.name, kind, geojson: layer.geojson };
        } else {
          const bytes = await fetchLayerInputBytes(layer);
          if (!bytes) {
            throw new Error(`Layer "${layer.name}" is not fetchable for "${param.name}"`);
          }
          layerInputs[param.name] = { name: layer.name, kind, bytes };
        }
      }

      const tracker = beginProcessingRun({
        kind: "whitebox",
        toolId: tool.id,
        toolName: whiteboxToolName(tool),
        engine: "wasm",
        parameters: supplied,
      });
      try {
        const job = await runWhiteboxToolWasm({
          tool_id: tool.id,
          parameters,
          tool,
          layer_inputs: layerInputs,
          include_pro: false,
          tier: "open",
        });
        if (job.status !== "succeeded") {
          throw new Error(job.error || job.messages.join("\n") || `Whitebox tool ${id} failed`);
        }
        const resultLayerIds: string[] = [];
        for (const [outputName, value] of Object.entries(job.outputs)) {
          const displayName = `${whiteboxToolName(tool)} ${outputName.replace(/_/g, " ")}`;
          if (
            value &&
            typeof value === "object" &&
            (value as { type?: unknown }).type === "FeatureCollection"
          ) {
            const layerId = useAppStore
              .getState()
              .addGeoJsonLayer(displayName, value as FeatureCollection);
            resultLayerIds.push(layerId);
            tracker.addOutputLayer(displayName);
          } else if (value instanceof Uint8Array) {
            const outputParam = tool.params?.find((item) => item.name === outputName);
            if (parameterKind(outputParam ?? { name: outputName }) === "raster_out") {
              if (!addRasterOutput) {
                throw new Error("This scripting host cannot add Whitebox raster outputs");
              }
              const layerId = await addRasterOutput(
                value,
                displayName,
                `${tool.id}_${outputName}.tif`,
              );
              resultLayerIds.push(layerId);
              tracker.addOutputLayer(displayName);
            }
          }
        }
        tracker.finish("success");
        return { logs: job.messages, resultLayerIds };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        tracker.finish("error", message);
        throw error;
      }
    },

    // -- export -------------------------------------------------------------
    toImage: () => {
      const map = getController()?.getMap();
      if (!map) throw new Error("The map is not ready yet");
      // toDataURL is a synchronous PNG encode (100-400ms on a large/high-DPI
      // viewport). In the in-app console (main thread) this briefly freezes the
      // UI, so callers should avoid it in tight loops; the notebook path hides
      // this behind the postMessage round-trip.
      return captureMapImage(map).image.toDataURL("image/png");
    },
  };
}
