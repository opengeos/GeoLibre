// Cuboid (3D bounding box) objects for the point cloud annotator: the object
// list, box creation (fit to the selection, or grow-and-fit from a clicked
// point), wireframes on the map, the orthographic editor, persistence and
// export (GeoJSON footprints, Segments.ai `pointcloud-cuboid`).

import { LineLayer } from "@deck.gl/layers";
import type { LidarControl } from "maplibre-gl-components";
import type { PointCloudData } from "maplibre-gl-lidar";
import type { GeoLibreAppAPI } from "../../types";
import { assignableClasses, classDefinition } from "./classes";
import {
  CUBOID_EDGES,
  cuboidCorners,
  fitCuboid,
  growCluster,
  localFrame,
  pointsInCuboid,
  type Cuboid,
} from "./cuboid";
import { resolveExportCrs, safeFileStem } from "./las-writer";
import { getOverlayViewport, getRenderZOffset } from "./lidar-access";
import { ObjectViews, boxFramePoints } from "./object-views";
import { createOffsetProjector } from "./selection";

/** Review status of a labelled object. */
export type ObjectStatus = "new" | "reviewed" | "flagged";

export const OBJECT_STATUSES: readonly ObjectStatus[] = ["new", "reviewed", "flagged"];

/** Limits on free-form attributes, so a project file stays small and sane. */
export const MAX_OBJECT_ATTRIBUTES = 32;
export const MAX_ATTRIBUTE_KEY = 64;
export const MAX_ATTRIBUTE_VALUE = 256;

/** A labelled box. */
export interface CuboidObject {
  id: number;
  classCode: number;
  box: Cuboid;
  status: ObjectStatus;
  /** Free-form name/value attributes (e.g. make, occluded). */
  attributes: Record<string, string>;
}

/** Saved boxes for one source (URL is a value, so redaction can scrub it). */
export interface EncodedCuboids {
  url: string;
  boxes: {
    id: number;
    classCode: number;
    center: number[];
    size: number[];
    yaw: number;
    status?: ObjectStatus;
    attributes?: Record<string, string>;
  }[];
}

/**
 * Cuts text to at most `length` UTF-16 code units without splitting a
 * surrogate pair (the Python reader truncates the same way).
 *
 * @param text - The text.
 * @param length - Maximum UTF-16 code units.
 * @returns The prefix.
 */
export function clipText(text: string, length: number): string {
  if (text.length <= length) return text;
  const cut = text.slice(0, length);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Validates free-form attributes: string keys and values within the length
 * limits, at most {@link MAX_OBJECT_ATTRIBUTES} of them.
 *
 * @param value - Anything (e.g. from a project file).
 * @returns The attributes that pass, as a plain object.
 */
export function sanitizeAttributes(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (Object.keys(out).length >= MAX_OBJECT_ATTRIBUTES) break;
    const key = clipText(rawKey.trim(), MAX_ATTRIBUTE_KEY);
    if (!key || typeof rawValue !== "string" || key === "__proto__") continue;
    out[key] = clipText(rawValue, MAX_ATTRIBUTE_VALUE);
  }
  return out;
}

/** Property names the box exports set themselves; an attribute cannot use them. */
export const RESERVED_ATTRIBUTE_NAMES: ReadonlySet<string> = new Set([
  "id",
  "status",
  "classification",
  "class_name",
  "z_min",
  "z_max",
  "length_m",
  "width_m",
  "height_m",
  "yaw_deg",
]);

function parseStatus(value: unknown): ObjectStatus {
  return OBJECT_STATUSES.includes(value as ObjectStatus) ? (value as ObjectStatus) : "new";
}

/** Boxes per source URL, saved with the project alongside point labels. */
const cuboidStore = new Map<string, CuboidObject[]>();

/**
 * Serialises every source's boxes for the project file.
 *
 * @returns The saved boxes, or an empty list.
 */
