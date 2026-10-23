// 3D vector annotations for the point cloud annotator: polylines (lane
// markings, power lines, kerbs), polygons (roof outlines, footprints) and
// keypoints (poles, tree tops). Each vertex snaps to the nearest drawn point,
// so it carries that point's elevation. Drawn into the LiDAR overlay, saved
// with the project, and exported as 3D GeoJSON or a Segments.ai
// `pointcloud-vector` label.

import { LineLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { LidarControl } from "maplibre-gl-components";
import type { PointCloudData } from "maplibre-gl-lidar";
import type { GeoLibreAppAPI } from "../../types";
import { assignableClasses, classDefinition } from "./classes";
import { localFrame } from "./cuboid";
import { resolveExportCrs, safeFileStem } from "./las-writer";
import { getOverlayViewport, getRenderElevationRange, getRenderZOffset } from "./lidar-access";
import { createOffsetProjector } from "./selection";

/** The kinds of vector annotation. */
export type VectorKind = "polyline" | "polygon" | "keypoint";

export const VECTOR_KINDS: readonly VectorKind[] = ["polyline", "polygon", "keypoint"];

/** A vertex: longitude, latitude (degrees) and elevation (metres). */
export type Vertex = [number, number, number];

/** A labelled 3D vector. */
export interface VectorObject {
  id: number;
  kind: VectorKind;
  classCode: number;
  points: Vertex[];
}

/** Saved vectors for one source (URL is a value, so redaction can scrub it). */
export interface EncodedVectors {
  url: string;
  items: { id: number; kind: VectorKind; classCode: number; points: number[][] }[];
}

/** Most vertices one vector may have, so a project file stays bounded. */
export const MAX_VECTOR_VERTICES = 10_000;

/** Fewest vertices a finished vector of each kind needs. */
const MIN_VERTICES: Record<VectorKind, number> = { polyline: 2, polygon: 3, keypoint: 1 };

/** Pixels within which a click snaps to a point. */
const SNAP_PIXELS = 12;

/** Vectors per source URL, saved with the project alongside point labels. */
const vectorStore = new Map<string, VectorObject[]>();

/**
 * Serialises every source's vectors for the project file.
 *
 * @returns The saved vectors, or an empty list.
 */
export function encodeVectors(): EncodedVectors[] {
  // Vectors on a local file (keyed by session) cannot be reopened, so skip them.
  return [...vectorStore]
    .filter(([url, objects]) => objects.length > 0 && /^https?:\/\//i.test(url))
    .map(([url, objects]) => ({
      url,
      items: objects.map(({ id, kind, classCode, points }) => ({
        id,
        kind,
        classCode,
        points: points.map((point) => [...point]),
      })),
    }));
}

/**
 * Replaces the stored vectors with saved ones, dropping malformed entries.
 *
 * @param state - The `vectors` list from the project, or anything else to clear.
 */
export function loadVectors(state: unknown): void {
  vectorStore.clear();
  if (!Array.isArray(state)) return;
  const isVertex = (value: unknown): value is Vertex =>
    Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
  for (const entry of state as Partial<EncodedVectors>[]) {
    if (typeof entry?.url !== "string" || !Array.isArray(entry.items)) continue;
    const objects: VectorObject[] = [];
    const used = new Set<number>();
    let nextFree = 1;
    for (const saved of entry.items) {
      const kind = saved?.kind;
      const points = saved?.points;
      if (!VECTOR_KINDS.includes(kind as VectorKind) || !Array.isArray(points)) continue;
      if (points.length > MAX_VECTOR_VERTICES || !points.every(isVertex)) continue;
      if (points.length < MIN_VERTICES[kind as VectorKind]) continue;
      const code = Number(saved.classCode);
      // Keep a saved id when it is a positive integer not taken yet.
      let id = Number(saved.id);
      if (!Number.isInteger(id) || id < 1 || used.has(id)) {
        while (used.has(nextFree)) nextFree++;
        id = nextFree;
      }
      used.add(id);
      objects.push({
        id,
        kind: kind as VectorKind,
        classCode: Number.isInteger(code) && code >= 0 && code <= 255 ? code : 1,
        points: (kind === "keypoint" ? points.slice(0, 1) : points).map(
          (point) => [point[0], point[1], point[2]] as Vertex,
        ),
      });
    }
    if (objects.length > 0) vectorStore.set(entry.url, objects);
  }
}

/**
 * Length in metres along a vector's vertices (3D), closing a polygon's ring.
 *
 * @param object - The vector.
 * @returns The length, 0 for a keypoint.
 */
export function vectorLength(object: VectorObject): number {
  const { points } = object;
  if (points.length < 2) return 0;
  const frame = localFrame(points[0][1]);
  const ring = object.kind === "polygon" ? [...points, points[0]] : points;
  let total = 0;
  for (let i = 1; i < ring.length; i++) {
    const dx = (ring[i][0] - ring[i - 1][0]) * frame.mx;
    const dy = (ring[i][1] - ring[i - 1][1]) * frame.my;
    const dz = ring[i][2] - ring[i - 1][2];
    total += Math.hypot(dx, dy, dz);
  }
  return total;
}

/**
 * Converts vectors to 3D GeoJSON: keypoints as Points, polylines as
 * LineStrings and polygons as Polygons, each coordinate `[lng, lat, z]`.
 *
 * @param objects - The vectors.
 * @param className - Name for a class code.
 * @returns A FeatureCollection.
 */
export function vectorsToGeoJson(
  objects: readonly VectorObject[],
  className: (code: number) => string,
): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: objects.map((object) => {
      const { id, kind, classCode, points } = object;
      const coordinates = points.map((point) => [...point]);
      const geometry: GeoJSON.Geometry =
        kind === "keypoint"
          ? { type: "Point", coordinates: coordinates[0] }
          : kind === "polyline"
            ? { type: "LineString", coordinates }
            : { type: "Polygon", coordinates: [[...coordinates, coordinates[0]]] };
      return {
        type: "Feature",
        id,
        geometry,
        properties: {
          id,
          kind,
          classification: classCode,
          class_name: className(classCode),
          vertices: points.length,
          length_m: vectorLength(object),
        },
      };
    }),
  };
}

