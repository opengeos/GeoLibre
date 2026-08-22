/**
 * Interactive SAM3 segmentation backed by segment-geospatial's REST API.
 *
 * The panel deliberately talks to samgeo-api directly (default :8000). This
 * keeps it useful in both the browser and desktop builds and mirrors SamGeo's
 * own interactive map: text, foreground/background points, a similarity box,
 * and automatic mask generation all share one uploaded image and model cache.
 */

import type { FeatureCollection, Geometry, Position } from "geojson";
import { fromArrayBuffer } from "geotiff";
import proj4 from "proj4";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

export const SAMGEO_PLUGIN_ID = "maplibre-samgeo";
const PANEL_ID = "samgeo-segmentation-panel";
const PROMPT_SOURCE = "samgeo-prompt-source";
const PROMPT_FILL = "samgeo-prompt-fill";
const PROMPT_LINE = "samgeo-prompt-line";
const PROMPT_POINTS = "samgeo-prompt-points";
const DEFAULT_API_URL = "http://127.0.0.1:8000";

type Mode = "text" | "points" | "box" | "automatic";
type PromptPoint = { coordinates: [number, number]; label: 0 | 1 };

interface SamGeoState {
  apiUrl: string;
  mode: Mode;
  modelId: string;
  backend: "meta" | "transformers";
  prompt: string;
  confidence: number;
  minSize: number;
  maxSize: number;
  pointsPerSide: number;
  predIou: number;
  stability: number;
}

const state: SamGeoState = {
  apiUrl: DEFAULT_API_URL,
  mode: "text",
  modelId: "facebook/sam3.1",
  backend: "meta",
  prompt: "building",
  confidence: 0.5,
  minSize: 10,
  maxSize: 0,
  pointsPerSide: 32,
  predIou: 0.8,
  stability: 0.95,
};

let appRef: GeoLibreAppAPI | null = null;
let unregisterPanel: (() => void) | null = null;
let disposePanel: (() => void) | null = null;
let promptPoints: PromptPoint[] = [];
let promptBox: [number, number, number, number] | null = null;
let cancelDrawing: (() => void) | null = null;

const css = {
  root: "box-sizing:border-box;height:100%;overflow:auto;padding:12px;font:13px system-ui,sans-serif;color:var(--foreground);",
  section: "display:grid;gap:7px;margin-bottom:13px;",
  label: "font-size:12px;font-weight:600;",
  input:
    "box-sizing:border-box;width:100%;min-height:34px;border:1px solid var(--border);border-radius:6px;background:var(--background);color:var(--foreground);padding:6px 8px;",
  row: "display:flex;gap:7px;align-items:center;",
  button:
    "min-height:34px;border:1px solid var(--border);border-radius:6px;background:var(--background);color:var(--foreground);padding:6px 10px;cursor:pointer;",
  primary:
    "min-height:36px;border:0;border-radius:6px;background:var(--primary);color:var(--primary-foreground);padding:7px 12px;font-weight:600;cursor:pointer;",
  muted: "color:var(--muted-foreground);font-size:12px;line-height:1.4;",
  status: "min-height:18px;font-size:12px;line-height:1.4;overflow-wrap:anywhere;",
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function field(labelText: string, input: HTMLElement): HTMLDivElement {
  const wrap = element("div");
  wrap.style.cssText = css.section;
  const label = element("label", labelText);
  label.style.cssText = css.label;
  wrap.append(label, input);
  return wrap;
}

function input(type = "text"): HTMLInputElement {
  const node = element("input");
  node.type = type;
  node.style.cssText = css.input;
  return node;
}

function button(text: string, primary = false): HTMLButtonElement {
  const node = element("button", text);
  node.type = "button";
  node.style.cssText = primary ? css.primary : css.button;
  return node;
}

function apiBase(): string {
  return state.apiUrl.trim().replace(/\/+$/, "");
}

function promptFeatures(): FeatureCollection {
  const features: FeatureCollection["features"] = promptPoints.map((point, index) => ({
    type: "Feature",
    id: `point-${index}`,
    geometry: { type: "Point", coordinates: point.coordinates },
    properties: { label: point.label },
  }));
  if (promptBox) {
    const [west, south, east, north] = promptBox;
    features.push({
      type: "Feature",
      id: "box",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [west, south],
            [east, south],
            [east, north],
            [west, north],
            [west, south],
          ],
        ],
      },
      properties: { label: 2 },
    });
  }
  return { type: "FeatureCollection", features };
}