export function encodeCuboids(): EncodedCuboids[] {
  // Boxes on a local file (keyed by session) cannot be reopened, so skip them.
  return [...cuboidStore]
    .filter(([url, objects]) => objects.length > 0 && /^https?:\/\//i.test(url))
    .map(([url, objects]) => ({
      url,
      boxes: objects.map(({ id, classCode, box, status, attributes }) => ({
        id,
        classCode,
        center: [...box.center],
        size: [...box.size],
        yaw: box.yaw,
        ...(status !== "new" ? { status } : {}),
        ...(Object.keys(attributes).length > 0 ? { attributes: { ...attributes } } : {}),
      })),
    }));
}

/**
 * Replaces the stored boxes with saved ones.
 *
 * @param state - The `cuboids` list from the project, or anything else to clear.
 */
export function loadCuboids(state: unknown): void {
  cuboidStore.clear();
  if (!Array.isArray(state)) return;
  const isTriple = (value: unknown): value is [number, number, number] =>
    Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
  for (const entry of state as Partial<EncodedCuboids>[]) {
    if (typeof entry?.url !== "string" || !Array.isArray(entry.boxes)) continue;
    const objects: CuboidObject[] = [];
    const used = new Set<number>();
    let nextFree = 1;
    for (const saved of entry.boxes) {
      if (!isTriple(saved?.center) || !isTriple(saved.size) || !Number.isFinite(saved.yaw))
        continue;
      // Keep a saved id when it is a positive integer not taken yet; give a
      // missing or duplicate one a fresh id, so select/delete are unambiguous.
      let id = Number(saved.id);
      if (!Number.isInteger(id) || id < 1 || used.has(id)) {
        while (used.has(nextFree)) nextFree++;
        id = nextFree;
      }
      used.add(id);
      objects.push({
        id,
        classCode: Number(saved.classCode) || 0,
        box: { center: saved.center, size: saved.size, yaw: saved.yaw },
        status: parseStatus(saved.status),
        attributes: sanitizeAttributes(saved.attributes),
      });
    }
    if (objects.length > 0) cuboidStore.set(entry.url, objects);
  }
}

/**
 * Converts boxes to GeoJSON: one footprint polygon per box, with its class,
 * vertical extent and size as properties.
 *
 * @param objects - The boxes.
 * @param className - Name for a class code.
 * @returns A FeatureCollection.
 */
export function cuboidsToGeoJson(
  objects: readonly CuboidObject[],
  className: (code: number) => string,
): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: objects.map(({ id, classCode, box, status, attributes }) => {
      const corners = cuboidCorners(box);
      const ring = [0, 1, 2, 3, 0].map((k) => [corners[k][0], corners[k][1]]);
      return {
        type: "Feature",
        id,
        geometry: { type: "Polygon", coordinates: [ring] },
        properties: {
          // Free-form attributes first, so a clashing name cannot replace a
          // built-in property.
          ...attributes,
          status,
          id,
          classification: classCode,
          class_name: className(classCode),
          z_min: box.center[2] - box.size[2] / 2,
          z_max: box.center[2] + box.size[2] / 2,
          length_m: box.size[0],
          width_m: box.size[1],
          height_m: box.size[2],
          yaw_deg: (box.yaw * 180) / Math.PI,
        },
      };
    }),
  };
}

/**
 * Converts boxes to a Segments.ai `pointcloud-cuboid` label in the same CRS
 * and units as the annotator's LAS export, so it lines up with that file:
 * position and dimensions in CRS units, yaw measured from the CRS x axis
 * (grid east, which differs from true east by the meridian convergence).
 *
 * @param objects - The boxes.
 * @param wkt - The source CRS WKT (WGS 84 when missing).
 * @returns The label as a JSON-serialisable object.
 */
