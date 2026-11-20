import type { FeatureCollection } from "geojson";
import type { GeoLibreLayer } from "./types";

/**
 * Feature collections GeoLibre fetched from a layer's `source.data` /
 * `source.url` rather than read from the project file.
 *
 * Tracked by identity, not by a metadata flag, so nothing about the fetch is
 * persisted: the store replaces `layer.geojson` with a new object on any edit,
 * which drops the layer out of this set and makes a save embed the edited
 * features instead of discarding them. A copy that loses identity some other
 * way (a cloned history snapshot) is likewise embedded — the safe direction.
 */
const fetchedCollections = new WeakSet<object>();

/**
 * Record that a FeatureCollection was fetched from its layer's source URL, so
 * {@link isFetchedGeoJson} lets a project save leave it out of the file.
 *
 * @param collection - The FeatureCollection about to be written to `layer.geojson`.
 * @returns The same collection, for chaining into the store update.
 */
export function rememberFetchedGeoJson<T extends FeatureCollection>(collection: T): T {
  fetchedCollections.add(collection);
  return collection;
}

/**
 * Whether a layer's `geojson` is the unedited copy fetched from its source URL.
 *
 * Relies on the store's invariant that every edit replaces `layer.geojson`
 * with a new object; an in-place mutation of a fetched collection would be
 * mistaken for the unedited download and dropped on save.
 *
 * @param collection - A layer's `geojson`, or undefined.
 * @returns True when the collection came from {@link rememberFetchedGeoJson}.
 */
export function isFetchedGeoJson(collection: FeatureCollection | undefined): boolean {
  return collection !== undefined && fetchedCollections.has(collection);
}

/** The layer fields the remote-GeoJSON helpers read. */
export type RemoteGeoJsonLayer = Pick<GeoLibreLayer, "type" | "geojson" | "source" | "metadata">;

/**
 * The string references a plain GeoJSON layer names its data by, in the order
 * they are tried, or an empty list when the layer is not one that is fetched.
 *
 * A `type: "geojson"` layer renders from its inline `geojson`. A project file
 * (or an embed `addLayer` spec) may instead point at the data with
 * `source.data` (MapLibre's own spelling) or `source.url`. Only plain layers
 * qualify: layers owned by a control or plugin (`metadata.sourceKind`,
 * `metadata.externalNativeLayer`) and desktop local-file layers
 * (`metadata.localFileReloadable`) have their own restore paths.
 *
 * @param layer - A store layer.
 * @returns The non-empty trimmed `source.data` / `source.url` strings.
 */
export function geoJsonSourceReferences(layer: RemoteGeoJsonLayer): string[] {
  if (layer.type !== "geojson" || layer.geojson) return [];
  const metadata = layer.metadata ?? {};
  if (
    metadata.sourceKind != null ||
    metadata.externalNativeLayer === true ||
    metadata.localFileReloadable === true
  ) {
    return [];
  }
  const source = layer.source ?? {};
  return [source.data, source.url]
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => candidate.trim())
    .filter(Boolean);
}

/**
 * The URL a plain GeoJSON layer's features should be fetched from, or null.
 *
 * Tries each of {@link geoJsonSourceReferences}. Accepted are absolute http(s)
 * URLs and root-relative paths, which are resolved against `baseUrl` (the page
 * the app is served from). Pass `null` where the page is not a web server (the
 * desktop app), so a leading `/` — there an OS path such as `/home/…` — is
 * never fetched. A layer with references but no fetchable URL gets null too;
 * callers tell that apart with {@link geoJsonSourceReferences}.
 *
 * @param layer - A store layer.
 * @param baseUrl - The URL root-relative paths resolve against, or null to
 *   accept absolute http(s) URLs only.
 * @returns The absolute URL to fetch, or null when there is none.
 */
export function remoteGeoJsonUrl(layer: RemoteGeoJsonLayer, baseUrl: string | null): string | null {
  for (const value of geoJsonSourceReferences(layer)) {
    const isAbsolute = /^https?:\/\//i.test(value);
    // The URL parser reads `\` as `/` and drops tabs and newlines, so
    // `/\host/x` or `/<tab>/host/x` would otherwise resolve to another origin.
    const isRootRelative =
      baseUrl !== null && value.startsWith("/") && !/^\/[\\/\t\r\n]/.test(value);
    if (!isAbsolute && !isRootRelative) continue;
    try {
      return new URL(value, baseUrl ?? undefined).href;
    } catch {
      continue;
    }
  }
  return null;
}
