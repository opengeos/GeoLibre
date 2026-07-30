import {
  DEFAULT_LAYER_STYLE,
  createEmptyProject,
  type GeoLibreLayer,
  type GeoLibreProject,
  type LayerGroup,
  type LayerStyle,
  type MapViewState,
} from "@geolibre/core";
import { strFromU8, unzipSync } from "fflate";

export interface QgisProjectImportWarning {
  layerName: string;
  reason: "non-vector" | "provider" | "missing-source" | "format" | "browser-local-file";
  provider?: string;
}

export interface QgisProjectImportResult {
  project: GeoLibreProject;
  warnings: QgisProjectImportWarning[];
}

const SUPPORTED_VECTOR_EXTENSIONS = new Set([
  "csv",
  "dxf",
  "fgb",
  "flatgeobuf",
  "geojson",
  "geoparquet",
  "gml",
  "gpkg",
  "gpx",
  "json",
  "kml",
  "kmz",
  "parquet",
  "shp",
  "tab",
  "tsv",
  "zip",
]);

/** Convert a QGIS project into a GeoLibre project without evaluating QGIS code. */
export function importQgisProject(
  data: ArrayBuffer | Uint8Array | string,
  sourcePath: string,
): QgisProjectImportResult {
  const xml = qgisProjectXml(data, sourcePath);
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (document.querySelector("parsererror") || document.documentElement.tagName !== "qgis") {
    throw new Error("This file is not a valid QGIS project.");
  }

  const projectName =
    text(document.querySelector("title")) || fileStem(sourcePath) || "Imported QGIS Project";
  const project = createEmptyProject(projectName, { mapView: parseMapView(document) });
  const groups = parseLayerGroups(document);
  const groupByLayerId = layerGroupAssignments(document, groups);
  const visibilityByLayerId = layerVisibility(document);
  const mapLayers = Array.from(document.querySelectorAll("projectlayers > maplayer"));
  const byId = new Map(
    mapLayers.map((element) => [text(element.querySelector(":scope > id")), element]),
  );
  const warnings: QgisProjectImportWarning[] = [];
  const layers: GeoLibreLayer[] = [];

  for (const id of layerOrder(document, mapLayers)) {
    const element = byId.get(id);
    if (!element) continue;
    const name = text(element.querySelector(":scope > layername")) || id || "QGIS layer";
    const provider = text(element.querySelector(":scope > provider")).toLowerCase();
    const source = qgisVectorSource(text(element.querySelector(":scope > datasource")), sourcePath);

    if (!isSupportedVectorLayer(element, provider, source)) {
      warnings.push({
        layerName: name,
        reason: unsupportedReason(element, provider, source),
        ...(provider ? { provider } : {}),
      });
      continue;
    }

    layers.push({
      id: uniqueLayerId(id, layers),
      name,
      type: "geojson",
      source: { type: "geojson" },
      visible: visibilityByLayerId.get(id) ?? true,
      opacity: parseOpacity(element),
      style: parseLayerStyle(element),
      metadata: {
        localFileReloadable: true,
        importedFrom: "qgis",
        qgisLayerId: id,
        qgisProvider: provider,
      },
      sourcePath: source,
      ...(groupByLayerId.get(id) ? { groupId: groupByLayerId.get(id) } : {}),
    });
  }

  project.layers = layers;
  project.layerGroups = groups.filter((group) =>
    layers.some((layer) => layer.groupId === group.id),
  );
  project.metadata = {
    importedFrom: "qgis",
    qgisProjectPath: sourcePath,
    qgisVersion: document.documentElement.getAttribute("version") ?? "",
  };
  return { project, warnings };
}

function qgisProjectXml(data: ArrayBuffer | Uint8Array | string, sourcePath: string): string {
  if (typeof data === "string") return data;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (sourcePath.toLowerCase().endsWith(".qgs")) return strFromU8(bytes);
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error("Could not read the compressed QGIS project.");
  }
  const qgsName = Object.keys(entries).find((name) => name.toLowerCase().endsWith(".qgs"));
  if (!qgsName) throw new Error("The QGZ archive does not contain a QGS project file.");
  return strFromU8(entries[qgsName]);
}