export function cuboidsToSegments(objects: readonly CuboidObject[], wkt: string | undefined) {
  const crs = resolveExportCrs(wkt);
  return {
    format_version: "0.2",
    annotations: objects.map(({ id, classCode, box, status, attributes }) => {
      const frame = localFrame(box.center[1]);
      const [x, y] = crs.forward(box.center[0], box.center[1]);
      // Project a point a metre ahead along the heading to get the grid yaw
      // and the CRS's horizontal units per metre at the box.
      const ahead = crs.forward(
        box.center[0] + Math.cos(box.yaw) / frame.mx,
        box.center[1] + Math.sin(box.yaw) / frame.my,
      );
      const scale = Math.hypot(ahead[0] - x, ahead[1] - y);
      return {
        id,
        track_id: id,
        category_id: classCode,
        type: "cuboid",
        position: { x, y, z: box.center[2] / crs.zFactor },
        dimensions: {
          x: box.size[0] * scale,
          y: box.size[1] * scale,
          z: box.size[2] / crs.zFactor,
        },
        yaw: Math.atan2(ahead[1] - y, ahead[0] - x),
        attributes: { ...attributes, status },
      };
    }),
  };
}

/** What the cuboid section needs from the annotator panel. */
export interface CuboidHost {
  app: GeoLibreAppAPI;
  tr: (key: string, fallback: string, params?: Record<string, string | number>) => string;
  control: () => LidarControl | null;
  /** The running session, or null. */
  session: () => { cloudId: string; cloudName: string; source: string | null; wkt?: string } | null;
  data: () => PointCloudData | null;
  classifications: () => Uint8Array | undefined;
  selection: () => Uint32Array;
  setSelection: (indices: Uint32Array) => void;
  targetClass: () => number;
  className: (code: number) => string;
  /** Classes a selection must never pick (hidden and locked). */
  protectedClasses: () => ReadonlySet<number>;
  assignClass: (indices: Uint32Array, code: number) => void;
  setStatus: (text: string) => void;
  exportText: (name: string, text: string) => void;
  /** Flags the project as changed, so closing it asks to save. */
  changed: () => void;
}

const LAYER_ID = "pointcloud-annotation-cuboids";
const VIEWS_PANEL_ID = "pc-annotation-object-views";
/** Metres of context shown around a box in the orthographic views. */
const VIEW_MARGIN = 1.5;
/** Ground and noise never join an auto-fitted object. */
const AUTO_BOX_SKIP = new Set([2, 7, 9, 18]);

/** The cuboid section of the annotator panel. */
export class CuboidSection {
  readonly root: HTMLElement;
  private readonly heading: HTMLElement;
  private readonly list: HTMLElement;
  private readonly fromSelection: HTMLButtonElement;
  private readonly exportGeoJson: HTMLButtonElement;
  private readonly exportSegments: HTMLButtonElement;
  private selectedId: number | null = null;
  /** Boxes whose attribute editor is expanded. */
  private readonly openAttributes = new Set<number>();
  private views: ObjectViews | null = null;
  private unregisterViews: (() => void) | null = null;
  private frame = 0;

  /**
   * @param host - Hooks into the annotator panel.
   * @param makeButton - The panel's button factory, for a consistent look.
   */
  constructor(
    private readonly host: CuboidHost,
    makeButton: (text: string, primary?: boolean) => HTMLButtonElement,
  ) {
    this.root = document.createElement("div");
    this.root.style.cssText = "display:flex;flex-direction:column;gap:6px;";
    this.heading = document.createElement("div");
    this.heading.style.fontWeight = "600";
    this.fromSelection = makeButton("");
    this.fromSelection.dataset.testid = "pc-annotation-box-from-selection";
    this.exportGeoJson = makeButton("");
    this.exportGeoJson.dataset.testid = "pc-annotation-export-cuboids-geojson";
    this.exportSegments = makeButton("");
    this.exportSegments.dataset.testid = "pc-annotation-export-cuboids-segments";
    this.list = document.createElement("div");
    this.list.dataset.testid = "pc-annotation-cuboids";
    this.list.style.cssText = "display:flex;flex-direction:column;gap:4px;";
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";
    row.append(this.fromSelection);
    const exportRow = document.createElement("div");
    exportRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";
    exportRow.append(this.exportGeoJson, this.exportSegments);
    this.root.append(this.heading, row, this.list, exportRow);
    this.fromSelection.addEventListener("click", () => this.addFromSelection());
    this.exportGeoJson.addEventListener("click", () => this.exportAs("geojson"));
    this.exportSegments.addEventListener("click", () => this.exportAs("segments"));
    this.renderLabels();
  }

