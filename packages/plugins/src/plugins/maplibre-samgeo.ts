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
import { useAppStore } from "@geolibre/core";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

export const SAMGEO_PLUGIN_ID = "maplibre-samgeo";
const PANEL_ID = "samgeo-segmentation-panel";
const PROMPT_SOURCE = "samgeo-prompt-source";
const PROMPT_FILL = "samgeo-prompt-fill";
const PROMPT_LINE = "samgeo-prompt-line";
const PROMPT_POINTS = "samgeo-prompt-points";
const DEFAULT_API_URL = "http://127.0.0.1:8000";
export const SAMGEO_API_DOCS_URL = "https://samgeo.gishub.org/api/";

type Mode = "text" | "points" | "box" | "automatic";
type PromptPoint = { coordinates: [number, number]; label: 0 | 1 };

interface SamGeoState {
  apiUrl: string;
  mode: Mode;
  modelId: string;
  /** SAM2 checkpoint for automatic mode, which the API runs with SAM2. */
  sam2ModelId: string;
  backend: "meta" | "transformers";
  prompt: string;
  confidence: number;
  minSize: number;
  maxSize: number;
  pointsPerSide: number;
  predIou: number;
  stability: number;
}

/**
 * Host-translated strings. The plugins package has no i18n access, so the
 * desktop shell pushes translations through {@link setSamGeoLabels} (the same
 * pattern as `maplibre-stac` and `maplibre-graticule`).
 */
export interface SamGeoLabels {
  panelTitle: string;
  intro: string;
  apiUrl: string;
  checkConnection: string;
  notChecked: string;
  checking: string;
  connected: string;
  unavailable: (error: string) => string;
  image: string;
  imageSource: string;
  imageUpload: string;
  noRasterLayers: string;
  layerUnreadable: string;
  docsLink: string;
  mode: string;
  modeText: string;
  modePoints: string;
  modeBox: string;
  modeAutomatic: string;
  modelId: string;
  sam2ModelId: string;
  automaticHint: string;
  textPrompt: string;
  confidence: string;
  minSize: string;
  maxSize: string;
  backend: string;
  foregroundPoint: string;
  backgroundPoint: string;
  clickForeground: string;
  clickBackground: string;
  pointAdded: string;
  drawBox: string;
  dragBox: string;
  boxAdded: string;
  boxSummary: (box: string) => string;
  noBox: string;
  pointSummary: (foreground: number, background: number) => string;
  pointsPerSide: string;
  predIou: string;
  stability: string;
  clearPrompts: string;
  promptsCleared: string;
  segment: string;
  chooseImage: string;
  enterPrompt: string;
  addPoint: string;
  drawBoxFirst: string;
  segmenting: string;
  noObjects: string;
  added: (count: number, layer: string) => string;
  badResponse: string;
  unknownProjection: string;
}

