import {
  OPENFREEMAP_BASEMAPS,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import type { InvokableTool, JSONValue } from "@strands-agents/sdk";
import { tool } from "@strands-agents/sdk";
import type { FeatureCollection } from "geojson";
import { z } from "zod";
import { inferPropertyColumns } from "../pglite-sql";
import { previewLayerTables, runSqlQuery } from "../sql-workspace";
import { buildSymbologyStyle } from "./symbology";

/** Dependencies the assistant tools need beyond the global store. */
export interface AssistantToolDeps {
  /** Returns the live map controller, or null before the map mounts. */
  getMapController: () => MapController | null;
}

/** A short, model-facing description of one layer (no feature data leaked). */
interface LayerSummary {
  id: string;
  name: string;
  type: string;
  geometryType: string | null;
  featureCount: number;
  fields: { name: string; type: string }[];
}

/** Detect a layer's geometry family from its first feature. */
function geometryTypeOf(layer: GeoLibreLayer): string | null {
  return layer.geojson?.features?.[0]?.geometry?.type ?? null;
}

/** Summarize a layer's identity and schema without exposing row data. */
function summarizeLayer(layer: GeoLibreLayer): LayerSummary {
  const features = layer.geojson?.features ?? [];
  return {
    id: layer.id,
    name: layer.name,
    type: layer.type,
    geometryType: geometryTypeOf(layer),
    featureCount: features.length,
    fields: features.length
      ? inferPropertyColumns(features).map((column) => ({
          name: column.name,
          type: column.type,
        }))
      : [],
  };
}

/**
 * Build a compact, model-facing description of the current layers and the SQL
 * table names they map to. Used to seed the agent's system prompt with names
 * and schemas only — never full datasets.
 */
export function describeLayers(layers: GeoLibreLayer[]): string {
  if (layers.length === 0) return "No layers are currently loaded.";
  const tables = new Map(
    previewLayerTables(layers).map((table) => [table.layerName, table.tableName]),
  );
  return layers
    .map((layer) => {
      const summary = summarizeLayer(layer);
      const table = tables.get(layer.name);
      const fields = summary.fields
        .map((field) => `${field.name}:${field.type}`)
        .join(", ");
      return [
        `- "${layer.name}" (${summary.type}`,
        summary.geometryType ? `, ${summary.geometryType}` : "",
        `, ${summary.featureCount} features`,
        table ? `, SQL table ${table}` : "",
        `)`,
        fields ? ` fields: ${fields}` : "",
      ].join("");
    })
    .join("\n");
}

/** Resolve a layer by id first, then case-insensitive name match. */
function resolveLayer(reference: string): GeoLibreLayer | null {
  const layers = useAppStore.getState().layers;
  const byId = layers.find((layer) => layer.id === reference);
  if (byId) return byId;
  const target = reference.trim().toLowerCase();
  return (
    layers.find((layer) => layer.name.toLowerCase() === target) ??
    layers.find((layer) => layer.name.toLowerCase().includes(target)) ??
    null
  );
}

/** Resolve a basemap name/id/url to a style URL via the known presets. */
function resolveBasemap(reference: string): string | null {
  const target = reference.trim().toLowerCase();
  if (target.startsWith("http")) return reference.trim();
  const preset = OPENFREEMAP_BASEMAPS.find(
    (basemap) =>
      basemap.id.toLowerCase() === target ||
      basemap.name.toLowerCase() === target,
  );
  return preset?.styleUrl ?? null;
}

/** Validate that a fetched payload is GeoJSON the store can ingest. */
function asFeatureCollection(data: unknown): FeatureCollection {
  const value = data as { type?: string; features?: unknown };
  if (value?.type === "FeatureCollection" && Array.isArray(value.features)) {
    return value as FeatureCollection;
  }
  if (value?.type === "Feature") {
    return { type: "FeatureCollection", features: [value as never] };
  }
  throw new Error("URL did not return a GeoJSON Feature or FeatureCollection.");
}

/**
 * Build the GeoLibre-native tool set the Strands agent can call. Every tool acts
 * through the Zustand store, the SQL Workspace, or the symbology helpers — never
 * by mutating MapLibre directly — so all changes flow through the app's one-way
 * data flow and are covered by undo/redo.
 *
 * @param deps Map-controller accessor for camera tools.
 * @returns The tools to register on the agent.
 */
export function createAssistantTools(
  deps: AssistantToolDeps,
): InvokableTool<unknown, unknown>[] {
  const store = () => useAppStore.getState();
  // Tool results are serialized to the model; the data we return is JSON-safe by
  // construction, so this asserts the shape against Strands' strict JSONValue.
  const json = (value: unknown): JSONValue => value as JSONValue;

  const listLayers = tool({
    name: "list_layers",
    description:
      "List the layers currently loaded in the map, with their id, type, geometry, feature count, attribute field names, and the SQL table name to use in run_sql. Call this before referring to a layer.",
    inputSchema: z.object({}),
    callback: () => json({ layers: store().layers.map(summarizeLayer) }),
  });

  const runSql = tool({
    name: "run_sql",
    description:
      "Run a single read-only DuckDB Spatial SQL statement against the loaded layers (use the SQL table names from list_layers) and/or remote files. Returns column names, the row count, and a small preview. Set add_as_layer to add a geometry result to the map.",
    inputSchema: z.object({
      sql: z.string().describe("A single SELECT statement (no trailing semicolon needed)."),
      add_as_layer: z
        .boolean()
        .optional()
        .describe("When the result has geometry, add it to the map as a new layer."),
      layer_name: z
        .string()
        .optional()
        .describe("Name for the added layer (when add_as_layer is true)."),
    }),
    callback: async (input) => {
      const result = await runSqlQuery(input.sql, store().layers);
      let addedLayerId: string | null = null;
      if (input.add_as_layer && result.geojson) {
        addedLayerId = store().addGeoJsonLayer(
          input.layer_name?.trim() || "SQL result",
          result.geojson,
        );
      }
      return json({
        columns: result.columns,
        rowCount: result.rowCount,
        hasGeometry: Boolean(result.geojson),
        preview: result.rows.slice(0, 10),
        addedLayerId,
      });
    },
  });

  const addLayerFromUrl = tool({
    name: "add_layer_from_url",
    description:
      "Fetch a public GeoJSON URL and add it to the map as a new vector layer.",
    inputSchema: z.object({
      url: z.string().describe("A public URL returning GeoJSON."),
      name: z.string().optional().describe("Optional layer name."),
    }),
    callback: async (input) => {
      const response = await fetch(input.url);
      if (!response.ok) {
        throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
      }
      const geojson = asFeatureCollection(await response.json());
      const name =
        input.name?.trim() ||
        input.url.split("/").pop()?.split("?")[0] ||
        "Remote layer";
      const id = store().addGeoJsonLayer(name, geojson, input.url);
      return json({ addedLayerId: id, name, featureCount: geojson.features.length });
    },
  });

  const removeLayer = tool({
    name: "remove_layer",
    description: "Remove a layer from the map by name or id.",
    inputSchema: z.object({
      layer: z.string().describe("Layer name or id."),
    }),
    callback: (input) => {
      const layer = resolveLayer(input.layer);
      if (!layer) throw new Error(`No layer matching "${input.layer}".`);
      store().removeLayer(layer.id);
      return json({ removedLayerId: layer.id, name: layer.name });
    },
  });

  const setLayerVisibility = tool({
    name: "set_layer_visibility",
    description: "Show or hide a layer by name or id.",
    inputSchema: z.object({
      layer: z.string().describe("Layer name or id."),
      visible: z.boolean(),
    }),
    callback: (input) => {
      const layer = resolveLayer(input.layer);
      if (!layer) throw new Error(`No layer matching "${input.layer}".`);
      store().setLayerVisibility(layer.id, input.visible);
      return json({ layerId: layer.id, visible: input.visible });
    },
  });

  const setLayerOpacity = tool({
    name: "set_layer_opacity",
    description: "Set a layer's opacity (0 transparent to 1 opaque) by name or id.",
    inputSchema: z.object({
      layer: z.string().describe("Layer name or id."),
      opacity: z.number().min(0).max(1),
    }),
    callback: (input) => {
      const layer = resolveLayer(input.layer);
      if (!layer) throw new Error(`No layer matching "${input.layer}".`);
      store().setLayerOpacity(layer.id, input.opacity);
      return json({ layerId: layer.id, opacity: input.opacity });
    },
  });

  const setBasemap = tool({
    name: "set_basemap",
    description: `Switch the basemap. Accepts a known name (${OPENFREEMAP_BASEMAPS.map((basemap) => basemap.id).join(", ")}) or a full style URL.`,
    inputSchema: z.object({
      basemap: z.string().describe("A basemap name/id or a style URL."),
    }),
    callback: (input) => {
      const styleUrl = resolveBasemap(input.basemap);
      if (!styleUrl) throw new Error(`Unknown basemap "${input.basemap}".`);
      store().setBasemapStyleUrl(styleUrl);
      return json({ basemap: styleUrl });
    },
  });

  const zoomTo = tool({
    name: "zoom_to",
    description:
      "Move the camera to fit a layer (by name or id) or an explicit bounding box [west, south, east, north].",
    inputSchema: z.object({
      layer: z.string().optional().describe("Layer name or id to fit."),
      bbox: z
        .array(z.number())
        .length(4)
        .optional()
        .describe("Bounding box [west, south, east, north] in WGS84."),
    }),
    callback: (input) => {
      const controller = deps.getMapController();
      if (!controller) throw new Error("The map is not ready yet.");
      if (input.bbox) {
        controller.fitBounds(input.bbox as [number, number, number, number]);
        return json({ fit: "bbox", bbox: input.bbox });
      }
      if (input.layer) {
        const layer = resolveLayer(input.layer);
        if (!layer) throw new Error(`No layer matching "${input.layer}".`);
        controller.fitLayer(layer);
        return json({ fit: "layer", layerId: layer.id });
      }
      throw new Error("Provide either a layer or a bbox.");
    },
  });

  const applySymbology = tool({
    name: "apply_symbology",
    description:
      "Color a vector layer by one of its attribute fields using a graduated (numeric) or categorized (text) color ramp. Use list_layers to find field names and color ramps like reds, blues, viridis.",
    inputSchema: z.object({
      layer: z.string().describe("Layer name or id."),
      property: z.string().describe("Attribute field to style by."),
      mode: z.enum(["graduated", "categorized"]),
      color_ramp: z.string().optional().describe("Color ramp id (e.g. reds, viridis)."),
      class_count: z.number().optional().describe("Number of classes for graduated mode."),
      scheme: z.enum(["equal-interval", "quantile"]).optional(),
    }),
    callback: (input) => {
      const layer = resolveLayer(input.layer);
      if (!layer) throw new Error(`No layer matching "${input.layer}".`);
      const style = buildSymbologyStyle(layer, {
        mode: input.mode,
        property: input.property,
        colorRamp: input.color_ramp,
        classCount: input.class_count,
        scheme: input.scheme,
      });
      store().setLayerStyle(layer.id, style);
      return json({
        layerId: layer.id,
        mode: input.mode,
        property: input.property,
        classes: style.vectorStyleStops?.length ?? 0,
      });
    },
  });

  return [
    listLayers,
    runSql,
    addLayerFromUrl,
    removeLayer,
    setLayerVisibility,
    setLayerOpacity,
    setBasemap,
    zoomTo,
    applySymbology,
  ] as InvokableTool<unknown, unknown>[];
}
