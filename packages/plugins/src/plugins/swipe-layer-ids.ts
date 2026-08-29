import { nativeLayerIdPrefix, sourceId } from "@geolibre/map/style-layer-ids";
import { pmtilesIdsForSourceLayers } from "@geolibre/map/pmtiles-layer";

/**
 * Resolving the project layer ids a saved swipe carries into the MapLibre style
 * layer ids the swipe control actually drives.
 *
 * `SwipeControl` splits the map by toggling **style layer** visibility, and
 * matches its `leftLayers`/`rightLayers` against `getStyle().layers` by exact
 * id. A project (`.geolibre.json`) instead names layers by their **store** id —
 * that is what the Python `authoring.add_swipe` and the MCP `add_swipe` tool
 * write, and it is all they can write: a GeoJSON layer draws through several
 * style layers, and vector-tile/MBTiles/PMTiles ids embed source-layer names
 * that only the running app knows. A side holding an id the control cannot
 * match assigns the layer to neither half, so it stays drawn across the whole
 * map — the bug in #2161, of which #2155 fixed the single-style-layer raster
 * case in Python.
 *
 * The app is the one place that can close the gap, because it can read the live
 * style. These helpers expand each project id into the style layer ids that
 * currently draw it, keeping the project id in the list so the saved file stays
 * portable and re-resolves on the next load.
 */

/** A style layer as the resolver needs to see it. */
export interface SwipeStyleLayer {
  /** The MapLibre style layer id. */
  id: string;
  /** The style layer's source id, when it has one (a `background` layer has none). */
  source?: string;
}

