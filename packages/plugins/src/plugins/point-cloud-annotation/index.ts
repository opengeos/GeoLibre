// Point Cloud Annotation: select LiDAR points on the map with a box or lasso
// and assign ASPRS classes, then export the edited cloud as LAS 1.4 or a
// Segments.ai segmentation label. First slice of opengeos/GeoLibre#2749.

import { COORDINATE_SYSTEM } from "@deck.gl/core";
import { PointCloudLayer } from "@deck.gl/layers";
import type { LidarControl } from "maplibre-gl-components";
import type { ColorScheme, LidarControlEventHandler, PointCloudData } from "maplibre-gl-lidar";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../../types";
import { getLidarControl, openLidarLayerPanel } from "../components/lidar";
import { ASPRS_CLASSES, classDefinition, countClasses } from "./classes";
import { LabelHistory } from "./history";
import { PointLabelStore, type LabelledCloud } from "./label-store";
import { buildSegmentsLabel, writeLas, writeLaz, writeNpy, type LazEncoder } from "./las-writer";
import {
  getCloudData,
  getOverlayViewport,
  getRenderElevationRange,
  getRenderZOffset,
  isStreamingLoading,
  pauseStreaming,
  refreshCloudColors,
} from "./lidar-access";
import {
  combineSelection,
  createOffsetProjector,
  selectPointsInShape,
  type SelectionMode,
  type SelectionShape,
} from "./selection";

export const POINT_CLOUD_ANNOTATION_PLUGIN_ID = "geolibre-point-cloud-annotation";
const PANEL_ID = POINT_CLOUD_ANNOTATION_PLUGIN_ID;
const SELECTION_LAYER_ID = "pointcloud-annotation-selection";
const OVERLAY_CLASS = "geolibre-pc-annotation-overlay";

/**
 * How the host saves an exported binary file (a native dialog under Tauri, a
 * download on the web). Injected by the app (see usePlugins.ts) because the
 * plugins package cannot depend on the app's Tauri I/O helpers. Resolves to
 * the saved path, or null when the user cancels.
 */
export type PointCloudAnnotationFileSaver = (
  bytes: Uint8Array,
  options: { defaultName: string; extension: string; mimeType: string; description: string },
) => Promise<string | null>;

let fileSaver: PointCloudAnnotationFileSaver | null = null;

/**
 * Registers the host's binary file saver.
 *
 * @param saver - The saver, or null to fall back to a browser download.
 */
export function setPointCloudAnnotationFileSaver(
  saver: PointCloudAnnotationFileSaver | null,
): void {
  fileSaver = saver;
}

type Tool = "pan" | "box" | "lasso" | "brush";

let lazEncoder: Promise<LazEncoder> | null = null;

/**
 * Loads the laz-rs WASM encoder on first use, so the ~100 KB module stays off
 * the startup path.
 *
 * @returns The initialised encoder.
 */
function loadLazEncoder(): Promise<LazEncoder> {
  lazEncoder ??= Promise.all([
    import("./laz-encoder/laz_encoder.js"),
    import("./laz-encoder/laz_encoder_bg.wasm?url"),
  ]).then(async ([encoder, wasm]) => {
    await encoder.default({ module_or_path: wasm.default });
    return encoder;
  });
  lazEncoder.catch(() => {
    lazEncoder = null;
  });
  return lazEncoder;
}

interface Session {
  cloudId: string;
  cloudName: string;
  /** The cloud's source URL, which keys its saved labels; null for a local file. */
  source: string | null;
  wkt: string | undefined;
  resumeStreaming: (() => void) | null;
  previousColorScheme: ColorScheme | null;
  selection: Uint32Array;
  history: LabelHistory;
}

function tr(
  app: GeoLibreAppAPI,
  key: string,
  fallback: string,
  params?: Record<string, string | number>,
): string {
  const text = app.translate?.(
    `plugin.${POINT_CLOUD_ANNOTATION_PLUGIN_ID}.${key}`,
    fallback,
    params,
  );
  if (text !== undefined) return text;
  return params
    ? fallback.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params[name] ?? ""))
    : fallback;
}

function className(app: GeoLibreAppAPI, code: number): string {
  const definition = classDefinition(code);
  return tr(app, `classes.${code}`, definition.name);
}

const numberFormat = new Intl.NumberFormat();

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  style?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (style) node.style.cssText = style;
  return node;
}

const BUTTON_STYLE =
  "padding:6px 8px;border:1px solid hsl(var(--border));border-radius:5px;background:transparent;color:inherit;cursor:pointer;";
const PRIMARY_STYLE =
  "padding:6px 8px;border:1px solid hsl(var(--primary));border-radius:5px;background:hsl(var(--primary));color:hsl(var(--primary-foreground));cursor:pointer;font-weight:600;";
const ACTIVE_TOOL_STYLE =
  "padding:6px 8px;border:1px solid hsl(var(--primary));border-radius:5px;background:hsl(var(--accent));color:inherit;cursor:pointer;font-weight:600;";

function button(text: string, primary = false): HTMLButtonElement {
  const node = el("button", text, primary ? PRIMARY_STYLE : BUTTON_STYLE);
  node.type = "button";
  return node;
}

function select(): HTMLSelectElement {
  const node = el("select");
  node.style.cssText =
    "padding:6px;border:1px solid hsl(var(--border));border-radius:5px;background:hsl(var(--background));min-width:0;";
  node.style.setProperty("color", "hsl(var(--foreground))", "important");
  return node;
}

function numberInput(placeholder: string): HTMLInputElement {
  const node = el("input");
  node.type = "number";
  node.step = "any";
  node.placeholder = placeholder;
  node.style.cssText =
    "padding:6px;border:1px solid hsl(var(--border));border-radius:5px;background:transparent;color:inherit;min-width:0;width:100%;box-sizing:border-box;";
  return node;
}

