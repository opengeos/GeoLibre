// A searchable catalog of coordinate reference systems for the Processing
// toolbox's EPSG parameters.
//
// Tools such as `reproject_vector` and `assign_projection_vector` take their
// target CRS as a bare EPSG code, which the dialog used to render as a plain
// number box: the code had to be recalled from memory (GeoLibre#1538). These
// entries back a QGIS-style picker that searches by name or code and separates
// geographic from projected systems. The free-text field stays the source of
// truth, so a code that is not listed here can still be typed.
//
// The catalog is curated rather than exhaustive (the EPSG dataset holds ~6000
// geographic and projected systems, too much to bundle): every UTM/MGA/Japan/
// China zone of the major datums, the world and polar projections, and the
// national grids in common use. Names are the official EPSG dataset names, so a
// label copied out of QGIS or PROJ matches what is shown here.

/** Whether a CRS is a geographic (lon/lat) or a projected (planar) system. */
export type CrsKind = "geographic" | "projected";

/** One catalog entry: an EPSG code with its official name and kind. */
export interface CrsEntry {
  /** The numeric EPSG code, as tools expect it. */
  code: number;
  /** The official EPSG name, e.g. `WGS 84 / UTM zone 17N`. */
  name: string;
  kind: CrsKind;
}

/** Inclusive integer range helper for the zone families below. */
function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

/**
 * UTM-style zone family whose EPSG code is `codeBase + zone` and whose name is
 * `<datum> / UTM zone <zone><hemisphere>` (the shape EPSG uses for WGS 84,
 * NAD83 and ETRS89 alike).
 */
function utmZones(
  datum: string,
  codeBase: number,
  hemisphere: "N" | "S",
  zones: number[],
): CrsEntry[] {
  return zones.map((zone) => ({
    code: codeBase + zone,
    name: `${datum} / UTM zone ${zone}${hemisphere}`,
    kind: "projected" as const,
  }));
}

/** Australian Map Grid zones, named `<datum> / MGA zone <zone>` (no hemisphere). */
function mgaZones(datum: string, codeBase: number, zones: number[]): CrsEntry[] {
  return zones.map((zone) => ({
    code: codeBase + zone,
    name: `${datum} / MGA zone ${zone}`,
    kind: "projected" as const,
  }));
}

/** Roman numerals I..XIX, the way EPSG labels Japan's 19 plane rectangular zones. */
const JAPAN_ZONE_NUMERALS = [
  "I",
  "II",
  "III",
  "IV",
  "V",
  "VI",
  "VII",
  "VIII",
  "IX",
  "X",
  "XI",
  "XII",
  "XIII",
  "XIV",
  "XV",
  "XVI",
  "XVII",
  "XVIII",
  "XIX",
];

/** JGD2011 / Japan Plane Rectangular CS I..XIX (EPSG:6669-6687). */
function japanPlaneZones(): CrsEntry[] {
  return JAPAN_ZONE_NUMERALS.map((numeral, index) => ({
    code: 6669 + index,
    name: `JGD2011 / Japan Plane Rectangular CS ${numeral}`,
    kind: "projected" as const,
  }));
}

/** CGCS2000 / Gauss-Kruger zone 13..23 (EPSG:4491-4501), China's 6-degree belts. */
function chinaGaussKrugerZones(): CrsEntry[] {
  return range(13, 23).map((zone) => ({
    code: 4478 + zone,
    name: `CGCS2000 / Gauss-Kruger zone ${zone}`,
    kind: "projected" as const,
  }));
}

// Geographic systems, most widely used first so the picker's default list opens
// on the ones a user is most likely to want.
const GEOGRAPHIC_CRS: CrsEntry[] = (
  [
    [4326, "WGS 84"],
    [4269, "NAD83"],
    [6318, "NAD83(2011)"],
    [4152, "NAD83(HARN)"],
    [4267, "NAD27"],
    [4258, "ETRS89"],
    [4283, "GDA94"],
    [7844, "GDA2020"],
    [4277, "OSGB36"],
    [4188, "OSNI 1952"],
    [4230, "ED50"],
    [4231, "ED87"],
    [4171, "RGF93 v1"],
    [4275, "NTF"],
    [4314, "DHDN"],
    [4289, "Amersfoort"],
    [4149, "CH1903"],
    [4150, "CH1903+"],
    [4619, "SWEREF99"],
    [4123, "KKJ"],
    [4207, "Lisbon"],
    [4265, "Monte Mario"],
    [4237, "HD72"],
    [4284, "Pulkovo 1942"],
    [4200, "Pulkovo 1995"],
    [4740, "PZ-90"],
    [4674, "SIRGAS 2000"],
    [4490, "China Geodetic Coordinate System 2000"],
    [4555, "New Beijing"],
    [4612, "JGD2000"],
    [6668, "JGD2011"],
    [4301, "Tokyo"],
    [4739, "Hong Kong 1963(67)"],
    [4756, "VN-2000"],
    [4272, "NZGD49"],
    [4322, "WGS 72"],
  ] as [number, string][]
).map(([code, name]) => ({ code, name, kind: "geographic" as const }));