/** A store layer as the resolver needs to see it. */
export interface SwipeProjectLayer {
  id: string;
  source?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** The outcome of expanding one side's ids. */
export interface SwipeSideResolution {
  /** The side's ids, with every resolvable project id followed by its style layer ids. */
  ids: string[];
  /**
   * The style layer ids contributed for each project id on this pass, to carry
   * into the next one as `contributed`. Only ids not already recorded there, so
   * the caller accumulates a per-project-id set of everything ever contributed.
   */
  contributed: Map<string, string[]>;
  /** Whether {@link ids} differs from the side it was resolved from. */
  changed: boolean;
}

/** `metadata.nativeLayerIds`, the ids a control created itself, when present. */
function nativeLayerIds(projectLayer: SwipeProjectLayer | undefined): string[] {
  const ids = projectLayer?.metadata?.nativeLayerIds;
  return stringList(ids);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringField(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * The style layer ids a PMTiles layer's own source layers draw under.
 *
 * PMTiles is the one type the rules in {@link styleLayerIdsForProjectLayer} miss:
 * its style layers are named `<sourceId>-<sourceLayer>-<kind>` with no
 * `layer-` prefix, its source id is the archive's rather than the layer's
 * derived one, and a project written by the Python authoring API carries only a
 * placeholder in `metadata.nativeLayerIds`. Matching on the source alone would
 * over-reach for a split archive, where several store layers read one source, so
 * the candidates are narrowed to the ids this layer's source layers can produce.
 *
 * @param projectLayer - The PMTiles store layer.
 * @param styleLayers - The style layers currently on the map.
 * @returns The matching style layer ids, or an empty list for any other type.
 */
function pmtilesStyleLayerIds(
  projectLayer: SwipeProjectLayer,
  styleLayers: readonly SwipeStyleLayer[],
): string[] {
  const archiveSourceId = stringField(
    projectLayer.metadata?.sourceId,
    projectLayer.source?.sourceId,
    projectLayer.id,
  );
  if (!archiveSourceId) return [];
  const sourceLayers = stringList(
    projectLayer.source?.sourceLayers ?? projectLayer.metadata?.sourceLayers,
  );
  if (sourceLayers.length === 0) return [];

  const candidates = styleLayers
    .filter((styleLayer) => styleLayer.source === archiveSourceId)
    .map((styleLayer) => styleLayer.id);
  return pmtilesIdsForSourceLayers(candidates, archiveSourceId, sourceLayers);
}

/**
 * The style layer ids currently drawing one store layer.
 *
 * Read off the live style rather than derived, because the derived forms differ
 * per layer type and per style options (`layer-<id>-fill`/`-line`/`-circle` and
 * decorations for GeoJSON, `layer-<id>-raster` for rasters,
 * `layer-<id>-vector-<sourceLayer>-<kind>` and the MBTiles equivalent for tiled
 * vectors, and an arbitrary control-chosen set for PMTiles). Three signals,
 * because no single one covers every type:
 *
 * - `metadata.nativeLayerIds` — the ids a control created itself (every
 *   `externalNativeLayer`), which follow no shared scheme;
 * - the {@link nativeLayerIdPrefix} shared by every id `syncLayers` derives;
 * - the layer's own GeoJSON source and the derived ones beside it
 *   (`source-<id>-label`, `-inverted`, `-generator`), which catch a render layer
 *   named outside the prefix scheme;
 * - {@link pmtilesStyleLayerIds}, for the one scheme none of the above reaches.
 *
 * @param projectLayerId - The store layer id to resolve.
 * @param styleLayers - The style layers currently on the map.
 * @param projectLayer - The store layer, when it is still in the project.
 * @returns The matching style layer ids, in the order given.
 */
export function styleLayerIdsForProjectLayer(
  projectLayerId: string,
  styleLayers: readonly SwipeStyleLayer[],
  projectLayer?: SwipeProjectLayer,
): string[] {
  const prefix = nativeLayerIdPrefix(projectLayerId);
  const ownSource = sourceId(projectLayerId);
  const native = new Set(nativeLayerIds(projectLayer));
  const pmtiles = projectLayer ? new Set(pmtilesStyleLayerIds(projectLayer, styleLayers)) : null;

  return styleLayers
    .filter(
      (styleLayer) =>
        native.has(styleLayer.id) ||
        styleLayer.id.startsWith(prefix) ||
        styleLayer.source === ownSource ||
        styleLayer.source?.startsWith(`${ownSource}-`) === true ||
        pmtiles?.has(styleLayer.id) === true,
    )
    .map((styleLayer) => styleLayer.id);
}

/**
 * Expand one swipe side's ids so the control can match them.
 *
 * Ids that are already style layer ids and ids a `SwipeLayerProvider`
 * contributes (deck.gl COG/raster overlays, which the provider assigns by store
 * id itself) are passed through untouched. The rest are expanded in place, each
 * project id kept ahead of the style ids it resolved to.
 *
 * Expansion is **incremental**: a project id keeps resolving on every pass, and
 * only style layer ids not already in `contributed` are added. A store layer's
 * style layers are added to the map one `map.addLayer` call at a time, each
 * firing its own `styledata`, so a pass can catch a GeoJSON layer with only its
 * fill layer up; the next pass then adds the line and circle layers. Recording
 * what was contributed is what keeps that from fighting the panel: a checkbox
 * the user clears is never re-checked, because that id has been contributed
 * already.
 *
 * @param sideIds - The side's current ids.
 * @param options - The live style, the project's layers, the provider's ids, and
 *   the style layer ids contributed for each project id on earlier passes.
 * @returns The expanded ids plus the bookkeeping for the next pass.
 */
export function resolveSwipeSideIds(
  sideIds: readonly string[],
  options: {
    styleLayers: readonly SwipeStyleLayer[];
    projectLayers: readonly SwipeProjectLayer[];
    providerLayerIds?: ReadonlySet<string>;
    contributed?: ReadonlyMap<string, ReadonlySet<string>>;
  },
): SwipeSideResolution {
  const styleLayerIds = new Set(options.styleLayers.map((styleLayer) => styleLayer.id));
  const projectLayersById = new Map(
    options.projectLayers.map((projectLayer) => [projectLayer.id, projectLayer]),
  );
  const present = new Set(sideIds);
  const ids: string[] = [];
  const seen = new Set<string>();
  const contributed = new Map<string, string[]>();
  let changed = false;

  const push = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };

  for (const id of sideIds) {
    push(id);
    if (styleLayerIds.has(id)) continue;
    if (options.providerLayerIds?.has(id)) continue;

    const projectLayer = projectLayersById.get(id);
    // An id that names nothing in the project — the control's grouped
    // `__basemap__` entry, or a layer since removed — never resolves to
    // anything, so it is left alone.
    if (!projectLayer) continue;

    const already = options.contributed?.get(id);
    const matched = styleLayerIdsForProjectLayer(id, options.styleLayers, projectLayer);
    const fresh = matched.filter((matchedId) => already?.has(matchedId) !== true);
    if (fresh.length > 0) contributed.set(id, fresh);
    // Keep what is new plus what the side already holds (moved up beside the
    // project id it belongs to). An id contributed earlier and no longer on the
    // side is one the user cleared, so it is not put back.
    for (const matchedId of matched) {
      if (already?.has(matchedId) === true && !present.has(matchedId)) continue;
      if (!present.has(matchedId)) changed = true;
      push(matchedId);
    }
  }

  return { ids, contributed, changed };
}