const DEFAULT_LABELS: SamGeoLabels = {
  panelTitle: "SamGeo Segmentation",
  intro: "Segment imagery with SAM3 using text, points, a box, or automatic masks.",
  apiUrl: "SamGeo API URL",
  checkConnection: "Check connection",
  notChecked: "Not checked",
  checking: "Checking…",
  connected: "Connected",
  unavailable: (error) => `Unavailable: ${error}`,
  image: "Image",
  imageSource: "Image source",
  imageUpload: "Upload a file",
  noRasterLayers: "No raster layers loaded",
  layerUnreadable:
    "This layer has no readable GeoTIFF source; export it or upload the file instead.",
  docsLink: "How to set up the SamGeo API",
  mode: "Mode",
  modeText: "Text prompt",
  modePoints: "Point prompts",
  modeBox: "Bounding box (find similar)",
  modeAutomatic: "Automatic (everything)",
  modelId: "Model ID",
  sam2ModelId: "SAM2 model",
  automaticHint:
    "Automatic mode runs SAM2's mask generator, which segments every object; SAM3 only responds to prompts.",
  textPrompt: "Text prompt",
  confidence: "Confidence threshold",
  minSize: "Minimum mask size (pixels)",
  maxSize: "Maximum mask size (0 = no limit)",
  backend: "Backend",
  foregroundPoint: "+ Foreground point",
  backgroundPoint: "− Background point",
  clickForeground: "Click the map to add a foreground point.",
  clickBackground: "Click the map to add a background point.",
  pointAdded: "Point added.",
  drawBox: "Draw box on map",
  dragBox: "Drag a rectangle on the map.",
  boxAdded: "Box added.",
  boxSummary: (box) => `Box: ${box}`,
  noBox: "No box drawn.",
  pointSummary: (foreground, background) => `${foreground} foreground, ${background} background`,
  pointsPerSide: "Points per side",
  predIou: "Predicted IoU threshold",
  stability: "Stability threshold",
  clearPrompts: "Clear prompts",
  promptsCleared: "Prompts cleared.",
  segment: "Segment",
  chooseImage: "Choose an image first.",
  enterPrompt: "Enter a text prompt.",
  addPoint: "Add at least one foreground point.",
  drawBoxFirst: "Draw a box first.",
  segmenting: "Segmenting…",
  noObjects: "No objects found.",
  added: (count, layer) => `Added ${count} feature(s)${layer}.`,
  badResponse: "SamGeo API did not return a GeoJSON FeatureCollection.",
  unknownProjection:
    "The result is not in WGS84 and the image carries no readable projection, so it cannot be placed on the map. Use a georeferenced GeoTIFF.",
};

let labels: SamGeoLabels = { ...DEFAULT_LABELS };

/** Replace the panel's user-facing strings; call again on language change. */
export function setSamGeoLabels(next: Partial<SamGeoLabels>): void {
  labels = { ...DEFAULT_LABELS, ...next };
  rebuildPanel();
}

const DEFAULT_STATE: SamGeoState = {
  apiUrl: DEFAULT_API_URL,
  mode: "text",
  modelId: "facebook/sam3.1",
  sam2ModelId: "sam2-hiera-large",
  backend: "meta",
  prompt: "building",
  confidence: 0.5,
  minSize: 10,
  maxSize: 0,
  pointsPerSide: 32,
  predIou: 0.8,
  stability: 0.95,
};

const state: SamGeoState = { ...DEFAULT_STATE };

const MODES: readonly Mode[] = ["text", "points", "box", "automatic"];
const NUMERIC_RANGES: Readonly<
  Record<
    "confidence" | "minSize" | "maxSize" | "pointsPerSide" | "predIou" | "stability",
    [number, number]
  >
> = {
  confidence: [0, 1],
  minSize: [0, 1_000_000],
  maxSize: [0, 10_000_000],
  pointsPerSide: [1, 128],
  predIou: [0, 1],
  stability: [0, 1],
};

/**
 * Validate a restored project-state blob field by field. Unknown keys and
 * values of the wrong type or outside the panel's range are ignored, so a
 * crafted `.geolibre.json` cannot widen `mode`/`backend` past their unions or
 * hand `apiBase()` a non-string.
 */
export function sanitizeSamGeoState(value: unknown): Partial<SamGeoState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const next: Partial<SamGeoState> = {};
  for (const key of ["apiUrl", "modelId", "sam2ModelId", "prompt"] as const) {
    if (typeof raw[key] === "string") next[key] = raw[key] as string;
  }
  if (MODES.includes(raw.mode as Mode)) next.mode = raw.mode as Mode;
  if (raw.backend === "meta" || raw.backend === "transformers") next.backend = raw.backend;
  for (const [key, [min, max]] of Object.entries(NUMERIC_RANGES) as [
    keyof typeof NUMERIC_RANGES,
    [number, number],
  ][]) {
    const n = raw[key];
    if (typeof n === "number" && Number.isFinite(n)) next[key] = Math.min(max, Math.max(min, n));
  }
  return next;
}

