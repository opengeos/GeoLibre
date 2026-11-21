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
    | "file-geodatabase"
    | "file-geodatabase-raster"
    | "file-geodatabase-read"
    | "file-geodatabase-crs"
    | "network-path"
    | "service"
    | "service-unavailable"
    | "browser-local-file"
    | "map-extent"
    | "nesting";
  layerType?: string;
  /**
   * Import id of the layer, raster or service the warning is about, when that
   * item was imported (a note on a layer that still loads). Lets
   * {@link dropArcgisImportLayers} take the note away with the layer. Absent
   * for warnings about layers that were never imported.
   */
  layerId?: string;
}

export interface ArcgisProjectImportResult {
  project: GeoLibreProject;
  rasters: ArcgisRasterImport[];
  services: ArcgisServiceImport[];
  /**
   * Feature classes read from a local File Geodatabase. Each is already in
   * `project.layers` (in table-of-contents order, grouped and styled) as a
   * GeoJSON layer with no features yet; the caller fills it through the
   * desktop sidecar or drops it. Empty unless `readFileGeodatabase` was set.
   */
  fileGeodatabaseLayers: ArcgisFileGeodatabaseImport[];
  /**
   * Import ids of every layer, raster and service, bottom first as the store
   * keeps them (ArcGIS Pro lists them top first). Rasters and services join
   * the store only after the project loads, each on top, so the caller puts
   * them back in this order once they have been added.
   */
  layerOrder: string[];
  warnings: ArcgisProjectImportWarning[];
}

export interface ArcgisFileGeodatabaseImport {
  /** Id of the placeholder layer in `project.layers`. */
  id: string;
  name: string;
  /** Absolute path of the `.gdb` folder. */
  gdbPath: string;
  /** Feature class name inside the geodatabase. */
  featureClass: string;
}

export interface ArcgisProjectImportOptions {
  /**
   * Keep File Geodatabase feature classes as layers for the caller to read,
   * rather than reporting them as unsupported. Only the desktop build can read
   * a geodatabase (through the Python sidecar's GDAL). The layers come back
   * without features: the caller fills them, or drops them with a warning, by
   * passing the result to `loadArcgisFileGeodatabaseLayers`
   * (`arcgis-gdb-import.ts`) before loading the project.
   */
  readFileGeodatabase?: boolean;
}

export interface ArcgisRasterImport {
  id: string;
  name: string;
  sourcePath: string;
  visible: boolean;
  opacity: number;
  groupId?: string;
}

/**
 * A service layer the ArcGIS plugin adds once the project has loaded: a portal
 * vector tile item, or one numbered sublayer of a FeatureServer.
 */
export type ArcgisServiceImport = ArcgisVectorTileServiceImport | ArcgisFeatureServiceImport;

export interface ArcgisVectorTileServiceImport {
  kind: "vector-tile";
  /** Import id; the service gets a new store id once the ArcGIS plugin adds it. */
  id: string;
  name: string;
  itemId: string;
  visible: boolean;
  groupId?: string;
}