function parseMapView(document: Document): MapViewState {
  const extent =
    document.querySelector("mapcanvas > extent") ??
    document.querySelector("projectviewsettings extent");
  const xmin = numberText(extent?.querySelector("xmin"));
  const ymin = numberText(extent?.querySelector("ymin"));
  const xmax = numberText(extent?.querySelector("xmax"));
  const ymax = numberText(extent?.querySelector("ymax"));
  const authId =
    text(document.querySelector("mapcanvas > destinationsrs authid")) ||
    text(document.querySelector("projectCrs authid"));
  if ([xmin, ymin, xmax, ymax].every(Number.isFinite)) {
    const [west, south] = toWgs84(xmin, ymin, authId);
    const [east, north] = toWgs84(xmax, ymax, authId);
    if ([west, south, east, north].every(Number.isFinite)) {
      return {
        center: [(west + east) / 2, (south + north) / 2],
        zoom: zoomForBounds(west, south, east, north),
        bearing: 0,
        pitch: 0,
        bbox: [west, south, east, north],
      };
    }
  }
  return { center: [-100, 40], zoom: 2, bearing: 0, pitch: 0 };
}

function toWgs84(x: number, y: number, authId: string): [number, number] {
  if (authId.toUpperCase() !== "EPSG:3857") return [x, y];
  return [
    (x / 20037508.34) * 180,
    (180 / Math.PI) * (2 * Math.atan(Math.exp((y / 20037508.34) * Math.PI)) - Math.PI / 2),
  ];
}

function zoomForBounds(west: number, south: number, east: number, north: number): number {
  const span = Math.max(Math.abs(east - west), Math.abs(north - south) * 2, 0.000001);
  return Math.max(0, Math.min(20, Math.log2(360 / span) - 0.75));
}

function parseLayerGroups(document: Document): LayerGroup[] {
  const root = document.querySelector("layer-tree-group");
  if (!root) return [];
  return Array.from(root.children)
    .filter((element) => element.tagName === "layer-tree-group")
    .map((element, index) => ({
      id: `qgis-group-${index}-${slug(element.getAttribute("name") ?? "group")}`,
      name: element.getAttribute("name") || "Group",
      collapsed: element.getAttribute("expanded") === "0",
      visible: element.getAttribute("checked") !== "Qt::Unchecked",
      opacity: 1,
    }));
}

function layerGroupAssignments(document: Document, groups: LayerGroup[]): Map<string, string> {
  const assignments = new Map<string, string>();
  const root = document.querySelector("layer-tree-group");
  if (!root) return assignments;
  Array.from(root.children)
    .filter((element) => element.tagName === "layer-tree-group")
    .forEach((element, index) => {
      const group = groups[index];
      if (!group) return;
      element.querySelectorAll("layer-tree-layer[id]").forEach((layer) => {
        const id = layer.getAttribute("id");
        if (id) assignments.set(id, group.id);
      });
    });
  return assignments;
}

function layerVisibility(document: Document): Map<string, boolean> {
  const result = new Map<string, boolean>();
  document.querySelectorAll("layer-tree-layer[id]").forEach((element) => {
    const id = element.getAttribute("id");
    if (id) result.set(id, element.getAttribute("checked") !== "Qt::Unchecked");
  });
  return result;
}

function layerOrder(document: Document, mapLayers: Element[]): string[] {
  const ids = Array.from(document.querySelectorAll("layer-tree-layer[id]"))
    .map((element) => element.getAttribute("id") ?? "")
    .filter(Boolean);
  if (ids.length > 0) return ids.reverse();
  return mapLayers
    .map((element) => text(element.querySelector(":scope > id")))
    .filter(Boolean)
    .reverse();
}