function stateIsDefault(): boolean {
  return (Object.keys(DEFAULT_STATE) as (keyof SamGeoState)[]).every(
    (key) => state[key] === DEFAULT_STATE[key],
  );
}

let appRef: GeoLibreAppAPI | null = null;
let unregisterPanel: (() => void) | null = null;
let disposePanel: (() => void) | null = null;
let promptPoints: PromptPoint[] = [];
let promptBox: [number, number, number, number] | null = null;
let cancelDrawing: (() => void) | null = null;
let panelContainer: HTMLElement | null = null;
/** In-flight requests, aborted when the panel closes. Health checks and
 * segmentation run independently so one never cancels the other. */
let pendingSegmentation: AbortController | null = null;
let pendingHealth: AbortController | null = null;

const HEALTH_TIMEOUT_MS = 10_000;

/**
 * Re-render the open panel from the module state, mirroring
 * `maplibre-graticule`. Prompt geometry lives outside the DOM so it survives;
 * a chosen file does not, the same trade-off that plugin makes.
 */
function rebuildPanel(): void {
  if (!panelContainer) return;
  disposePanel?.();
  disposePanel = buildPanel(panelContainer);
}

type RequestSlot = "segmentation" | "health";

function beginRequest(slot: RequestSlot): AbortController {
  const controller = new AbortController();
  if (slot === "segmentation") {
    pendingSegmentation?.abort();
    pendingSegmentation = controller;
  } else {
    pendingHealth?.abort();
    pendingHealth = controller;
  }
  return controller;
}

function endRequest(slot: RequestSlot, controller: AbortController): void {
  if (slot === "segmentation" && pendingSegmentation === controller) pendingSegmentation = null;
  if (slot === "health" && pendingHealth === controller) pendingHealth = null;
}

function abortRequests(): void {
  pendingSegmentation?.abort();
  pendingSegmentation = null;
  pendingHealth?.abort();
  pendingHealth = null;
}

/** Everything a segmentation request reads, frozen when the user clicks Segment. */
interface SegmentationSnapshot extends SamGeoState {
  points: PromptPoint[];
  box: [number, number, number, number] | null;
}

function snapshotRequest(): SegmentationSnapshot {
  return {
    ...state,
    points: promptPoints.map((p) => ({ ...p })),
    box: promptBox,
  };
}