function section(title: string): { root: HTMLElement; heading: HTMLElement } {
  const root = el("div", undefined, "display:flex;flex-direction:column;gap:6px;");
  const heading = el("div", title, "font-weight:600;");
  root.append(heading);
  return { root, heading };
}

function row(...children: HTMLElement[]): HTMLElement {
  const node = el("div", undefined, "display:flex;gap:6px;align-items:center;flex-wrap:wrap;");
  node.append(...children);
  return node;
}

function swatch(color: [number, number, number]): HTMLElement {
  return el(
    "span",
    undefined,
    `display:inline-block;width:12px;height:12px;border-radius:2px;flex:none;border:1px solid hsl(var(--border));background:rgb(${color.join(",")});`,
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName);
}

function downloadBytes(bytes: Uint8Array, name: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFileStem(name: string): string {
  const stem = name.replace(/\.(copc\.)?la[sz]$/i, "").replace(/[^\w.-]+/g, "_");
  return stem || "point-cloud";
}

/** Builds the panel and its map interaction; returns the teardown. */
function buildPanel(container: HTMLElement, app: GeoLibreAppAPI): () => void {
  const map = app.getMap?.() as MapLibreMap | null | undefined;
  let session: Session | null = null;
  let tool: Tool = "box";
  let mode: SelectionMode = "replace";
  let targetClass = 6;
  let onlyClass: number | null = null;
  let brushRadius = 16;
  // Classes whose points no selection may pick (Segments.ai's protect/lock).
  const lockedClasses = new Set<number>();
  let boundControl: LidarControl | null = null;
  let disposed = false;

  container.replaceChildren();
  container.classList.add("geolibre-pc-annotation-panel");
  container.style.cssText =
    "display:flex;flex-direction:column;gap:12px;padding:10px;box-sizing:border-box;height:100%;overflow:auto;font-size:12px;color:hsl(var(--foreground));";

  const hint = el("div", undefined, "line-height:1.4;color:hsl(var(--muted-foreground));");
  hint.dataset.testid = "pc-annotation-hint";
  const status = el("div", "", "line-height:1.4;min-height:1.4em;");
  status.setAttribute("role", "status");
  status.dataset.testid = "pc-annotation-status";

  // Setup: choose the cloud and start a session.
  const setup = section("");
  const cloudSelect = select();
  cloudSelect.setAttribute("aria-label", "point cloud");
  const startButton = button("", true);
  startButton.dataset.testid = "pc-annotation-start";
  const openLidarButton = button("");
  setup.root.append(cloudSelect, row(startButton, openLidarButton));

  // Tools.
  const tools = section("");
  const panButton = button("");
  const boxButton = button("");
  const lassoButton = button("");
  const brushButton = button("");
  brushButton.dataset.tool = "brush";
  const brushSize = numberInput("");
  brushSize.min = "2";
  brushSize.max = "200";
  brushSize.step = "1";
  brushSize.value = String(brushRadius * 2);
  brushSize.style.width = "5em";
  const brushSizeLabel = el("label", "", "display:flex;gap:6px;align-items:center;");
  const brushSizeText = el("span");
  brushSizeLabel.append(brushSizeText, brushSize);
  panButton.dataset.tool = "pan";
  boxButton.dataset.tool = "box";
  lassoButton.dataset.tool = "lasso";
  const modeSelect = select();
  const toolHint = el("div", "", "line-height:1.4;color:hsl(var(--muted-foreground));");
  tools.root.append(
    row(panButton, boxButton, lassoButton, brushButton),
    brushSizeLabel,
    modeSelect,
    toolHint,
  );

  // Filters.
  const filters = section("");
  const minZ = numberInput("");
  const maxZ = numberInput("");
  const onlyClassSelect = select();
  const zRow = el("div", undefined, "display:grid;grid-template-columns:1fr 1fr;gap:6px;");
  zRow.append(minZ, maxZ);
  filters.root.append(zRow, onlyClassSelect);

  // Assign.
  const assign = section("");
  const selectedCount = el("div", "", "font-weight:600;");
  selectedCount.dataset.testid = "pc-annotation-selected";
  const targetSelect = select();
  targetSelect.dataset.testid = "pc-annotation-target";
  const applyButton = button("", true);
  applyButton.dataset.testid = "pc-annotation-apply";
  const clearButton = button("");
  const undoButton = button("");
  const redoButton = button("");
  undoButton.dataset.testid = "pc-annotation-undo";
  redoButton.dataset.testid = "pc-annotation-redo";
  assign.root.append(
    selectedCount,
    targetSelect,
    row(applyButton, clearButton),
    row(undoButton, redoButton),
  );

  // Class summary.
  const summary = section("");
  const summaryList = el("div", undefined, "display:flex;flex-direction:column;gap:2px;");
  summaryList.dataset.testid = "pc-annotation-classes";
  summary.root.append(summaryList);

  // Export.
  const exportSection = section("");
  const exportLasButton = button("");
  const exportLazButton = button("");
  exportLazButton.dataset.testid = "pc-annotation-export-laz";
  const exportNpyButton = button("");
  exportNpyButton.dataset.testid = "pc-annotation-export-npy";
  const exportSegmentsButton = button("");
  exportLasButton.dataset.testid = "pc-annotation-export-las";
  exportSegmentsButton.dataset.testid = "pc-annotation-export-segments";
  const exportNote = el("div", "", "line-height:1.4;color:hsl(var(--muted-foreground));");
  exportSection.root.append(
    row(exportLasButton, exportLazButton, exportNpyButton, exportSegmentsButton),
    exportNote,
  );

  const sessionSections = [tools.root, filters.root, assign.root, summary.root, exportSection.root];
  container.append(hint, setup.root, ...sessionSections, status);

  const setStatus = (text: string) => {
    status.textContent = text;
  };

  const control = (): LidarControl | null => getLidarControl();

  const activeData = (): PointCloudData | null => {
    const ctl = control();
    return session && ctl ? getCloudData(ctl, session.cloudId) : null;
  };

  const liveClassifications = (cloudId: string): Uint8Array | undefined => {
    const ctl = control();
    const data = ctl ? getCloudData(ctl, cloudId) : null;
    if (!data) return undefined;
    // A cloud loaded without classifications gets a shadow array, grown when
    // late streamed nodes raise pointCount so their points stay editable.
    // (A streamed cloud's own array is a view that already tracks pointCount.)
    const existing = data.classifications;
    if (!existing || existing.length < data.pointCount) {
      const grown = new Uint8Array(data.pointCount).fill(1);
      if (existing) grown.set(existing);
      data.classifications = grown;
    }
    return data.classifications;
  };

  // --- Selection highlight, drawn into the LiDAR overlay's own canvas so it
  // shares the point cloud's camera (a MapLibre layer cannot draw over it).
  const removeHighlight = () => {
    control()?.getDeckOverlay()?.removeLayer(SELECTION_LAYER_ID);
  };

  const renderHighlight = () => {
    const ctl = control();
    const data = activeData();
    const overlay = ctl?.getDeckOverlay();
    if (!ctl || !data || !overlay || !session || session.selection.length === 0) {
      removeHighlight();
      return;
    }
    // Only indices the live buffers still cover (defensive: selections are
    // computed against the live data just before this runs).
    const loaded = Math.min(data.pointCount, Math.floor(data.positions.length / 3));
    const indices = session.selection.filter((index) => index < loaded);
    const zOffset = getRenderZOffset(ctl);
    const positions = new Float32Array(indices.length * 3);
    indices.forEach((index, k) => {
      positions[k * 3] = data.positions[index * 3];
      positions[k * 3 + 1] = data.positions[index * 3 + 1];
      positions[k * 3 + 2] = data.positions[index * 3 + 2] + zOffset;
    });
    overlay.addLayer(
      SELECTION_LAYER_ID,
      new PointCloudLayer({
        id: SELECTION_LAYER_ID,
        coordinateSystem: COORDINATE_SYSTEM.LNGLAT_OFFSETS,
        coordinateOrigin: data.coordinateOrigin,
        data: {
          length: indices.length,
          attributes: { getPosition: { value: positions, size: 3 } },
        },
        getColor: [255, 255, 0, 255],
        getNormal: [0, 0, 1],
        pointSize: 3,
        sizeUnits: "pixels",
        // Unlit, so the highlight reads as the same yellow at any camera angle.
        material: false,
        pickable: false,
        // Draw on top of the cloud, like the measure mirror, so the selection
        // stays visible through the points in front of it.
        parameters: { depthTest: false } as Record<string, unknown>,
        updateTriggers: { getPosition: [indices] },
      }),
    );
  };

  // --- Panel state rendering.
  const fillClassOptions = (
    target: HTMLSelectElement,
    codes: number[],
    selected: number | null,
    anyLabel?: string,
  ) => {
    target.replaceChildren();
    if (anyLabel !== undefined) target.append(new Option(anyLabel, ""));
    for (const code of codes)
      target.append(new Option(`${code} · ${className(app, code)}`, String(code)));
    target.value = selected === null ? "" : String(selected);
  };

  const renderSummary = () => {
    summaryList.replaceChildren();
    const data = activeData();
    const classifications = session ? liveClassifications(session.cloudId) : undefined;
    if (!data || !classifications) return;
    const counts = countClasses(classifications, data.pointCount);
    for (const [code, count] of counts) {
      const entry = el("div", undefined, "display:flex;gap:4px;align-items:center;");
      entry.dataset.code = String(code);
      const pick = el(
        "button",
        undefined,
        "display:flex;flex:1;gap:6px;align-items:center;padding:2px 4px;border:0;background:transparent;color:inherit;cursor:pointer;text-align:start;min-width:0;",
      );
      pick.type = "button";
      pick.title = tr(app, "useAsTarget", "Use as the class to assign");
      const label = el("span", `${code} · ${className(app, code)}`, "flex:1;");
      const value = el("span", numberFormat.format(count), "font-variant-numeric:tabular-nums;");
      pick.append(swatch(classDefinition(code).color), label, value);
      pick.addEventListener("click", () => {
        targetClass = code;
        targetSelect.value = String(code);
      });
      const locked = lockedClasses.has(code);
      const lock = el(
        "button",
        locked ? tr(app, "locked", "Locked") : tr(app, "lock", "Lock"),
        locked ? ACTIVE_TOOL_STYLE : BUTTON_STYLE,
      );
      lock.type = "button";
      lock.style.padding = "1px 6px";
      lock.dataset.lock = String(code);
      lock.setAttribute("aria-pressed", String(locked));
      lock.title = tr(
        app,
        "lockHint",
        "Locked classes are never selected, so their points keep their class.",
      );
      lock.addEventListener("click", () => {
        if (lockedClasses.has(code)) lockedClasses.delete(code);
        else lockedClasses.add(code);
        renderSummary();
      });
      entry.append(pick, lock);
      summaryList.append(entry);
    }
    const presentCodes = [...counts.keys()];
    // Relabelling every point of the filtered class removes it from the list;
    // drop the filter too, or later selections would silently match nothing.
    if (onlyClass !== null && !counts.has(onlyClass)) onlyClass = null;
    fillClassOptions(onlyClassSelect, presentCodes, onlyClass, tr(app, "anyClass", "Any class"));
  };

  const renderSelection = () => {
    const count = session?.selection.length ?? 0;
    selectedCount.textContent = tr(app, "selectedCount", "{{count}} points selected", {
      count: numberFormat.format(count),
    });
    applyButton.disabled = count === 0;
    clearButton.disabled = count === 0;
    undoButton.disabled = !session?.history.canUndo;
    redoButton.disabled = !session?.history.canRedo;
  };

  const renderTools = () => {
    brushSizeLabel.hidden = tool !== "brush";
    for (const node of [panButton, boxButton, lassoButton, brushButton]) {
      node.style.cssText = node.dataset.tool === tool ? ACTIVE_TOOL_STYLE : BUTTON_STYLE;
      node.setAttribute("aria-pressed", String(node.dataset.tool === tool));
    }
    toolHint.textContent =
      tool === "pan"
        ? tr(app, "panHint", "Drag to move the map; right-drag to tilt and rotate.")
        : tr(
            app,
            "drawHint",
            "Drag on the map to select points. Hold Shift to add, Alt to subtract. Right-drag still tilts the map.",
          );
  };

  const renderCloudOptions = () => {
    const ctl = control();
    const clouds = ctl?.getPointClouds() ?? [];
    const previous = cloudSelect.value;
    cloudSelect.replaceChildren();
    for (const cloud of clouds) {
      cloudSelect.append(
        new Option(`${cloud.name} (${numberFormat.format(cloud.pointCount)})`, cloud.id),
      );
    }
    if (clouds.some((cloud) => cloud.id === previous)) cloudSelect.value = previous;
    cloudSelect.disabled = clouds.length === 0 || session !== null;
    startButton.disabled = clouds.length === 0 && session === null;
    openLidarButton.hidden = clouds.length > 0 || session !== null;
    if (!session) {
      hint.textContent =
        clouds.length === 0
          ? tr(
              app,
              "noClouds",
              "Load a LiDAR point cloud first (Add Data → LiDAR Layer), then start an annotation session here.",
            )
          : tr(
              app,
              "hint",
              "Zoom to the area you want to label, then start a session. Streaming pauses while you annotate so edited points stay loaded.",
            );
    }
  };

  const renderLabels = () => {
    setup.heading.textContent = tr(app, "pointCloud", "Point cloud");
    openLidarButton.textContent = tr(app, "openLidar", "Open LiDAR panel");
    startButton.textContent = session
      ? tr(app, "finishSession", "Finish session")
      : tr(app, "startSession", "Start annotating");
    tools.heading.textContent = tr(app, "tools", "Selection tool");
    panButton.textContent = tr(app, "toolPan", "Pan");
    boxButton.textContent = tr(app, "toolBox", "Box (B)");
    lassoButton.textContent = tr(app, "toolLasso", "Lasso (L)");
    brushButton.textContent = tr(app, "toolBrush", "Brush (P)");
    brushSizeText.textContent = tr(app, "brushSize", "Brush size (px, [ and ])");
    const modeValue = modeSelect.value || mode;
    modeSelect.replaceChildren(
      new Option(tr(app, "modeReplace", "New selection"), "replace"),
      new Option(tr(app, "modeAdd", "Add to selection"), "add"),
      new Option(tr(app, "modeSubtract", "Remove from selection"), "subtract"),
    );
    modeSelect.value = modeValue;
    filters.heading.textContent = tr(app, "filters", "Filters");
    minZ.placeholder = tr(app, "minZ", "Min Z (m)");
    maxZ.placeholder = tr(app, "maxZ", "Max Z (m)");
    minZ.setAttribute("aria-label", minZ.placeholder);
    maxZ.setAttribute("aria-label", maxZ.placeholder);
    onlyClassSelect.setAttribute("aria-label", tr(app, "onlyClass", "Only points in class"));
    assign.heading.textContent = tr(app, "assign", "Assign class");
    applyButton.textContent = tr(app, "apply", "Apply (Enter)");
    clearButton.textContent = tr(app, "clearSelection", "Clear (Esc)");
    undoButton.textContent = tr(app, "undo", "Undo");
    redoButton.textContent = tr(app, "redo", "Redo");
    summary.heading.textContent = tr(app, "classSummary", "Classes in session");
    exportSection.heading.textContent = tr(app, "export", "Export");
    exportLasButton.textContent = tr(app, "exportLas", "LAS 1.4");
    exportLazButton.textContent = tr(app, "exportLaz", "LAZ (compressed)");
    exportNpyButton.textContent = tr(app, "exportNpy", "NumPy (.npy)");
    exportSegmentsButton.textContent = tr(app, "exportSegments", "Segments.ai JSON");
    exportNote.textContent = tr(
      app,
      "exportNote",
      "Exports the points loaded in this session with their edited classes. The Segments.ai label lines up point-for-point with the LAS/LAZ file.",
    );
    fillClassOptions(
      targetSelect,
      ASPRS_CLASSES.map((entry) => entry.code),
      targetClass,
    );
    targetSelect.setAttribute("aria-label", assign.heading.textContent);
    renderCloudOptions();
    renderTools();
    renderSelection();
    renderSummary();
  };

  const renderSessionVisibility = () => {
    for (const node of sessionSections) node.hidden = session === null;
  };

  // --- Map interaction.
  let overlay: HTMLDivElement | null = null;
  let svgPath: SVGPathElement | null = null;
  let drawing: {
    points: [number, number][];
    pointerId: number;
    modifiers: SelectionMode | null;
  } | null = null;
  let dragPanWasEnabled = false;
  let boxZoomWasEnabled = false;

  const ensureOverlay = (): void => {
    if (!map || overlay) return;
    overlay = document.createElement("div");
    overlay.className = OVERLAY_CLASS;
    overlay.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:4;";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.style.cssText = "position:absolute;inset:0;overflow:visible;";
    svgPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    svgPath.setAttribute("fill", "rgba(255,255,0,0.12)");
    svgPath.setAttribute("stroke", "#facc15");
    svgPath.setAttribute("stroke-width", "1.5");
    svgPath.setAttribute("stroke-dasharray", "4 3");
    svg.append(svgPath);
    overlay.append(svg);
    map.getContainer().append(overlay);
  };

  const shapeOf = (points: [number, number][]): SelectionShape | null => {
    if (points.length < (tool === "brush" ? 1 : 2)) return null;
    if (tool === "box") {
      const [x0, y0] = points[0];
      const [x1, y1] = points[points.length - 1];
      return { kind: "rect", x0, y0, x1, y1 };
    }
    if (tool === "brush") return { kind: "stroke", points, radius: brushRadius };
    return { kind: "polygon", points };
  };

  const drawShape = () => {
    if (!svgPath) return;
    const points = drawing?.points ?? [];
    const brush = tool === "brush";
    svgPath.setAttribute("fill", brush ? "none" : "rgba(255,255,0,0.12)");
    svgPath.setAttribute("stroke", brush ? "rgba(250,204,21,0.45)" : "#facc15");
    svgPath.setAttribute("stroke-width", brush ? String(brushRadius * 2) : "1.5");
    svgPath.setAttribute("stroke-linecap", "round");
    svgPath.setAttribute("stroke-linejoin", "round");
    svgPath.setAttribute("stroke-dasharray", brush ? "" : "4 3");
    if (brush && points.length > 0) {
      // A lone point still needs a segment to draw its round cap.
      const [fx, fy] = points[0];
      svgPath.setAttribute("d", `M${fx},${fy}${points.map(([x, y]) => `L${x},${y}`).join("")}`);
      return;
    }
    if (points.length < 2) {
      svgPath.setAttribute("d", "");
      return;
    }
    if (tool === "box") {
      const [x0, y0] = points[0];
      const [x1, y1] = points[points.length - 1];
      svgPath.setAttribute("d", `M${x0},${y0}H${x1}V${y1}H${x0}Z`);
    } else {
      svgPath.setAttribute("d", `M${points.map(([x, y]) => `${x},${y}`).join("L")}Z`);
    }
  };

  const localPoint = (event: PointerEvent): [number, number] => {
    const rect = map!.getContainer().getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };

  const runSelection = (shape: SelectionShape, combine: SelectionMode) => {
    const ctl = control();
    const data = activeData();
    if (!ctl || !data || !session) return;
    const viewport = getOverlayViewport(ctl);
    if (!viewport) {
      setStatus(tr(app, "noViewport", "The point cloud view is not ready yet; try again."));
      return;
    }
    const started = performance.now();
    // Blank or unparseable means "no bound" rather than a NaN that would
    // silently disable the filter.
    const readZ = (input: HTMLInputElement) => {
      const value = input.value.trim() === "" ? Number.NaN : Number(input.value);
      return Number.isFinite(value) ? value : null;
    };
    const range = getRenderElevationRange(ctl);
    const zMin = readZ(minZ);
    const zMax = readZ(maxZ);
    const picked = selectPointsInShape(
      {
        positions: data.positions,
        classifications: liveClassifications(session.cloudId),
        pointCount: data.pointCount,
        zOffset: getRenderZOffset(ctl),
      },
      createOffsetProjector(viewport, data.coordinateOrigin),
      shape,
      {
        // Only points the renderer draws are selectable.
        minZ: Math.max(zMin ?? -Infinity, range?.[0] ?? -Infinity),
        maxZ: Math.min(zMax ?? Infinity, range?.[1] ?? Infinity),
        onlyClasses: onlyClass === null ? null : new Set([onlyClass]),
        skipClasses: new Set([...ctl.getHiddenClassifications(), ...lockedClasses]),
      },
    );
    session.selection = combineSelection(session.selection, picked, combine);
    renderSelection();
    renderHighlight();
    setStatus(
      tr(app, "selectionDone", "Selected {{picked}} points in {{ms}} ms.", {
        picked: numberFormat.format(picked.length),
        ms: Math.round(performance.now() - started),
      }),
    );
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!session || tool === "pan" || event.button !== 0 || !map) return;
    event.preventDefault();
    event.stopPropagation();
    const modifiers: SelectionMode | null = event.shiftKey
      ? "add"
      : event.altKey
        ? "subtract"
        : null;
    drawing = { points: [localPoint(event)], pointerId: event.pointerId, modifiers };
    map.getCanvasContainer().setPointerCapture?.(event.pointerId);
    drawShape();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!drawing || event.pointerId !== drawing.pointerId) return;
    const point = localPoint(event);
    if (tool === "box") {
      drawing.points = [drawing.points[0], point];
    } else {
      const last = drawing.points[drawing.points.length - 1];
      if (Math.hypot(point[0] - last[0], point[1] - last[1]) >= 2) drawing.points.push(point);
    }
    drawShape();
  };

  const onPointerUp = (event: PointerEvent) => {
    if (!drawing || event.pointerId !== drawing.pointerId) return;
    const finished = drawing;
    drawing = null;
    map?.getCanvasContainer().releasePointerCapture?.(event.pointerId);
    drawShape();
    const shape = shapeOf(finished.points);
    if (shape) runSelection(shape, finished.modifiers ?? mode);
  };

  const bindMapInteraction = () => {
    if (!map) return;
    ensureOverlay();
    const canvasContainer = map.getCanvasContainer();
    canvasContainer.addEventListener("pointerdown", onPointerDown, true);
    canvasContainer.addEventListener("pointermove", onPointerMove);
    canvasContainer.addEventListener("pointerup", onPointerUp);
    canvasContainer.addEventListener("pointercancel", onPointerUp);
  };

  const unbindMapInteraction = () => {
    if (!map) return;
    const canvasContainer = map.getCanvasContainer();
    canvasContainer.removeEventListener("pointerdown", onPointerDown, true);
    canvasContainer.removeEventListener("pointermove", onPointerMove);
    canvasContainer.removeEventListener("pointerup", onPointerUp);
    canvasContainer.removeEventListener("pointercancel", onPointerUp);
    overlay?.remove();
    overlay = null;
    svgPath = null;
    drawing = null;
  };

  const applyToolToMap = () => {
    if (!map) return;
    const drawingTool = session !== null && tool !== "pan";
    if (drawingTool) {
      if (map.dragPan.isEnabled()) {
        dragPanWasEnabled = true;
        map.dragPan.disable();
      }
      // Shift+drag adds to the selection, so box zoom must not claim it.
      if (map.boxZoom.isEnabled()) {
        boxZoomWasEnabled = true;
        map.boxZoom.disable();
      }
      map.getCanvas().style.cursor = "crosshair";
    } else {
      if (dragPanWasEnabled) map.dragPan.enable();
      if (boxZoomWasEnabled) map.boxZoom.enable();
      dragPanWasEnabled = false;
      boxZoomWasEnabled = false;
      map.getCanvas().style.cursor = "";
    }
  };

  const setBrushRadius = (radius: number) => {
    if (!Number.isFinite(radius)) return;
    brushRadius = Math.min(100, Math.max(1, Math.round(radius)));
    brushSize.value = String(brushRadius * 2);
  };

  const setTool = (next: Tool) => {
    tool = next;
    renderTools();
    applyToolToMap();
  };

  // --- Session lifecycle.
  const refreshAfterEdit = (cloudId: string) => {
    const ctl = control();
    if (ctl && session?.cloudId === cloudId) refreshCloudColors(ctl);
    renderSummary();
    renderSelection();
  };

  // Saves the current class of changed points so they persist with the project.
  const recordLabels = (indices: ArrayLike<number>) => {
    const data = activeData();
    if (!session?.source || !data) return;
    if (labelStore.record(session.source, data as LabelledCloud, indices) > 0) startLabelSync();
  };

  const applyClass = () => {
    const ctl = control();
    if (!session || !ctl || session.selection.length === 0) return;
    const classes = liveClassifications(session.cloudId);
    if (!classes) return;
    const changed = session.history.assign(
      session.cloudId,
      classes,
      session.selection,
      targetClass,
    );
    recordLabels(session.selection);
    session.selection = new Uint32Array(0);
    renderHighlight();
    refreshAfterEdit(session.cloudId);
    setStatus(
      tr(app, "applied", "Assigned {{count}} points to {{name}}.", {
        count: numberFormat.format(changed),
        name: className(app, targetClass),
      }),
    );
  };

  const clearSelection = () => {
    if (!session) return;
    session.selection = new Uint32Array(0);
    renderHighlight();
    renderSelection();
  };

  const endSession = (reason?: string) => {
    if (!session) return;
    const ended = session;
    session = null;
    removeHighlight();
    unbindMapInteraction();
    applyToolToMap();
    ended.resumeStreaming?.();
    const ctl = control();
    if (ctl && ended.previousColorScheme && ended.previousColorScheme !== "classification") {
      ctl.setColorScheme(ended.previousColorScheme);
    }
    renderLabels();
    renderSessionVisibility();
    if (reason) setStatus(reason);
  };

  const startSession = () => {
    const ctl = control();
    const cloudId = cloudSelect.value;
    const info = ctl?.getPointClouds().find((cloud) => cloud.id === cloudId);
    const data = ctl && info ? getCloudData(ctl, info.id) : null;
    if (!ctl || !info || !data) {
      setStatus(tr(app, "cloudMissing", "That point cloud is no longer loaded."));
      renderCloudOptions();
      return;
    }
    liveClassifications(info.id);
    const stillLoading = isStreamingLoading(ctl, info.id);
    // Fall back to the control's default so finishing always restores a scheme.
    const previousColorScheme: ColorScheme =
      (ctl.getState().colorScheme as ColorScheme | undefined) ?? "elevation";
    session = {
      cloudId: info.id,
      cloudName: info.name,
      source: isPersistentSource(info.source) ? info.source : null,
      wkt: info.wkt ?? data.wkt,
      resumeStreaming: pauseStreaming(ctl, info.id),
      previousColorScheme,
      selection: new Uint32Array(0),
      history: new LabelHistory(),
    };
    if (previousColorScheme !== "classification") ctl.setColorScheme("classification");
    bindMapInteraction();
    setTool(tool === "pan" ? "box" : tool);
    renderLabels();
    renderSessionVisibility();
    hint.textContent = tr(
      app,
      "sessionHint",
      "Annotating {{name}}: {{count}} points loaded. Streaming is paused; export before finishing the session.",
      { name: info.name, count: numberFormat.format(data.pointCount) },
    );
    setStatus(
      stillLoading
        ? tr(
            app,
            "stillLoading",
            "Some point cloud nodes were still loading; they will join the session as they arrive.",
          )
        : "",
    );
  };

  // --- Export.
  const exportCloudData = () => {
    const data = activeData();
    if (!session || !data) return null;
    const count = data.pointCount;
    return {
      positions: data.positions.subarray(0, count * 3),
      coordinateOrigin: data.coordinateOrigin,
      pointCount: count,
      classifications: liveClassifications(session.cloudId),
      intensities: data.intensities,
      colors: data.colors,
      hasRGB: data.hasRGB,
      extraAttributes: data.extraAttributes as Record<string, ArrayLike<number>> | undefined,
      wkt: session.wkt,
    };
  };

  const exportPoints = async (format: "las" | "laz" | "npy") => {
    const cloud = exportCloudData();
    if (!session || !cloud) return;
    const name = `${safeFileStem(session.cloudName)}-annotated.${format}`;
    try {
      const bytes =
        format === "laz"
          ? writeLaz(cloud, await loadLazEncoder())
          : format === "npy"
            ? writeNpy(cloud)
            : new Uint8Array(writeLas(cloud));
      const options = {
        defaultName: name,
        extension: format,
        mimeType: {
          las: "application/vnd.las",
          laz: "application/vnd.laszip",
          npy: "application/octet-stream",
        }[format],
        description: format === "npy" ? "NumPy" : format.toUpperCase(),
      };
      const saved = fileSaver
        ? await fileSaver(bytes, options)
        : (downloadBytes(bytes, name, options.mimeType), name);
      if (saved) {
        setStatus(
          tr(app, "exported", "Exported {{count}} points to {{name}}.", {
            count: numberFormat.format(cloud.pointCount),
            name: saved,
          }),
        );
      }
    } catch (error) {
      setStatus(
        tr(app, "exportFailed", "Export failed: {{message}}", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  const exportSegments = () => {
    const cloud = exportCloudData();
    if (!session || !cloud?.classifications) return;
    const label = buildSegmentsLabel(
      cloud.classifications,
      cloud.pointCount,
      (code) => classDefinition(code).name,
    );
    const name = `${safeFileStem(session.cloudName)}-segments-label.json`;
    const text = JSON.stringify(label);
    if (app.exportTextFile) {
      app.exportTextFile(name, text, { description: "JSON", extensions: ["json"] });
    } else {
      downloadBytes(new TextEncoder().encode(text), name, "application/json");
    }
    setStatus(
      tr(app, "exportedLabel", "Exported the Segments.ai label for {{count}} points.", {
        count: numberFormat.format(cloud.pointCount),
      }),
    );
  };

  // --- Wiring.
  const onKeyDown = (event: KeyboardEvent) => {
    if (!session || event.ctrlKey || event.metaKey || isEditableTarget(event.target)) return;
    const key = event.key.toLowerCase();
    if (key === "b") setTool("box");
    else if (key === "l") setTool("lasso");
    else if (key === "p") setTool("brush");
    else if (key === "[" || key === "]") setBrushRadius(brushRadius + (key === "]" ? 4 : -4));
    else if (key === "enter") applyClass();
    else if (key === "escape") clearSelection();
    else return;
    event.preventDefault();
  };

  const onControlChange: LidarControlEventHandler = (event) => {
    if (disposed) return;
    if (event.type === "unload" && session && event.pointCloud?.id === session.cloudId) {
      endSession(tr(app, "cloudUnloaded", "The point cloud was removed, so the session ended."));
      return;
    }
    renderCloudOptions();
  };

  const bindControl = () => {
    const ctl = control();
    if (ctl === boundControl) return;
    boundControl?.off("load", onControlChange);
    boundControl?.off("unload", onControlChange);
    boundControl = ctl;
    ctl?.on("load", onControlChange);
    ctl?.on("unload", onControlChange);
  };

  startButton.addEventListener("click", () => {
    bindControl();
    if (session) endSession(tr(app, "sessionEnded", "Session finished; streaming resumed."));
    else startSession();
  });
  openLidarButton.addEventListener("click", () => {
    openLidarLayerPanel(app);
    // The control mounts asynchronously; bind once it exists.
    setTimeout(() => {
      bindControl();
      renderCloudOptions();
    }, 500);
  });
  panButton.addEventListener("click", () => setTool("pan"));
  boxButton.addEventListener("click", () => setTool("box"));
  lassoButton.addEventListener("click", () => setTool("lasso"));
  brushButton.addEventListener("click", () => setTool("brush"));
  brushSize.addEventListener("change", () => setBrushRadius(Number(brushSize.value) / 2));
  modeSelect.addEventListener("change", () => {
    mode = modeSelect.value as SelectionMode;
  });
  onlyClassSelect.addEventListener("change", () => {
    onlyClass = onlyClassSelect.value === "" ? null : Number(onlyClassSelect.value);
  });
  targetSelect.addEventListener("change", () => {
    targetClass = Number(targetSelect.value);
  });
  applyButton.addEventListener("click", applyClass);
  clearButton.addEventListener("click", clearSelection);
  undoButton.addEventListener("click", () => {
    const changed = session?.history.undo(liveClassifications);
    if (changed) {
      recordLabels(changed.indices);
      refreshAfterEdit(changed.cloudId);
    }
  });
  redoButton.addEventListener("click", () => {
    const changed = session?.history.redo(liveClassifications);
    if (changed) {
      recordLabels(changed.indices);
      refreshAfterEdit(changed.cloudId);
    }
  });
  exportLasButton.addEventListener("click", () => void exportPoints("las"));
  exportLazButton.addEventListener("click", () => void exportPoints("laz"));
  exportNpyButton.addEventListener("click", () => void exportPoints("npy"));
  exportSegmentsButton.addEventListener("click", exportSegments);
  document.addEventListener("keydown", onKeyDown);
  const unsubscribeLocale = app.onLocaleChange?.(() => {
    renderLabels();
    if (session) {
      const data = activeData();
      hint.textContent = tr(
        app,
        "sessionHint",
        "Annotating {{name}}: {{count}} points loaded. Streaming is paused; export before finishing the session.",
        { name: session.cloudName, count: numberFormat.format(data?.pointCount ?? 0) },
      );
    }
  });
  // Stored labels can land after a session started (nodes stream in late).
  const onLabelsApplied = () => {
    if (disposed) return;
    renderSummary();
  };
  labelAppliedListeners.add(onLabelsApplied);
  // The LiDAR control may mount after this panel; poll cheaply until it does.
  const bindTimer = setInterval(() => {
    bindControl();
    if (!session) renderCloudOptions();
  }, 1500);

  bindControl();
  renderLabels();
  renderSessionVisibility();

  return () => {
    disposed = true;
    labelAppliedListeners.delete(onLabelsApplied);
    clearInterval(bindTimer);
    endSession();
    document.removeEventListener("keydown", onKeyDown);
    boundControl?.off("load", onControlChange);
    boundControl?.off("unload", onControlChange);
    unsubscribeLocale?.();
    container.replaceChildren();
  };
}

/**
 * Edited classes for every labelled cloud, saved with the project (plugin
 * state) and keyed by stable point identity so they survive reloads.
 */
const labelStore = new PointLabelStore();

/** Whether a source can key saved labels (a local file cannot be reopened). */
function isPersistentSource(source: string | undefined): source is string {
  return typeof source === "string" && /^https?:\/\//i.test(source);
}

let labelSyncControl: LidarControl | null = null;
/** Called after stored labels changed loaded points (the open panel re-renders). */
const labelAppliedListeners = new Set<() => void>();
let labelSyncTimer: ReturnType<typeof setTimeout> | null = null;
let labelSyncPoll: ReturnType<typeof setInterval> | null = null;

/**
 * Writes saved labels into every loaded cloud they belong to, recolouring
 * when anything changed. Runs whenever the LiDAR control loads or streams
 * points, so labels reappear on nodes streamed in after a project reopens.
 */
function applyStoredLabels(): void {
  const ctl = getLidarControl();
  if (!ctl || labelStore.isEmpty) return;
  let changed = 0;
  for (const info of ctl.getPointClouds()) {
    if (!isPersistentSource(info.source)) continue;
    const data = getCloudData(ctl, info.id);
    if (data) changed += labelStore.apply(info.source, data as LabelledCloud);
  }
  if (changed > 0) {
    refreshCloudColors(ctl);
    for (const listener of labelAppliedListeners) listener();
  }
}

const onLabelSyncEvent: LidarControlEventHandler = () => {
  // Streaming progress fires per node; coalesce into one pass.
  if (labelSyncTimer) return;
  labelSyncTimer = setTimeout(() => {
    labelSyncTimer = null;
    applyStoredLabels();
  }, 300);
};

/** Keeps saved labels applied to the LiDAR control, whenever it exists. */
function startLabelSync(): void {
  const bind = () => {
    const ctl = getLidarControl();
    if (ctl === labelSyncControl) return;
    labelSyncControl?.off("load", onLabelSyncEvent);
    labelSyncControl?.off("streamingprogress", onLabelSyncEvent);
    labelSyncControl = ctl;
    ctl?.on("load", onLabelSyncEvent);
    ctl?.on("streamingprogress", onLabelSyncEvent);
    onLabelSyncEvent({} as Parameters<LidarControlEventHandler>[0]);
  };
  bind();
  // The control mounts lazily (and is rebuilt on a renderer swap).
  labelSyncPoll ??= setInterval(bind, 2000);
}

function stopLabelSync(): void {
  if (labelSyncPoll) clearInterval(labelSyncPoll);
  labelSyncPoll = null;
  if (labelSyncTimer) clearTimeout(labelSyncTimer);
  labelSyncTimer = null;
  labelSyncControl?.off("load", onLabelSyncEvent);
  labelSyncControl?.off("streamingprogress", onLabelSyncEvent);
  labelSyncControl = null;
}

let unregisterPanel: (() => void) | null = null;
let disposePanel: (() => void) | null = null;

/** Label LiDAR points with ASPRS classes and export them (issue #2749). */
export const pointCloudAnnotationPlugin: GeoLibrePlugin = {
  id: POINT_CLOUD_ANNOTATION_PLUGIN_ID,
  name: "Point Cloud Annotation",
  version: "0.1.0",
  // Edits the maplibre-gl-lidar overlay, which only the MapLibre engine hosts
  // with the camera the selection projects through.
  engines: ["maplibre"],
  activate: (app) => {
    unregisterPanel =
      app.registerRightPanel?.({
        id: PANEL_ID,
        title: () =>
          app.translate?.(
            `toolbar.plugin.${POINT_CLOUD_ANNOTATION_PLUGIN_ID}`,
            "Point Cloud Annotation",
          ) ?? "Point Cloud Annotation",
        dock: "replace-style",
        defaultWidth: 320,
        deactivatePluginOnClose: true,
        render: (container) => {
          disposePanel?.();
          disposePanel = buildPanel(container, app);
          return () => {
            disposePanel?.();
            disposePanel = null;
          };
        },
      }) ?? null;
    app.openRightPanel?.(PANEL_ID);
  },
  deactivate: (app) => {
    app.closeRightPanel?.(PANEL_ID);
    disposePanel?.();
    disposePanel = null;
    unregisterPanel?.();
    unregisterPanel = null;
    // Saved labels stay applied to the map after the panel closes.
  },
  // Point labels are saved with the project whether or not the panel is open.
  getProjectState: () => labelStore.encode(),
  applyProjectState: (_app, state) => {
    labelStore.load(state);
    if (labelStore.isEmpty) stopLabelSync();
    else startLabelSync();
  },
};

export default pointCloudAnnotationPlugin;
