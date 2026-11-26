/**
 * Pure helpers behind the Offline Basemap Extract panel: the editable
 * bounding-box fields, zoom validation, the archive URL to seed the form with,
 * and the checks that decide whether an archive can render as a styled
 * Protomaps basemap.
 */

/** Remembered across sessions so repeat extracts don't retype the archive URL. */
export const URL_STORAGE_KEY = "geolibre.basemapExtract.url";

/** GeoLibre's Cloudflare Worker (workers/tiles) range-proxies the Protomaps
 * daily planet builds with CORS. */
export const PLANET_PROXY_PREFIX = "https://tiles.geolibre.app/pmtiles/";

/**
 * Default archive URL: the latest Protomaps planet build through the proxy. The
 * Worker resolves `latest` to the newest daily build, so this URL is always
 * current (no client-side date to go stale) and works from any origin —
 * build.protomaps.com itself only allowlists a few and has no `latest` alias.
 */
export const DEFAULT_ARCHIVE_URL = `${PLANET_PROXY_PREFIX}latest.pmtiles`;

/** Above this planned size the user must explicitly confirm the download. */
export const CONFIRM_BYTES = 150 * 1024 * 1024;

/** The highest zoom a saved package may start at, whatever the map allows. */
const MAX_PACKAGE_MIN_ZOOM = 24;

/** An ordered `[west, south, east, north]` box in degrees. */
export type Bbox = [number, number, number, number];

/** The four editable bounding-box fields, held as strings so partial edits
 * (a lone "-", an in-progress decimal) don't fight the controlled inputs. */
export interface CoordFields {
  west: string;
  south: string;
  east: string;
  north: string;
}

export const EMPTY_COORDS: CoordFields = { west: "", south: "", east: "", north: "" };

/**
 * Round a coordinate to a readable-but-precise 6 decimal places.
 *
 * Args:
 *   value: The coordinate in degrees.
 *
 * Returns:
 *   The rounded value without trailing zeros.
 */
export function fmtCoord(value: number): string {
  return Number(value.toFixed(6)).toString();
}

/**
 * Parse the four coordinate fields into an ordered box.
 *
 * Args:
 *   coords: The form's coordinate fields.
 *
 * Returns:
 *   The box, or `null` if any field is missing, out of the valid lng/lat
 *   range, or the box is degenerate.
 */
export function parseBbox(coords: CoordFields): Bbox | null {
  const west = Number(coords.west);
  const south = Number(coords.south);
  const east = Number(coords.east);
  const north = Number(coords.north);
  if (
    coords.west === "" ||
    coords.south === "" ||
    coords.east === "" ||
    coords.north === "" ||
    !Number.isFinite(west) ||
    !Number.isFinite(south) ||
    !Number.isFinite(east) ||
    !Number.isFinite(north) ||
    west < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90 ||
    west >= east ||
    south >= north
  ) {
    return null;
  }
  return [west, south, east, north];
}

/**
 * Whether every field is filled in but they do not form a valid box, which is
 * when the panel shows its "invalid box" hint.
 *
 * Args:
 *   coords: The form's coordinate fields.
 *
 * Returns:
 *   True for a complete but invalid box.
 */
export function isBboxInvalid(coords: CoordFields): boolean {
  return (
    parseBbox(coords) === null &&
    coords.west !== "" &&
    coords.south !== "" &&
    coords.east !== "" &&
    coords.north !== ""
  );
}

/**
 * Coordinate fields from an ordered box, clamped to the valid lng/lat range so
 * a low-zoom "use view" that reads past ±180/±90 still forms a valid box.
 *
 * Args:
 *   bbox: The box to show.
 *
 * Returns:
 *   The formatted coordinate fields.
 */
export function coordsFromBbox(bbox: Bbox): CoordFields {
  return {
    west: fmtCoord(Math.max(bbox[0], -180)),
    south: fmtCoord(Math.max(bbox[1], -90)),
    east: fmtCoord(Math.min(bbox[2], 180)),
    north: fmtCoord(Math.min(bbox[3], 90)),
  };
}

/**
 * Whether the min/max zoom fields fail to form an integer range within 0–30.
 *
 * Args:
 *   minZoom: The minimum zoom field.
 *   maxZoom: The maximum zoom field.
 *
 * Returns:
 *   True when the range cannot be extracted.
 */
export function isZoomRangeInvalid(minZoom: string, maxZoom: string): boolean {
  const minZoomValue = Number(minZoom);
  const maxZoomValue = Number(maxZoom);
  return (
    minZoom === "" ||
    maxZoom === "" ||
    !Number.isInteger(minZoomValue) ||
    !Number.isInteger(maxZoomValue) ||
    minZoomValue < 0 ||
    maxZoomValue > 30 ||
    minZoomValue > maxZoomValue
  );
}

