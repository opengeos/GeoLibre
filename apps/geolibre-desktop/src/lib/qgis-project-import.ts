import {
  DEFAULT_BASEMAP,
  DEFAULT_LAYER_STYLE,
  VECTOR_COLOR_RAMPS,
  createEmptyProject,
  type GeoLibreLayer,
  type GeoLibreProject,
  type LayerGroup,
  type LayerStyle,
  type MapViewState,
} from "@geolibre/core";
import { strFromU8, unzipSync } from "fflate";
import type { FeatureCollection } from "geojson";

export interface QgisProjectImportWarning {
  layerName: string;
  reason:
    | "non-vector"
    | "provider"
    | "missing-source"
    | "format"
    | "remote-file"
    | "network-path"
    | "browser-local-file"
    | "browser-local-raster";
  provider?: string;
}

export interface QgisProjectImportResult {
  project: GeoLibreProject;
  rasters: QgisRasterImport[];
  warnings: QgisProjectImportWarning[];
}

export interface QgisRasterImport {
  id: string;
  name: string;
  sourcePath: string;
  visible: boolean;
  opacity: number;
  groupId?: string;
  beforeId?: string;
  state?: {
    mode: "single";
    bands: number[];
    colormap: string;
    gamma: number;
    rescale: [number, number][] | null;
    reversed: boolean;
  };
}

const MAX_QGS_BYTES = 25 * 1024 * 1024;
const REMOTE_FETCH_CONCURRENCY = 4;
const REMOTE_FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetch remote GeoJSON sources referenced by a parsed QGIS project.
 *
 * QGIS commonly stores HTTP-backed OGR layers behind GDAL's `/vsicurl/`
 * prefix. The synchronous parser normalizes that prefix to an HTTP URL; this
 * step materializes those features before the project enters the store because
 * GeoLibre's GeoJSON renderer consumes an in-memory FeatureCollection.
 */
export async function materializeQgisRemoteLayers(
  result: QgisProjectImportResult,
  fetcher: typeof fetch = fetch,
): Promise<QgisProjectImportResult> {
  const failedLayerIds = new Set<string>();
  const remoteLayers = result.project.layers.filter(
    (layer) => layer.sourcePath && isHttpSource(layer.sourcePath),
  );
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < remoteLayers.length) {
      const layer = remoteLayers[nextIndex++];
      const sourcePath = layer.sourcePath;
      if (!sourcePath) continue;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REMOTE_FETCH_TIMEOUT_MS);
      try {
        const response = await fetcher(sourcePath, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as unknown;
        if (!isFeatureCollection(data))
          throw new Error("Response is not a GeoJSON FeatureCollection");
        layer.geojson = data;
      } catch {
        failedLayerIds.add(layer.id);
        result.warnings.push({
          layerName: layer.name,
          reason: "remote-file",
        });
      } finally {
        clearTimeout(timeout);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(REMOTE_FETCH_CONCURRENCY, remoteLayers.length) }, () => worker()),
  );
  if (failedLayerIds.size > 0) {
    result.project.layers = result.project.layers.filter((layer) => !failedLayerIds.has(layer.id));
    const usedGroupIds = new Set(
      result.project.layers.flatMap((layer) => (layer.groupId ? [layer.groupId] : [])),
    );
    result.project.layerGroups = result.project.layerGroups?.filter((group) =>
      usedGroupIds.has(group.id),
    );
  }
  return result;
}