function removePromptOverlay(map: MapLibreMap): void {
  for (const id of [PROMPT_POINTS, PROMPT_LINE, PROMPT_FILL]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(PROMPT_SOURCE)) map.removeSource(PROMPT_SOURCE);
}

function updatePromptOverlay(map: MapLibreMap): void {
  const data = promptFeatures();
  const existing = map.getSource(PROMPT_SOURCE) as
    | { setData?: (value: FeatureCollection) => void }
    | undefined;
  if (existing?.setData) {
    existing.setData(data);
    return;
  }
  map.addSource(PROMPT_SOURCE, { type: "geojson", data });
  map.addLayer({
    id: PROMPT_FILL,
    type: "fill",
    source: PROMPT_SOURCE,
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: { "fill-color": "#8b5cf6", "fill-opacity": 0.14 },
  });
  map.addLayer({
    id: PROMPT_LINE,
    type: "line",
    source: PROMPT_SOURCE,
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: { "line-color": "#8b5cf6", "line-width": 2, "line-dasharray": [2, 1] },
  });
  map.addLayer({
    id: PROMPT_POINTS,
    type: "circle",
    source: PROMPT_SOURCE,
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-radius": 7,
      "circle-color": ["case", ["==", ["get", "label"], 1], "#22c55e", "#ef4444"],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
    },
  });
}

function beginPointDraw(label: 0 | 1, done: () => void): (() => void) | null {
  const map = appRef?.getMap?.();
  if (!map) return null;
  const canvas = map.getCanvas();
  canvas.style.cursor = "crosshair";
  const onClick = (event: { lngLat: { lng: number; lat: number } }) => {
    promptPoints.push({ coordinates: [event.lngLat.lng, event.lngLat.lat], label });
    updatePromptOverlay(map);
    cleanup();
    done();
  };
  const cleanup = () => {
    map.off("click", onClick);
    canvas.style.cursor = "";
  };
  map.once("click", onClick);
  return cleanup;
}

function beginBoxDraw(done: () => void): (() => void) | null {
  const map = appRef?.getMap?.();
  if (!map) return null;
  const canvas = map.getCanvas();
  let start: [number, number] | null = null;
  canvas.style.cursor = "crosshair";
  map.dragPan.disable();
  const coordinatesAt = (event: MouseEvent): [number, number] => {
    const rect = canvas.getBoundingClientRect();
    const p = map.unproject([event.clientX - rect.left, event.clientY - rect.top]);
    return [p.lng, p.lat];
  };
  const onDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    start = coordinatesAt(event);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  const setBox = (end: [number, number]) => {
    if (!start) return;
    promptBox = [
      Math.min(start[0], end[0]),
      Math.min(start[1], end[1]),
      Math.max(start[0], end[0]),
      Math.max(start[1], end[1]),
    ];
    updatePromptOverlay(map);
  };
  const onMove = (event: MouseEvent) => setBox(coordinatesAt(event));
  const onUp = (event: MouseEvent) => {
    setBox(coordinatesAt(event));
    cleanup();
    done();
  };
  const cleanup = () => {
    canvas.removeEventListener("mousedown", onDown);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    canvas.style.cursor = "";
    map.dragPan.enable();
  };
  canvas.addEventListener("mousedown", onDown);
  return cleanup;
}

async function rasterProjection(bytes: ArrayBuffer): Promise<string | null> {
  try {
    const image = await (await fromArrayBuffer(bytes)).getImage();
    const keys = image.getGeoKeys() as Record<string, unknown>;
    const mod = await import("geotiff-geokeys-to-proj4");
    return mod.toProj4(keys as never)?.proj4?.replace(/\+axis=\w+\s*/g, "") ?? null;
  } catch {
    return null;
  }
}

function mapPositions(value: unknown, convert: (position: Position) => Position): unknown {
  if (!Array.isArray(value)) return value;
  if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    return convert(value as Position);
  }
  return value.map((part) => mapPositions(part, convert));
}

/** Convert SamGeo polygons from the source raster CRS to MapLibre's WGS84. */
export function reprojectSamGeoResult(
  fc: FeatureCollection,
  sourceProjection: string | null,
): FeatureCollection {
  const namedCrs = (fc as FeatureCollection & { crs?: { properties?: { name?: unknown } } }).crs
    ?.properties?.name;
  const crsText = typeof namedCrs === "string" ? namedCrs : "";
  const alreadyWgs84 = /(?:EPSG(?::|::)4326|CRS84)/i.test(crsText);
  const projection = alreadyWgs84 ? null : sourceProjection;
  const features = fc.features.map((feature) => {
    if (!projection || !feature.geometry) return feature;
    const geometry = feature.geometry as Geometry;
    return {
      ...feature,
      geometry: {
        ...geometry,
        coordinates: mapPositions(
          (geometry as { coordinates?: unknown }).coordinates,
          (position) => {
            const [lng, lat] = proj4(projection, "EPSG:4326", [position[0], position[1]]);
            return [lng, lat, ...position.slice(2)];
          },
        ),
      } as Geometry,
    };
  });
  return { type: "FeatureCollection", features };
}

