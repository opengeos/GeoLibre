/** A geographic location supplied by a web link or Android geo URI. */
export interface CoordinateTarget {
  center: [number, number];
  zoom: number;
}

const DEFAULT_LOCATION_ZOOM = 14;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

function decimal(value: string | null): number | null {
  if (value === null || !DECIMAL.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function target(
  lat: string | null,
  lon: string | null,
  zoom: string | null,
): CoordinateTarget | null {
  const latitude = decimal(lat);
  const longitude = decimal(lon);
  const level = zoom === null ? DEFAULT_LOCATION_ZOOM : decimal(zoom);
  if (
    latitude === null ||
    Math.abs(latitude) > 90 ||
    longitude === null ||
    Math.abs(longitude) > 180 ||
    level === null ||
    level < 0 ||
    level > 24
  )
    return null;
  return { center: [longitude, latitude], zoom: level };
}

/** Accept ?lat=40.7&lon=-74&zoom=12 and the compact ?12/40.7/-74 form. */
export function coordinateTargetFromSearch(search: string): CoordinateTarget | null {
  const params = new URLSearchParams(search);
  if (params.has("lat") || params.has("lon")) {
    return target(params.get("lat"), params.get("lon"), params.get("zoom"));
  }
  const compact = search.replace(/^\?/, "").split("&", 1)[0].split("/");
  return compact.length === 3 ? target(compact[1], compact[2], compact[0]) : null;
}

/** Numeric geo queries only; address searches require a separate geocoder. */
export function coordinateTargetFromGeoUri(uri: string): CoordinateTarget | null {
  if (!/^geo:/i.test(uri)) return null;
  const [position, query = ""] = uri.slice(4).split("?");
  const params = new URLSearchParams(query);
  // Android's q=lat,lon(label) takes precedence over its 0,0 placeholder.
  const coordinates = params.has("q")
    ? params
        .get("q")!
        .replace(/\([^()]*\)$/, "")
        .trim()
    : position;
  const parts = coordinates.split(",");
  if (parts.length !== 2) return null;
  return target(parts[0], parts[1], params.get("z"));
}
