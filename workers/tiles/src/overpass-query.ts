// The bounded Overpass query grammar the `/overpass` route relays. Kept out of
// index.ts because workerd refuses to start a Worker whose entry module has a
// named export that is not a handler (the constants below are imported by the
// tests and mirrored in packages/plugins osm-downloader-api.ts).

export const OVERPASS_MAX_ALL_QUERY_AREA_SQUARE_DEGREES = 0.25;
export const OVERPASS_MAX_QUERY_AREA_SQUARE_DEGREES = 4;
const OVERPASS_QUERY_PREFIX = "[out:json][timeout:60];";
const OVERPASS_QUERY_SUFFIX = "out geom;";
const OVERPASS_NUMBER = "-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
const OVERPASS_QUOTED = '"(?:\\\\.|[^"\\\\])*"';
const OVERPASS_FILTER = `(?:\\[~"\\."~"\\."\\]|\\[${OVERPASS_QUOTED}(?:=${OVERPASS_QUOTED})?\\])`;
const OVERPASS_SELECTOR = new RegExp(
  `nwr(${OVERPASS_FILTER})\\((${OVERPASS_NUMBER}),(${OVERPASS_NUMBER}),(${OVERPASS_NUMBER}),(${OVERPASS_NUMBER})\\);`,
  "g",
);

/**
 * Accept only the exact bounded query grammar emitted by buildOsmDownloadQuery.
 * This enforces the client's limits at the trust boundary so a forged POST
 * cannot use GeoLibre's Worker for an unbounded or long-running Overpass query.
 */
export function isAllowedOverpassQuery(query: string): boolean {
  if (!query.startsWith(OVERPASS_QUERY_PREFIX) || !query.endsWith(OVERPASS_QUERY_SUFFIX)) {
    return false;
  }
  let selectorsText = query.slice(OVERPASS_QUERY_PREFIX.length, -OVERPASS_QUERY_SUFFIX.length);
  const wrapped = selectorsText.startsWith("(") && selectorsText.endsWith(");");
  if (wrapped) {
    selectorsText = selectorsText.slice(1, -2);
  }
  OVERPASS_SELECTOR.lastIndex = 0;
  const matches = [...selectorsText.matchAll(OVERPASS_SELECTOR)];
  if (matches.length < 1 || matches.length > 2) return false;
  if (matches.map((match) => match[0]).join("") !== selectorsText) return false;
  // The client wraps exactly two selectors only when splitting one view at the
  // antimeridian. Reject unrelated multi-region queries forged outside it.
  if (wrapped !== (matches.length === 2)) return false;
  if (
    matches.length === 2 &&
    (matches[0][1] !== matches[1][1] ||
      matches[0][2] !== matches[1][2] ||
      matches[0][4] !== matches[1][4] ||
      Number(matches[0][5]) !== 180 ||
      Number(matches[1][3]) !== -180)
  ) {
    return false;
  }

  const allFeatures = matches.every((match) => match[1] === '[~"."~"."]');
  if (matches.some((match) => (match[1] === '[~"."~"."]') !== allFeatures)) return false;
  // Keep these mirrored limits aligned with osm-downloader-api.ts in packages/plugins.
  const areaLimit = allFeatures
    ? OVERPASS_MAX_ALL_QUERY_AREA_SQUARE_DEGREES
    : OVERPASS_MAX_QUERY_AREA_SQUARE_DEGREES;
  let totalArea = 0;
  for (const match of matches) {
    const [, , southText, westText, northText, eastText] = match;
    const [south, west, north, east] = [southText, westText, northText, eastText].map(Number);
    if (
      ![south, west, north, east].every(Number.isFinite) ||
      south < -90 ||
      north > 90 ||
      west < -180 ||
      east > 180 ||
      south >= north ||
      west >= east
    ) {
      return false;
    }
    totalArea += (north - south) * (east - west);
  }
  return totalArea <= areaLimit;
}