function appendCommon(form: FormData): void {
  form.append("output_format", "geojson");
  form.append("min_size", String(state.minSize));
  if (state.maxSize > 0) form.append("max_size", String(state.maxSize));
  if (state.modelId.trim()) form.append("model_id", state.modelId.trim());
}

async function requestSegmentation(file: File, bytes: ArrayBuffer): Promise<FeatureCollection> {
  const form = new FormData();
  form.append("file", file, file.name);
  appendCommon(form);
  let endpoint: string;
  if (state.mode === "text") {
    endpoint = "/segment/text";
    form.append("prompt", state.prompt.trim());
    form.append("backend", state.backend);
    form.append("confidence_threshold", String(state.confidence));
  } else if (state.mode === "automatic") {
    endpoint = "/segment/automatic";
    form.append("model_version", "sam3");
    form.append("points_per_side", String(state.pointsPerSide));
    form.append("pred_iou_thresh", String(state.predIou));
    form.append("stability_score_thresh", String(state.stability));
  } else {
    endpoint = "/segment/predict";
    form.append("model_version", "sam3");
    form.append("point_crs", "EPSG:4326");
    // Match the QGIS plugin: multiple prompts and any background prompt are
    // already unambiguous; a lone foreground click benefits from alternatives.
    const multimask =
      state.mode === "points" && promptPoints.length === 1 && promptPoints[0]?.label === 1;
    form.append("multimask_output", String(multimask));
    if (state.mode === "points") {
      form.append("point_coords", JSON.stringify(promptPoints.map((point) => point.coordinates)));
      form.append("point_labels", JSON.stringify(promptPoints.map((point) => point.label)));
    } else if (promptBox) {
      form.append("boxes", JSON.stringify([promptBox]));
    }
  }
  const response = await fetch(`${apiBase()}${endpoint}`, { method: "POST", body: form });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`SamGeo API ${response.status}: ${detail || response.statusText}`);
  }
  const result = (await response.json()) as FeatureCollection;
  if (result.type !== "FeatureCollection" || !Array.isArray(result.features)) {
    throw new Error("SamGeo API did not return a GeoJSON FeatureCollection.");
  }
  return reprojectSamGeoResult(result, await rasterProjection(bytes));
}

