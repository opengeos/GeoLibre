/**
 * Raster basemaps for regions the default catalog does not serve well.
 *
 * Today that means mainland China: GeoLibre's defaults (OpenFreeMap, Protomaps)
 * and almost every provider in the Basemaps control are hosted outside it with
 * no presence inside, so from there they range from slow to unreachable. These
 * entries are served from inside China and give those users a basemap that
 * loads.
 *
 * The mechanism mirrors {@link PlanetaryBasemap}: `styleUrl` is a
 * `geolibre://regional-basemap/<id>` sentinel that the map controller's
 * `resolveMapStyle` expands into a raster style at apply time (it is not a
 * fetchable URL). A separate sentinel prefix from the planetary one keeps the
 * two apart, because selecting a planetary basemap also switches the project's
 * celestial body, which must not happen here.
 */

/**
 * The regions the pickers group these basemaps under. Each gets its own
 * heading and explanatory note inside the single "Regional" section, so a
 * future region slots in without the section itself becoming country-specific.
 */
export type RegionalBasemapRegionId = "china";

/**
 * A raster basemap for a region, rendered from XYZ (or TMS) tiles.
 */
export interface RegionalBasemap {
  id: string;
  /** Which region heading this basemap sits under. */
  region: RegionalBasemapRegionId;
  /**
   * Display name, in the language of the region the basemap serves. These are
   * Chinese-market services whose users know them by their Chinese names, and
   * the section heading already says which region they belong to, so the labels
   * are not translated the way UI strings are.
   */
  name: string;
  /**
   * The tile provider's brand name in Latin script ("Amap", "Tencent Maps"),
   * for messages read outside the region, such as the confirmation shown when
   * an opened project names this basemap. A proper noun, so not translated.
   */
  provider: string;
  /** Sentinel stored as the basemap style URL. */
  styleUrl: string;
  /** XYZ (or TMS, see {@link scheme}) tile template. */
  tileUrl: string;
  /**
   * An optional transparent overlay drawn above {@link tileUrl}, so a satellite
   * basemap can ship with its roads and labels burnt in as one selectable
   * basemap rather than something the user has to stack by hand.
   */
  overlayTileUrl?: string;
  /**
   * Tile row ordering. Tencent numbers rows from the bottom (**TMS**); Amap is
   * standard XYZ. Omit for XYZ; MapLibre defaults to `"xyz"` when absent.
   */
  scheme?: "tms";
  /** Max native zoom of the source (MapLibre overzooms beyond this). */
  maxZoom: number;
  /** Attribution shown on the map. */
  attribution: string;
  /**
   * True when the tiles are drawn in GCJ-02, the offset datum Chinese law
   * mandates for public map services. Neither GeoLibre nor MapLibre applies the
   * shift, so WGS84 data laid over these lands roughly 100 to 700 m off (see
   * docs/getting-started.md). Not every regional basemap is offset — Tianditu
   * publishes in CGCS2000 and lines up — so this records which are, rather than
   * leaving a caveat that applies to some entries implied by the region.
   */
  gcj02?: boolean;
}

export const REGIONAL_BASEMAP_SENTINEL_PREFIX = "geolibre://regional-basemap/";

const AMAP_ATTRIBUTION = '&copy; <a href="https://www.amap.com">高德地图 Amap</a>';
const TENCENT_ATTRIBUTION = '&copy; <a href="https://map.qq.com">腾讯地图 Tencent Maps</a>';

const sentinel = (id: string) => `${REGIONAL_BASEMAP_SENTINEL_PREFIX}${id}`;

// Amap serves each product from four numbered hosts; MapLibre takes a single
// template per source, so pin host 01. Browsers multiplex over HTTP/2, which
// makes the sharding a non-issue. `style` selects the product: 7 street, 6
// imagery, 8 roads-and-labels.
const AMAP_STREET_URL =
  "https://wprd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scl=1&style=7&x={x}&y={y}&z={z}";
const AMAP_SATELLITE_URL = "https://webst01.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}";
const AMAP_LABELS_URL = "https://webst01.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}";

const tencentUrl = (styleId: number) =>
  `https://rt0.map.gtimg.com/tile?z={z}&x={x}&y={y}&styleid=${styleId}&scene=0`;

/**
 * Basemaps served from inside mainland China.
 *
 * Zoom limits are each source's probed maximum, so MapLibre overzooms (blurs)
 * rather than painting a placeholder: Amap's imagery returns a "no imagery"
 * tile rather than a 404 past zoom 18, and Tencent 400s past 19 with zoom 19
 * already blank.
 */