// Named projected systems: world and polar projections first, then the national
// and continental grids. The zone families are appended after these.
const NAMED_PROJECTED_CRS: CrsEntry[] = (
  [
    [3857, "WGS 84 / Pseudo-Mercator"],
    [3395, "WGS 84 / World Mercator"],
    [4087, "WGS 84 / World Equidistant Cylindrical"],
    [8857, "WGS 84 / Equal Earth Greenwich"],
    [3832, "WGS 84 / PDC Mercator"],
    [6933, "WGS 84 / NSIDC EASE-Grid 2.0 Global"],
    [6931, "WGS 84 / NSIDC EASE-Grid 2.0 North"],
    [6932, "WGS 84 / NSIDC EASE-Grid 2.0 South"],
    [3413, "WGS 84 / NSIDC Sea Ice Polar Stereographic North"],
    [3976, "WGS 84 / NSIDC Sea Ice Polar Stereographic South"],
    [3995, "WGS 84 / Arctic Polar Stereographic"],
    [3031, "WGS 84 / Antarctic Polar Stereographic"],
    [5070, "NAD83 / Conus Albers"],
    [6350, "NAD83(2011) / Conus Albers"],
    [3338, "NAD83 / Alaska Albers"],
    [9311, "NAD27 / US National Atlas Equal Area"],
    [3347, "NAD83 / Statistics Canada Lambert"],
    [3978, "NAD83 / Canada Atlas Lambert"],
    [3035, "ETRS89-extended / LAEA Europe"],
    [3034, "ETRS89-extended / LCC Europe"],
    [27700, "OSGB36 / British National Grid"],
    [29903, "TM75 / Irish Grid"],
    [2157, "IRENET95 / Irish Transverse Mercator"],
    [28992, "Amersfoort / RD New"],
    [2154, "RGF93 v1 / Lambert-93"],
    [31370, "BD72 / Belgian Lambert 72"],
    [3812, "ETRS89 / Belgian Lambert 2008"],
    [21781, "CH1903 / LV03"],
    [2056, "CH1903+ / LV95"],
    [3067, "EUREF-FIN / TM35FIN(E,N)"],
    [3006, "SWEREF99 TM"],
    [3301, "Estonian Coordinate System of 1997"],
    [3346, "LKS94 / Lithuania TM"],
    [3059, "LKS-92 / Latvia TM"],
    [2180, "ETRF2000-PL / CS92"],
    [5514, "S-JTSK / Krovak East North"],
    [23700, "HD72 / EOV"],
    [3765, "HTRS96 / Croatia TM"],
    [3844, "Pulkovo 1942(58) / Stereo70"],
    [2100, "GGRS87 / Greek Grid"],
    [2039, "Israel 1993 / Israeli TM Grid"],
    [2048, "Hartebeesthoek94 / Lo19"],
    [2055, "Hartebeesthoek94 / Lo33"],
    [5880, "SIRGAS 2000 / Brazil Polyconic"],
    [31983, "SIRGAS 2000 / UTM zone 23S"],
    [3116, "MAGNA-SIRGAS / Colombia Bogota zone"],
    [3414, "SVY21 / Singapore TM"],
    [2326, "Hong Kong 1980 Grid System"],
    [3826, "TWD97 / TM2 zone 121"],
    [5179, "KGD2002 / Unified CS"],
    [5186, "KGD2002 / Central Belt 2010"],
    [2193, "NZGD2000 / New Zealand Transverse Mercator 2000"],
    [3577, "GDA94 / Australian Albers"],
    [9473, "GDA2020 / Australian Albers"],
    [7845, "GDA2020 / GA LCC"],
    [3112, "GDA94 / Geoscience Australia Lambert"],
  ] as [number, string][]
).map(([code, name]) => ({ code, name, kind: "projected" as const }));