/**
 * Converts vectors to a Segments.ai `pointcloud-vector` label in the same CRS
 * and units as the annotator's LAS export, so it lines up with that file.
 *
 * @param objects - The vectors.
 * @param wkt - The source CRS WKT (WGS 84 when missing).
 * @returns The label as a JSON-serialisable object.
 */
export function vectorsToSegments(objects: readonly VectorObject[], wkt: string | undefined) {
  const crs = resolveExportCrs(wkt);
  return {
    format_version: "0.2",
    annotations: objects.map(({ id, kind, classCode, points }) => ({
      id,
      track_id: id,
      category_id: classCode,
      type: kind === "keypoint" ? "point" : kind,
      points: points.map(([lng, lat, z]) => {
        const [x, y] = crs.forward(lng, lat);
        return [x, y, z / crs.zFactor];
      }),
    })),
  };
}

/** The drawable points a vertex can snap to. */
interface SnapPoints {
  positions: Float32Array;
  coordinateOrigin: readonly [number, number, number];
  pointCount: number;
}

/**
 * The drawn point nearest to a screen position, within a snapping radius.
 *
 * @param data - The cloud's points.
 * @param project - Offset projector for the current view.
 * @param x - Screen x in map-container pixels.
 * @param y - Screen y in map-container pixels.
 * @param options - Render Z offset, points to skip, and snapping radius.
 * @returns The point's `[lng, lat, z]` (z in metres, without the render
 *   offset), or null when nothing is close enough.
 */
export function snapToPoint(
  data: SnapPoints,
  project: (dx: number, dy: number, z: number, out: Float64Array) => boolean,
  x: number,
  y: number,
  options: { zOffset: number; skip?: (index: number) => boolean; radius?: number },
): Vertex | null {
  const radius = options.radius ?? SNAP_PIXELS;
  const out = new Float64Array(2);
  let best = radius * radius;
  let found = -1;
  const p = data.positions;
  // Only indices the live buffers cover (a streamed cloud's count can run ahead).
  const count = Math.min(data.pointCount, Math.floor(p.length / 3));
  for (let i = 0; i < count; i++) {
    if (options.skip?.(i)) continue;
    if (!project(p[i * 3], p[i * 3 + 1], p[i * 3 + 2] + options.zOffset, out)) continue;
    const d = (out[0] - x) ** 2 + (out[1] - y) ** 2;
    if (d < best) {
      best = d;
      found = i;
    }
  }
  if (found < 0) return null;
  const [lng0, lat0] = data.coordinateOrigin;
  return [lng0 + p[found * 3], lat0 + p[found * 3 + 1], p[found * 3 + 2]];
}

