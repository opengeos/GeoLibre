import {
  DEFAULT_LAYER_STYLE,
  OPENFREEMAP_BASEMAPS,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import type { ModelToolDescriptor } from "@geolibre/processing";
import { listAssistantToolEntries } from "@geolibre/plugins";
import type { InvokableTool, JSONSchema, JSONValue } from "@strands-agents/sdk";
import * as maplibregl from "maplibre-gl";
import { tool } from "@strands-agents/sdk";
import type { FeatureCollection } from "geojson";
import { z } from "zod";
import { projectedGeoJsonCrs } from "../crs-utils";
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

/**
 * The algorithms the assistant may place in a Model Builder graph: the same
 * palette the canvas itself offers, so anything a user could drag in, the
 * assistant can wire up — the client vector registry plus the Whitebox catalog
 * snapshot and the WASM manifests.
 *
 * `list_model_algorithms` and `create_model_builder_model` both read this one
 * list, so the ids offered to the model and the ids `buildAssistantModel`
 * resolves cannot drift apart. Imported dynamically to keep the processing
 * registry out of the assistant's initial chunk. The two remote sources degrade
 * independently, matching `ModelBuilderPanel`: losing one still leaves a usable
 * palette built from the other, rather than failing the whole tool call.
 */
async function loadModelToolDescriptors(): Promise<ModelToolDescriptor[]> {
  const [
    {
      VECTOR_TOOLS,
      fetchRemoteWhiteboxCatalogSnapshot,
      listWasmToolManifests,
      mergeWasmToolManifests,
    },
    { buildModelToolCatalog },
  ] = await Promise.all([import("@geolibre/processing"), import("../model-tool-catalog")]);
  const [catalogResult, wasmResult] = await Promise.allSettled([
    fetchRemoteWhiteboxCatalogSnapshot(),
    listWasmToolManifests(),
  ]);
  if (catalogResult.status === "rejected") {
    console.warn("[GeoLibre] Assistant could not load the Whitebox catalog:", catalogResult.reason);
  }
  if (wasmResult.status === "rejected") {
    console.warn("[GeoLibre] Assistant could not enumerate WASM manifests:", wasmResult.reason);
  }
  return buildModelToolCatalog(
    VECTOR_TOOLS,
    mergeWasmToolManifests(
      catalogResult.status === "fulfilled" ? catalogResult.value : [],
      wasmResult.status === "fulfilled" ? wasmResult.value : [],
    ),
  );
}

/** The model-facing shape of one algorithm: ports and parameters, no manifest. */
function modelAlgorithmDetail(descriptor: ModelToolDescriptor) {
  return {
    // Qualified, because two registries can define the same bare id and
    // `buildAssistantModel` rejects a colliding one until it is namespaced.
    id: descriptor.key,
    provider: descriptor.provider,
    name: descriptor.name,
    group: descriptor.group,
    description: descriptor.description,
    inputs: descriptor.inputs,
    parameters: descriptor.parameters,
    outputs: descriptor.outputs,
  };
}

/** Full detail for at most this many `list_model_algorithms` search hits. */
const MAX_MODEL_ALGORITHM_MATCHES = 25;

/** Full detail for at most this many `list_whitebox_tools` search hits. */
const MAX_WHITEBOX_MATCHES = 25;

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
  type WhiteboxToolSummary = {
    id: string;
    name: string;
    category: string;
    description: string;
    parameters: unknown[];
  };
  type ScriptingHandlers = {
    listAlgorithms: () => unknown;
    runAlgorithm: (input: {
      id: string;
      params: Record<string, unknown>;
    }) => Promise<{ logs?: string[]; resultLayerIds?: string[] }>;
    listWhiteboxTools: () => Promise<WhiteboxToolSummary[]>;
    runWhiteboxTool: (input: {
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
        const parsed = asFeatureCollection(JSON.parse(await readTextCapped(response, MAX_BYTES)));
        // A projected GeoJSON declares a non-WGS84 CRS via a legacy top-level
        // `crs` member; reproject to WGS84 so MapLibre receives lon/lat. The
        // DuckDB loader is pulled in only when such a member is present.
        const sourceCrs = projectedGeoJsonCrs(parsed);
        const geojson = sourceCrs
          ? await (
              await import("../duckdb-vector-loader")
            ).reprojectFeatureCollectionToWgs84(parsed, sourceCrs)
          : parsed;
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
      "List the available client-side processing algorithms (vector geometry/overlay tools like buffer, clip, dissolve, intersection, difference, union, spatial-join; plus H3 grids) with their id, name, group, and typed parameters. Call this before run_algorithm. These are vector-only — for raster work (hydrology, terrain, LiDAR, image processing) use list_whitebox_tools and run_whitebox_tool instead.",
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

  const listWhiteboxTools = tool({
    name: "list_whitebox_tools",
    description:
      "List Whitebox raster/terrain tools that can run in the browser (hydrology such as fill_depressions, d8_pointer, flow accumulation and extract_streams; terrain such as slope, aspect, hillshade; LiDAR; image processing; raster↔vector conversion) with their exact parameter names, kinds and defaults. The catalog runs to ~1000 tools, so pass `search` to filter by name, id or category ('slope', 'stream', 'hydro'); without it you get the category names to search within. Call this before run_whitebox_tool.",
    inputSchema: z.object({
      search: z
        .string()
        .optional()
        .describe("Filter by tool name, id or category, e.g. 'slope' or 'hydrology'."),
    }),
    callback: async (input) => {
      const tools = await (await getScripting()).listWhiteboxTools();
      const query = input.search?.trim().toLowerCase();
      if (query) {
        const matches = tools.filter((item) =>
          `${item.name} ${item.id} ${item.category}`.toLowerCase().includes(query),
        );
        return json({
          search: input.search,
          matched: matches.length,
          truncated: matches.length > MAX_WHITEBOX_MATCHES,
          tools: matches.slice(0, MAX_WHITEBOX_MATCHES),
        });
      }
      // ~1000 tools with full parameter lists is far too much to serialize, so
      // an unfiltered call returns the categories to search within instead.
      const categories = new Map<string, number>();
      for (const item of tools) {
        categories.set(item.category, (categories.get(item.category) ?? 0) + 1);
      }
      return json({
        total: tools.length,
        categories: [...categories]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([category, count]) => ({ category, tools: count })),
        hint: "Call again with `search` (a category, a tool name, or a keyword like 'stream') to get exact ids and parameters.",
      });
    },
  });

  const runWhiteboxTool = tool({
    name: "run_whitebox_tool",
    description:
      "Run a Whitebox tool by id (from list_whitebox_tools) in the browser via WASM and add its results as new layers. `params` is keyed by the tool's exact parameter names; a raster/vector input parameter takes a layer id (from list_layers). Chain steps by feeding one run's returned result layer id into the next. Returns the run log and the new layer id(s).",
    inputSchema: z.object({
      id: z.string().describe("Whitebox tool id, e.g. 'fill_depressions', 'slope'."),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Parameter values keyed by parameter name; input parameters take a layer id."),
    }),
    callback: async (input) => {
      const result = await (
        await getScripting()
      ).runWhiteboxTool({ id: input.id, params: input.params ?? {} });
      return json({
        logs: result.logs ?? [],
        resultLayerIds: result.resultLayerIds ?? [],
      });
    },
  });

  const listModelAlgorithms = tool({
    name: "list_model_algorithms",
    description:
      "List algorithms that can be placed in Model Builder — client-side vector tools plus the full Whitebox/raster catalog (hydrology, terrain, LiDAR, image processing) — with their exact input-port and parameter ids. The catalog runs to ~1000 tools, so pass `search` to filter by name, id or group ('stream', 'flow accumulation', 'hydro', 'terrain'); without it you get the vector tools in full plus the Whitebox group names to search within. Call this before create_model_builder_model and use the exact ids it returns.",
    inputSchema: z.object({
      search: z
        .string()
        .optional()
        .describe("Filter by tool name, id or group, e.g. 'stream' or 'hydrology'."),
    }),
    callback: async (input) => {
      const [catalog, { searchModelTools }] = await Promise.all([
        loadModelToolDescriptors(),
        import("../model-tool-catalog"),
      ]);
      const query = input.search?.trim();
      if (query) {
        const matches = searchModelTools(catalog, query);
        return json({
          search: query,
          matched: matches.length,
          // Enough for the model to pick from without flooding the context; a
          // narrower search is the way to see the rest.
          truncated: matches.length > MAX_MODEL_ALGORITHM_MATCHES,
          algorithms: matches.slice(0, MAX_MODEL_ALGORITHM_MATCHES).map(modelAlgorithmDetail),
        });
      }
      // Unfiltered, the Whitebox half is far too large to serialize, so it is
      // summarized to its groups. Searching one of those group names returns
      // the tools inside it with full ports and parameters.
      const groups = new Map<string, number>();
      for (const descriptor of catalog) {
        if (descriptor.provider === "vector") continue;
        groups.set(descriptor.group, (groups.get(descriptor.group) ?? 0) + 1);
      }
      return json({
        algorithms: catalog.filter((d) => d.provider === "vector").map(modelAlgorithmDetail),
        rasterGroups: [...groups]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([group, tools]) => ({ group, tools })),
        hint: "Raster/Whitebox tools are summarized by group. Call again with `search` (a group name, a tool name, or a keyword like 'stream') to get their exact ids, ports and parameters.",
      });
    },
  });

  const createModelBuilderModel = tool({
    name: "create_model_builder_model",
    description:
      "Create, save, and open an editable Model Builder workflow. Steps can mix client-side vector tools and Whitebox/raster tools, so a raster chain (e.g. fill depressions → flow accumulation → extract streams → raster-to-vector) is a valid model. Inputs and steps use unique short keys. Each step's inputs maps an algorithm input-port id to an earlier input/step key; parameters holds non-layer settings. Outputs name results to add to the map. Call list_model_algorithms first and use the exact ids it returns; the model is always saved, but Model Builder asks before replacing unsaved canvas work or a running job.",
    inputSchema: z.object({
      name: z.string(),
      inputs: z.array(
        z.object({
          key: z.string(),
          layer: z.string().describe("Layer id (from list_layers), or the layer's name."),
        }),
      ),
      steps: z.array(
        z.object({
          key: z.string(),
          algorithm: z
            .string()
            .describe("Algorithm id from list_model_algorithms, e.g. 'vector:buffer'."),
          parameters: z.record(z.string(), z.unknown()).optional(),
          inputs: z
            .record(z.string(), z.string())
            .describe(
              "Maps an input-port id to an earlier input or step key. A step whose tool has several outputs must name the port too, as 'stepKey.portId'.",
            ),
        }),
      ),
      outputs: z.array(
        z.object({
          source: z
            .string()
            .describe(
              "The step key whose result to add to the map, or 'stepKey.portId' when the tool has several outputs.",
            ),
          name: z.string(),
        }),
      ),
    }),
    callback: async (input) => {
      // Loaded here rather than at module scope so `@geolibre/processing` —
      // which `model-builder` imports for its graph helpers — stays out of the
      // assistant's initial chunk, the same reason `getScripting` defers it.
      const [{ buildAssistantModel }, descriptors] = await Promise.all([
        import("./model-builder"),
        loadModelToolDescriptors(),
      ]);
      // Read the layers only once the catalog has loaded: the first call fetches
      // the Whitebox snapshot and WASM manifests, and a layer added or renamed
      // in that window would otherwise be validated against a stale list.
      const model = buildAssistantModel(input, store().layers, descriptors);
      store().saveModel(model);
      store().setModelBuilderRequestedModelId(model.id);
      store().setModelBuilderOpen(true);
      return json({
        modelId: model.id,
        name: model.name,
        nodes: model.graph?.nodes.length ?? 0,
        edges: model.graph?.edges.length ?? 0,
        saved: true,
        // The panel is opened here, but it loads the model from an effect that
        // first asks about unsaved canvas work or a run in flight. That answer
        // arrives long after this result, so claiming the model is on screen
        // would let the assistant report an outcome the user may have declined.
        builderOpened: true,
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

  const builtIns = [
    listLayers,
    runSql,
    addLayerFromUrl,
    addTileLayer,
    listAlgorithms,
    runAlgorithm,
    listWhiteboxTools,
    runWhiteboxTool,
    listModelAlgorithms,
    createModelBuilderModel,
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

  // Plugin-contributed tools (see @geolibre/plugins' assistant-tool-registry).
  // Their names are owner-prefixed at registration, so a collision with a
  // built-in name is a registry bug — skipped defensively rather than letting
  // the agent build fail on a duplicate. A plugin tool runs plugin-authored
  // code with model-chosen inputs (like run_algorithm), so it is not routed
  // through confirmCodeExecution, which guards model-authored code only.
  const takenNames = new Set(
    builtIns
      .map((builtIn) => (builtIn as { name?: unknown }).name)
      .filter((name): name is string => typeof name === "string"),
  );
  const pluginTools = listAssistantToolEntries()
    .filter((entry) => {
      if (!takenNames.has(entry.qualifiedName)) return true;
      console.warn(
        `Assistant tool "${entry.qualifiedName}" collides with a built-in tool name; skipped.`,
      );
      return false;
    })
    .map((entry) =>
      tool({
        name: entry.qualifiedName,
        description: entry.tool.description,
        ...(entry.tool.inputSchema
          ? { inputSchema: entry.tool.inputSchema as JSONSchema }
          : {}),
        callback: async (input: unknown) => json(await entry.tool.execute(input)),
      }),
    );

  return [...builtIns, ...pluginTools] as InvokableTool<unknown, unknown>[];
}

/**
 * A system-prompt section enumerating the plugin-contributed tools, so the
 * model discovers them the way the built-in prompt enumerates its own tools.
 * Empty when no plugin tool is registered. The assistant rebuilds its agent
 * whenever the registry changes, so this stays in step with
 * {@link createAssistantTools}.
 */
export function describePluginTools(): string {
  const entries = listAssistantToolEntries();
  if (entries.length === 0) return "";
  const lines = entries.map((entry) => `- ${entry.qualifiedName}: ${entry.tool.description}`);
  return `\n\nPlugins have contributed these additional tools — call them like any built-in tool:\n${lines.join("\n")}`;
}
