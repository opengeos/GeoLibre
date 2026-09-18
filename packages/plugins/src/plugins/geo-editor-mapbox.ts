import {
  BaseDomMarker,
  FEATURE_ID_PROPERTY,
  type BaseDomMarkerOptions,
  type Geoman,
  type LngLatTuple,
} from "@geoman-io/maplibre-geoman-free";
import type { Feature, GeoJSON, Geometry } from "geojson";
import type { GeoEditorPopup, GeoEditorPopupOptions } from "maplibre-gl-geo-editor";
import type * as mapboxgl from "mapbox-gl";

/** The mapbox-gl namespace, as `app.getMapboxGl()` hands it out. */
export type MapboxGl = typeof mapboxgl.default;

/**
 * The mapbox-gl members this module constructs. Narrowed from the namespace so
 * a unit test can stand in fakes for the three classes.
 */
export type MapboxGlLike = Pick<MapboxGl, "Marker" | "Popup" | "LngLatBounds">;

/**
 * The mapbox-gl map members the swapped adapter methods touch, narrowed from
 * `mapboxgl.Map` for the same reason.
 */
export type MapboxGeomanMap = Pick<mapboxgl.Map, "hasImage" | "addImage" | "getSource">;

/**
 * One entry of the diff Geoman hands its source wrapper: MapLibre's
 * `GeoJSONSourceDiff`, before `hashedToDiff` flattens its sets and maps. Both
 * spellings are accepted so the mirror survives that helper moving.
 */
export interface GeomanSourceDiff {
  removeAll?: boolean;
  remove?: Iterable<string | number>;
  add?: Map<string | number, Feature> | Iterable<Feature>;
  update?: Map<string | number, GeomanFeatureDiff> | Iterable<GeomanFeatureDiff>;
}

/** MapLibre's `GeoJSONFeatureDiff`: what changed on one existing feature. */
export interface GeomanFeatureDiff {
  id: string | number;
  newGeometry?: Geometry;
  removeAllProperties?: boolean;
  removeProperties?: string[];
  addOrUpdateProperties?: { key: string; value: unknown }[];
}

/**
 * Run `@geoman-io/maplibre-geoman-free` on a mapbox-gl map.
 *
 * Geoman routes every engine call through one adapter object
 * (`geoman.mapAdapter`), and its MapLibre adapter takes only three things from
 * `maplibre-gl` itself: a `Marker` for each vertex handle and the cursor
 * marker, a `LngLatBounds` to turn the cut tool's polygon into a screen-space
 * query box, and the promise that MapLibre's `map.loadImage` returns for the
 * default marker icon. None of those run on a mapbox-gl map: MapLibre's
 * `Marker` reads `map._camera.transform` and throws on `addTo`, and mapbox-gl's
 * `loadImage` is callback-based, so Geoman's `await` sees `undefined` and its
 * whole initialization fails. A fourth difference sits one level down: Geoman
 * keeps its GeoJSON sources current with MapLibre's `GeoJSONSource.updateData`
 * *diffs* (add / remove / per-feature update). mapbox-gl has a method of that
 * name, but it is an upsert of whole features on `dynamic` sources and rejects
 * a diff ("Data to update should be a feature or a feature collection"), so
 * every vertex drag and shape commit would be refused with a map `error`
 * event and Geoman's display would freeze while its feature store moved on.
 * Everything else the adapter calls (`addLayer`, `queryRenderedFeatures`,
 * `project`, `dragPan`, events) is the Style Spec surface both engines share.
 *
 * Replaces those three members on the adapter instance with mapbox-gl's
 * equivalents, and gives each source wrapper Geoman creates a feature mirror
 * that applies the diffs here and pushes the result with `setData`. Call it
 * synchronously after constructing the `Geoman`: its initialization is
 * deferred to a microtask, so the swap lands before the first `loadImage`.
 *
 * @param geoman - The Geoman instance built on the Mapbox map.
 * @param gl - The mapbox-gl namespace (`app.getMapboxGl()`).
 * @param map - The mapbox-gl map Geoman was built on (`app.getMapboxMap()`).
 */
export function adaptGeomanToMapbox(geoman: Geoman, gl: MapboxGlLike, map: MapboxGeomanMap): void {
  const adapter = geoman.mapAdapter;
  const addSource = adapter.addSource.bind(adapter);
  adapter.addSource = (sourceId, geoJson) => {
    // Geoman keeps the wrapper this returns (`features.sources[name]`) and
    // routes every later `setData` / `updateData` through it.
    const wrapper = addSource(sourceId, geoJson);
    mirrorGeomanSource(wrapper, geoJson, () => map.getSource(sourceId) as MapboxGeoJSONSource);
    return wrapper;
  };
  adapter.createDomMarker = (options, lngLat) =>
    new MapboxDomMarker(gl, adapter.getMapInstance() as unknown as mapboxgl.Map, options, lngLat);
  adapter.coordBoundsToScreenBounds = (bounds) => {
    const box = new gl.LngLatBounds(bounds);
    return [
      adapter.project(box.getSouthWest().toArray()),
      adapter.project(box.getNorthEast().toArray()),
    ];
  };
  adapter.loadImage = async ({ id, image }) => {
    if (map.hasImage(id)) return;
    const element = await loadImageElement(image);
    // Geoman may have been torn down, or a second load may have won, while the
    // image decoded.
    if (!map.hasImage(id)) map.addImage(id, element);
  };
}