  /** The current source's boxes (live array). */
  private objects(): CuboidObject[] {
    const source = this.host.session()?.source ?? null;
    const key = source ?? `session:${this.host.session()?.cloudId ?? ""}`;
    let objects = cuboidStore.get(key);
    if (!objects) {
      objects = [];
      cuboidStore.set(key, objects);
    }
    return objects;
  }

  /** Re-applies translated text. */
  renderLabels(): void {
    const tr = this.host.tr;
    this.heading.textContent = tr("cuboids", "Objects (3D boxes)");
    this.fromSelection.textContent = tr("boxFromSelection", "Box from selection");
    this.exportGeoJson.textContent = tr("exportCuboidsGeoJson", "Boxes as GeoJSON");
    this.exportSegments.textContent = tr("exportCuboidsSegments", "Boxes as Segments.ai JSON");
    this.renderList();
  }

  /** Redraws the list, the wireframes and (for the selected box) the views. */
  render(refit = false): void {
    this.renderList();
    this.renderMap();
    this.renderViews(refit);
  }

  /** Removes the wireframes and closes the views (session end). */
  clear(): void {
    this.host.control()?.getDeckOverlay()?.removeLayer(LAYER_ID);
    this.selectedId = null;
    this.host.app.closeFloatingPanel?.(VIEWS_PANEL_ID);
    this.renderList();
  }

  /** Releases the views and their panel. */
  destroy(): void {
    this.clear();
    this.views?.destroy();
    this.views = null;
    this.unregisterViews?.();
    this.unregisterViews = null;
  }

  private nextId(): number {
    return this.objects().reduce((max, object) => Math.max(max, object.id), 0) + 1;
  }

  private add(box: Cuboid): void {
    const object: CuboidObject = {
      id: this.nextId(),
      classCode: this.host.targetClass(),
      box,
      status: "new",
      attributes: {},
    };
    this.objects().push(object);
    this.host.changed();
    this.select(object.id);
    this.host.setStatus(
      this.host.tr("boxAdded", "Added box {{id}} ({{l}} × {{w}} × {{h}} m).", {
        id: object.id,
        l: box.size[0].toFixed(2),
        w: box.size[1].toFixed(2),
        h: box.size[2].toFixed(2),
      }),
    );
  }

  private addFromSelection(): void {
    const data = this.host.data();
    const selection = this.host.selection();
    if (!data || selection.length === 0) {
      this.host.setStatus(this.host.tr("boxNeedsSelection", "Select the object's points first."));
      return;
    }
    const box = fitCuboid(data, selection);
    if (box) this.add(box);
  }

  /**
   * Auto box: grows a cluster from the point under the cursor (skipping
   * ground, water and noise) and fits a box to it.
   *
   * @param x - Pointer x in map-container pixels.
   * @param y - Pointer y in map-container pixels.
   */
  autoBoxAt(x: number, y: number): void {
    const ctl = this.host.control();
    const data = this.host.data();
    const viewport = ctl ? getOverlayViewport(ctl) : null;
    if (!ctl || !data || !viewport) return;
    const classes = this.host.classifications();
    const protectedClasses = this.host.protectedClasses();
    const project = createOffsetProjector(viewport, data.coordinateOrigin);
    const zOffset = getRenderZOffset(ctl);
    const out = new Float64Array(2);
    let seed = -1;
    let best = 8 * 8;
    for (let i = 0; i < data.pointCount; i++) {
      const code = classes?.[i];
      if (code !== undefined && (AUTO_BOX_SKIP.has(code) || protectedClasses.has(code))) continue;
      const p = data.positions;
      if (!project(p[i * 3], p[i * 3 + 1], p[i * 3 + 2] + zOffset, out)) continue;
      const d = (out[0] - x) ** 2 + (out[1] - y) ** 2;
      if (d < best) {
        best = d;
        seed = i;
      }
    }
    if (seed < 0) {
      this.host.setStatus(
        this.host.tr(
          "noPointUnderCursor",
          "No object point under the cursor (ground and noise are skipped).",
        ),
      );
      return;
    }
    const cluster = growCluster(data, seed, {
      radius: 0.75,
      // Large enough for a warehouse or a stadium stand; the grow still stops
      // at the object's edge.
      searchRadius: 150,
      skip: (i) => {
        const code = classes?.[i];
        return code !== undefined && (AUTO_BOX_SKIP.has(code) || protectedClasses.has(code));
      },
    });
    this.host.setSelection(cluster);
    const box = fitCuboid(data, cluster);
    if (box) this.add(box);
  }

