import {
  DEFAULT_LAYER_STYLE,
  OPENFREEMAP_BASEMAPS,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import type { InvokableTool, JSONValue } from "@strands-agents/sdk";
import maplibregl from "maplibre-gl";
import { tool } from "@strands-agents/sdk";
import type { FeatureCollection } from "geojson";
import { z } from "zod";
import { inferPropertyColumns } from "../pglite-sql";
import { consoleDeps, runConsoleCode } from "../pyodide/pyodide-console";
import { cleanStatement, maskSqlLiterals, previewLayerTables, runSqlQuery } from "../sql-workspace";
import { createXyzTileUrlTemplate } from "../xyz-url";
import { findNamedTileBasemap, NAMED_TILE_BASEMAPS } from "./basemaps";
import { buildSymbologyStyle } from "./symbology";
import { webSearch } from "./web-search";

/** Dependencies the assistant tools need beyond the global store. */
export interface AssistantToolDeps {
  /** Returns the live map controller, or null before the map mounts. */
  getMapController: () => MapController | null;
  /**
   * Ask the user to approve executing model-generated code before it runs.
   * Resolves true to proceed, false to decline. The assistant can be steered by
   * untrusted content (e.g. `web_search` results, layer attributes) into
   * emitting a `run_python`/`run_maplibre_js` snippet that exfiltrates secrets
   * or mutates the app, so these two tools are gated behind an explicit user
   * confirmation. When omitted (e.g. in tests) code runs without a prompt; the
   * desktop UI always provides it.
   */
  confirmCodeExecution?: (request: {
    tool: "run_python" | "run_maplibre_js";
    code: string;
  }) => Promise<boolean>;
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

/** Statement keywords that write data or have side effects. */
const SQL_WRITE_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|REPLACE|ATTACH|DETACH|COPY|EXPORT|IMPORT|INSTALL|LOAD|PRAGMA|VACUUM|CHECKPOINT)\b/;

/**
 * True when a SQL statement is a read-only SELECT/WITH query. Guards both the
 * leading keyword and the body (with string/comment literals masked) so a
 * data-modifying CTE — `WITH x AS (DELETE …) …` — is also rejected.
 */
function isReadOnlySql(sql: string): boolean {
  const cleaned = cleanStatement(sql);
  const head = cleaned.trimStart().toUpperCase();
  if (!head.startsWith("SELECT") && !head.startsWith("WITH")) return false;
  return !SQL_WRITE_KEYWORDS.test(maskSqlLiterals(cleaned).toUpperCase());
}

/**
 * Validate a model-supplied URL before fetching: only http(s), and never a
 * loopback/private/link-local address (guards against AI-directed SSRF to the
 * local sidecar or internal services via prompt injection).
 */
function assertPublicHttpUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Only http(s) URLs are allowed (got ${url.protocol}).`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // Unwrap IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) before the IPv4 checks.
  const v4 = host.startsWith("::ffff:") ? host.slice(7) : host;
  const isPrivate =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::" ||
    host === "::1" ||
    /^0\./.test(v4) || // 0.0.0.0/8 (incl. 0.0.0.0)
    /^127\./.test(v4) ||
    /^10\./.test(v4) ||
    /^192\.168\./.test(v4) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(v4) ||
    /^169\.254\./.test(v4) || // link-local
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(v4) || // 100.64/10 CGNAT
    /^(fc|fd)[0-9a-f]{2}:/.test(host) || // unique-local IPv6
    /^fe80:/.test(host); // link-local IPv6
  if (isPrivate) {
    throw new Error(`Refusing to fetch a private/loopback address: ${host}`);
  }
}

/**
 * Read a response body as text, aborting once `maxBytes` is exceeded — so an
 * over-large (or Content-Length–less) response can't buffer unbounded into
 * memory before the size check.
 */
async function readTextCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (text.length > maxBytes) throw new Error("Response too large.");
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Response too large (> ${maxBytes} bytes).`);
      }
      chunks.push(value);
    }
  }
  return new TextDecoder().decode(chunks.length === 1 ? chunks[0] : concatBytes(chunks, total));
}

