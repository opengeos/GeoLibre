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

export interface ArcgisProjectImportWarning {
  layerName: string;
  reason:
    | "layer-type"
    | "missing-source"
    | "format"
    | "network-path"
    | "service"
    | "browser-local-file";
  layerType?: string;
}

export interface ArcgisProjectImportResult {
  project: GeoLibreProject;
  warnings: ArcgisProjectImportWarning[];
}

type CimObject = Record<string, unknown>;

const MAX_CIM_BYTES = 25 * 1024 * 1024;
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

/**
 * Convert an ArcGIS Pro project (.aprx) or map file (.mapx) from its documented
 * CIM JSON representation without executing scripts or requiring ArcPy.
 *
 * ArcGIS projects can contain several maps. GeoLibre imports the first 2D map
 * in project order because one GeoLibre project represents one map.
 */
export function importArcgisProject(
  data: ArrayBuffer | Uint8Array | string,
  sourcePath: string,
): ArcgisProjectImportResult {
  const files = readCimFiles(data, sourcePath);
  const map = findMap(files);
  if (!map) throw new Error("This file does not contain an ArcGIS Pro map.");

  const projectName = stringValue(map.name) || fileStem(sourcePath) || "Imported ArcGIS Project";
  const project = createEmptyProject(projectName, {
    mapView: parseMapView(map),
  });
  const warnings: ArcgisProjectImportWarning[] = [];
  const layers: GeoLibreLayer[] = [];
  const groups: LayerGroup[] = [];
  const usedIds = new Set<string>();

  const definitions = resolveLayerList(map, files);
  for (const definition of definitions) {
    importLayer(definition, files, sourcePath, undefined, true, layers, groups, warnings, usedIds);
  }

  project.layers = layers;
  project.layerGroups = groups.filter(
    (group) =>
      layers.some((layer) => layer.groupId === group.id) ||
      groups.some((child) => child.parentId === group.id),
  );
  project.metadata = {
    ...project.metadata,
    importedFrom: "arcgis-pro",
    arcgisProjectPath: sourcePath,
  };
  return { project, warnings };
}

function readCimFiles(
  data: ArrayBuffer | Uint8Array | string,
  sourcePath: string,
): Map<string, CimObject> {
  if (typeof data === "string" || sourcePath.toLowerCase().endsWith(".mapx")) {
    const text = typeof data === "string" ? data : strFromU8(asBytes(data));
    if (text.length > MAX_CIM_BYTES)
      throw new Error("The ArcGIS map is too large to import safely.");
    const parsed = parseCimJson(text);
    return new Map([["map.mapx", parsed]]);
  }

  const bytes = asBytes(data);
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter(entry) {
        const name = normalizeEntryName(entry.name);
        const relevant = name === "gisproject.json" || /\.(mapx|lyrx|json|xml)$/i.test(name);
        if (relevant && entry.originalSize > MAX_CIM_BYTES) {
          throw new Error(
            `The ArcGIS project member "${entry.name}" is too large to import safely.`,
          );
        }
        return relevant;
      },
    });
  } catch (error) {
    if (error instanceof Error && /too large to import safely/.test(error.message)) throw error;
    throw new Error("This file is not a valid ArcGIS Pro project.");
  }

  const files = new Map<string, CimObject>();
  for (const [name, bytes] of Object.entries(entries)) {
    try {
      files.set(normalizeEntryName(name), parseCimJson(strFromU8(bytes)));
    } catch {
      // Some APRX XML members are binary or non-CIM metadata. They are not maps
      // or layers, so a malformed unrelated member must not abort the project.
    }
  }
  if (files.size === 0) throw new Error("This ArcGIS Pro project contains no readable CIM files.");
  return files;
}