  private select(id: number | null): void {
    this.selectedId = id;
    if (id !== null) this.openViews();
    this.render(true);
  }

  private remove(id: number): void {
    const objects = this.objects();
    const index = objects.findIndex((object) => object.id === id);
    if (index >= 0) {
      objects.splice(index, 1);
      this.host.changed();
    }
    if (this.selectedId === id) {
      this.selectedId = null;
      this.host.app.closeFloatingPanel?.(VIEWS_PANEL_ID);
    }
    this.render();
  }

  private pointsIn(object: CuboidObject): Uint32Array {
    const data = this.host.data();
    if (!data) return new Uint32Array(0);
    const protectedClasses = this.host.protectedClasses();
    const classes = this.host.classifications();
    const inside = pointsInCuboid(data, object.box);
    return classes && protectedClasses.size > 0
      ? inside.filter((i) => !protectedClasses.has(classes[i]))
      : inside;
  }

  private renderList(): void {
    this.list.replaceChildren();
    if (!this.host.session()) return;
    const tr = this.host.tr;
    for (const object of this.objects()) {
      const row = document.createElement("div");
      row.dataset.box = String(object.id);
      row.style.cssText = `display:flex;flex-direction:column;gap:4px;padding:4px;border-radius:4px;border:1px solid ${
        object.id === this.selectedId ? "hsl(var(--primary))" : "hsl(var(--border))"
      };`;
      const title = document.createElement("button");
      title.type = "button";
      title.style.cssText =
        "display:flex;gap:6px;align-items:center;border:0;background:transparent;color:inherit;cursor:pointer;padding:0;text-align:start;";
      const [r, g, b] = classDefinition(object.classCode).color;
      title.innerHTML = "";
      const swatch = document.createElement("span");
      swatch.style.cssText = `width:10px;height:10px;border-radius:2px;background:rgb(${r},${g},${b});flex:none;`;
      const label = document.createElement("span");
      label.textContent = `#${object.id} · ${object.box.size.map((v) => v.toFixed(1)).join(" × ")} m`;
      title.append(swatch, label);
      title.title = tr("editBox", "Edit in the side views");
      title.addEventListener("click", () => this.select(object.id));
      const classSelect = document.createElement("select");
      classSelect.style.cssText =
        "padding:4px;border:1px solid hsl(var(--border));border-radius:4px;background:hsl(var(--background));min-width:0;";
      classSelect.style.setProperty("color", "hsl(var(--foreground))", "important");
      for (const entry of assignableClasses()) {
        classSelect.append(
          new Option(`${entry.code} · ${this.host.className(entry.code)}`, String(entry.code)),
        );
      }
      classSelect.value = String(object.classCode);
      classSelect.setAttribute("aria-label", tr("boxClass", "Box class"));
      classSelect.addEventListener("change", () => {
        object.classCode = Number(classSelect.value);
        this.host.changed();
        this.render();
      });
      const statusSelect = document.createElement("select");
      statusSelect.style.cssText = classSelect.style.cssText;
      statusSelect.dataset.status = String(object.id);
      for (const status of OBJECT_STATUSES) {
        statusSelect.append(new Option(this.statusLabel(status), status));
      }
      statusSelect.value = object.status;
      statusSelect.setAttribute("aria-label", tr("boxStatus", "Review status"));
      statusSelect.addEventListener("change", () => {
        object.status = parseStatus(statusSelect.value);
        this.host.changed();
        this.renderList();
      });
      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;";
      const action = (key: string, fallback: string, onClick: () => void) => {
        const node = document.createElement("button");
        node.type = "button";
        node.textContent = tr(key, fallback);
        node.dataset.action = key;
        node.style.cssText =
          "padding:2px 6px;border:1px solid hsl(var(--border));border-radius:4px;background:transparent;color:inherit;cursor:pointer;font-size:11px;";
        node.addEventListener("click", onClick);
        actions.append(node);
      };
      action("selectInBox", "Select points", () => this.host.setSelection(this.pointsIn(object)));
      action("assignInBox", "Assign class to points", () => {
        this.host.assignClass(this.pointsIn(object), object.classCode);
      });
      action("deleteBox", "Delete", () => this.remove(object.id));
      row.append(title, classSelect, statusSelect, this.attributesEditor(object), actions);
      this.list.append(row);
    }
    const hasBoxes = this.objects().length > 0;
    this.exportGeoJson.disabled = !hasBoxes;
    this.exportSegments.disabled = !hasBoxes;
  }