/** What the vector section needs from the annotator panel. */
export interface VectorHost {
  app: GeoLibreAppAPI;
  tr: (key: string, fallback: string, params?: Record<string, string | number>) => string;
  control: () => LidarControl | null;
  session: () => { cloudId: string; cloudName: string; source: string | null; wkt?: string } | null;
  data: () => PointCloudData | null;
  classifications: () => Uint8Array | undefined;
  targetClass: () => number;
  className: (code: number) => string;
  /** Classes a vertex must never snap to (hidden and locked). */
  protectedClasses: () => ReadonlySet<number>;
  /** Switches the annotator to the vector drawing tool. */
  activateTool: () => void;
  /** Stops map zoom/rotate while a vector is being drawn, so vertices stay put. */
  lockCamera: () => void;
  unlockCamera: () => void;
  setStatus: (text: string) => void;
  exportText: (name: string, text: string) => void;
  /** Flags the project as changed, so closing it asks to save. */
  changed: () => void;
}

const LINE_LAYER_ID = "pointcloud-annotation-vectors-lines";
const POINT_LAYER_ID = "pointcloud-annotation-vectors-points";
const DRAFT_COLOR: [number, number, number, number] = [250, 204, 21, 255];

/** The 3D vector section of the annotator panel. */
export class VectorSection {
  readonly root: HTMLElement;
  private readonly heading: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly kindButtons = new Map<VectorKind, HTMLButtonElement>();
  private readonly list: HTMLElement;
  private readonly exportGeoJson: HTMLButtonElement;
  private readonly exportSegments: HTMLButtonElement;
  private kind: VectorKind = "polyline";
  private draft: Vertex[] | null = null;
  private active = false;

  /**
   * @param host - Hooks into the annotator panel.
   * @param makeButton - The panel's button factory, for a consistent look.
   */
  constructor(
    private readonly host: VectorHost,
    private readonly makeButton: (text: string, primary?: boolean) => HTMLButtonElement,
  ) {
    this.root = document.createElement("div");
    this.root.style.cssText = "display:flex;flex-direction:column;gap:6px;";
    this.heading = document.createElement("div");
    this.heading.style.fontWeight = "600";
    const kinds = document.createElement("div");
    kinds.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";
    for (const kind of VECTOR_KINDS) {
      const node = makeButton("");
      node.dataset.vectorKind = kind;
      node.addEventListener("click", () => this.start(kind));
      this.kindButtons.set(kind, node);
      kinds.append(node);
    }
    this.hint = document.createElement("div");
    this.hint.style.cssText = "line-height:1.4;color:hsl(var(--muted-foreground));";
    this.list = document.createElement("div");
    this.list.dataset.testid = "pc-annotation-vectors";
    this.list.style.cssText = "display:flex;flex-direction:column;gap:4px;";
    this.exportGeoJson = makeButton("");
    this.exportGeoJson.dataset.testid = "pc-annotation-export-vectors-geojson";
    this.exportSegments = makeButton("");
    this.exportSegments.dataset.testid = "pc-annotation-export-vectors-segments";
    const exportRow = document.createElement("div");
    exportRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";
    exportRow.append(this.exportGeoJson, this.exportSegments);
    this.root.append(this.heading, kinds, this.hint, this.list, exportRow);
    this.exportGeoJson.addEventListener("click", () => this.exportAs("geojson"));
    this.exportSegments.addEventListener("click", () => this.exportAs("segments"));
    this.renderLabels();
  }

  /** The current source's vectors (live array). */
  private objects(): VectorObject[] {
    const source = this.host.session()?.source ?? null;
    const key = source ?? `session:${this.host.session()?.cloudId ?? ""}`;
    let objects = vectorStore.get(key);
    if (!objects) {
      objects = [];
      vectorStore.set(key, objects);
    }
    return objects;
  }