// SYNC: VECTOR_FILE_DIALOG_EXTENSIONS in tauri-io.ts and
// RESTORABLE_VECTOR_EXTENSIONS in src-tauri/src/lib.rs.
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
const SUPPORTED_RASTER_EXTENSIONS = new Set(["tif", "tiff"]);

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
  const project = createEmptyProject(projectName, {
    mapView: parseMapView(document),
  });
  const parsedGroups = parseLayerGroups(document);
  const groupByLayerId = layerGroupAssignments(document, parsedGroups.ids);
  const visibilityByLayerId = layerVisibility(document);
  const mapLayers = Array.from(document.querySelectorAll("projectlayers > maplayer"));
  const byId = new Map(
    mapLayers.map((element) => [text(element.querySelector(":scope > id")), element]),
  );
  const warnings: QgisProjectImportWarning[] = [];
  const layers: GeoLibreLayer[] = [];
  const rasters: QgisRasterImport[] = [];

  for (const id of layerOrder(document, mapLayers)) {
    const element = byId.get(id);
    if (!element) continue;
    const name = text(element.querySelector(":scope > layername")) || id || "QGIS layer";
    const provider = text(element.querySelector(":scope > provider")).toLowerCase();
    const dataSource = text(element.querySelector(":scope > datasource"));

    if (
      isOpenStreetMapBasemap(element, provider, dataSource) &&
      !groupByLayerId.has(id) &&
      id === layerOrder(document, mapLayers)[0]
    ) {
      project.basemapStyleUrl = DEFAULT_BASEMAP;
      project.basemapVisible = visibilityByLayerId.get(id) ?? true;
      project.basemapOpacity = parseOpacity(element);
      continue;
    }

    const source = qgisSourcePath(dataSource, sourcePath);

    if (isSupportedRasterLayer(element, provider, source)) {
      const state = parseRasterState(element);
      rasters.push({
        id,
        name,
        sourcePath: source,
        visible: visibilityByLayerId.get(id) ?? true,
        opacity: parseOpacity(element),
        ...(groupByLayerId.get(id) ? { groupId: groupByLayerId.get(id) } : {}),
        ...(nextLayerId(id, layerOrder(document, mapLayers))
          ? { beforeId: nextLayerId(id, layerOrder(document, mapLayers)) }
          : {}),
        ...(state ? { state } : {}),
      });
      continue;
    }

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
      source: {
        type: "geojson",
        ...(isHttpSource(source) ? { url: source } : {}),
      },
      visible: visibilityByLayerId.get(id) ?? true,
      opacity: parseOpacity(element),
      style: parseLayerStyle(element),
      metadata: {
        ...(!isHttpSource(source) ? { localFileReloadable: true } : {}),
        importedFrom: "qgis",
        qgisLayerId: id,
        qgisProvider: provider,
      },
      sourcePath: source,
      ...(groupByLayerId.get(id) ? { groupId: groupByLayerId.get(id) } : {}),
    });
  }

  project.layers = layers;
  project.layerGroups = parsedGroups.groups.filter(
    (group) =>
      layers.some((layer) => layer.groupId === group.id) ||
      rasters.some((raster) => raster.groupId === group.id),
  );
  project.metadata = {
    importedFrom: "qgis",
    qgisProjectPath: sourcePath,
    qgisVersion: document.documentElement.getAttribute("version") ?? "",
  };
  return { project, rasters, warnings };
}

function parseRasterState(element: Element): QgisRasterImport["state"] {
  const renderer = element.querySelector(":scope > pipe > rasterrenderer");
  if (!renderer) return undefined;
  const type = renderer.getAttribute("type")?.toLowerCase();
  if (type !== "singlebandpseudocolor" && type !== "singlebandgray") return undefined;

  const band = positiveInteger(renderer.getAttribute("band")) ?? 1;
  const shader = renderer.querySelector("rastershader > colorrampshader");
  const minimum = numberAttribute(shader, "minimumValue");
  const maximum = numberAttribute(shader, "maximumValue");
  const ramp = shader?.querySelector(":scope > colorramp");
  const first = qgisRampColor(ramp, "color1");
  const last = qgisRampColor(ramp, "color2");
  const matched = matchBuiltInColorRamp(first, last);
  const gamma =
    numberAttribute(element.querySelector(":scope > pipe > brightnesscontrast"), "gamma") ?? 1;

  return {
    mode: "single",
    bands: [band],
    colormap: type === "singlebandgray" ? "gray" : (matched?.colormap ?? "viridis"),
    gamma: gamma > 0 ? gamma : 1,
    rescale:
      Number.isFinite(minimum) && Number.isFinite(maximum) && minimum < maximum
        ? [[minimum, maximum]]
        : null,
    reversed: matched?.reversed ?? false,
  };
}

