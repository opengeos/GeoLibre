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
 * @param collection - A layer's `geojson`, or undefined.
 * @returns True when the collection came from {@link rememberFetchedGeoJson}.
 */
export function isFetchedGeoJson(collection: FeatureCollection | undefined): boolean {
  return collection !== undefined && fetchedCollections.has(collection);
}

/**
 * The URL a plain GeoJSON layer's features should be fetched from, or null.
 *
 * A `type: "geojson"` layer renders from its inline `geojson`. A project file
 * (or an embed `addLayer` spec) may instead point at the data with
 * `source.data` (MapLibre's own spelling) or `source.url`, in which case the
 * features are fetched when the layer is restored. Only plain layers qualify:
 * layers owned by a control or plugin (`metadata.sourceKind`,
 * `metadata.externalNativeLayer`) and desktop local-file layers
 * (`metadata.localFileReloadable`) have their own restore paths.
 *
 * Accepted URLs are absolute http(s) URLs and root-relative paths, which are
 * resolved against `baseUrl` (the page the app is served from). Pass `null`
 * where the page is not a web server (the desktop app), so a leading `/` —
 * there an OS path such as `/home/…` — is never fetched.
 *
 * @param layer - A store layer.
 * @param baseUrl - The URL root-relative paths resolve against, or null to
 *   accept absolute http(s) URLs only.
 * @returns The absolute URL to fetch, or null when the layer needs no fetch.
 */
export function remoteGeoJsonUrl(
  layer: Pick<GeoLibreLayer, "type" | "geojson" | "source" | "metadata">,
  baseUrl: string | null,
): string | null {
  if (layer.type !== "geojson" || layer.geojson) return null;
  const metadata = layer.metadata ?? {};
  if (
    metadata.sourceKind != null ||
    metadata.externalNativeLayer === true ||
    metadata.localFileReloadable === true
  ) {
    return null;
  }
  const source = layer.source ?? {};
  const candidates = [source.data, source.url];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const value = candidate.trim();
    if (!value) continue;
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