  private kindLabel(kind: VectorKind): string {
    const tr = this.host.tr;
    if (kind === "polygon") return tr("vectorPolygon", "3D polygon");
    if (kind === "keypoint") return tr("vectorKeypoint", "Keypoint");
    return tr("vectorPolyline", "Polyline");
  }

  /** Re-applies translated text. */
  renderLabels(): void {
    const tr = this.host.tr;
    this.heading.textContent = tr("vectors", "3D vectors");
    for (const [kind, node] of this.kindButtons) node.textContent = this.kindLabel(kind);
    this.exportGeoJson.textContent = tr("exportVectorsGeoJson", "Vectors as GeoJSON");
    this.exportSegments.textContent = tr("exportVectorsSegments", "Vectors as Segments.ai JSON");
    // Text only: this also runs from the constructor, before the host's map
    // hooks are ready.
    this.renderButtons();
    this.renderList();
  }

  /**
   * Whether the vector tool is the annotator's current tool. The panel calls
   * this when the tool changes, so the kind buttons show which one is armed.
   *
   * @param active - True while the vector tool is selected.
   */
  setActive(active: boolean): void {
    this.active = active;
    if (!active) this.cancel();
    this.renderButtons();
  }

  /** Arms the vector tool for one kind. */
  start(kind: VectorKind): void {
    if (this.draft && this.draft.length > 0) {
      // Switching kinds drops the vector being drawn; say so, as Esc would.
      this.host.setStatus(
        this.host.tr("vectorDiscarded", "Discarded the unfinished vector ({{count}} vertices).", {
          count: this.draft.length,
        }),
      );
    }
    this.cancel();
    this.kind = kind;
    this.host.activateTool();
    this.active = true;
    this.renderButtons();
  }

  private renderButtons(): void {
    const tr = this.host.tr;
    for (const [kind, node] of this.kindButtons) {
      const pressed = this.active && kind === this.kind;
      node.setAttribute("aria-pressed", String(pressed));
      node.style.outline = pressed ? "2px solid hsl(var(--primary))" : "";
    }
    this.hint.textContent = !this.active
      ? tr(
          "vectorHint",
          "Pick a kind, then click points on the cloud; each vertex snaps to the nearest point.",
        )
      : this.kind === "keypoint"
        ? tr("keypointHint", "Click a point to place a keypoint.")
        : tr(
            "vectorDrawHint",
            "Click points to add vertices; double-click or press Enter to finish, Backspace removes the last vertex, Esc cancels.",
          );
  }

  /**
   * Handles a click with the vector tool: adds a vertex snapped to the
   * nearest drawn point (a keypoint is complete at once).
   *
   * @param x - Pointer x in map-container pixels.
   * @param y - Pointer y in map-container pixels.
   */
  handleClick(x: number, y: number): void {
    const vertex = this.pick(x, y);
    if (!vertex) {
      this.host.setStatus(this.host.tr("vectorNoPoint", "No point under the cursor to snap to."));
      return;
    }
    if (this.kind === "keypoint") {
      this.add([vertex]);
      return;
    }
    if (!this.draft) {
      this.draft = [];
      this.host.lockCamera();
    }
    if (this.draft.length >= MAX_VECTOR_VERTICES) return;
    // A double-click's second press snaps to the same point; keep one vertex.
    const last = this.draft[this.draft.length - 1];
    if (last && last.every((value, k) => value === vertex[k])) return;
    this.draft.push(vertex);
    this.renderMap();
  }

  /**
   * Finishes the vector being drawn (a double-click). Pointer events report
   * no click count, so the panel forwards the map's `dblclick` here.
   *
   * @returns True when there was a vector being drawn.
   */
  handleDoubleClick(): boolean {
    if (!this.draft) return false;
    if (this.draft.length >= MIN_VERTICES[this.kind]) this.finish();
    return true;
  }

  /**
   * Keyboard control of a vector being drawn: Enter finishes, Backspace
   * removes the last vertex, Esc cancels.
   *
   * @param event - The key event.
   * @returns True when the key was used (the caller stops it).
   */
  handleKey(event: KeyboardEvent): boolean {
    if (!this.draft) return false;
    if (event.key === "Enter") this.finish();
    else if (event.key === "Escape") this.cancel();
    else if (event.key === "Backspace") {
      this.draft.pop();
      // Removing the last vertex ends the draft, releasing the camera.
      if (this.draft.length === 0) this.cancel();
      else this.renderMap();
    } else return false;
    return true;
  }