/**
 * `maplibre-gl-geo-editor`'s `createPopup` option for a Mapbox map: the
 * numerical-rotation form and the read-only feature-properties popup come
 * from mapbox-gl's `Popup`, whose surface matches the editor's contract as is.
 *
 * @param gl - The mapbox-gl namespace (`app.getMapboxGl()`).
 * @returns The factory to pass as `createPopup`.
 */
export function mapboxGeoEditorPopupFactory(
  gl: MapboxGlLike,
): (options: GeoEditorPopupOptions) => GeoEditorPopup {
  return (options) => new gl.Popup(options);
}

/** The one member of mapbox-gl's `GeoJSONSource` the mirror pushes through. */
type MapboxGeoJSONSource = Pick<mapboxgl.GeoJSONSource, "setData"> | undefined;

/** The two members of Geoman's source wrapper the mirror takes over. */
interface GeomanSourceWrapper {
  setData(data: GeoJSON): Promise<void>;
  updateData(diff: GeomanSourceDiff): Promise<void>;
}

/**
 * Keep a source wrapper's features here and replace the whole source on every
 * change, since mapbox-gl cannot take MapLibre's diffs. Geoman creates each
 * source empty and only ever changes it through the wrapper, so the mirror is
 * complete from the first call.
 *
 * Exported for the unit test; the plugin reaches it through
 * {@link adaptGeomanToMapbox}.
 */
export function mirrorGeomanSource(
  wrapper: GeomanSourceWrapper,
  initial: GeoJSON,
  source: () => MapboxGeoJSONSource,
): void {
  const features = new Map<string | number, Feature>();
  replaceFeatures(features, initial);
  wrapper.setData = async (data) => {
    replaceFeatures(features, data);
    source()?.setData(data);
  };
  wrapper.updateData = async (diff) => {
    applyGeomanDiff(features, diff);
    source()?.setData({ type: "FeatureCollection", features: [...features.values()] });
  };
}

/**
 * Reseed the mirror from a whole collection. Cloned for the same reason as the
 * diff's additions: later diffs update the mirrored copies in place, and the
 * objects handed in here are Geoman's (or the caller's) own.
 */
function replaceFeatures(features: Map<string | number, Feature>, data: GeoJSON): void {
  features.clear();
  const list: Feature[] =
    data.type === "FeatureCollection" ? data.features : data.type === "Feature" ? [data] : [];
  for (const feature of list) {
    const id = featureIdOf(feature);
    if (id !== undefined) features.set(id, structuredClone(feature));
  }
}

/**
 * Apply one MapLibre-style diff the way MapLibre's worker does: removals, then
 * additions (an existing id is replaced), then in-place updates of features
 * that exist (an unknown id is ignored). Additions are cloned so Geoman's
 * later edits to its own objects do not leak into the mirrored copy.
 */
export function applyGeomanDiff(
  features: Map<string | number, Feature>,
  diff: GeomanSourceDiff,
): void {
  if (diff.removeAll) features.clear();
  for (const id of diff.remove ?? []) features.delete(id);
  const additions = diff.add instanceof Map ? diff.add.values() : (diff.add ?? []);
  for (const feature of additions) {
    const id = featureIdOf(feature);
    if (id !== undefined) features.set(id, structuredClone(feature));
  }
  const updates = diff.update instanceof Map ? diff.update.values() : (diff.update ?? []);
  for (const update of updates) {
    const feature = features.get(update.id);
    if (!feature) continue;
    if (update.newGeometry) feature.geometry = structuredClone(update.newGeometry);
    if (update.removeAllProperties) feature.properties = {};
    else if (update.removeProperties?.length && feature.properties) {
      for (const key of update.removeProperties) delete feature.properties[key];
    }
    if (update.addOrUpdateProperties?.length) {
      feature.properties ??= {};
      for (const { key, value } of update.addOrUpdateProperties) feature.properties[key] = value;
    }
  }
}

/**
 * The id a diff refers to: Geoman promotes its own id property
 * (`promoteId: FEATURE_ID_PROPERTY`), so that wins over `feature.id`, as it
 * does in MapLibre's worker.
 */
function featureIdOf(feature: Feature): string | number | undefined {
  const promoted = feature.properties?.[FEATURE_ID_PROPERTY];
  if (typeof promoted === "string" || typeof promoted === "number") return promoted;
  return feature.id;
}

/** Geoman's DOM marker, backed by mapbox-gl's `Marker` instead of MapLibre's. */
class MapboxDomMarker extends BaseDomMarker<mapboxgl.Marker> {
  markerInstance: mapboxgl.Marker | null;

  constructor(
    gl: MapboxGlLike,
    map: mapboxgl.Map,
    options: BaseDomMarkerOptions,
    lngLat: LngLatTuple,
  ) {
    super();
    this.markerInstance = new gl.Marker(options).setLngLat(lngLat).addTo(map);
  }

  getElement(): HTMLElement | null {
    return this.markerInstance?.getElement() ?? null;
  }

  setLngLat(lngLat: LngLatTuple): void {
    this.markerInstance?.setLngLat(lngLat);
  }

  getLngLat(): LngLatTuple {
    return this.markerInstance?.getLngLat().toArray() ?? [0, 0];
  }

  remove(): void {
    this.markerInstance?.remove();
    this.markerInstance = null;
  }
}

/** Decode an image URL (Geoman passes a data URL) into an element `addImage` accepts. */
function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const element = new Image();
    // A data URL needs no CORS, but a remote icon would otherwise taint the
    // WebGL texture `addImage` uploads and throw a security error.
    element.crossOrigin = "anonymous";
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error(`Could not load the editor marker image: ${src}`));
    element.src = src;
  });
}