function qgisVectorSource(dataSource: string, projectPath: string): string {
  let source = dataSource.split("|", 1)[0]?.trim() ?? "";
  if (source.startsWith("file://")) {
    try {
      source = decodeURIComponent(new URL(source).pathname);
    } catch {
      source = source.slice("file://".length);
    }
  }
  source = source.replace(/^['"]|['"]$/g, "");
  if (!source || isAbsolutePath(source) || /^[a-z]+:\/\//i.test(source)) return source;
  const directory = projectPath.replace(/[/\\][^/\\]*$/, "");
  return normalizeJoinedPath(directory, source);
}

function normalizeJoinedPath(directory: string, relative: string): string {
  const separator = directory.includes("\\") ? "\\" : "/";
  const absolute = directory.startsWith("/");
  const parts = [
    ...directory.replace(/\\/g, "/").split("/"),
    ...relative.replace(/\\/g, "/").split("/"),
  ];
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  return `${absolute ? "/" : ""}${normalized.join(separator)}`;
}

function isSupportedVectorLayer(element: Element, provider: string, source: string): boolean {
  const extension = source.split(/[?#]/, 1)[0]?.split(".").pop()?.toLowerCase() ?? "";
  return (
    element.getAttribute("type")?.toLowerCase() === "vector" &&
    (provider === "ogr" || provider === "delimitedtext") &&
    SUPPORTED_VECTOR_EXTENSIONS.has(extension)
  );
}

function unsupportedReason(
  element: Element,
  provider: string,
  source: string,
): QgisProjectImportWarning["reason"] {
  if (element.getAttribute("type")?.toLowerCase() !== "vector") {
    return "non-vector";
  }
  if (provider !== "ogr" && provider !== "delimitedtext") {
    return "provider";
  }
  if (!source) return "missing-source";
  return "format";
}

function parseLayerStyle(element: Element): LayerStyle {
  const style: LayerStyle = structuredClone(DEFAULT_LAYER_STYLE);
  const symbolLayer = element.querySelector("renderer-v2 symbols symbol layer");
  const options = new Map<string, string>();
  symbolLayer?.querySelectorAll("Option[name]").forEach((option) => {
    options.set(option.getAttribute("name") ?? "", option.getAttribute("value") ?? "");
  });
  const fill = qgisColor(options.get("color"));
  const stroke = qgisColor(options.get("outline_color") ?? options.get("line_color"));
  if (fill) {
    style.fillColor = fill.color;
    style.fillOpacity = fill.opacity;
    style.markerColor = fill.color;
  }
  if (stroke) {
    style.strokeColor = stroke.color;
  }
  const width = optionalNumber(options.get("outline_width") ?? options.get("line_width"));
  if (width !== null) style.strokeWidth = Math.max(0, width * 3.78);
  const size = optionalNumber(options.get("size"));
  if (symbolLayer?.getAttribute("class") === "SimpleMarker" && size !== null) {
    style.circleRadius = Math.max(1, (size * 3.78) / 2);
  }
  const textStyle = element.querySelector("labeling[type='simple'] settings text-style");
  const field = textStyle?.getAttribute("fieldName")?.trim();
  if (field) {
    style.labels.enabled = true;
    style.labels.field = field;
    const color = qgisColor(textStyle?.getAttribute("textColor") ?? undefined);
    if (color) style.labels.color = color.color;
    const sizeValue = optionalNumber(textStyle?.getAttribute("fontSize") ?? undefined);
    if (sizeValue !== null) style.labels.size = sizeValue;
  }
  return style;
}

function qgisColor(value: string | undefined): { color: string; opacity: number } | null {
  if (!value) return null;
  const parts = value.split(",").map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null;
  const [red, green, blue, alpha = 255] = parts;
  return {
    color: `#${[red, green, blue]
      .map((part) =>
        Math.max(0, Math.min(255, Math.round(part)))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`,
    opacity: Math.max(0, Math.min(1, alpha / 255)),
  };
}

function parseOpacity(element: Element): number {
  const value = optionalNumber(text(element.querySelector(":scope > layerOpacity")));
  return value !== null ? Math.max(0, Math.min(1, value)) : 1;
}

function optionalNumber(value: string | undefined): number | null {
  if (value == null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function uniqueLayerId(candidate: string, layers: GeoLibreLayer[]): string {
  const base = candidate.trim() || `qgis-layer-${layers.length + 1}`;
  let id = base;
  let suffix = 2;
  while (layers.some((layer) => layer.id === id)) id = `${base}-${suffix++}`;
  return id;
}

function numberText(element: Element | null | undefined): number {
  return Number(text(element));
}

function text(element: Element | null | undefined): string {
  return element?.textContent?.trim() ?? "";
}

function fileStem(path: string): string {
  return (
    path
      .split(/[/\\]/)
      .pop()
      ?.replace(/\.(qgz|qgs)$/i, "") ?? ""
  );
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[/\\]/.test(path);
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "group"
  );
}