function findMap(files: Map<string, CimObject>): CimObject | null {
  const project = files.get("gisproject.json");
  const projectItems = arrayValue(project?.projectItems);
  for (const item of projectItems) {
    if (!isObject(item)) continue;
    const itemType = stringValue(item.itemType).toLowerCase();
    const type = stringValue(item.type).toLowerCase();
    if (itemType !== "map" && !type.includes("cimmapdocument")) continue;
    const path = cimPath(item.catalogPath ?? item.uRI ?? item.uri);
    const candidate = path ? files.get(path) : undefined;
    const map = unwrapMap(candidate);
    if (map && stringValue(map.mapType).toLowerCase() !== "scene") return map;
  }
  for (const candidate of files.values()) {
    const map = unwrapMap(candidate);
    if (map && stringValue(map.mapType).toLowerCase() !== "scene") return map;
  }
  return null;
}

function unwrapMap(value: CimObject | undefined): CimObject | null {
  if (!value) return null;
  if (stringValue(value.type).includes("CIMMap") && !stringValue(value.type).includes("Document")) {
    return value;
  }
  if (isObject(value.mapDefinition)) return value.mapDefinition;
  if (isObject(value.map)) return value.map;
  return null;
}

function resolveLayerList(container: CimObject, files: Map<string, CimObject>): CimObject[] {
  const inline = arrayValue(container.layerDefinitions).filter(isObject);
  if (inline.length > 0) return inline;
  return arrayValue(container.layers)
    .map((reference) => {
      if (isObject(reference)) return reference;
      const path = cimPath(reference);
      return path ? unwrapLayer(files.get(path)) : null;
    })
    .filter((layer): layer is CimObject => layer !== null);
}

function unwrapLayer(value: CimObject | undefined): CimObject | null {
  if (!value) return null;
  const definitions = arrayValue(value.layerDefinitions).filter(isObject);
  if (definitions.length > 0) return definitions[0];
  if (stringValue(value.type).includes("Layer")) return value;
  return null;
}

function importLayer(
  layer: CimObject,
  files: Map<string, CimObject>,
  sourcePath: string,
  parentId: string | undefined,
  parentVisible: boolean,
  layers: GeoLibreLayer[],
  groups: LayerGroup[],
  warnings: ArcgisProjectImportWarning[],
  usedIds: Set<string>,
): void {
  const type = stringValue(layer.type);
  const name = stringValue(layer.name) || type || "ArcGIS layer";
  const visible = parentVisible && layer.visibility !== false;
  const id = uniqueId(stringValue(layer.uRI) || name, usedIds);

  if (type.includes("CIMGroupLayer")) {
    groups.push({
      id,
      name,
      visible,
      collapsed: false,
      opacity: 1,
      ...(parentId ? { parentId } : {}),
    });
    for (const child of resolveLayerList(layer, files)) {
      importLayer(child, files, sourcePath, id, visible, layers, groups, warnings, usedIds);
    }
    return;
  }

  if (!type.includes("CIMFeatureLayer")) {
    warnings.push({
      layerName: name,
      reason: "layer-type",
      ...(type ? { layerType: type } : {}),
    });
    return;
  }

  const connection = objectValue(objectValue(layer.featureTable)?.dataConnection);
  const resolved = resolveDataSource(connection, sourcePath);
  if (!resolved.path) {
    warnings.push({
      layerName: name,
      reason: resolved.reason,
      ...(type ? { layerType: type } : {}),
    });
    return;
  }

  layers.push({
    id,
    name,
    type: "geojson",
    source: { type: "geojson" },
    visible,
    opacity: 1,
    style: parseStyle(layer),
    sourcePath: resolved.path,
    metadata: {
      localFileReloadable: true,
      importedFrom: "arcgis-pro",
      arcgisLayerUri: stringValue(layer.uRI),
      arcgisDataset: stringValue(connection?.dataset),
      arcgisWorkspaceFactory: stringValue(connection?.workspaceFactory),
    },
    ...(parentId ? { groupId: parentId } : {}),
  });
}