function buildPanel(container: HTMLElement): () => void {
  container.replaceChildren();
  const root = element("div");
  root.style.cssText = css.root;
  root.dataset.testid = "samgeo-panel";

  const intro = element(
    "p",
    "Segment imagery with SAM3 using text, points, a box, or automatic masks.",
  );
  intro.style.cssText = `${css.muted}margin:0 0 13px;`;

  const api = input();
  api.value = state.apiUrl;
  api.dataset.testid = "samgeo-api-url";
  api.addEventListener("change", () => {
    state.apiUrl = api.value;
  });
  const health = button("Check connection");
  const healthText = element("span", "Not checked");
  healthText.style.cssText = css.muted;
  const healthRow = element("div");
  healthRow.style.cssText = css.row;
  healthRow.append(health, healthText);

  const fileInput = input("file");
  fileInput.accept = ".tif,.tiff,.png,.jpg,.jpeg";
  fileInput.dataset.testid = "samgeo-image";

  const mode = element("select");
  mode.style.cssText = css.input;
  mode.dataset.testid = "samgeo-mode";
  for (const [value, label] of [
    ["text", "Text prompt"],
    ["points", "Point prompts"],
    ["box", "Bounding box (find similar)"],
    ["automatic", "Automatic (everything)"],
  ] as const) {
    const option = element("option", label);
    option.value = value;
    mode.append(option);
  }
  mode.value = state.mode;

  const dynamic = element("div");
  const drawSummary = element("div");
  drawSummary.style.cssText = css.muted;
  const status = element("div");
  status.style.cssText = css.status;
  status.dataset.testid = "samgeo-status";

  const numberField = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    update: (n: number) => void,
  ) => {
    const node = input("number");
    node.value = String(value);
    node.min = String(min);
    node.max = String(max);
    node.step = String(step);
    node.addEventListener("change", () => {
      const parsed = Number(node.value);
      if (Number.isFinite(parsed)) update(Math.min(max, Math.max(min, parsed)));
    });
    return field(label, node);
  };

  const refreshDynamic = () => {
    cancelDrawing?.();
    cancelDrawing = null;
    dynamic.replaceChildren();
    if (state.mode === "text") {
      const prompt = input();
      prompt.value = state.prompt;
      prompt.dataset.testid = "samgeo-text-prompt";
      prompt.addEventListener("input", () => {
        state.prompt = prompt.value;
      });
      dynamic.append(field("Text prompt", prompt));
      dynamic.append(
        numberField("Confidence threshold", state.confidence, 0, 1, 0.05, (n) => {
          state.confidence = n;
        }),
      );
      dynamic.append(
        numberField("Minimum mask size (pixels)", state.minSize, 0, 1_000_000, 1, (n) => {
          state.minSize = n;
        }),
      );
      dynamic.append(
        numberField("Maximum mask size (0 = no limit)", state.maxSize, 0, 10_000_000, 1, (n) => {
          state.maxSize = n;
        }),
      );
      const backend = element("select");
      backend.style.cssText = css.input;
      for (const value of ["meta", "transformers"] as const) {
        const option = element("option", value);
        option.value = value;
        backend.append(option);
      }
      backend.value = state.backend;
      backend.addEventListener("change", () => {
        state.backend = backend.value as SamGeoState["backend"];
      });
      dynamic.append(field("Backend", backend));
    } else if (state.mode === "points") {
      const row = element("div");
      row.style.cssText = `${css.row}margin-bottom:7px;flex-wrap:wrap;`;
      const positive = button("+ Foreground point");
      const negative = button("− Background point");
      const arm = (label: 0 | 1) => {
        cancelDrawing?.();
        status.textContent = `Click the map to add a ${label ? "foreground" : "background"} point.`;
        cancelDrawing = beginPointDraw(label, () => {
          cancelDrawing = null;
          status.textContent = "Point added.";
          refreshSummary();
        });
      };
      positive.addEventListener("click", () => arm(1));
      negative.addEventListener("click", () => arm(0));
      row.append(positive, negative);
      dynamic.append(row, drawSummary);
      dynamic.append(
        numberField("Minimum mask size (pixels)", state.minSize, 0, 1_000_000, 1, (n) => {
          state.minSize = n;
        }),
      );
      dynamic.append(
        numberField("Maximum mask size (0 = no limit)", state.maxSize, 0, 10_000_000, 1, (n) => {
          state.maxSize = n;
        }),
      );
    } else if (state.mode === "box") {
      const draw = button("Draw box on map");
      draw.addEventListener("click", () => {
        cancelDrawing?.();
        status.textContent = "Drag a rectangle on the map.";
        cancelDrawing = beginBoxDraw(() => {
          cancelDrawing = null;
          status.textContent = "Box added.";
          refreshSummary();
        });
      });
      dynamic.append(draw, drawSummary);
      dynamic.append(
        numberField("Minimum mask size (pixels)", state.minSize, 0, 1_000_000, 1, (n) => {
          state.minSize = n;
        }),
      );
      dynamic.append(
        numberField("Maximum mask size (0 = no limit)", state.maxSize, 0, 10_000_000, 1, (n) => {
          state.maxSize = n;
        }),
      );
    } else {
      dynamic.append(
        numberField("Points per side", state.pointsPerSide, 1, 128, 1, (n) => {
          state.pointsPerSide = n;
        }),
      );
      dynamic.append(
        numberField("Predicted IoU threshold", state.predIou, 0, 1, 0.05, (n) => {
          state.predIou = n;
        }),
      );
      dynamic.append(
        numberField("Stability threshold", state.stability, 0, 1, 0.05, (n) => {
          state.stability = n;
        }),
      );
      dynamic.append(
        numberField("Minimum mask size (pixels)", state.minSize, 0, 1_000_000, 1, (n) => {
          state.minSize = n;
        }),
      );
      dynamic.append(
        numberField("Maximum mask size (0 = no limit)", state.maxSize, 0, 10_000_000, 1, (n) => {
          state.maxSize = n;
        }),
      );
    }
    refreshSummary();
  };
  const refreshSummary = () => {
    drawSummary.textContent =
      state.mode === "points"
        ? `${promptPoints.filter((p) => p.label === 1).length} foreground, ${promptPoints.filter((p) => p.label === 0).length} background`
        : promptBox
          ? `Box: ${promptBox.map((n) => n.toFixed(5)).join(", ")}`
          : "No box drawn.";
  };

  const model = input();
  model.value = state.modelId;
  model.addEventListener("change", () => {
    state.modelId = model.value;
  });
  const clear = button("Clear prompts");
  clear.addEventListener("click", () => {
    promptPoints = [];
    promptBox = null;
    const map = appRef?.getMap?.();
    if (map) updatePromptOverlay(map);
    refreshSummary();
    status.textContent = "Prompts cleared.";
  });
  const run = button("Segment", true);
  run.dataset.testid = "samgeo-run";
  run.addEventListener("click", async () => {
    const file = fileInput.files?.[0];
    if (!file) {
      status.textContent = "Choose an image first.";
      return;
    }
    if (state.mode === "text" && !state.prompt.trim()) {
      status.textContent = "Enter a text prompt.";
      return;
    }
    if (state.mode === "points" && promptPoints.length === 0) {
      status.textContent = "Add at least one point prompt.";
      return;
    }
    if (state.mode === "box" && !promptBox) {
      status.textContent = "Draw a box first.";
      return;
    }
    run.disabled = true;
    status.textContent = "Segmenting…";
    try {
      const bytes = await file.arrayBuffer();
      const result = await requestSegmentation(file, bytes);
      if (!result.features.length) {
        status.textContent = "No objects found.";
        return;
      }
      const suffix = state.mode === "text" ? `: ${state.prompt.trim()}` : ` (${state.mode})`;
      const layerId = appRef?.addGeoJsonLayer(`SamGeo${suffix}`, result);
      const bounds = result.features.flatMap((feature) => {
        const coords: Position[] = [];
        mapPositions((feature.geometry as { coordinates?: unknown } | null)?.coordinates, (p) => {
          coords.push(p);
          return p;
        });
        return coords;
      });
      if (bounds.length) {
        appRef?.fitBounds?.([
          Math.min(...bounds.map((p) => p[0])),
          Math.min(...bounds.map((p) => p[1])),
          Math.max(...bounds.map((p) => p[0])),
          Math.max(...bounds.map((p) => p[1])),
        ]);
      }
      status.textContent = `Added ${result.features.length} feature(s)${layerId ? ` as ${layerId}` : ""}.`;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      run.disabled = false;
    }
  });

  health.addEventListener("click", async () => {
    health.disabled = true;
    healthText.textContent = "Checking…";
    try {
      const response = await fetch(`${apiBase()}/health`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { version?: string };
      healthText.textContent = `Connected${data.version ? ` · v${data.version}` : ""}`;
    } catch (error) {
      healthText.textContent = `Unavailable: ${error instanceof Error ? error.message : error}`;
    } finally {
      health.disabled = false;
    }
  });
  mode.addEventListener("change", () => {
    state.mode = mode.value as Mode;
    refreshDynamic();
  });

  const actions = element("div");
  actions.style.cssText = `${css.row}flex-wrap:wrap;margin-bottom:8px;`;
  actions.append(run, clear);
  root.append(
    intro,
    field("SamGeo API URL", api),
    healthRow,
    field("Image", fileInput),
    field("Mode", mode),
    field("Model ID", model),
    dynamic,
    actions,
    status,
  );
  container.append(root);
  refreshDynamic();
  return () => {
    cancelDrawing?.();
    cancelDrawing = null;
    container.replaceChildren();
  };
}

export const maplibreSamGeoPlugin: GeoLibrePlugin = {
  id: SAMGEO_PLUGIN_ID,
  name: "SamGeo",
  version: "0.1.0",
  activate(app) {
    appRef = app;
    unregisterPanel =
      app.registerRightPanel?.({
        id: PANEL_ID,
        title: "SamGeo Segmentation",
        dock: "replace-style",
        defaultWidth: 390,
        render(container) {
          disposePanel?.();
          disposePanel = buildPanel(container);
          return () => {
            disposePanel?.();
            disposePanel = null;
          };
        },
      }) ?? null;
    app.openRightPanel?.(PANEL_ID);
  },
  deactivate(app) {
    cancelDrawing?.();
    cancelDrawing = null;
    disposePanel?.();
    disposePanel = null;
    const map = app.getMap?.();
    if (map) removePromptOverlay(map);
    app.closeRightPanel?.(PANEL_ID);
    unregisterPanel?.();
    unregisterPanel = null;
    appRef = null;
  },
  getProjectState: () => ({ ...state }),
  applyProjectState(_app, value) {
    if (!value || typeof value !== "object") return false;
    Object.assign(state, value);
    return true;
  },
};

export default maplibreSamGeoPlugin;