/** Concatenate byte chunks into one buffer. */
function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
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
  // previewLayerTables returns one entry per layer in order, so align by index —
  // keying by name would collapse layers that share a name onto one table.
  const tables = previewLayerTables(layers);
  return layers
    .map((layer, index) => {
      const summary = summarizeLayer(layer);
      const table = tables[index]?.tableName;
      const fields = summary.fields.map((field) => `${field.name}:${field.type}`).join(", ");
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
  const exact = layers.find((layer) => layer.name.toLowerCase() === target);
  if (exact) return exact;
  // Only fall back to a substring match for references long enough to be
  // meaningful, so a 1–2 char string can't match an arbitrary layer.
  if (target.length < 3) return null;
  return layers.find((layer) => layer.name.toLowerCase().includes(target)) ?? null;
}

/** Resolve a basemap name/id/url to a style URL via the known presets. */
function resolveBasemap(reference: string): string | null {
  const target = reference.trim().toLowerCase();
  if (target.startsWith("http")) {
    // Only accept https style URLs; an http style could mix-content fail and is
    // a needless freeform-URL surface.
    return target.startsWith("https://") ? reference.trim() : null;
  }
  const preset = OPENFREEMAP_BASEMAPS.find(
    (basemap) => basemap.id.toLowerCase() === target || basemap.name.toLowerCase() === target,
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
export function createAssistantTools(deps: AssistantToolDeps): InvokableTool<unknown, unknown>[] {
  const store = () => useAppStore.getState();
  // Tool results are serialized to the model; the data we return is JSON-safe by
  // construction, so this asserts the shape against Strands' strict JSONValue.
  const json = (value: unknown): JSONValue => value as JSONValue;
  // Shared Pyodide scripting context for run_python (exposes the `geolibre`
  // facade that drives the live map).
  const pyDeps = consoleDeps(deps.getMapController);

  /**
   * Gate model-authored code behind the user's confirmation hook. Returns true
   * when execution may proceed (approved, or no hook configured).
   */
  const approveCodeExecution = (
    toolName: "run_python" | "run_maplibre_js",
    code: string,
  ): Promise<boolean> =>
    deps.confirmCodeExecution
      ? deps.confirmCodeExecution({ tool: toolName, code })
      : Promise.resolve(true);

  /** The current map viewport as [west, south, east, north], or null. */
  const viewBbox = (): [number, number, number, number] | null => {
    const map = deps.getMapController()?.getMap();
    if (!map) return null;
    const b = map.getBounds();
    return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  };

  /** Reduce a STAC bbox (2D or 3D) to a 2D [w, s, e, n]. */
  const bbox2d = (bbox: number[]): [number, number, number, number] | null =>
    bbox.length >= 6
      ? [bbox[0], bbox[1], bbox[3], bbox[4]]
      : bbox.length >= 4
        ? [bbox[0], bbox[1], bbox[2], bbox[3]]
        : null;

  // Lazily load the shared processing executor (Phase 2). It pulls in the
  // algorithm registries (Turf, DuckDB), so it is imported only when used.
  type ScriptingHandlers = {
    listAlgorithms: () => unknown;
    runAlgorithm: (input: {
      id: string;
      params: Record<string, unknown>;
    }) => Promise<{ logs?: string[]; resultLayerIds?: string[] }>;
  };
  let scriptingPromise: Promise<ScriptingHandlers> | null = null;
  const getScripting = (): Promise<ScriptingHandlers> => {
    scriptingPromise ??= import("../scripting/scriptingApi").then(
      ({ createScriptingHandlers }) =>
        createScriptingHandlers({
          getController: deps.getMapController,
        }) as unknown as ScriptingHandlers,
    );
    return scriptingPromise;
  };

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
      if (!isReadOnlySql(input.sql)) {
        throw new Error("Only read-only SELECT/WITH queries are allowed.");
      }
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
    description: "Fetch a public GeoJSON URL and add it to the map as a new vector layer.",
    inputSchema: z.object({
      url: z.string().describe("A public URL returning GeoJSON."),
      name: z.string().optional().describe("Optional layer name."),
    }),
    callback: async (input) => {
      assertPublicHttpUrl(input.url);
      const MAX_BYTES = 100 * 1024 * 1024; // 100 MB guard against OOM.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await fetch(input.url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
        }
        // Check the advertised length first (cheap), then stream the body with
        // a hard byte cap — Content-Length is optional and bypassable.
        const length = response.headers.get("content-length");
        if (length && Number(length) > MAX_BYTES) {
          throw new Error(`Response too large (${length} bytes).`);
        }
        const geojson = asFeatureCollection(JSON.parse(await readTextCapped(response, MAX_BYTES)));
        const name =
          input.name?.trim() || input.url.split("/").pop()?.split("?")[0] || "Remote layer";
        const id = store().addGeoJsonLayer(name, geojson, input.url);
        return json({
          addedLayerId: id,
          name,
          featureCount: geojson.features.length,
        });
      } finally {
        clearTimeout(timeout);
      }
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

  const addTileLayer = tool({
    name: "add_tile_layer",
    description: `Add an XYZ raster tile basemap/layer to the map. Use a known name (${NAMED_TILE_BASEMAPS.map((basemap) => basemap.id).join(", ")}) or a custom XYZ url template containing {z}/{x}/{y}. The layer is placed underneath existing layers so it acts as a basemap.`,
    inputSchema: z.object({
      basemap: z
        .string()
        .optional()
        .describe(
          `Known basemap name, one of: ${NAMED_TILE_BASEMAPS.map((basemap) => basemap.id).join(", ")}.`,
        ),
      url: z
        .string()
        .optional()
        .describe("Custom XYZ tile URL template with {z}, {x}, {y} placeholders."),
      name: z.string().optional(),
      attribution: z.string().optional(),
    }),
    callback: (input) => {
      let url = input.url?.trim();
      let name = input.name?.trim();
      let attribution = input.attribution?.trim();
      if (input.basemap?.trim()) {
        const found = findNamedTileBasemap(input.basemap);
        if (found) {
          url = url || found.url;
          name = name || found.label;
          attribution = attribution || found.attribution;
        } else if (!url) {
          throw new Error(
            `Unknown basemap "${input.basemap}". Known: ${NAMED_TILE_BASEMAPS.map((basemap) => basemap.id).join(", ")} — or pass a url.`,
          );
        }
      }
      if (!url) {
        throw new Error("Provide a known basemap name or an XYZ url template with {z}/{x}/{y}.");
      }
      const tileUrl = createXyzTileUrlTemplate(url);
      const layer: GeoLibreLayer = {
        id: crypto.randomUUID(),
        name: name || "Tile layer",
        type: "xyz",
        source: {
          type: "raster",
          tiles: [tileUrl.renderUrl],
          tileSize: 256,
          url: tileUrl.originalUrl,
          ...(attribution ? { attribution } : {}),
        },
        visible: true,
        opacity: 1,
        style: { ...DEFAULT_LAYER_STYLE },
        metadata: { sourceKind: "xyz-url" },
      };
      // Insert at the bottom of the stack (index 0) so imagery sits under data.
      const bottomBeforeId = store().layers[0]?.id ?? null;
      store().addLayer(layer, bottomBeforeId);
      return json({
        addedLayerId: layer.id,
        name: layer.name,
        url: tileUrl.originalUrl,
      });
    },
  });

  const webSearchTool = tool({
    name: "web_search",
    description:
      "Search the web for current information (news, recent data, documentation). Returns top results with title, url, and snippet, plus a short answer when available. Most reliable when TAVILY_API_KEY is configured; the keyless fallback is best-effort and may be blocked by the browser.",
    inputSchema: z.object({
      query: z.string().describe("The search query."),
    }),
    callback: async (input) => {
      try {
        const response = await webSearch(input.query);
        return json({
          provider: response.provider,
          answer: response.answer ?? null,
          results: response.results.slice(0, 8),
        });
      } catch (error) {
        // Don't surface a raw fetch/CORS error as a tool crash — tell the model
        // search is unavailable so it can fall back gracefully.
        return json({
          error:
            "Web search is unavailable from the browser. Configure TAVILY_API_KEY in Settings → Environment Variables for reliable search.",
          detail: error instanceof Error ? error.message : String(error),
          results: [],
        });
      }
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
    inputSchema: z
      .object({
        layer: z.string().optional().describe("Layer name or id to fit."),
        bbox: z
          .array(z.number())
          .length(4)
          .optional()
          .describe("Bounding box [west, south, east, north] in WGS84."),
      })
      .refine((value) => value.layer !== undefined || value.bbox !== undefined, {
        message: "Provide either a layer or a bbox.",
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

  const runPython = tool({
    name: "run_python",
    description:
      "Run a Python snippet in the in-app Pyodide runtime for data/compute tasks (numpy, pandas, etc.). A `geolibre` object is in scope to drive the live map, e.g. `geolibre.get_center()` or `geolibre.add_geojson(name, data)`; `await geolibre.load_package('geopandas')` installs packages. Returns captured stdout and the repr of the last expression. The first call boots the Python runtime and can take several seconds. Prefer run_sql for querying layer attributes.",
    inputSchema: z.object({
      code: z.string().describe("Python source to execute."),
    }),
    callback: async (input) => {
      if (!(await approveCodeExecution("run_python", input.code))) {
        return json({
          output: "",
          error: "The user declined to run this Python code.",
        });
      }
      const result = await runConsoleCode(pyDeps, input.code);
      // Cap stdout so a snippet printing megabytes can't blow the model's
      // context window on the next turn.
      const MAX_OUTPUT = 8000;
      const output =
        result.output.length > MAX_OUTPUT
          ? `${result.output.slice(0, MAX_OUTPUT)}\n[truncated]`
          : result.output;
      return json({ output, error: result.error });
    },
  });

  const runMaplibreJs = tool({
    name: "run_maplibre_js",
    description:
      "Fallback for tasks with no dedicated tool (e.g. globe projection, terrain, sky, custom paint/layout properties, controls, markers). Runs a small JavaScript snippet against the live map. The snippet is a function body with `map` (the MapLibre GL JS map) and `maplibregl` (the MapLibre GL JS module, e.g. `maplibregl.TerrainControl`, `maplibregl.Marker`) in scope, and may `return` a JSON-serializable value. Example — switch to globe: `map.setProjection({ type: 'globe' })`. Prefer dedicated tools when one exists; changes made here bypass the store and are NOT undoable.",
    inputSchema: z.object({
      code: z.string().describe("JavaScript function body; `map` and `maplibregl` are in scope."),
    }),
    callback: async (input) => {
      if (!(await approveCodeExecution("run_maplibre_js", input.code))) {
        return json({ ok: false, error: "The user declined to run this code." });
      }
      const map = deps.getMapController()?.getMap();
      if (!map) throw new Error("The map is not ready yet.");
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      const run = new Function("map", "maplibregl", input.code) as (
        map: unknown,
        maplibregl: unknown,
      ) => unknown;
      const result = run(map, maplibregl);
      // Coerce to a JSON-safe value so non-serializable returns (e.g. the map
      // object itself) don't blow up the tool result.
      let safe: JSONValue = null;
      try {
        safe = JSON.parse(JSON.stringify(result ?? null)) as JSONValue;
      } catch {
        safe = String(result);
      }
      return json({ ok: true, result: safe });
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

  const listAlgorithms = tool({
    name: "list_algorithms",
    description:
      "List the available client-side processing algorithms (vector geometry/overlay tools like buffer, clip, dissolve, intersection, difference, union, spatial-join; plus H3 grids) with their id, name, group, and typed parameters. Call this before run_algorithm.",
    inputSchema: z.object({}),
    callback: async () => json({ algorithms: (await getScripting()).listAlgorithms() }),
  });

  const runAlgorithm = tool({
    name: "run_algorithm",
    description:
      "Run a processing algorithm by id (from list_algorithms) and add its result as a new layer. `params` is an object keyed by parameter id; a 'layer' parameter takes a layer id (from list_layers). Build a pipeline by running one algorithm, then passing its returned result layer id into the next. Returns the run log and the new layer id(s).",
    inputSchema: z.object({
      id: z.string().describe("Algorithm id, e.g. 'buffer', 'clip', 'dissolve'."),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Parameter values keyed by parameter id; layer params take a layer id."),
    }),
    callback: async (input) => {
      const result = await (
        await getScripting()
      ).runAlgorithm({
        id: input.id,
        params: (input.params as Record<string, unknown>) ?? {},
      });
      return json({
        logs: result.logs ?? [],
        resultLayerIds: result.resultLayerIds ?? [],
      });
    },
  });

  const searchStac = tool({
    name: "search_stac",
    description:
      "Search the Microsoft Planetary Computer STAC catalog for earth-observation items in a collection (e.g. 'sentinel-2-l2a', 'landsat-c2-l2', 'naip', 'cop-dem-glo-30'). Defaults the bounding box to the current map view and sorts newest-first. Returns matching items (id, datetime, cloud cover, bbox).",
    inputSchema: z.object({
      collection: z.string().describe("STAC collection id, e.g. 'sentinel-2-l2a'."),
      bbox: z
        .array(z.number())
        .length(4)
        .optional()
        .describe("[west, south, east, north]; defaults to the current view."),
      datetime: z
        .string()
        .optional()
        .describe("RFC3339 datetime or range, e.g. '2024-06-01/2024-09-30'."),
      limit: z.number().optional().describe("Max items (default 10)."),
    }),
    callback: async (input) => {
      const { STACClient } = await import("maplibre-gl-planetary-computer");
      const bbox =
        (input.bbox as [number, number, number, number] | undefined) ?? viewBbox() ?? undefined;
      const items = await new STACClient().search({
        collections: [input.collection],
        bbox,
        datetime: input.datetime,
        limit: input.limit ?? 10,
        sortby: [{ field: "datetime", direction: "desc" }],
      });
      return json({
        count: items.length,
        items: items.map((item) => ({
          id: item.id,
          datetime: item.properties.datetime,
          cloudCover: item.properties["eo:cloud_cover"] ?? null,
          bbox: item.bbox,
        })),
      });
    },
  });

  const addStacLayer = tool({
    name: "add_stac_layer",
    description:
      "Add a Planetary Computer STAC item as a raster tile layer (tiles are signed server-side — no credentials needed). Give a collection and optionally a specific itemId from search_stac; otherwise the newest item over the current view is used. Renders with the collection's default band/colormap preset.",
    inputSchema: z.object({
      collection: z.string().describe("STAC collection id, e.g. 'sentinel-2-l2a'."),
      itemId: z
        .string()
        .optional()
        .describe("A specific item id; otherwise the latest over the view is used."),
      bbox: z.array(z.number()).length(4).optional(),
      datetime: z.string().optional(),
      name: z.string().optional(),
    }),
    callback: async (input) => {
      const { STACClient, TiTilerClient, getDefaultPreset } =
        await import("maplibre-gl-planetary-computer");
      const stac = new STACClient();
      let item;
      if (input.itemId) {
        item = await stac.getItem(input.collection, input.itemId);
      } else {
        const bbox =
          (input.bbox as [number, number, number, number] | undefined) ?? viewBbox() ?? undefined;
        const items = await stac.search({
          collections: [input.collection],
          bbox,
          datetime: input.datetime,
          limit: 1,
          sortby: [{ field: "datetime", direction: "desc" }],
        });
        if (!items.length) {
          throw new Error(`No ${input.collection} items found for the given area/time.`);
        }
        item = items[0];
      }
      const preset = getDefaultPreset(input.collection);
      const tileUrl = new TiTilerClient().getItemTileUrl(input.collection, item.id, preset?.params);
      const bounds = bbox2d(item.bbox);
      const layer: GeoLibreLayer = {
        id: crypto.randomUUID(),
        name: input.name?.trim() || `${input.collection} ${item.properties.datetime ?? item.id}`,
        type: "xyz",
        source: {
          type: "raster",
          tiles: [tileUrl],
          tileSize: 256,
          attribution: "Microsoft Planetary Computer",
        },
        visible: true,
        opacity: 1,
        style: { ...DEFAULT_LAYER_STYLE },
        metadata: {
          sourceKind: "stac-planetary-computer",
          stacCollectionId: input.collection,
          stacItemId: item.id,
        },
      };
      const bottomBeforeId = store().layers[0]?.id ?? null;
      store().addLayer(layer, bottomBeforeId);
      if (bounds) deps.getMapController()?.fitBounds(bounds);
      return json({
        addedLayerId: layer.id,
        itemId: item.id,
        datetime: item.properties.datetime ?? null,
      });
    },
  });

  return [
    listLayers,
    runSql,
    addLayerFromUrl,
    addTileLayer,
    listAlgorithms,
    runAlgorithm,
    searchStac,
    addStacLayer,
    webSearchTool,
    removeLayer,
    setLayerVisibility,
    setLayerOpacity,
    setBasemap,
    zoomTo,
    applySymbology,
    runMaplibreJs,
    runPython,
  ] as InvokableTool<unknown, unknown>[];
}