function resolveDataSource(
  connection: CimObject | undefined,
  projectPath: string,
): { path?: string; reason: ArcgisProjectImportWarning["reason"] } {
  if (!connection) return { reason: "missing-source" };
  if (stringValue(connection.url)) return { reason: "service" };

  const workspace = parseWorkspacePath(stringValue(connection.workspaceConnectionString));
  const dataset = stringValue(connection.dataset);
  if (!workspace && !dataset) return { reason: "missing-source" };
  if (isNetworkPath(workspace)) return { reason: "network-path" };

  const workspaceFactory = stringValue(connection.workspaceFactory).toLowerCase();
  let path = workspace;
  if (workspaceFactory.includes("shapefile") && dataset) {
    path = joinPath(workspace, /\.[a-z0-9]+$/i.test(dataset) ? dataset : `${dataset}.shp`);
  } else if (workspaceFactory.includes("text") && dataset) {
    path = joinPath(workspace, dataset);
  } else if (workspaceFactory.includes("filegdb")) {
    return { reason: "format" };
  } else if (dataset && extension(workspace) === "gpkg") {
    path = workspace;
  } else if (!path && dataset) {
    path = dataset;
  }

  path = resolveRelativePath(path, projectPath);
  return SUPPORTED_VECTOR_EXTENSIONS.has(extension(path))
    ? { path, reason: "format" }
    : { reason: "format" };
}

function parseStyle(layer: CimObject): LayerStyle {
  const style: LayerStyle = structuredClone(DEFAULT_LAYER_STYLE);
  const renderer = objectValue(layer.renderer);
  const symbol =
    objectValue(objectValue(renderer?.symbol)?.symbol) ??
    objectValue(objectValue(renderer?.defaultSymbol)?.symbol);
  const symbolLayers = arrayValue(symbol?.symbolLayers).filter(isObject);
  for (const symbolLayer of symbolLayers) {
    const type = stringValue(symbolLayer.type);
    const color = cimColor(objectValue(symbolLayer.color));
    if (type === "CIMSolidFill" && color) {
      style.fillColor = color.hex;
      style.fillOpacity = color.opacity;
    } else if (type === "CIMSolidStroke" && color) {
      style.strokeColor = color.hex;
      const width = numberValue(symbolLayer.width);
      if (width !== null) style.strokeWidth = width * (96 / 72);
    } else if (/Marker$/.test(type) && color) {
      style.fillColor = color.hex;
      style.fillOpacity = color.opacity;
      const size = numberValue(symbolLayer.size);
      if (size !== null) style.circleRadius = (size * 96) / 144;
    }
  }

  const labelClass = arrayValue(layer.labelClasses).find(isObject);
  const expression = stringValue(labelClass?.expression);
  const field = expression.match(/^\s*\[\s*([^\]]+)\s*\]\s*$/)?.[1]?.trim();
  if (layer.labelVisibility === true && field) {
    style.labels = { ...style.labels, enabled: true, field };
  }
  return style;
}

