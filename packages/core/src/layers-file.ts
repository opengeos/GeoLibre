// A layers file holds a set of layer records that point at their data rather
// than carry it: tile and service URLs, remote files, and absolute local paths
// the desktop app can re-read. Project → Export → Export Layers writes one, and
// the Startup setting adds its layers to every untitled workspace (at launch
// and on File → New). Layers whose features exist only in memory are left out,
// so the file stays small enough to keep a copy of in the desktop settings.

import { hasRestorableLayerSource, layerLocalPath } from "./layer-library";
import { createDefaultMapView, isSessionOnlyLayer, parseProject } from "./project";
import {
  LAYER_TYPES,
  PROJECT_VERSION,
  type GeoLibreLayer,
  type GeoLibreProject,
  type LayerGroup,
} from "./types";

/** `type` tag identifying a layers file. */
export const LAYERS_FILE_TYPE = "geolibre-layers";

/** Format version written by {@link serializeLayersFile}. */
export const LAYERS_FILE_VERSION = 1;

/**
 * Size ceiling for a layers file, in UTF-8 bytes. A file of references is a few
 * kilobytes per layer, and the Startup setting keeps a parsed copy in the
 * desktop settings (localStorage), so a file past this is refused rather than
 * crowding out the rest of the settings.
 */
export const MAX_LAYERS_FILE_BYTES = 1024 * 1024;

/** The layers and the folders they sit in. */
export interface LayersFileContent {
  /** Layer records in store (bottom-to-top) order. */
  layers: GeoLibreLayer[];
  /** The folders the layers belong to, with their ancestors. */
  layerGroups: LayerGroup[];
}