const css = {
  root: "box-sizing:border-box;height:100%;overflow:auto;padding:12px;font:13px system-ui,sans-serif;color:hsl(var(--foreground));",
  section: "display:grid;gap:7px;margin-bottom:13px;",
  label: "font-size:12px;font-weight:600;",
  input:
    "box-sizing:border-box;width:100%;min-height:34px;border:1px solid hsl(var(--border));border-radius:6px;background:hsl(var(--background));color:hsl(var(--foreground));padding:6px 8px;",
  row: "display:flex;gap:7px;align-items:center;",
  button:
    "min-height:34px;border:1px solid hsl(var(--border));border-radius:6px;background:hsl(var(--background));color:hsl(var(--foreground));padding:6px 10px;cursor:pointer;",
  primary:
    "min-height:36px;border:0;border-radius:6px;background:hsl(var(--primary));color:hsl(var(--primary-foreground));padding:7px 12px;font-weight:600;cursor:pointer;",
  muted: "color:hsl(var(--muted-foreground));font-size:12px;line-height:1.4;",
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeApiUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function apiBase(): string {
  return normalizeApiUrl(state.apiUrl);
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

function clearPrompts(map?: MapLibreMap | null): void {
  promptPoints = [];
  promptBox = null;
  if (map) removePromptOverlay(map);
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
    paint: { "fill-color": "#8b5cf6", "fill-opacity": 0.2 },
  });
  map.addLayer({
    id: PROMPT_LINE,
    type: "line",
    source: PROMPT_SOURCE,
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: {
      "line-color": "#8b5cf6",
      "line-width": 2,
      "line-dasharray": [2, 1],
    },
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
    promptPoints.push({
      coordinates: [event.lngLat.lng, event.lngLat.lat],
      label,
    });
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

function beginBoxDraw(done: () => void, onProgress?: () => void): (() => void) | null {
  const map = appRef?.getMap?.();
  if (!map) return null;
  const canvas = map.getCanvas();
  let start: [number, number] | null = null;
  canvas.style.cursor = "crosshair";
  // Go through MapLibre's own pointer pipeline rather than raw canvas
  // listeners: it normalises mouse/pointer/touch across webviews (the Tauri
  // WebKit build included) and keeps the map's handlers from competing.
  map.dragPan.disable();
  map.boxZoom.disable();
  map.dragRotate.disable();
  type MapMouse = {
    lngLat: { lng: number; lat: number };
    originalEvent: MouseEvent;
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
    onProgress?.();
  };
  const onDown = (event: MapMouse) => {
    if (event.originalEvent.button !== 0) return;
    event.originalEvent.preventDefault();
    start = [event.lngLat.lng, event.lngLat.lat];
    map.on("mousemove", onMove);
    map.on("mouseup", onUp);
    window.addEventListener("mouseup", onWindowUp);
  };
  const onMove = (event: MapMouse) => setBox([event.lngLat.lng, event.lngLat.lat]);
  const finish = () => {
    // A plain click (no drag) yields a zero-area box; drop it so the user is
    // asked to draw again rather than posting a degenerate prompt.
    if (promptBox && (promptBox[0] === promptBox[2] || promptBox[1] === promptBox[3])) {
      promptBox = null;
      updatePromptOverlay(map);
    }
    cleanup();
    done();
  };
  const onUp = (event: MapMouse) => {
    setBox([event.lngLat.lng, event.lngLat.lat]);
    finish();
  };
  // Releasing outside the canvas never reaches the map; end the drag anyway.
  const onWindowUp = () => finish();
  const cleanup = () => {
    map.off("mousedown", onDown);
    map.off("mousemove", onMove);
    map.off("mouseup", onUp);
    window.removeEventListener("mouseup", onWindowUp);
    canvas.style.cursor = "";
    map.dragPan.enable();
    map.boxZoom.enable();
    map.dragRotate.enable();
  };
  map.on("mousedown", onDown);
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
  const alreadyWgs84 = /EPSG:{1,2}4326|CRS84/i.test(crsText);
  if (!alreadyWgs84 && !sourceProjection && fc.features.length > 0) {
    throw new Error(labels.unknownProjection);
  }
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

function appendCommon(form: FormData, req: SegmentationSnapshot): void {
  form.append("output_format", "geojson");
  form.append("min_size", String(req.minSize));
  if (req.maxSize > 0) form.append("max_size", String(req.maxSize));
  if (req.modelId.trim()) form.append("model_id", req.modelId.trim());
}

async function postSegmentation(
  endpoint: string,
  form: FormData,
  apiUrl: string,
  signal: AbortSignal,
): Promise<FeatureCollection> {
  const response = await fetch(`${normalizeApiUrl(apiUrl)}${endpoint}`, {
    method: "POST",
    body: form,
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`SamGeo API ${response.status}: ${detail || response.statusText}`);
  }
  const result = (await response.json()) as FeatureCollection;
  if (result.type !== "FeatureCollection" || !Array.isArray(result.features)) {
    throw new Error(labels.badResponse);
  }
  return result;
}

async function requestSegmentation(
  file: File,
  bytes: ArrayBuffer,
  req: SegmentationSnapshot,
  signal: AbortSignal,
): Promise<FeatureCollection> {
  const form = new FormData();
  form.append("file", file, file.name);
  appendCommon(form, req);
  let endpoint: string;
  if (req.mode === "text") {
    endpoint = "/segment/text";
    form.append("prompt", req.prompt.trim());
    form.append("backend", req.backend);
    form.append("confidence_threshold", String(req.confidence));
  } else if (req.mode === "automatic") {
    // SAM3 is prompt-driven: the API's SAM3 "automatic" path is a text prompt
    // of "everything", which its concept detector does not match (404). SAM2's
    // automatic mask generator is the engine these parameters belong to.
    endpoint = "/segment/automatic";
    form.set("model_id", req.sam2ModelId);
    form.append("model_version", "sam2");
    form.append("points_per_side", String(req.pointsPerSide));
    form.append("pred_iou_thresh", String(req.predIou));
    form.append("stability_score_thresh", String(req.stability));
  } else {
    endpoint = "/segment/predict";
    form.append("model_version", "sam3");
    form.append("point_crs", "EPSG:4326");
    // Never ask for multiple candidate masks: the API saves every candidate
    // as its own object, so a single click came back as three nested polygons.
    form.append("multimask_output", "false");
    if (req.mode === "points") {
      form.append("point_coords", JSON.stringify(req.points.map((point) => point.coordinates)));
      form.append("point_labels", JSON.stringify(req.points.map((point) => point.label)));
    } else if (req.box) {
      form.append("boxes", JSON.stringify([req.box]));
    }
  }
  // The API writes each mask's confidence as a `score` property of the
  // GeoJSON output (segment-geospatial >= 1.4.2), so one request is enough.
  const result = await postSegmentation(endpoint, form, req.apiUrl, signal);
  return reprojectSamGeoResult(result, await rasterProjection(bytes));
}

/** Raster store layers whose GeoTIFF bytes the panel can upload to the API. */
function rasterLayerChoices(): {
  id: string;
  name: string;
  url: string | null;
}[] {
  return useAppStore
    .getState()
    .layers.filter((layer) => layer.type === "cog" || layer.type === "raster")
    .map((layer) => {
      const source = layer.source as Record<string, unknown>;
      const candidates = [layer.metadata.localBytesUrl, source.url];
      const url =
        candidates.find(
          (value): value is string =>
            typeof value === "string" && /^(https?|blob|data):/i.test(value),
        ) ?? null;
      return { id: layer.id, name: layer.name, url };
    });
}

async function fileFromLayer(
  choice: { name: string; url: string },
  signal: AbortSignal,
): Promise<File> {
  const response = await fetch(choice.url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${choice.url}`);
  const blob = await response.blob();
  const name = /\.tiff?$/i.test(choice.name) ? choice.name : `${choice.name}.tif`;
  return new File([blob], name, { type: blob.type || "image/tiff" });
}

function buildPanel(container: HTMLElement): () => void {
  container.replaceChildren();
  const root = element("div");
  root.style.cssText = css.root;
  root.dataset.testid = "samgeo-panel";
  // Tag the panel so the host can theme its native form controls (select
  // popups, number spinners) from the design tokens; see index.css.
  root.classList.add("geolibre-samgeo-panel");

  const intro = element("p", `${labels.intro} `);
  intro.style.cssText = `${css.muted}margin:0 0 13px;`;
  const docs = element("a", labels.docsLink);
  docs.href = SAMGEO_API_DOCS_URL;
  docs.target = "_blank";
  docs.rel = "noopener noreferrer";
  docs.style.cssText = "color:hsl(var(--primary));text-decoration:underline;";
  intro.append(docs);

  const api = input();
  api.value = state.apiUrl;
  api.dataset.testid = "samgeo-api-url";
  api.addEventListener("change", () => {
    state.apiUrl = api.value;
  });
  const health = button(labels.checkConnection);
  const healthText = element("span", labels.notChecked);
  healthText.style.cssText = css.muted;
  const healthRow = element("div");
  healthRow.style.cssText = `${css.row}margin-bottom:13px;`;
  healthRow.append(health, healthText);

  const fileInput = input("file");
  fileInput.accept = ".tif,.tiff,.png,.jpg,.jpeg";
  fileInput.dataset.testid = "samgeo-image";
  // Loaded COG/raster layers can be segmented directly; "upload" keeps the
  // file picker for images that are not on the map.
  const UPLOAD = "__upload__";
  const imageSource = element("select");
  imageSource.style.cssText = css.input;
  imageSource.dataset.testid = "samgeo-image-source";
  const refreshImageSources = () => {
    const current = imageSource.value || UPLOAD;
    imageSource.replaceChildren();
    const upload = element("option", labels.imageUpload);
    upload.value = UPLOAD;
    imageSource.append(upload);
    const choices = rasterLayerChoices();
    if (!choices.length) {
      const none = element("option", labels.noRasterLayers);
      none.disabled = true;
      imageSource.append(none);
    }
    for (const choice of choices) {
      const option = element("option", choice.name);
      option.value = choice.id;
      imageSource.append(option);
    }
    imageSource.value = choices.some((c) => c.id === current) ? current : UPLOAD;
    fileInput.style.display = imageSource.value === UPLOAD ? "" : "none";
  };
  imageSource.addEventListener("change", () => {
    fileInput.style.display = imageSource.value === UPLOAD ? "" : "none";
  });
  imageSource.addEventListener("focus", refreshImageSources);
  const imageField = element("div");
  imageField.style.cssText = css.section;
  const imageLabel = element("label", labels.image);
  imageLabel.style.cssText = css.label;
  imageField.append(imageLabel, imageSource, fileInput);
  refreshImageSources();

  const mode = element("select");
  mode.style.cssText = css.input;
  mode.dataset.testid = "samgeo-mode";
  for (const [value, label] of [
    ["text", labels.modeText],
    ["points", labels.modePoints],
    ["box", labels.modeBox],
    ["automatic", labels.modeAutomatic],
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
    let committed = value;
    node.value = String(value);
    node.min = String(min);
    node.max = String(max);
    node.step = String(step);
    node.addEventListener("change", () => {
      const parsed = Number(node.value);
      if (!Number.isFinite(parsed)) {
        node.value = String(committed);
        return;
      }
      const clamped = Math.min(max, Math.max(min, parsed));
      node.value = String(clamped);
      committed = clamped;
      update(clamped);
    });
    return field(label, node);
  };

  // Mask-size limits apply to every mode.
  const sizeFields = () => [
    numberField(labels.minSize, state.minSize, 0, 1_000_000, 1, (n) => {
      state.minSize = n;
    }),
    numberField(labels.maxSize, state.maxSize, 0, 10_000_000, 1, (n) => {
      state.maxSize = n;
    }),
  ];

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
      dynamic.append(field(labels.textPrompt, prompt));
      dynamic.append(
        numberField(labels.confidence, state.confidence, 0, 1, 0.05, (n) => {
          state.confidence = n;
        }),
      );
      dynamic.append(...sizeFields());
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
      dynamic.append(field(labels.backend, backend));
    } else if (state.mode === "points") {
      const row = element("div");
      row.style.cssText = `${css.row}margin-bottom:7px;flex-wrap:wrap;`;
      const positive = button(labels.foregroundPoint);
      const negative = button(labels.backgroundPoint);
      const arm = (label: 0 | 1) => {
        cancelDrawing?.();
        status.textContent = label ? labels.clickForeground : labels.clickBackground;
        cancelDrawing = beginPointDraw(label, () => {
          cancelDrawing = null;
          status.textContent = labels.pointAdded;
          refreshSummary();
        });
      };
      positive.addEventListener("click", () => arm(1));
      negative.addEventListener("click", () => arm(0));
      row.append(positive, negative);
      dynamic.append(row, drawSummary);
      dynamic.append(...sizeFields());
    } else if (state.mode === "box") {
      const draw = button(labels.drawBox);
      draw.addEventListener("click", () => {
        cancelDrawing?.();
        status.textContent = labels.dragBox;
        cancelDrawing = beginBoxDraw(() => {
          cancelDrawing = null;
          status.textContent = promptBox ? labels.boxAdded : labels.drawBoxFirst;
          refreshSummary();
        }, refreshSummary);
      });
      dynamic.append(draw, drawSummary);
      dynamic.append(...sizeFields());
    } else {
      const hint = element("p", labels.automaticHint);
      hint.style.cssText = `${css.muted}margin:0 0 10px;`;
      dynamic.append(hint);
      const sam2 = element("select");
      sam2.style.cssText = css.input;
      for (const id of [
        "sam2-hiera-tiny",
        "sam2-hiera-small",
        "sam2-hiera-base-plus",
        "sam2-hiera-large",
      ]) {
        const option = element("option", id);
        option.value = id;
        sam2.append(option);
      }
      sam2.value = state.sam2ModelId;
      sam2.addEventListener("change", () => {
        state.sam2ModelId = sam2.value;
      });
      dynamic.append(field(labels.sam2ModelId, sam2));
      dynamic.append(
        numberField(labels.pointsPerSide, state.pointsPerSide, 1, 128, 1, (n) => {
          state.pointsPerSide = n;
        }),
      );
      dynamic.append(
        numberField(labels.predIou, state.predIou, 0, 1, 0.05, (n) => {
          state.predIou = n;
        }),
      );
      dynamic.append(
        numberField(labels.stability, state.stability, 0, 1, 0.05, (n) => {
          state.stability = n;
        }),
      );
      dynamic.append(...sizeFields());
    }
    refreshSummary();
  };
  const refreshSummary = () => {
    drawSummary.textContent =
      state.mode === "points"
        ? labels.pointSummary(
            promptPoints.filter((p) => p.label === 1).length,
            promptPoints.filter((p) => p.label === 0).length,
          )
        : promptBox
          ? labels.boxSummary(promptBox.map((n) => n.toFixed(5)).join(", "))
          : labels.noBox;
  };

  const model = input();
  model.value = state.modelId;
  model.addEventListener("change", () => {
    state.modelId = model.value;
  });
  const clear = button(labels.clearPrompts);
  clear.addEventListener("click", () => {
    clearPrompts(appRef?.getMap?.());
    refreshSummary();
    status.textContent = labels.promptsCleared;
  });
  const run = button(labels.segment, true);
  run.dataset.testid = "samgeo-run";
  run.addEventListener("click", async () => {
    const layerChoice =
      imageSource.value === UPLOAD
        ? null
        : (rasterLayerChoices().find((c) => c.id === imageSource.value) ?? null);
    const file = layerChoice ? null : fileInput.files?.[0];
    if (!layerChoice && !file) {
      status.textContent = labels.chooseImage;
      return;
    }
    if (layerChoice && !layerChoice.url) {
      status.textContent = labels.layerUnreadable;
      return;
    }
    if (state.mode === "text" && !state.prompt.trim()) {
      status.textContent = labels.enterPrompt;
      return;
    }
    // SAM point prompting needs at least one positive click; background-only
    // prompts have nothing to segment.
    if (state.mode === "points" && !promptPoints.some((p) => p.label === 1)) {
      status.textContent = labels.addPoint;
      return;
    }
    if (state.mode === "box" && !promptBox) {
      status.textContent = labels.drawBoxFirst;
      return;
    }
    run.disabled = true;
    status.textContent = labels.segmenting;
    const controller = beginRequest("segmentation");
    // Freeze the inputs now: the controls stay live while the file is read
    // and the request is in flight, so a mode switch mid-way must not change
    // what is submitted or how the result layer is named.
    const req = snapshotRequest();
    try {
      const image =
        layerChoice && layerChoice.url
          ? await fileFromLayer({ name: layerChoice.name, url: layerChoice.url }, controller.signal)
          : (file as File);
      const bytes = await image.arrayBuffer();
      const result = await requestSegmentation(image, bytes, req, controller.signal);
      // The panel was closed (or a newer request started) while this one was
      // in flight: drop the result rather than adding a layer the user has
      // moved on from.
      if (controller.signal.aborted) return;
      if (!result.features.length) {
        status.textContent = labels.noObjects;
        return;
      }
      const suffix = req.mode === "text" ? `: ${req.prompt.trim()}` : ` (${req.mode})`;
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
        // A reduce rather than Math.min(...spread): automatic mode can return
        // tens of thousands of vertices, past the argument limit of some engines.
        const extent = bounds.reduce<[number, number, number, number]>(
          (acc, [x, y]) => [
            Math.min(acc[0], x),
            Math.min(acc[1], y),
            Math.max(acc[2], x),
            Math.max(acc[3], y),
          ],
          [Infinity, Infinity, -Infinity, -Infinity],
        );
        appRef?.fitBounds?.(extent);
      }
      status.textContent = labels.added(result.features.length, layerId ? ` as ${layerId}` : "");
    } catch (error) {
      if (!controller.signal.aborted) status.textContent = errorMessage(error);
    } finally {
      endRequest("segmentation", controller);
      run.disabled = false;
    }
  });

  health.addEventListener("click", async () => {
    health.disabled = true;
    healthText.textContent = labels.checking;
    const controller = beginRequest("health");
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const response = await fetch(`${apiBase()}/health`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { version?: string };
      healthText.textContent = `${labels.connected}${data.version ? ` · v${data.version}` : ""}`;
    } catch (error) {
      healthText.textContent = labels.unavailable(errorMessage(error));
    } finally {
      clearTimeout(timer);
      endRequest("health", controller);
      health.disabled = false;
    }
  });
  mode.addEventListener("change", () => {
    state.mode = mode.value as Mode;
    // Only the active mode's prompts are sent, so drop the other mode's
    // geometry rather than leaving it painted on the map.
    clearPrompts();
    const map = appRef?.getMap?.();
    if (map) updatePromptOverlay(map);
    refreshDynamic();
  });

  const actions = element("div");
  actions.style.cssText = `${css.row}flex-wrap:wrap;margin-bottom:8px;`;
  actions.append(run, clear);
  root.append(
    intro,
    field(labels.apiUrl, api),
    healthRow,
    imageField,
    field(labels.mode, mode),
    field(labels.modelId, model),
    dynamic,
    actions,
    status,
  );
  container.append(root);
  refreshDynamic();
  return () => {
    cancelDrawing?.();
    cancelDrawing = null;
    abortRequests();
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
        title: () => labels.panelTitle,
        dock: "replace-style",
        defaultWidth: 390,
        render(container) {
          panelContainer = container;
          disposePanel?.();
          disposePanel = buildPanel(container);
          return () => {
            disposePanel?.();
            disposePanel = null;
            if (panelContainer === container) panelContainer = null;
            // The overlay is not a store layer, so closing the panel (header
            // "X") must tear it down here too, not only in deactivate.
            clearPrompts(appRef?.getMap?.());
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
    clearPrompts(app.getMap?.());
    app.closeRightPanel?.(PANEL_ID);
    unregisterPanel?.();
    unregisterPanel = null;
    appRef = null;
  },
  // Default settings are not worth persisting: the manager polls every
  // registered plugin on save, and any non-default blob makes the project look
  // like it carries plugin state (which the credential-redaction pass then
  // offers to strip on every Save).
  getProjectState: () => (stateIsDefault() ? undefined : { ...state }),
  applyProjectState(_app, value) {
    const next = sanitizeSamGeoState(value);
    if (Object.keys(next).length === 0) return false;
    Object.assign(state, next);
    // Keep an already-open panel's inputs in step with the restored state.
    rebuildPanel();
    return true;
  },
};

export default maplibreSamGeoPlugin;