  private statusLabel(status: ObjectStatus): string {
    const tr = this.host.tr;
    if (status === "reviewed") return tr("statusReviewed", "Reviewed");
    if (status === "flagged") return tr("statusFlagged", "Flagged");
    return tr("statusNew", "New");
  }

  /** A collapsible name/value editor for one box's attributes. */
  private attributesEditor(object: CuboidObject): HTMLElement {
    const tr = this.host.tr;
    const details = document.createElement("details");
    details.dataset.attributes = String(object.id);
    // Stay open across re-renders while the user is editing.
    details.open = this.openAttributes.has(object.id);
    details.addEventListener("toggle", () => {
      if (details.open) this.openAttributes.add(object.id);
      else this.openAttributes.delete(object.id);
    });
    const summary = document.createElement("summary");
    summary.style.cssText = "cursor:pointer;font-size:11px;";
    const entries = Object.entries(object.attributes);
    summary.textContent = tr("boxAttributes", "Attributes ({{count}})", { count: entries.length });
    details.append(summary);
    const inputStyle =
      "padding:3px;border:1px solid hsl(var(--border));border-radius:4px;background:transparent;color:inherit;min-width:0;flex:1;font-size:11px;";
    const small =
      "padding:2px 6px;border:1px solid hsl(var(--border));border-radius:4px;background:transparent;color:inherit;cursor:pointer;font-size:11px;";
    for (const [key, value] of entries) {
      const line = document.createElement("div");
      line.style.cssText = "display:flex;gap:4px;align-items:center;margin-top:3px;";
      line.dataset.attribute = key;
      const name = document.createElement("span");
      name.textContent = key;
      name.style.cssText = "font-weight:600;font-size:11px;max-width:40%;overflow-wrap:anywhere;";
      const input = document.createElement("input");
      input.type = "text";
      input.value = value;
      input.maxLength = MAX_ATTRIBUTE_VALUE;
      input.style.cssText = inputStyle;
      input.setAttribute("aria-label", key);
      input.addEventListener("change", () => {
        object.attributes[key] = clipText(input.value, MAX_ATTRIBUTE_VALUE);
        this.host.changed();
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = tr("attributeRemove", "Remove");
      remove.style.cssText = small;
      remove.addEventListener("click", () => {
        delete object.attributes[key];
        this.host.changed();
        this.renderList();
      });
      line.append(name, input, remove);
      details.append(line);
    }
    const add = document.createElement("div");
    add.style.cssText = "display:flex;gap:4px;align-items:center;margin-top:3px;";
    const keyInput = document.createElement("input");
    keyInput.type = "text";
    keyInput.maxLength = MAX_ATTRIBUTE_KEY;
    keyInput.placeholder = tr("attributeName", "Name");
    keyInput.setAttribute("aria-label", keyInput.placeholder);
    keyInput.dataset.attributeKey = String(object.id);
    keyInput.style.cssText = inputStyle;
    const valueInput = document.createElement("input");
    valueInput.type = "text";
    valueInput.maxLength = MAX_ATTRIBUTE_VALUE;
    valueInput.placeholder = tr("attributeValue", "Value");
    valueInput.setAttribute("aria-label", valueInput.placeholder);
    valueInput.dataset.attributeValue = String(object.id);
    valueInput.style.cssText = inputStyle;
    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.textContent = tr("attributeAdd", "Add");
    addButton.dataset.attributeAdd = String(object.id);
    addButton.style.cssText = small;
    addButton.addEventListener("click", () => {
      const key = clipText(keyInput.value.trim(), MAX_ATTRIBUTE_KEY);
      // Own keys only: `key in` would also match Object.prototype names.
      const full =
        !Object.hasOwn(object.attributes, key) &&
        Object.keys(object.attributes).length >= MAX_OBJECT_ATTRIBUTES;
      if (RESERVED_ATTRIBUTE_NAMES.has(key)) {
        this.host.setStatus(
          tr("attributeReserved", "{{name}} is a built-in box property; choose another name.", {
            name: key,
          }),
        );
        return;
      }
      if (!key || key === "__proto__" || full) {
        this.host.setStatus(
          tr("attributeInvalid", "Give the attribute a name (at most {{count}} per box).", {
            count: MAX_OBJECT_ATTRIBUTES,
          }),
        );
        return;
      }
      this.host.changed();
      object.attributes = {
        ...object.attributes,
        [key]: clipText(valueInput.value, MAX_ATTRIBUTE_VALUE),
      };
      this.renderList();
    });
    add.append(keyInput, valueInput, addButton);
    details.append(add);
    return details;
  }

  private renderMap(): void {
    const ctl = this.host.control();
    const overlay = ctl?.getDeckOverlay();
    if (!ctl || !overlay) return;
    const objects = this.host.session() ? this.objects() : [];
    if (objects.length === 0) {
      overlay.removeLayer(LAYER_ID);
      return;
    }
    const zOffset = getRenderZOffset(ctl);
    const edges: { source: number[]; target: number[]; color: number[] }[] = [];
    for (const object of objects) {
      const corners = cuboidCorners(object.box).map(([lng, lat, z]) => [lng, lat, z + zOffset]);
      const color =
        object.id === this.selectedId
          ? [250, 204, 21, 255]
          : [...classDefinition(object.classCode).color, 255];
      for (const [a, b] of CUBOID_EDGES)
        edges.push({ source: corners[a], target: corners[b], color });
    }
    overlay.addLayer(
      LAYER_ID,
      new LineLayer({
        id: LAYER_ID,
        data: edges,
        getSourcePosition: (d: { source: number[] }) => d.source as [number, number, number],
        getTargetPosition: (d: { target: number[] }) => d.target as [number, number, number],
        getColor: (d: { color: number[] }) => d.color as [number, number, number, number],
        getWidth: 2,
        widthUnits: "pixels",
        // Like the selection highlight: stay visible through the points.
        parameters: { depthTest: false } as Record<string, unknown>,
      }),
      { overlay: true },
    );
  }

  private openViews(): void {
    const app = this.host.app;
    if (!this.unregisterViews && app.registerFloatingPanel) {
      this.unregisterViews = app.registerFloatingPanel({
        id: VIEWS_PANEL_ID,
        title: () => this.host.tr("sideViews", "Box views (top · side · front)"),
        defaultWidth: 720,
        defaultHeight: 280,
        position: "bottom-left",
        render: (container) => {
          const host = document.createElement("div");
          host.style.cssText = "height:100%;min-height:180px;padding:4px;box-sizing:border-box;";
          host.dataset.testid = "pc-annotation-box-views";
          container.append(host);
          this.views = new ObjectViews(
            host,
            {
              onChange: (box) => this.onDrag(box),
              onCommit: () => this.render(),
            },
            {
              top: this.host.tr("viewTop", "Top"),
              side: this.host.tr("viewSide", "Side"),
              front: this.host.tr("viewFront", "Front"),
            },
          );
          // Wait a frame for the card to lay out before sizing the views.
          requestAnimationFrame(() => this.renderViews(true));
          return () => {
            this.views?.destroy();
            this.views = null;
          };
        },
        onClose: () => {
          this.selectedId = null;
          this.renderList();
          this.renderMap();
        },
      });
    }
    app.openFloatingPanel?.(VIEWS_PANEL_ID);
  }

  /**
   * Keyboard nudges for the selected box: arrows move it 10 cm along the map
   * axes (1 m with Shift), Q / E rotate it by 1 degree (5 with Shift), and
   * + / - raise or lower its top by 10 cm.
   *
   * @param event - The key event.
   * @returns True when the key edited the box (the caller stops it).
   */
  handleKey(event: KeyboardEvent): boolean {
    const object = this.selected();
    if (!object) return false;
    const step = event.shiftKey ? 1 : 0.1;
    const box = object.box;
    const frame = localFrame(box.center[1]);
    // Moves along the map axes (east/north), independent of the heading.
    const move = (east: number, north: number): typeof box => ({
      ...box,
      center: [box.center[0] + east / frame.mx, box.center[1] + north / frame.my, box.center[2]],
    });
    let next: typeof box | null = null;
    switch (event.key) {
      case "ArrowUp":
        next = move(0, step);
        break;
      case "ArrowDown":
        next = move(0, -step);
        break;
      case "ArrowLeft":
        next = move(-step, 0);
        break;
      case "ArrowRight":
        next = move(step, 0);
        break;
      case "q":
      case "Q":
      case "e":
      case "E": {
        const degrees = (event.shiftKey ? 5 : 1) * (event.key.toLowerCase() === "q" ? 1 : -1);
        const yaw = box.yaw + (degrees * Math.PI) / 180;
        next = { ...box, yaw: Math.atan2(Math.sin(yaw), Math.cos(yaw)) };
        break;
      }
      case "+":
      case "=":
      case "-": {
        const delta = event.key === "-" ? -0.1 : 0.1;
        const height = Math.max(0.05, box.size[2] + delta);
        const grown = height - box.size[2];
        next = {
          ...box,
          size: [box.size[0], box.size[1], height],
          center: [box.center[0], box.center[1], box.center[2] + grown / 2],
        };
        break;
      }
      default:
        return false;
    }
    object.box = next;
    this.host.changed();
    this.render();
    return true;
  }

  private selected(): CuboidObject | undefined {
    return this.objects().find((object) => object.id === this.selectedId);
  }

  private onDrag(box: Cuboid): void {
    const object = this.selected();
    if (!object) return;
    object.box = box;
    this.host.changed();
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderMap();
      this.renderViews(false);
    });
  }

  private renderViews(refit: boolean): void {
    const object = this.selected();
    const data = this.host.data();
    if (!this.views) return;
    if (!object || !data) {
      this.views.update(null, null);
      return;
    }
    const classes = this.host.classifications();
    const nearby = pointsInCuboid(data, object.box, VIEW_MARGIN);
    const points = boxFramePoints(
      object.box,
      data.positions,
      data.coordinateOrigin,
      nearby,
      (i) => classDefinition(classes?.[i] ?? 1).color,
    );
    this.views.update(object.box, points, refit);
  }

  private exportAs(format: "geojson" | "segments"): void {
    const session = this.host.session();
    const objects = this.objects();
    if (!session || objects.length === 0) return;
    const stem = safeFileStem(session.cloudName);
    if (format === "geojson") {
      this.host.exportText(
        `${stem}-boxes.geojson`,
        JSON.stringify(cuboidsToGeoJson(objects, this.host.className)),
      );
    } else {
      this.host.exportText(
        `${stem}-cuboids-segments-label.json`,
        JSON.stringify(cuboidsToSegments(objects, session.wkt)),
      );
    }
    this.host.setStatus(
      this.host.tr("exportedBoxes", "Exported {{count}} boxes.", { count: objects.length }),
    );
  }
}