function qgisRampColor(ramp: Element | null | undefined, name: string): string | null {
  const option = Array.from(ramp?.querySelectorAll("Option") ?? []).find(
    (candidate) => candidate.getAttribute("name") === name,
  );
  const channels = option?.getAttribute("value")?.split(",", 3).map(Number);
  if (!channels || channels.length !== 3 || channels.some((value) => !Number.isFinite(value))) {
    return null;
  }
  return `#${channels
    .map((value) =>
      Math.max(0, Math.min(255, Math.round(value)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function matchBuiltInColorRamp(
  first: string | null,
  last: string | null,
): { colormap: string; reversed: boolean } | null {
  if (!first || !last) return null;
  for (const ramp of VECTOR_COLOR_RAMPS) {
    const start = ramp.colors[0].toLowerCase();
    const end = ramp.colors[ramp.colors.length - 1].toLowerCase();
    if (first === start && last === end) return { colormap: ramp.value, reversed: false };
    if (first === end && last === start) return { colormap: ramp.value, reversed: true };
  }
  return null;
}

function positiveInteger(value: string | null): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function numberAttribute(element: Element | null | undefined, name: string): number {
  const raw = element?.getAttribute(name);
  if (raw == null || raw.trim() === "") return Number.NaN;
  const value = Number(raw);
  return Number.isFinite(value) ? value : Number.NaN;
}

function qgisProjectXml(data: ArrayBuffer | Uint8Array | string, sourcePath: string): string {
  if (typeof data === "string") {
    if (new TextEncoder().encode(data).byteLength > MAX_QGS_BYTES) {
      throw new Error("The QGIS project is too large to import safely.");
    }
    return data;
  }
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (sourcePath.toLowerCase().endsWith(".qgs")) return strFromU8(bytes);
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (entry) => {
        if (entry.originalSize > MAX_QGS_BYTES) {
          throw new Error("The QGIS project is too large to import safely.");
        }
        return entry.name.toLowerCase().endsWith(".qgs");
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("too large to import safely")) throw error;
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
    const southwest = toWgs84(xmin, ymin, authId);
    const northeast = toWgs84(xmax, ymax, authId);
    if (southwest && northeast) {
      const [west, south] = southwest;
      const [east, north] = northeast;
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

function toWgs84(x: number, y: number, authId: string): [number, number] | null {
  const normalized = authId.toUpperCase();
  if (normalized === "EPSG:4326" || normalized === "CRS:84") return [x, y];
  if (normalized === "EPSG:3857") {
    return [
      (x / 20037508.34) * 180,
      (180 / Math.PI) * (2 * Math.atan(Math.exp((y / 20037508.34) * Math.PI)) - Math.PI / 2),
    ];
  }
  return null;
}

function zoomForBounds(west: number, south: number, east: number, north: number): number {
  const span = Math.max(Math.abs(east - west), Math.abs(north - south) * 2, 0.000001);
  return Math.max(0, Math.min(20, Math.log2(360 / span) - 0.75));
}

function parseLayerGroups(document: Document): {
  groups: LayerGroup[];
  ids: Map<Element, string>;
} {
  const root = document.querySelector("layer-tree-group");
  if (!root) return { groups: [], ids: new Map() };
  const ids = new Map<Element, string>();
  const groups = Array.from(root.querySelectorAll("layer-tree-group")).map((element, index) => {
    const name = groupDisplayName(element, root);
    const id = `qgis-group-${index}-${slug(name)}`;
    ids.set(element, id);
    return {
      id,
      name,
      collapsed: element.getAttribute("expanded") === "0",
      visible: qgisGroupVisible(element, root),
      opacity: 1,
    };
  });
  return { groups, ids };
}

function qgisGroupVisible(element: Element, root: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (current.getAttribute("checked") === "Qt::Unchecked") return false;
    if (current === root) break;
    current = current.parentElement?.closest("layer-tree-group") ?? null;
  }
  return true;
}

function groupDisplayName(element: Element, root: Element): string {
  const names: string[] = [];
  let current: Element | null = element;
  while (current && current !== root) {
    const name = current.getAttribute("name")?.trim();
    if (name) names.unshift(name);
    current = current.parentElement?.closest("layer-tree-group") ?? null;
  }
  return names.join(" / ") || "Group";
}

function layerGroupAssignments(document: Document, ids: Map<Element, string>): Map<string, string> {
  const assignments = new Map<string, string>();
  document.querySelectorAll("layer-tree-layer[id]").forEach((layer) => {
    const layerId = layer.getAttribute("id");
    const parentGroup = layer.parentElement?.closest("layer-tree-group");
    const groupId = parentGroup ? ids.get(parentGroup) : undefined;
    if (layerId && groupId) assignments.set(layerId, groupId);
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

function qgisSourcePath(dataSource: string, projectPath: string): string {
  let source = dataSource.split("|", 1)[0]?.trim() ?? "";
  source = source.replace(/^['"]|['"]$/g, "");
  source = source.replace(/^\/vsicurl(?:_streaming)?\//i, "");
  if (/^\/?vsizip\//i.test(source)) return "";
  if (/^file:\/\//i.test(source)) {
    try {
      const url = new URL(source);
      const path = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, "$1");
      source =
        url.hostname && url.hostname.toLowerCase() !== "localhost"
          ? `//${url.hostname}${path}`
          : path;
    } catch {
      const path = source.replace(/^file:\/\//i, "");
      source = path.startsWith("/") ? path : `//${path}`;
    }
  }
  source = source.replace(/^file:(?:\/\/)?/i, "");
  if (!isHttpSource(source)) source = source.replace(/[?#].*$/, "");
  if (!source || isAbsolutePath(source) || /^[a-z]+:\/\//i.test(source)) return source;
  const directory = /[/\\]/.test(projectPath) ? projectPath.replace(/[/\\][^/\\]*$/, "") : "";
  return normalizeJoinedPath(directory, source);
}

function sourceExtension(source: string): string {
  return source.split(/[?#]/, 1)[0]?.split(".").pop()?.toLowerCase() ?? "";
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
  return (
    element.getAttribute("type")?.toLowerCase() === "vector" &&
    (provider === "ogr" || provider === "delimitedtext") &&
    !isUncPath(source) &&
    SUPPORTED_VECTOR_EXTENSIONS.has(sourceExtension(source))
  );
}

function isSupportedRasterLayer(element: Element, provider: string, source: string): boolean {
  return (
    element.getAttribute("type")?.toLowerCase() === "raster" &&
    provider === "gdal" &&
    !isHttpSource(source) &&
    !isUncPath(source) &&
    SUPPORTED_RASTER_EXTENSIONS.has(sourceExtension(source))
  );
}

function isOpenStreetMapBasemap(element: Element, provider: string, dataSource: string): boolean {
  if (element.getAttribute("type")?.toLowerCase() !== "raster" || provider !== "wms") {
    return false;
  }
  const params = new URLSearchParams(dataSource);
  if (params.get("type")?.toLowerCase() !== "xyz") return false;
  const tileUrl = params.get("url");
  if (!tileUrl) return false;
  try {
    const host = new URL(tileUrl).hostname.toLowerCase();
    return host === "tile.openstreetmap.org" || /^[abc]\.tile\.openstreetmap\.org$/.test(host);
  } catch {
    return false;
  }
}

function unsupportedReason(
  element: Element,
  provider: string,
  source: string,
): QgisProjectImportWarning["reason"] {
  if (element.getAttribute("type")?.toLowerCase() === "raster") {
    if (isHttpSource(source)) return "remote-file";
    return "format";
  }
  if (element.getAttribute("type")?.toLowerCase() !== "vector") {
    return "non-vector";
  }
  if (provider !== "ogr" && provider !== "delimitedtext") {
    return "provider";
  }
  if (!source) return "missing-source";
  if (isUncPath(source)) return "network-path";
  return "format";
}

function parseLayerStyle(element: Element): LayerStyle {
  const style: LayerStyle = structuredClone(DEFAULT_LAYER_STYLE);
  const renderer = element.querySelector(":scope > renderer-v2");
  if (renderer?.getAttribute("type") !== "singleSymbol") return style;
  const symbolLayer = renderer.querySelector("symbols symbol layer");
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
  const widthUnit = options.get("outline_width_unit") ?? options.get("line_width_unit") ?? "MM";
  if (width !== null && (widthUnit === "MM" || widthUnit === "Pixel")) {
    style.strokeWidth = Math.max(0, width * (widthUnit === "MM" ? 3.78 : 1));
  }
  const size = optionalNumber(options.get("size"));
  const sizeUnit = options.get("size_unit") ?? "MM";
  if (
    symbolLayer?.getAttribute("class") === "SimpleMarker" &&
    size !== null &&
    (sizeUnit === "MM" || sizeUnit === "Pixel")
  ) {
    style.circleRadius = Math.max(1, (size * (sizeUnit === "MM" ? 3.78 : 1)) / 2);
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
  if (parts.length < 3 || parts.slice(0, 4).some((part) => !Number.isFinite(part))) return null;
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

function nextLayerId(id: string, orderedIds: string[]): string | undefined {
  const index = orderedIds.indexOf(id);
  return index >= 0 ? orderedIds[index + 1] : undefined;
}

function numberText(element: Element | null | undefined): number {
  const value = text(element);
  return value === "" ? Number.NaN : Number(value);
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

function isHttpSource(path: string): boolean {
  return /^https?:\/\//i.test(path);
}

function isFeatureCollection(value: unknown): value is FeatureCollection {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "FeatureCollection" &&
    Array.isArray((value as { features?: unknown }).features)
  );
}

function isUncPath(path: string): boolean {
  return path.startsWith("\\\\") || path.startsWith("//");
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "group"
  );
}