function cimColor(color: CimObject | undefined): { hex: string; opacity: number } | null {
  if (!color) return null;
  const values = arrayValue(color.values).map(Number);
  if (values.length < 3 || values.slice(0, 3).some((value) => !Number.isFinite(value))) return null;
  const [r, g, b, a = 100] = values;
  const hex = `#${[r, g, b]
    .map((value) =>
      Math.max(0, Math.min(255, Math.round(value)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
  return { hex, opacity: Math.max(0, Math.min(1, a / 100)) };
}

function parseMapView(map: CimObject): MapViewState {
  const extent = objectValue(map.defaultExtent);
  const spatialReference =
    objectValue(extent?.spatialReference) ?? objectValue(map.spatialReference);
  const wkid =
    numberValue(spatialReference?.latestWkid) ?? numberValue(spatialReference?.wkid) ?? undefined;
  const xmin = numberValue(extent?.xmin);
  const ymin = numberValue(extent?.ymin);
  const xmax = numberValue(extent?.xmax);
  const ymax = numberValue(extent?.ymax);
  if (xmin === null || ymin === null || xmax === null || ymax === null) return defaultView();
  const bounds =
    wkid === 3857 || wkid === 102100
      ? [
          mercatorLongitude(xmin),
          mercatorLatitude(ymin),
          mercatorLongitude(xmax),
          mercatorLatitude(ymax),
        ]
      : wkid === 4326
        ? [xmin, ymin, xmax, ymax]
        : null;
  if (!bounds) return defaultView();
  const [west, south, east, north] = bounds;
  const longitudeSpan = Math.max(1e-9, Math.min(360, Math.abs(east - west)));
  const latitudeSpan = Math.max(1e-9, Math.min(180, Math.abs(north - south)));
  const zoom = Math.max(
    0,
    Math.min(22, Math.log2(Math.min(360 / longitudeSpan, 170 / latitudeSpan))),
  );
  return {
    center: [(west + east) / 2, (south + north) / 2],
    zoom,
    bearing: 0,
    pitch: 0,
  };
}

function defaultView(): MapViewState {
  return { center: [-100, 40], zoom: 2, bearing: 0, pitch: 0 };
}

function mercatorLongitude(x: number): number {
  return (x / 20037508.342789244) * 180;
}

function mercatorLatitude(y: number): number {
  const degrees = (y / 20037508.342789244) * 180;
  return (180 / Math.PI) * (2 * Math.atan(Math.exp((degrees * Math.PI) / 180)) - Math.PI / 2);
}

function parseCimJson(text: string): CimObject {
  const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!isObject(value)) throw new Error("Invalid ArcGIS CIM JSON.");
  return value;
}

function parseWorkspacePath(connection: string): string {
  const match = connection.match(/(?:^|;)DATABASE=(?:"([^"]+)"|([^;]+))/i);
  return (match?.[1] ?? match?.[2] ?? "").trim();
}

function resolveRelativePath(path: string, projectPath: string): string {
  if (!path || isAbsolutePath(path)) return normalizePath(path);
  const directory = projectPath.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
  return normalizePath(directory ? `${directory}/${path}` : path);
}

function joinPath(parent: string, child: string): string {
  return parent ? `${parent.replace(/[\\/]$/, "")}/${child}` : child;
}

function normalizePath(path: string): string {
  const windows = /^[A-Za-z]:/.test(path);
  const absolute = path.startsWith("/");
  const prefix = windows ? path.slice(0, 2) : absolute ? "/" : "";
  const parts = path
    .replace(/\\/g, "/")
    .replace(/^[A-Za-z]:|^\//, "")
    .split("/")
    .filter(Boolean);
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === ".." && normalized.length > 0) normalized.pop();
    else normalized.push(part);
  }
  const separator = windows && normalized.length ? "/" : "";
  return `${prefix}${separator}${normalized.join("/")}`;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function isNetworkPath(path: string): boolean {
  return /^\\\\|^\/\//.test(path);
}

function extension(path: string): string {
  return path.match(/\.([a-z0-9]+)(?:$|[?#])/i)?.[1]?.toLowerCase() ?? "";
}

function fileStem(path: string): string {
  return (
    path
      .replace(/\\/g, "/")
      .split("/")
      .pop()
      ?.replace(/\.(aprx|mapx)$/i, "") ?? ""
  );
}

function cimPath(value: unknown): string {
  return normalizeEntryName(stringValue(value).replace(/^CIMPATH=/i, ""));
}

function normalizeEntryName(name: string): string {
  return name
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .toLowerCase();
}

function uniqueId(seed: string, used: Set<string>): string {
  const base =
    seed
      .replace(/^CIMPATH=/i, "")
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "arcgis-layer";
  let id = base;
  let suffix = 2;
  while (used.has(id)) id = `${base}-${suffix++}`;
  used.add(id);
  return id;
}

function asBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function isObject(value: unknown): value is CimObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectValue(value: unknown): CimObject | undefined {
  return isObject(value) ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