/**
 * The translation key explaining why a package that starts at `minZoom` cannot
 * be shown, or `null` when the map can display it.
 *
 * A package whose lowest zoom is past the map's maximum zoom (capped at 24)
 * would never draw. Past 24 no setting can show it, which gets its own message.
 *
 * Args:
 *   minZoom: The package's (or requested) minimum zoom.
 *   mapMaxZoom: The map's configured maximum zoom.
 *   saved: Whether the message is about an already saved package.
 *
 * Returns:
 *   The `basemapExtract.*` key to show, or `null`.
 */
export function packageZoomErrorKey(
  minZoom: number,
  mapMaxZoom: number,
  saved = false,
): string | null {
  if (minZoom <= Math.min(MAX_PACKAGE_MIN_ZOOM, mapMaxZoom)) return null;
  const unsupported = minZoom > MAX_PACKAGE_MIN_ZOOM;
  if (saved)
    return unsupported
      ? "basemapExtract.errorSavedPackageZoomUnsupported"
      : "basemapExtract.errorSavedPackageZoom";
  return unsupported
    ? "basemapExtract.errorPackageZoomUnsupported"
    : "basemapExtract.errorPackageZoom";
}

/**
 * The archive URL to seed the form with when the panel opens.
 *
 * A remembered proxy URL, including an old dated one saved before the
 * `latest` default, defers to `latest` so the default never pins a stale
 * date; only a URL on a different host is restored.
 *
 * Args:
 *   stored: The URL remembered from the last extract, if any.
 *
 * Returns:
 *   The URL to show.
 */
export function seededArchiveUrl(stored: string | null): string {
  return stored && !stored.startsWith(PLANET_PROXY_PREFIX) ? stored : DEFAULT_ARCHIVE_URL;
}

/** Source layers a Protomaps basemap style targets; if an archive exposes some
 * of these it can render with the Protomaps flavors (styled as a basemap)
 * rather than a flat overlay. */
const PROTOMAPS_SCHEMA_LAYERS = ["earth", "water", "roads", "places", "landcover"];

/**
 * Whether an archive's source layers follow the Protomaps schema closely
 * enough to render with a Protomaps flavor.
 *
 * `earth`/`water` are distinctively Protomaps-schema; `roads`/`places` are
 * generic names other vector schemas also use. Requiring one of the former
 * (plus two schema layers overall) keeps a non-Protomaps archive that merely
 * has a `roads`/`places` layer from being styled with Protomaps-specific
 * expressions and rendering blank. When field names are known, a
 * `roads`/`places`/`landcover` layer without a `kind` field rules it out too.
 *
 * Args:
 *   sourceLayers: The archive's vector source layer names.
 *   sourceLayerFields: Each source layer's field names, when known.
 *
 * Returns:
 *   True when the archive can be styled as a Protomaps basemap.
 */
export function isProtomapsCompatible(
  sourceLayers: string[],
  sourceLayerFields?: Record<string, string[]>,
): boolean {
  const set = new Set(sourceLayers);
  if (!set.has("earth") && !set.has("water")) return false;
  if (
    ["roads", "places", "landcover"].some((layer) => {
      const fields = sourceLayerFields?.[layer];
      return fields != null && !fields.includes("kind");
    })
  )
    return false;
  return PROTOMAPS_SCHEMA_LAYERS.filter((l) => set.has(l)).length >= 2;
}

/**
 * A layer/file base name from the archive URL, e.g. "planet" for
 * `https://host/planet.pmtiles`.
 *
 * Args:
 *   url: The archive URL.
 *
 * Returns:
 *   The base name, or `"basemap"` when the URL has none.
 */
export function baseNameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const base = path.split("/").filter(Boolean).pop() ?? "basemap";
    return base.replace(/\.pmtiles$/i, "") || "basemap";
  } catch {
    return "basemap";
  }
}

/**
 * The download's completion percentage for the progress bar.
 *
 * Args:
 *   progress: The extraction's latest progress report, if any.
 *
 * Returns:
 *   A whole percentage, 0 before the data phase knows its total.
 */
export function extractProgressPercent(
  progress: { dataBytesTotal: number; dataBytesReceived: number } | null,
): number {
  return progress && progress.dataBytesTotal > 0
    ? Math.round((progress.dataBytesReceived / progress.dataBytesTotal) * 100)
    : 0;
}
