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
    | "browser-local-file"
    | "map-extent"
    | "nesting";
  layerType?: string;
}

export interface ArcgisProjectImportResult {
  project: GeoLibreProject;
  rasters: ArcgisRasterImport[];
  services: ArcgisServiceImport[];
  warnings: ArcgisProjectImportWarning[];
}

export interface ArcgisRasterImport {
  id: string;
  name: string;
  sourcePath: string;
  visible: boolean;
  opacity: number;
  groupId?: string;
}

export interface ArcgisServiceImport {
  name: string;
  itemId: string;
  visible: boolean;
  groupId?: string;
}

type CimObject = Record<string, unknown>;

const MAX_CIM_BYTES = 25 * 1024 * 1024;
/**
 * Deepest group nesting the importer will follow.
 *
 * A project file is untrusted input reachable straight from Project → Import,
 * and group children are resolved by path out of the archive's shared file map,
 * so a corrupt or crafted project can reference an ancestor and recurse without
 * end. The ancestor set in {@link importLayer} breaks true cycles; this cap
 * additionally bounds a very long acyclic chain of tiny group members, which
 * would otherwise exhaust the stack while staying under MAX_CIM_BYTES. Far
 * deeper than any real ArcGIS Pro table of contents.
 */
const MAX_GROUP_DEPTH = 64;
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
  const { view: mapView, extentRestored } = parseMapView(map);
  const project = createEmptyProject(projectName, { mapView });
  const warnings: ArcgisProjectImportWarning[] = [];
  // Every other unsupported condition is reported, so a dropped extent is too:
  // otherwise a project in an unsupported projection opens at a generic world
  // view with nothing to explain why.
  if (!extentRestored) warnings.push({ layerName: projectName, reason: "map-extent" });
  const layers: GeoLibreLayer[] = [];
  const rasters: ArcgisRasterImport[] = [];
  const services: ArcgisServiceImport[] = [];
  const groups: LayerGroup[] = [];
  const usedIds = new Set<string>();

  const definitions = resolveLayerList(map, files);
  for (const definition of definitions) {
    importLayer(
      definition,
      files,
      sourcePath,
      undefined,
      layers,
      rasters,
      services,
      groups,
      warnings,
      usedIds,
      new Set(),
    );
  }

  project.layers = layers;
  // Rasters and services are attached to their group after the project loads
  // (they become store layers only once the raster control and ArcGIS plugin
  // have added them), so a group holding nothing else must survive this prune.
  // Dropping it would make the later moveLayerToGroup call a silent no-op and
  // strand the raster or service at the top level.
  project.layerGroups = groups.filter(
    (group) =>
      layers.some((layer) => layer.groupId === group.id) ||
      rasters.some((raster) => raster.groupId === group.id) ||
      services.some((service) => service.groupId === group.id) ||
      groups.some((child) => child.parentId === group.id),
  );
  project.metadata = {
    ...project.metadata,
    importedFrom: "arcgis-pro",
    arcgisProjectPath: sourcePath,
  };
  return { project, rasters, services, warnings };
}