export const CHINA_BASEMAPS: readonly RegionalBasemap[] = [
  {
    id: "amap-street",
    region: "china",
    name: "高德地图",
    provider: "Amap",
    styleUrl: sentinel("amap-street"),
    tileUrl: AMAP_STREET_URL,
    maxZoom: 19,
    attribution: AMAP_ATTRIBUTION,
    gcj02: true,
  },
  {
    id: "amap-satellite",
    region: "china",
    name: "高德卫星",
    provider: "Amap",
    styleUrl: sentinel("amap-satellite"),
    tileUrl: AMAP_SATELLITE_URL,
    maxZoom: 18,
    attribution: AMAP_ATTRIBUTION,
    gcj02: true,
  },
  {
    id: "amap-hybrid",
    region: "china",
    name: "高德混合",
    provider: "Amap",
    styleUrl: sentinel("amap-hybrid"),
    tileUrl: AMAP_SATELLITE_URL,
    overlayTileUrl: AMAP_LABELS_URL,
    maxZoom: 18,
    attribution: AMAP_ATTRIBUTION,
    gcj02: true,
  },
  {
    id: "tencent-street",
    region: "china",
    name: "腾讯地图",
    provider: "Tencent Maps",
    styleUrl: sentinel("tencent-street"),
    tileUrl: tencentUrl(1),
    scheme: "tms",
    maxZoom: 18,
    attribution: TENCENT_ATTRIBUTION,
    gcj02: true,
  },
  {
    id: "tencent-dark",
    region: "china",
    name: "腾讯深色",
    provider: "Tencent Maps",
    styleUrl: sentinel("tencent-dark"),
    tileUrl: tencentUrl(4),
    scheme: "tms",
    maxZoom: 18,
    attribution: TENCENT_ATTRIBUTION,
    gcj02: true,
  },
];

/** Every regional basemap, across all regions. */
export const REGIONAL_BASEMAPS: readonly RegionalBasemap[] = CHINA_BASEMAPS;

/**
 * The regional basemaps grouped for display, one entry per region. Both the New
 * Project and Change Basemap panels render this inside a single collapsible
 * "Regional" section, so adding a region is a change here rather than in two
 * dialogs.
 */
export const REGIONAL_BASEMAP_GROUPS: readonly {
  id: RegionalBasemapRegionId;
  basemaps: readonly RegionalBasemap[];
}[] = [{ id: "china", basemaps: CHINA_BASEMAPS }];

/** Look up a regional basemap by its `geolibre://regional-basemap/<id>` sentinel. */
export function getRegionalBasemapByStyleUrl(
  styleUrl: string | undefined,
): RegionalBasemap | undefined {
  if (!styleUrl) return undefined;
  return REGIONAL_BASEMAPS.find((basemap) => basemap.styleUrl === styleUrl);
}

/** Look up a regional basemap by id. */
export function getRegionalBasemapById(id: string | undefined): RegionalBasemap | undefined {
  if (!id) return undefined;
  return REGIONAL_BASEMAPS.find((basemap) => basemap.id === id);
}

/** Whether a style URL is a regional-basemap sentinel, resolvable or not. */
export function isRegionalBasemapSentinel(styleUrl: string | undefined): boolean {
  return Boolean(styleUrl?.startsWith(REGIONAL_BASEMAP_SENTINEL_PREFIX));
}

/**
 * How the store treats a regional basemap that arrives without the user picking
 * it (a project file, share link, or startup restore naming one by its
 * `styleUrl`). The tiles come from servers in mainland China, so loading them
 * unasked sends the user's map requests there.
 *
 * - `"allow"`: apply it as is. This is the store default, so library consumers
 *   keep their behaviour; the desktop and web app switch to `"prompt"`.
 * - `"prompt"`: apply the default basemap and hold the regional one for the
 *   user to confirm (see {@link RegionalBasemapHold}).
 * - `"block"`: the deployment disabled regional basemaps. Always fall back to
 *   the default basemap, including when code sets one directly.
 */
export type RegionalBasemapPolicy = "allow" | "prompt" | "block";

/**
 * A regional basemap the store set aside when a project was loaded. The default
 * basemap renders in its place until the user answers (`"prompt"`), or for good
 * (`"blocked"`, which the app shows as a notice only).
 */
export interface RegionalBasemapHold {
  /** The regional sentinel the project asked for. */
  styleUrl: string;
  /** Why the default basemap is showing instead. */
  reason: "prompt" | "blocked";
}

/**
 * Decides which basemap a project load actually applies.
 *
 * Only a resolvable regional sentinel is gated. Every other style URL (and an
 * unknown regional id, which the map controller already replaces with the
 * default basemap) passes through untouched.
 *
 * @param styleUrl - The basemap style URL the project requests.
 * @param policy - The store's current {@link RegionalBasemapPolicy}.
 * @param fallbackStyleUrl - The basemap to apply instead (the default basemap).
 * @param trusted - True when the user already chose this basemap in this
 *   session (a template, an undo step, a duplicate), so `"prompt"` does not
 *   apply. `"block"` still does.
 * @returns The style URL to apply and, when it was replaced, why.
 */
export function gateRegionalBasemap(
  styleUrl: string,
  policy: RegionalBasemapPolicy,
  fallbackStyleUrl: string,
  trusted = false,
): { styleUrl: string; held?: RegionalBasemapHold["reason"] } {
  if (!getRegionalBasemapByStyleUrl(styleUrl)) return { styleUrl };
  if (policy === "block") return { styleUrl: fallbackStyleUrl, held: "blocked" };
  if (policy === "prompt" && !trusted) return { styleUrl: fallbackStyleUrl, held: "prompt" };
  return { styleUrl };
}