  private pick(x: number, y: number): Vertex | null {
    const ctl = this.host.control();
    const data = this.host.data();
    const viewport = ctl ? getOverlayViewport(ctl) : null;
    if (!ctl || !data || !viewport) return null;
    const classes = this.host.classifications();
    const protectedClasses = this.host.protectedClasses();
    const range = getRenderElevationRange(ctl);
    const p = data.positions;
    return snapToPoint(data, createOffsetProjector(viewport, data.coordinateOrigin), x, y, {
      zOffset: getRenderZOffset(ctl),
      // Only points the renderer draws can be snapped to.
      skip: (i) =>
        (classes !== undefined && protectedClasses.has(classes[i])) ||
        (range !== null && (p[i * 3 + 2] < range[0] || p[i * 3 + 2] > range[1])),
    });
  }

  private finish(): void {
    const points = this.draft;
    this.draft = null;
    this.host.unlockCamera();
    if (points && points.length >= MIN_VERTICES[this.kind]) this.add(points);
    else this.renderMap();
  }

  /** Drops a vector being drawn (e.g. when the tool or session changes). */
  cancel(): void {
    if (!this.draft) return;
    this.draft = null;
    this.host.unlockCamera();
    this.renderMap();
  }

  private add(points: Vertex[]): void {
    const objects = this.objects();
    const object: VectorObject = {
      id: objects.reduce((max, entry) => Math.max(max, entry.id), 0) + 1,
      kind: this.kind,
      classCode: this.host.targetClass(),
      points,
    };
    objects.push(object);
    this.host.changed();
    this.render();
    this.host.setStatus(
      this.host.tr("vectorAdded", "Added vector {{id}}: {{kind}}, {{count}} vertices.", {
        kind: this.kindLabel(object.kind),
        id: object.id,
        count: points.length,
      }),
    );
  }

  private remove(id: number): void {
    const objects = this.objects();
    const index = objects.findIndex((object) => object.id === id);
    if (index >= 0) {
      objects.splice(index, 1);
      this.host.changed();
    }
    this.render();
  }

  /** Redraws the list and the map layers. */
  render(): void {
    this.renderButtons();
    this.renderList();
    this.renderMap();
  }

  /** Removes the map layers and any vector being drawn (session end). */
  clear(): void {
    this.draft = null;
    this.active = false;
    this.host.unlockCamera();
    const overlay = this.host.control()?.getDeckOverlay();
    overlay?.removeLayer(LINE_LAYER_ID);
    overlay?.removeLayer(POINT_LAYER_ID);
    this.renderList();
    this.renderButtons();
  }

  private renderList(): void {
    this.list.replaceChildren();
    const session = this.host.session();
    const objects = session ? this.objects() : [];
    const tr = this.host.tr;
    for (const object of objects) {
      const row = document.createElement("div");
      row.dataset.vector = String(object.id);
      row.style.cssText = "display:flex;gap:4px;align-items:center;flex-wrap:wrap;";
      const [r, g, b] = classDefinition(object.classCode).color;
      const swatch = document.createElement("span");
      swatch.style.cssText = `width:10px;height:10px;border-radius:2px;background:rgb(${r},${g},${b});flex:none;`;
      const label = document.createElement("span");
      label.style.cssText = "flex:1;min-width:0;";
      label.textContent =
        object.kind === "keypoint"
          ? `#${object.id} · ${this.kindLabel(object.kind)} · ${object.points[0][2].toFixed(2)} m`
          : `#${object.id} · ${this.kindLabel(object.kind)} · ${object.points.length} · ${vectorLength(object).toFixed(1)} m`;
      const classSelect = document.createElement("select");
      classSelect.style.cssText =
        "padding:2px;border:1px solid hsl(var(--border));border-radius:4px;background:hsl(var(--background));min-width:0;max-width:9em;";
      classSelect.style.setProperty("color", "hsl(var(--foreground))", "important");
      for (const entry of assignableClasses()) {
        classSelect.append(
          new Option(`${entry.code} · ${this.host.className(entry.code)}`, String(entry.code)),
        );
      }
      classSelect.value = String(object.classCode);
      classSelect.setAttribute("aria-label", tr("vectorClass", "Vector class"));
      classSelect.addEventListener("change", () => {
        object.classCode = Number(classSelect.value);
        this.host.changed();
        this.render();
      });
      const remove = this.makeButton(tr("deleteVector", "Delete"));
      remove.style.padding = "1px 6px";
      remove.dataset.vectorDelete = String(object.id);
      remove.addEventListener("click", () => this.remove(object.id));
      row.append(swatch, label, classSelect, remove);
      this.list.append(row);
    }
    this.exportGeoJson.disabled = objects.length === 0;
    this.exportSegments.disabled = objects.length === 0;
  }