function readCimFiles(
  data: ArrayBuffer | Uint8Array | string,
  sourcePath: string,
): Map<string, CimObject> {
  if (typeof data === "string" || sourcePath.toLowerCase().endsWith(".mapx")) {
    // Measured in bytes, not `String.length`: the latter counts UTF-16 code
    // units, so a CIM document full of multi-byte characters would slip past a
    // byte-denominated cap. Binary input is checked before it is decoded, so an
    // oversized map never pays for a full string decode.
    if (typeof data !== "string") {
      const bytes = asBytes(data);
      if (bytes.byteLength > MAX_CIM_BYTES) {
        throw new Error("The ArcGIS map is too large to import safely.");
      }
      return new Map([["map.mapx", parseCimJson(strFromU8(bytes))]]);
    }
    if (new TextEncoder().encode(data).byteLength > MAX_CIM_BYTES) {
      throw new Error("The ArcGIS map is too large to import safely.");
    }
    return new Map([["map.mapx", parseCimJson(data)]]);
  }

  const archiveBytes = asBytes(data);
  let entries: Record<string, Uint8Array>;
  try {
    // Capped per member *and* in total: without the running sum, an archive of
    // many members each just under the limit would still decompress to an
    // arbitrarily large amount of JSON held in memory at once.
    let decompressedBytes = 0;
    entries = unzipSync(archiveBytes, {
      filter(entry) {
        const name = normalizeEntryName(entry.name);
        const relevant = name === "gisproject.json" || /\.(mapx|lyrx|json|xml)$/i.test(name);
        if (!relevant) return false;
        decompressedBytes += entry.originalSize;
        if (entry.originalSize > MAX_CIM_BYTES || decompressedBytes > MAX_CIM_BYTES) {
          throw new Error("This ArcGIS Pro project is too large to import safely.");
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof Error && /too large to import safely/.test(error.message)) throw error;
    throw new Error("This file is not a valid ArcGIS Pro project.");
  }

  const files = new Map<string, CimObject>();
  for (const [name, content] of Object.entries(entries)) {
    try {
      files.set(normalizeEntryName(name), parseCimJson(strFromU8(content)));
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

/**
 * @param ancestors - Group definitions already open on this branch. Children
 *   resolved out of the archive share object identity with the file map's
 *   entries, so a project that references an ancestor is detected here rather
 *   than recursing until the stack overflows.
 */
function importLayer(
  layer: CimObject,
  files: Map<string, CimObject>,
  sourcePath: string,
  parentId: string | undefined,
  layers: GeoLibreLayer[],
  rasters: ArcgisRasterImport[],
  services: ArcgisServiceImport[],
  groups: LayerGroup[],
  warnings: ArcgisProjectImportWarning[],
  usedIds: Set<string>,
  ancestors: ReadonlySet<CimObject>,
): void {
  const type = stringValue(layer.type);
  const name = stringValue(layer.name) || type || "ArcGIS layer";
  // Each item stores only its *own* ArcGIS toggle. `applyGroupEffects`
  // (packages/core/src/layer-groups.ts) folds ancestor group visibility in at
  // render time, so pre-cascading it here would look right on first paint but
  // discard the item's real state -- re-enabling a hidden parent group would
  // leave its children stuck hidden. Matches the QGIS importer's contract.
  const visible = layer.visibility !== false;
  const id = uniqueId(stringValue(layer.uRI) || name, usedIds);

  if (type.includes("CIMGroupLayer")) {
    if (ancestors.has(layer) || ancestors.size >= MAX_GROUP_DEPTH) {
      warnings.push({ layerName: name, reason: "nesting", layerType: type });
      return;
    }
    groups.push({
      id,
      name,
      visible,
      collapsed: false,
      opacity: 1,
      ...(parentId ? { parentId } : {}),
    });
    const branch = new Set(ancestors).add(layer);
    for (const child of resolveLayerList(layer, files)) {
      importLayer(
        child,
        files,
        sourcePath,
        id,
        layers,
        rasters,
        services,
        groups,
        warnings,
        usedIds,
        branch,
      );
    }
    return;
  }

  if (type.includes("CIMRasterLayer")) {
    const connection = objectValue(layer.dataConnection);
    const resolvedRaster = resolveRasterSource(connection, sourcePath);
    if (resolvedRaster.path) {
      rasters.push({
        id,
        name,
        sourcePath: resolvedRaster.path,
        visible,
        opacity: numberValue(layer.opacity) ?? 1,
        ...(parentId ? { groupId: parentId } : {}),
      });
    } else {
      warnings.push({
        layerName: name,
        reason: resolvedRaster.reason ?? "format",
        layerType: type,
      });
    }
    return;
  }

  if (type.includes("CIMTiledServiceLayer")) {
    const serviceConnection = objectValue(layer.serviceConnection);
    const url = stringValue(serviceConnection?.url).replace(/\/+$/, "");
    if (url && stringValue(serviceConnection?.objectType).toLowerCase() === "mapserver") {
      layers.push({
        id,
        name,
        type: "xyz",
        source: { tiles: [`${url}/tile/{z}/{y}/{x}`] },
        visible,
        opacity: numberValue(layer.opacity) ?? 1,
        style: structuredClone(DEFAULT_LAYER_STYLE),
        metadata: { importedFrom: "arcgis-pro", sourceKind: "arcgis-tiled-map-service" },
        sourcePath: url,
        ...(parentId ? { groupId: parentId } : {}),
      });
      return;
    }
  }

  if (type.includes("CIMVectorTileLayer")) {
    const itemId = stringValue(layer.sourceURI);
    if (/^[a-f0-9]{32}$/i.test(itemId)) {
      services.push({
        name,
        itemId,
        visible,
        ...(parentId ? { groupId: parentId } : {}),
      });
      return;
    }
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
      reason: resolved.reason ?? "format",
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

/**
 * Resolve a raster layer's local file path.
 *
 * Mirrors {@link resolveDataSource}'s result shape so a raster reports the same
 * reason a vector layer would for the same root cause -- a UNC workspace is a
 * "network-path", not an unsupported "format".
 */
function resolveRasterSource(
  connection: CimObject | undefined,
  projectPath: string,
): { path?: string; reason?: ArcgisProjectImportWarning["reason"] } {
  if (!connection) return { reason: "missing-source" };
  const workspace = parseWorkspacePath(stringValue(connection.workspaceConnectionString));
  const dataset = stringValue(connection.dataset);
  if (!workspace && !dataset) return { reason: "missing-source" };
  if (isNetworkPath(workspace)) return { reason: "network-path" };
  if (!workspace || !dataset) return { reason: "missing-source" };
  const path = resolveRelativePath(joinPath(workspace, dataset), projectPath);
  return ["tif", "tiff"].includes(extension(path)) ? { path } : { reason: "format" };
}

function resolveDataSource(
  connection: CimObject | undefined,
  projectPath: string,
): { path?: string; reason?: ArcgisProjectImportWarning["reason"] } {
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
  } else if (dataset && !extension(workspace)) {
    // A workspace with no extension is a containing folder, so the dataset
    // carries the file name -- the shape shapefile and delimited-text
    // connections use. Joining them generically lets the other file formats in
    // SUPPORTED_VECTOR_EXTENSIONS resolve instead of falling through to the
    // bare folder path, which has no extension and is always rejected below.
    path = joinPath(workspace, dataset);
  }

  path = resolveRelativePath(path, projectPath);
  // `reason` is omitted on success so a caller that reads it unconditionally
  // cannot mistake a supported layer for an unsupported format.
  return SUPPORTED_VECTOR_EXTENSIONS.has(extension(path)) ? { path } : { reason: "format" };
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

/**
 * Convert a CIM color to hex plus opacity.
 *
 * Every CIMColor subclass stores its channels in a `values` array with alpha
 * last, but the channel meaning and scale differ per subclass, so the type has
 * to be read before `values` can be interpreted -- treating a CMYK or HSV
 * triple as RGB silently produces the wrong colour. Channels are per the CIM
 * spec (Esri/cim-spec docs/v3/CIMColor.md): RGB 0-255, CMYK/Gray/S/V 0-100,
 * hue 0-360, alpha 0-100. An unrecognized subclass returns null so the layer
 * keeps GeoLibre's default style rather than an invented colour.
 */
function cimColor(color: CimObject | undefined): { hex: string; opacity: number } | null {
  if (!color) return null;
  const type = stringValue(color.type);
  const values = arrayValue(color.values).map(Number);
  if (values.some((value) => !Number.isFinite(value))) return null;

  let rgb: [number, number, number] | null = null;
  let alpha = 100;
  if (type === "CIMRGBColor" && values.length >= 3) {
    rgb = [values[0], values[1], values[2]];
    alpha = values[3] ?? 100;
  } else if (type === "CIMGrayColor" && values.length >= 1) {
    const level = (values[0] / 100) * 255;
    rgb = [level, level, level];
    alpha = values[1] ?? 100;
  } else if (type === "CIMCMYKColor" && values.length >= 4) {
    const [c, m, y, k] = values;
    rgb = [
      255 * (1 - c / 100) * (1 - k / 100),
      255 * (1 - m / 100) * (1 - k / 100),
      255 * (1 - y / 100) * (1 - k / 100),
    ];
    alpha = values[4] ?? 100;
  } else if (type === "CIMHSVColor" && values.length >= 3) {
    rgb = hsvToRgb(values[0], values[1] / 100, values[2] / 100);
    alpha = values[3] ?? 100;
  }
  if (!rgb) return null;

  const hex = `#${rgb
    .map((value) =>
      Math.max(0, Math.min(255, Math.round(value)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
  return { hex, opacity: Math.max(0, Math.min(1, alpha / 100)) };
}

/**
 * Standard HSV to RGB conversion for {@link cimColor}.
 *
 * @param hue - Hue in degrees; wrapped into 0-360.
 * @param saturation - Saturation as a 0-1 fraction.
 * @param value - Value as a 0-1 fraction.
 * @returns Red, green, and blue channels on a 0-255 scale.
 */
function hsvToRgb(hue: number, saturation: number, value: number): [number, number, number] {
  const h = (((hue % 360) + 360) % 360) / 60;
  const s = Math.max(0, Math.min(1, saturation));
  const v = Math.max(0, Math.min(1, value));
  const chroma = v * s;
  const second = chroma * (1 - Math.abs((h % 2) - 1));
  const [r, g, b] =
    h < 1
      ? [chroma, second, 0]
      : h < 2
        ? [second, chroma, 0]
        : h < 3
          ? [0, chroma, second]
          : h < 4
            ? [0, second, chroma]
            : h < 5
              ? [second, 0, chroma]
              : [chroma, 0, second];
  const match = v - chroma;
  return [(r + match) * 255, (g + match) * 255, (b + match) * 255];
}

/**
 * Read the map's saved extent as a GeoLibre view.
 *
 * @returns The view, and whether it came from the project rather than the
 *   generic fallback -- the caller warns when the saved extent was dropped.
 */
function parseMapView(map: CimObject): { view: MapViewState; extentRestored: boolean } {
  const extent = objectValue(map.defaultExtent);
  const spatialReference =
    objectValue(extent?.spatialReference) ?? objectValue(map.spatialReference);
  const wkid =
    numberValue(spatialReference?.latestWkid) ?? numberValue(spatialReference?.wkid) ?? undefined;
  const xmin = numberValue(extent?.xmin);
  const ymin = numberValue(extent?.ymin);
  const xmax = numberValue(extent?.xmax);
  const ymax = numberValue(extent?.ymax);
  if (xmin === null || ymin === null || xmax === null || ymax === null) {
    return { view: defaultView(), extentRestored: false };
  }
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
  if (!bounds) return { view: defaultView(), extentRestored: false };
  const [west, south, east, north] = bounds;
  const longitudeSpan = Math.max(1e-9, Math.min(360, Math.abs(east - west)));
  const latitudeSpan = Math.max(1e-9, Math.min(180, Math.abs(north - south)));
  const zoom = Math.max(
    0,
    Math.min(22, Math.log2(Math.min(360 / longitudeSpan, 170 / latitudeSpan))),
  );
  return {
    view: {
      center: [(west + east) / 2, (south + north) / 2],
      zoom,
      bearing: 0,
      pitch: 0,
    },
    extentRestored: true,
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