/**
 * Every CRS the picker offers: geographic systems, then named projected
 * systems, then the zone families. Ordered by how often each is reached for, so
 * the list is useful before anything is typed.
 */
export const CRS_CATALOG: readonly CrsEntry[] = [
  ...GEOGRAPHIC_CRS,
  ...NAMED_PROJECTED_CRS,
  ...utmZones("WGS 84", 32600, "N", range(1, 60)),
  ...utmZones("WGS 84", 32700, "S", range(1, 60)),
  ...utmZones("NAD83", 26900, "N", range(1, 23)),
  ...utmZones("ETRS89", 25800, "N", range(28, 38)),
  ...mgaZones("GDA94", 28300, range(48, 58)),
  ...mgaZones("GDA2020", 7800, range(46, 59)),
  ...japanPlaneZones(),
  ...chinaGaussKrugerZones(),
];

const CRS_BY_CODE = new Map(CRS_CATALOG.map((entry) => [entry.code, entry]));

/**
 * The catalog entry for an EPSG code, or `undefined` when the code is not one of
 * the curated systems (a valid code the tool will still accept).
 *
 * @param code - An EPSG code, as a number or as typed text (`4326`, `EPSG:4326`).
 * @returns The matching entry, or `undefined`.
 */
export function crsEntryForCode(code: number | string | null | undefined): CrsEntry | undefined {
  const parsed = typeof code === "number" ? code : parseEpsgCode(code);
  return parsed === null ? undefined : CRS_BY_CODE.get(parsed);
}

/**
 * Reads an EPSG code out of typed text, tolerating the `EPSG:` prefix, stray
 * whitespace and the URN form. Returns null when no code is present, so callers
 * can leave a partially typed field alone.
 *
 * @param value - Free text from an EPSG field.
 * @returns The numeric code, or null.
 */
export function parseEpsgCode(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const match = String(value)
    .toUpperCase()
    .match(/(?:EPSG:+)?(\d{4,6})\s*$/);
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isInteger(code) ? code : null;
}

/**
 * A CRS as one line of display text: `WGS 84 / UTM zone 17N (EPSG:32617)`.
 *
 * @param entry - A catalog entry.
 * @returns The name followed by its parenthesized EPSG code.
 */
export function formatCrsLabel(entry: CrsEntry): string {
  return `${entry.name} (EPSG:${entry.code})`;
}

/** Rank buckets: an exact code match beats a code prefix, which beats a name hit. */
const RANK_EXACT_CODE = 0;
const RANK_CODE_PREFIX = 1;
const RANK_NAME_PREFIX = 2;
const RANK_NAME_MATCH = 3;

/**
 * Searches the catalog by CRS name or EPSG code. Every whitespace-separated
 * token must match (so `utm 17n` narrows to the zone-17 north systems), matched
 * against both the name and the code; an `EPSG:` prefix in the query is ignored.
 * A blank query returns the catalog in its curated order.
 *
 * Results are ranked exact code, then code prefix, then name prefix, then any
 * name hit, and within a rank keep the catalog's own order.
 *
 * @param query - The user's search text.
 * @param limit - Maximum results to return.
 * @returns Matching entries, best first.
 */
export function searchCrsCatalog(query: string, limit = 200): CrsEntry[] {
  // Drop an `EPSG:` prefix so both `epsg:32617` and `32617` search by code.
  const normalized = query
    .toLowerCase()
    .replace(/epsg\s*:+\s*/g, " ")
    .trim();
  if (!normalized) return CRS_CATALOG.slice(0, limit);
  const tokens = normalized.split(/\s+/);

  const ranked: { entry: CrsEntry; rank: number; order: number }[] = [];
  CRS_CATALOG.forEach((entry, order) => {
    const name = entry.name.toLowerCase();
    const code = String(entry.code);
    let rank = RANK_NAME_MATCH;
    for (const token of tokens) {
      if (code === token) {
        rank = Math.min(rank, RANK_EXACT_CODE);
      } else if (code.startsWith(token)) {
        rank = Math.min(rank, RANK_CODE_PREFIX);
      } else if (name.startsWith(token)) {
        rank = Math.min(rank, RANK_NAME_PREFIX);
      } else if (!name.includes(token)) {
        // This token matches neither the name nor the code: reject the entry.
        return;
      }
    }
    ranked.push({ entry, rank, order });
  });

  return ranked
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, limit)
    .map((item) => item.entry);
}