export interface ArcgisFeatureServiceImport {
  kind: "feature";
  /** Import id; the service gets a new store id once the ArcGIS plugin adds it. */
  id: string;
  name: string;
  /**
   * The sublayer URL (`…/FeatureServer/<n>`), rebuilt from scheme, host and
   * path only, so no query string or user info from the project file reaches
   * a request, a saved project or a log.
   */
  url: string;
  visible: boolean;
  opacity: number;
  groupId?: string;
  /** The CIM layer URI, kept on the store layer as its ArcGIS identity. */
  arcgisLayerUri?: string;
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

/** A 2D map in an ArcGIS Pro project that the user can choose to import. */
export interface ArcgisProjectMapChoice {
  /** Position among the project's 2D maps, in project order. */
  index: number;
  /** The map's own name; empty when the CIM document does not give one. */
  name: string;
}

/** An ArcGIS Pro project read once, listing its 2D maps for the caller to choose from. */
export interface ArcgisProjectReader {
  /** The project's 2D maps in project order. Scenes are left out. */
  maps: ArcgisProjectMapChoice[];
  /** Import one map by its {@link ArcgisProjectMapChoice.index}; the first by default. */
  importMap(index?: number): ArcgisProjectImportResult;
}

/**
 * Read an ArcGIS Pro project (.aprx) or map file (.mapx) from its documented
 * CIM JSON representation without executing scripts or requiring ArcPy.
 *
 * An ArcGIS project can contain several maps, but one GeoLibre project
 * represents one map, so the caller picks which 2D map to import.
 */
export function readArcgisProject(
  data: ArrayBuffer | Uint8Array | string,
  sourcePath: string,
  options: ArcgisProjectImportOptions = {},
): ArcgisProjectReader {
  const files = readCimFiles(data, sourcePath);
  const maps = findMaps(files);
  if (maps.length === 0) throw new Error("This file does not contain an ArcGIS Pro map.");
  return {
    maps: maps.map((map, index) => ({ index, name: stringValue(map.name) })),
    importMap: (index = 0) => {
      const map = maps[index];
      if (!map) throw new Error("This ArcGIS Pro project has no such map.");
      return importMap(map, files, sourcePath, options);
    },
  };
}

/**
 * Convert an ArcGIS Pro project or map file, importing its first 2D map in
 * project order. Use {@link readArcgisProject} to import a different map.
 */
export function importArcgisProject(
  data: ArrayBuffer | Uint8Array | string,
  sourcePath: string,
  options: ArcgisProjectImportOptions = {},
): ArcgisProjectImportResult {
  return readArcgisProject(data, sourcePath, options).importMap();
}

function importMap(
  map: CimObject,
  files: Map<string, CimObject>,
  sourcePath: string,
  options: ArcgisProjectImportOptions,
): ArcgisProjectImportResult {
  const projectName = stringValue(map.name) || fileStem(sourcePath) || "Imported ArcGIS Project";
  const { view: mapView, extentRestored } = parseMapView(map);
  const project = createEmptyProject(projectName, { mapView });
  const warnings: ArcgisProjectImportWarning[] = [];
  // Every other unsupported condition is reported, so a dropped extent is too:
  // otherwise a project in an unsupported projection opens at a generic world
  // view with nothing to explain why.
  if (!extentRestored) warnings.push({ layerName: projectName, reason: "map-extent" });
  const context: ImportContext = {
    files,
    sourcePath,
    readFileGeodatabase: options.readFileGeodatabase === true,
    layers: [],
    rasters: [],
    services: [],
    fileGeodatabaseLayers: [],
    order: [],
    groups: [],
    warnings,
    usedIds: new Set(),
  };
  for (const definition of resolveLayerList(map, files)) {
    importLayer(definition, context, undefined, new Set());
  }

  // CIM lists layers top first; the store keeps them bottom first (the layer
  // panel reverses them), as the QGIS importer does.
  project.layers = context.layers.reverse();
  project.layerGroups = context.groups;
  project.metadata = {
    ...project.metadata,
    importedFrom: "arcgis-pro",
    arcgisProjectPath: sourcePath,
  };
  const result: ArcgisProjectImportResult = {
    project,
    rasters: context.rasters,
    services: context.services,
    fileGeodatabaseLayers: context.fileGeodatabaseLayers,
    layerOrder: context.order.reverse(),
    warnings,
  };
  pruneArcgisImportGroups(result);
  return result;
}

/**
 * Drop groups an import result no longer needs. A group survives while it
 * holds a layer, a raster or service still to be added, or a surviving child
 * group, so the ancestors of anything kept are kept too. Rasters and services
 * count because they are moved into their group only after the project loads;
 * dropping that group would strand them at the top level.
 *
 * @param imported - The import result, updated in place.
 */
export function pruneArcgisImportGroups(imported: ArcgisProjectImportResult): void {
  const usedGroupIds = new Set<string>(
    [...imported.project.layers, ...imported.rasters, ...imported.services].flatMap((item) =>
      item.groupId ? [item.groupId] : [],
    ),
  );
  const groupById = new Map((imported.project.layerGroups ?? []).map((group) => [group.id, group]));
  for (const id of [...usedGroupIds]) {
    let parentId = groupById.get(id)?.parentId;
    while (parentId && !usedGroupIds.has(parentId)) {
      usedGroupIds.add(parentId);
      parentId = groupById.get(parentId)?.parentId;
    }
  }
  imported.project.layerGroups = imported.project.layerGroups?.filter((group) =>
    usedGroupIds.has(group.id),
  );
}

/**
 * Remove imported layers, rasters and services the caller cannot load, along
 * with the warnings tagged with their ids and any group left empty, so the
 * import report never describes a layer the user will not see.
 *
 * @param imported - The import result, updated in place.
 * @param ids - Import ids to drop.
 */
export function dropArcgisImportLayers(
  imported: ArcgisProjectImportResult,
  ids: ReadonlySet<string>,
): void {
  if (ids.size === 0) return;
  const kept = <T extends { id: string }>(items: T[]) => items.filter((item) => !ids.has(item.id));
  imported.project.layers = kept(imported.project.layers);
  imported.rasters = kept(imported.rasters);
  imported.services = kept(imported.services);
  imported.fileGeodatabaseLayers = kept(imported.fileGeodatabaseLayers);
  imported.layerOrder = imported.layerOrder.filter((id) => !ids.has(id));
  imported.warnings = imported.warnings.filter(
    (warning) => warning.layerId === undefined || !ids.has(warning.layerId),
  );
  pruneArcgisImportGroups(imported);
}

/** The state one {@link importMap} call builds up while walking the layer tree. */
interface ImportContext {
  files: Map<string, CimObject>;
  sourcePath: string;
  /** Keep File Geodatabase feature classes for the caller to read. */
  readFileGeodatabase: boolean;
  /** Layers, rasters and services in CIM (top-first) order. */
  layers: GeoLibreLayer[];
  rasters: ArcgisRasterImport[];
  services: ArcgisServiceImport[];
  fileGeodatabaseLayers: ArcgisFileGeodatabaseImport[];
  /** Ids of layers, rasters and services in CIM (top-first) order. */
  order: string[];
  groups: LayerGroup[];
  warnings: ArcgisProjectImportWarning[];
  usedIds: Set<string>;
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

/**
 * The project's 2D maps in project order: those its catalogue lists, or, when
 * the catalogue names none that can be read, every map document in the file.
 */
function findMaps(files: Map<string, CimObject>): CimObject[] {
  // CIM MapType "Map" is the only 2D map; Scene, Basemap, NetworkDiagram,
  // ContainmentMap and LinkChart share the CIMMap type but are not maps a
  // GeoLibre project can stand in for. Older documents omit the field.
  const is2dMap = (map: CimObject | null): map is CimObject =>
    map !== null && ["", "map"].includes(stringValue(map.mapType).toLowerCase());
  const project = files.get("gisproject.json");
  const listed: CimObject[] = [];
  const seenPaths = new Set<string>();
  for (const item of arrayValue(project?.projectItems)) {
    if (!isObject(item)) continue;
    const itemType = stringValue(item.itemType).toLowerCase();
    const type = stringValue(item.type).toLowerCase();
    if (itemType !== "map" && !type.includes("cimmapdocument")) continue;
    const path = cimPath(item.catalogPath ?? item.uRI ?? item.uri);
    if (!path || seenPaths.has(path)) continue;
    seenPaths.add(path);
    const map = unwrapMap(files.get(path));
    if (is2dMap(map)) listed.push(map);
  }
  if (listed.length > 0) return listed;
  return [...files.values()].map(unwrapMap).filter(is2dMap);
}

function unwrapMap(value: CimObject | undefined): CimObject | null {
  if (!value) return null;
  // Exact match: layer and layout element types such as CIMMapImageLayer and
  // CIMMapFrame also start with "CIMMap".
  if (stringValue(value.type) === "CIMMap") return value;
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
  context: ImportContext,
  parentId: string | undefined,
  ancestors: ReadonlySet<CimObject>,
): void {
  const { files, sourcePath, layers, rasters, services, groups, warnings, usedIds } = context;
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
      opacity: layerOpacity(layer),
      ...(parentId ? { parentId } : {}),
    });
    const branch = new Set(ancestors).add(layer);
    for (const child of resolveLayerList(layer, files)) {
      importLayer(child, context, id, branch);
    }
    return;
  }

  if (type.includes("CIMRasterLayer")) {
    const connection = objectValue(layer.dataConnection);
    const resolvedRaster = resolveRasterSource(connection, sourcePath);
    if (resolvedRaster.path) {
      context.order.push(id);
      rasters.push({
        id,
        name,
        sourcePath: resolvedRaster.path,
        visible,
        opacity: layerOpacity(layer),
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
      context.order.push(id);
      layers.push({
        id,
        name,
        type: "xyz",
        source: { tiles: [`${url}/tile/{z}/{y}/{x}`] },
        visible,
        opacity: layerOpacity(layer),
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
      context.order.push(id);
      services.push({
        kind: "vector-tile",
        id,
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
  const serviceUrl = featureServiceSublayerUrl(connection);
  if (serviceUrl) {
    const arcgisLayerUri = stringValue(layer.uRI);
    context.order.push(id);
    services.push({
      kind: "feature",
      id,
      name,
      url: serviceUrl,
      visible,
      opacity: layerOpacity(layer),
      ...(arcgisLayerUri ? { arcgisLayerUri } : {}),
      ...(parentId ? { groupId: parentId } : {}),
    });
    return;
  }
  const resolved = resolveDataSource(connection, sourcePath, context.readFileGeodatabase);
  if (resolved.fileGeodatabase) {
    context.fileGeodatabaseLayers.push({ id, name, ...resolved.fileGeodatabase });
    context.order.push(id);
    layers.push({
      id,
      name,
      type: "geojson",
      source: { type: "geojson" },
      visible,
      opacity: layerOpacity(layer),
      style: parseStyle(layer),
      sourcePath: resolved.fileGeodatabase.gdbPath,
      // The same shape the Add data → File geodatabase source saves, so the
      // features are embedded on save (a .gdb cannot be re-read on reopen).
      metadata: {
        sourceKind: "gdb",
        gdbLayer: resolved.fileGeodatabase.featureClass,
        importedFrom: "arcgis-pro",
        arcgisLayerUri: stringValue(layer.uRI),
        arcgisDataset: stringValue(connection?.dataset),
        arcgisWorkspaceFactory: stringValue(connection?.workspaceFactory),
      },
      ...(parentId ? { groupId: parentId } : {}),
    });
    return;
  }
  if (!resolved.path) {
    warnings.push({
      layerName: name,
      reason: resolved.reason ?? "format",
      ...(type ? { layerType: type } : {}),
    });
    return;
  }

  context.order.push(id);
  layers.push({
    id,
    name,
    type: "geojson",
    source: { type: "geojson" },
    visible,
    opacity: layerOpacity(layer),
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
/**
 * A layer's opacity, from the CIM transparency it was saved with.
 *
 * `CIMBaseLayer` records `transparency` as a 0-100 percentage where 0 is fully
 * opaque -- the inverse of GeoLibre's 0-1 opacity. ArcGIS omits the property
 * entirely at the default, so a missing value means opaque. `opacity` is read
 * as a fallback only because it costs nothing; the CIM spec does not define it.
 */
function layerOpacity(layer: CimObject): number {
  const transparency = numberValue(layer.transparency);
  if (transparency === null) return numberValue(layer.opacity) ?? 1;
  // Rounded because `1 - 80 / 100` is 0.19999999999999996 in binary floating
  // point, and that would be written verbatim into the saved project.
  return Math.max(0, Math.min(1, Math.round((1 - transparency / 100) * 10000) / 10000));
}

function resolveRasterSource(
  connection: CimObject | undefined,
  projectPath: string,
): { path?: string; reason?: ArcgisProjectImportWarning["reason"] } {
  if (!connection) return { reason: "missing-source" };
  const workspace = parseWorkspacePath(stringValue(connection.workspaceConnectionString));
  const dataset = stringValue(connection.dataset);
  if (!workspace && !dataset) return { reason: "missing-source" };
  if (isNetworkPath(workspace)) return { reason: "network-path" };
  // Reported under its own reason rather than the feature class one: the
  // desktop build's Add Data -> File Geodatabase source lists only feature
  // classes that carry geometry, so pointing a raster at it would send the
  // user somewhere that cannot open their data.
  if (stringValue(connection.workspaceFactory).toLowerCase().includes("filegdb")) {
    return { reason: "file-geodatabase-raster" };
  }
  // Past this point the factory did not name a geodatabase, so only the
  // workspace suffix is left to go on -- and it is consulted last, after the
  // joined path fails. A readable GeoTIFF is therefore still loaded from a
  // plain folder that happens to be named "*.gdb"; only a dataset the app
  // cannot open falls through to the suffix, where naming the geodatabase
  // beats a bare "format".
  const looksLikeGeodatabase = extension(workspace) === "gdb";
  if (!workspace || !dataset) {
    return looksLikeGeodatabase
      ? { reason: "file-geodatabase-raster" }
      : { reason: "missing-source" };
  }
  const path = resolveRelativePath(joinPath(workspace, dataset), projectPath);
  if (["tif", "tiff"].includes(extension(path))) return { path };
  return looksLikeGeodatabase ? { reason: "file-geodatabase-raster" } : { reason: "format" };
}

/**
 * The FeatureServer sublayer a feature layer reads, when its connection names
 * one explicitly.
 *
 * ArcGIS Pro saves a hosted feature layer as a `CIMStandardDataConnection` with
 * `workspaceFactory: "FeatureService"`, the service root in the connection
 * string (`URL=https://…/FeatureServer`) and the sublayer number as the
 * `dataset`. Only that shape is accepted: a connection without a numeric
 * dataset is reported rather than guessed as sublayer 0.
 *
 * The URL is rebuilt from scheme, host and path, so a token or user info in the
 * connection string never reaches a request, a saved project or a log.
 *
 * Plain `http:` is accepted, as Add Data accepts it on desktop, because ArcGIS
 * Server on an intranet often has no certificate; such a layer loads
 * anonymously, since a sign-in token is only ever sent over https. A browser
 * deployment whose content security policy allows only https requests (as
 * `docker/nginx.conf` does) cannot reach such a layer, so it is reported as
 * unavailable there.
 */
function featureServiceSublayerUrl(connection: CimObject | undefined): string | null {
  if (!connection || !isFeatureServiceFactory(connection)) return null;
  const dataset = stringValue(connection.dataset).trim();
  if (!/^\d+$/.test(dataset)) return null;
  const match = stringValue(connection.workspaceConnectionString).match(
    /(?:^|;)URL=(?:"([^"]+)"|([^;]+))/i,
  );
  let url: URL;
  try {
    url = new URL((match?.[1] ?? match?.[2] ?? "").trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const path = url.pathname.replace(/\/+$/, "");
  if (!/\/FeatureServer$/i.test(path)) return null;
  return `${url.origin}${path}/${dataset.replace(/^0+(?=\d)/, "")}`;
}

function isFeatureServiceFactory(connection: CimObject): boolean {
  return stringValue(connection.workspaceFactory).toLowerCase() === "featureservice";
}

function resolveDataSource(
  connection: CimObject | undefined,
  projectPath: string,
  readFileGeodatabase: boolean,
): {
  path?: string;
  fileGeodatabase?: { gdbPath: string; featureClass: string };
  reason?: ArcgisProjectImportWarning["reason"];
} {
  if (!connection) return { reason: "missing-source" };
  if (stringValue(connection.url) || isFeatureServiceFactory(connection)) {
    return { reason: "service" };
  }

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
  } else if (workspaceFactory.includes("filegdb") || extension(workspace) === "gdb") {
    // Reported distinctly from a plain unsupported "format" because a File
    // Geodatabase backs whole projects at a time -- a .gdb-based project can
    // produce hundreds of identical warnings, and "data format is not
    // supported" leaves the user with no idea which format that was, nor that
    // the desktop build can add those feature classes another way. The
    // workspace path is checked as well as the factory because not every
    // connection names one, and a .gdb workspace is a geodatabase either way.
    // Without a geodatabase and a feature class to read, report it as the
    // default path does, so Add Data → File geodatabase is still suggested.
    if (!readFileGeodatabase || !workspace || !dataset) return { reason: "file-geodatabase" };
    const gdbPath = resolveRelativePath(workspace, projectPath);
    // The path comes from the project file and the desktop sidecar does not
    // confine its reads, so only a local folder named `*.gdb` is handed to it,
    // never a plain folder, a URL or a GDAL virtual path (`/vsicurl/`,
    // `/vsizip/`). Any local geodatabase the project names is read, wherever it
    // is, as with the project's other local files: ArcGIS Pro projects often
    // use a shared geodatabase outside their own folder. Anything else stays
    // listed as a geodatabase the import did not load.
    if (!isLocalFileGeodatabasePath(gdbPath)) return { reason: "file-geodatabase" };
    return {
      fileGeodatabase: {
        gdbPath,
        featureClass: dataset,
      },
    };
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

/**
 * Whether a resolved geodatabase path is a plain local `.gdb` folder: absolute,
 * its last segment ending in `.gdb`, with no URL scheme, query or fragment, and
 * not one of GDAL's `/vsi*` virtual file systems.
 */
function isLocalFileGeodatabasePath(path: string): boolean {
  // UNC paths never get here: `resolveDataSource` refuses the raw workspace as
  // "network-path" first, and normalising collapses the leading `//` anyway.
  if (!isAbsolutePath(path)) return false;
  const normalised = path.replace(/\\/g, "/");
  if (/^\/vsi[a-z0-9_]*\//i.test(normalised)) return false;
  const segments = normalised.split("/");
  if (segments.some((segment) => /^[a-z][a-z0-9+.-]+:$/i.test(segment))) return false;
  return /\.gdb$/i.test(segments[segments.length - 1] ?? "") && !/[?#]/.test(normalised);
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