  private renderMap(): void {
    const ctl = this.host.control();
    const overlay = ctl?.getDeckOverlay();
    if (!ctl || !overlay) return;
    const objects = this.host.session() ? this.objects() : [];
    const zOffset = getRenderZOffset(ctl);
    const lift = ([lng, lat, z]: Vertex): Vertex => [lng, lat, z + zOffset];
    const segments: { source: Vertex; target: Vertex; color: number[] }[] = [];
    const vertices: { position: Vertex; color: number[]; radius: number }[] = [];
    const addPath = (points: Vertex[], closed: boolean, color: number[]) => {
      const ring = closed && points.length >= 3 ? [...points, points[0]] : points;
      for (let i = 1; i < ring.length; i++) {
        segments.push({ source: lift(ring[i - 1]), target: lift(ring[i]), color });
      }
    };
    for (const object of objects) {
      const color = [...classDefinition(object.classCode).color, 255];
      if (object.kind !== "keypoint") addPath(object.points, object.kind === "polygon", color);
      for (const point of object.points) {
        vertices.push({ position: lift(point), color, radius: object.kind === "keypoint" ? 6 : 3 });
      }
    }
    if (this.draft) {
      addPath(this.draft, this.kind === "polygon", DRAFT_COLOR);
      for (const point of this.draft)
        vertices.push({ position: lift(point), color: DRAFT_COLOR, radius: 4 });
    }
    if (segments.length === 0) overlay.removeLayer(LINE_LAYER_ID);
    else {
      overlay.addLayer(
        LINE_LAYER_ID,
        new LineLayer({
          id: LINE_LAYER_ID,
          data: segments,
          getSourcePosition: (d: { source: Vertex }) => d.source,
          getTargetPosition: (d: { target: Vertex }) => d.target,
          getColor: (d: { color: number[] }) => d.color as [number, number, number, number],
          getWidth: 3,
          widthUnits: "pixels",
          // Like the selection highlight: stay visible through the points.
          parameters: { depthTest: false } as Record<string, unknown>,
        }),
        { overlay: true },
      );
    }
    if (vertices.length === 0) overlay.removeLayer(POINT_LAYER_ID);
    else {
      overlay.addLayer(
        POINT_LAYER_ID,
        new ScatterplotLayer({
          id: POINT_LAYER_ID,
          data: vertices,
          getPosition: (d: { position: Vertex }) => d.position,
          getFillColor: (d: { color: number[] }) => d.color as [number, number, number, number],
          getLineColor: [255, 255, 255, 255],
          getRadius: (d: { radius: number }) => d.radius,
          radiusUnits: "pixels",
          stroked: true,
          lineWidthMinPixels: 1,
          parameters: { depthTest: false } as Record<string, unknown>,
        }),
        { overlay: true },
      );
    }
  }

  private exportAs(format: "geojson" | "segments"): void {
    const session = this.host.session();
    const objects = session ? this.objects() : [];
    if (!session || objects.length === 0) return;
    const stem = safeFileStem(session.cloudName);
    if (format === "geojson") {
      this.host.exportText(
        `${stem}-vectors.geojson`,
        JSON.stringify(vectorsToGeoJson(objects, this.host.className)),
      );
    } else {
      this.host.exportText(
        `${stem}-vectors-segments.json`,
        JSON.stringify(vectorsToSegments(objects, session.wkt)),
      );
    }
    this.host.setStatus(
      this.host.tr("exportedVectors", "Exported {{count}} vectors.", { count: objects.length }),
    );
  }
}