/** The on-disk layers document. */
export interface LayersFile extends LayersFileContent {
  type: typeof LAYERS_FILE_TYPE;
  version: typeof LAYERS_FILE_VERSION;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** A `blob:` or `data:` URL is the data itself, not a reference to it. */
function isInlineUrl(value: unknown): boolean {
  return typeof value === "string" && /^\s*(blob|data):/i.test(value);
}

function hasInlineUrl(layer: GeoLibreLayer): boolean {
  const source = layer.source ?? {};
  const tiles = Array.isArray(source.tiles) ? source.tiles : [];
  return (
    isInlineUrl(source.url) ||
    isInlineUrl(source.data) ||
    tiles.some(isInlineUrl) ||
    isInlineUrl(layer.sourcePath) ||
    isInlineUrl((layer.metadata ?? {}).originalUrl)
  );
}

/**
 * Whether a layer (in its saved form) points at its data rather than carrying
 * it: it has a re-fetchable source, an http(s) source path, or an absolute
 * local path the desktop app re-reads, and holds no inline features.
 *
 * @param layer - A layer as `projectFromStore` writes it.
 * @returns True when the layer can go in a layers file.
 */
export function isReferencedLayer(layer: GeoLibreLayer): boolean {
  if (isSessionOnlyLayer(layer)) return false;
  if (layer.geojson) return false;
  const source = layer.source ?? {};
  const metadata = layer.metadata ?? {};
  if (source.data !== undefined && typeof source.data !== "string") return false;
  if (source.czmlData !== undefined) return false;
  if (metadata.embeddedGeoJSON !== undefined) return false;
  if (hasInlineUrl(layer)) return false;
  return (
    hasRestorableLayerSource(layer) ||
    layerLocalPath(layer) !== undefined ||
    isHttpUrl(layer.sourcePath)
  );
}

/** Folders the given layers sit in, plus every ancestor, in their original order. */
function groupsForLayers(
  layers: readonly GeoLibreLayer[],
  groups: readonly LayerGroup[],
): LayerGroup[] {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const keep = new Set<string>();
  for (const layer of layers) {
    let id = layer.groupId;
    // The `keep` check also stops a hand-edited parent cycle.
    while (id && !keep.has(id) && byId.has(id)) {
      keep.add(id);
      id = byId.get(id)?.parentId;
    }
  }
  return groups.filter((group) => keep.has(group.id));
}

/**
 * Pick the layers of a saved project that can go in a layers file.
 *
 * @param project - A project as `projectFromStore` writes it. A host that can
 *   re-fetch a layer's features (a GeoJSON layer loaded from a URL) strips its
 *   `geojson` first, so the layer counts as a reference here.
 * @returns The file content, and the names of the layers left out because they
 *   carry their data inline.
 */
export function extractLayersFileContent(
  project: Pick<GeoLibreProject, "layers" | "layerGroups">,
): { content: LayersFileContent; skipped: string[] } {
  const layers: GeoLibreLayer[] = [];
  const skipped: string[] = [];
  for (const layer of project.layers) {
    if (isReferencedLayer(layer)) layers.push(layer);
    else if (!isSessionOnlyLayer(layer)) skipped.push(layer.name);
  }
  return {
    content: { layers, layerGroups: groupsForLayers(layers, project.layerGroups ?? []) },
    skipped,
  };
}

/**
 * Serialize layers into the JSON written by Export Layers.
 *
 * @param content - The layers and their folders.
 * @returns Pretty-printed file content.
 */
export function serializeLayersFile(content: LayersFileContent): string {
  const file: LayersFile = {
    type: LAYERS_FILE_TYPE,
    version: LAYERS_FILE_VERSION,
    layers: [...content.layers],
    layerGroups: [...content.layerGroups],
  };
  return JSON.stringify(file, null, 2);
}

/**
 * Coerce untrusted layers (a hand-edited file, or the copy kept in settings)
 * into clean ones. Each layer goes through the same normalization a project
 * file's layers do; one without an id, a name, a known type, or a reference to
 * its data is dropped, as is a repeated id.
 *
 * @param value - An object with `layers` and optional `layerGroups` arrays.
 * @returns The usable layers and the folders they sit in.
 */
export function normalizeLayersFileContent(value: unknown): LayersFileContent {
  const empty: LayersFileContent = { layers: [], layerGroups: [] };
  if (!isPlainObject(value) || !Array.isArray(value.layers)) return empty;
  try {
    return normalizeLayers(value.layers, value.layerGroups);
  } catch {
    // A corrupt copy in settings must not break loading the rest of them.
    return empty;
  }
}

/**
 * The body of {@link normalizeLayersFileContent}, which catches what it throws.
 *
 * @param rawLayers - The raw `layers` array.
 * @param rawGroups - The raw `layerGroups` value.
 * @returns The usable layers and the folders they sit in, or nothing when the
 *   layers are past {@link MAX_LAYERS_FILE_BYTES}.
 */
function normalizeLayers(rawLayers: unknown[], rawGroups: unknown): LayersFileContent {
  const seen = new Set<string>();
  const candidates = rawLayers.filter((layer): layer is Record<string, unknown> => {
    if (!isPlainObject(layer)) return false;
    if (typeof layer.id !== "string" || !layer.id.trim() || seen.has(layer.id)) return false;
    if (typeof layer.name !== "string") return false;
    if (!(LAYER_TYPES as readonly unknown[]).includes(layer.type)) return false;
    if (!isPlainObject(layer.source)) return false;
    seen.add(layer.id);
    return true;
  });
  // Borrow the project parser rather than duplicate its per-layer rules: the
  // layers below are exactly what a project file with only these layers holds.
  // The round trip through JSON also bounds the size of what is kept.
  const json = JSON.stringify({
    version: PROJECT_VERSION,
    name: "layers",
    mapView: createDefaultMapView(),
    layers: candidates.map((layer) => ({
      ...layer,
      metadata: isPlainObject(layer.metadata) ? layer.metadata : {},
      style: isPlainObject(layer.style) ? layer.style : {},
    })),
    layerGroups: Array.isArray(rawGroups) ? rawGroups : [],
  });
  if (new TextEncoder().encode(json).length > MAX_LAYERS_FILE_BYTES) {
    return { layers: [], layerGroups: [] };
  }
  const parsed = parseProject(json);
  const layers = parsed.layers.filter(isReferencedLayer);
  return { layers, layerGroups: groupsForLayers(layers, parsed.layerGroups ?? []) };
}

/**
 * Parse a file written by {@link serializeLayersFile}.
 *
 * @param json - The file content.
 * @returns The normalized layers and folders.
 * @throws Error when the content is too large, is not a layers file, comes
 *   from a newer format version, or holds no usable layers.
 */
export function parseLayersFile(json: string): LayersFileContent {
  if (new TextEncoder().encode(json).length > MAX_LAYERS_FILE_BYTES) {
    throw new Error("The layers file is too large. Keep it under 1 MB.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Not a valid layers file (invalid JSON).");
  }
  if (!isPlainObject(parsed) || parsed.type !== LAYERS_FILE_TYPE) {
    throw new Error("Not a valid layers file.");
  }
  // Refuse a newer format rather than misread it with this version's rules.
  if (parsed.version !== LAYERS_FILE_VERSION) {
    throw new Error("Unsupported layers file version.");
  }
  const content = normalizeLayersFileContent(parsed);
  if (content.layers.length === 0) {
    throw new Error("The layers file holds no usable layers.");
  }
  return content;
}

/**
 * Add a layers file's layers on top of a project's own, keeping the project's
 * layers where an id repeats.
 *
 * @param project - The project to add to (usually a new, empty one).
 * @param content - The layers and folders to add.
 * @returns A new project with the layers added.
 */
export function addLayersToProject(
  project: GeoLibreProject,
  content: LayersFileContent,
): GeoLibreProject {
  const layerIds = new Set(project.layers.map((layer) => layer.id));
  const groups = project.layerGroups ?? [];
  const groupIds = new Set(groups.map((group) => group.id));
  const layers = content.layers.filter((layer) => !layerIds.has(layer.id));
  const layerGroups = content.layerGroups.filter((group) => !groupIds.has(group.id));
  return {
    ...project,
    layers: [...project.layers, ...structuredClone(layers)],
    layerGroups: [...groups, ...structuredClone(layerGroups)],
  };
}
