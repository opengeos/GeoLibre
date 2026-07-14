/**
 * Imagery providers for the Timelapse plugin.
 *
 * A provider supplies an ordered list of dated "frames" (one per year), each a
 * raster tile URL template the plugin turns into a pre-warmed MapLibre raster
 * layer. Providers with remote discovery (Google Earth Engine per-year
 * composites, Planetary Computer mosaic searches) can return a Promise from
 * {@link TimelapseProvider.listFrames}; the four built-in providers (EOX
 * Sentinel-2 cloudless, NASA GIBS Landsat/WELD true color and NDVI, and NASA
 * GIBS MODIS land cover) are static. Register more with
 * {@link registerTimelapseProvider} — the control only shows a provider picker
 * when more than one is registered. A thematic provider may add a
 * {@link TimelapseProvider.legend} the panel renders (the imagery providers
 * omit it).
 */

/** One dated imagery frame (a year) a timelapse steps through. */
export interface TimelapseFrame {
  /** Stable frame id, unique within its provider (e.g. `s2cloudless-2016`). */
  id: string;
  /** Short label shown on the slider and burned into recordings (e.g. `2016`). */
  label: string;
  /** The frame's calendar year, used for ordering and project persistence. */
  year: number;
  /** Raster tile URL template with `{z}`/`{x}`/`{y}` placeholders. */
  tileUrlTemplate: string;
  /** Attribution HTML required by the imagery license. */
  attribution: string;
  minzoom?: number;
  maxzoom?: number;
  tileSize?: number;
  scheme?: "xyz" | "tms";
}

/** One class of a categorical provider's legend (a colored swatch + label). */
export interface TimelapseLegendItem {
  /** CSS color of the class swatch, e.g. `rgb(255,0,0)`. */
  color: string;
  /** Human-readable class name shown next to the swatch. */
  label: string;
}

/** A source of annual imagery frames for the Timelapse plugin. */
export interface TimelapseProvider {
  id: string;
  /** Human-readable name shown in the control header (e.g. provider picker). */
  name: string;
  /**
   * Optional categorical legend for a thematic provider (e.g. land-cover
   * classes). When present, the panel renders it so the colors are readable;
   * full-imagery providers (EOX, WELD true color) omit it. The same legend
   * applies to every year, so it lives on the provider, not per frame.
   */
  legend?: TimelapseLegendItem[];
  /**
   * One attribution string applied to every frame's map source. All frames of
   * a provider are live sources at once (the pre-warmed stack), so per-frame
   * strings would stack ten near-identical credits in MapLibre's attribution
   * control; a single shared string dedupes to one line. The per-frame
   * {@link TimelapseFrame.attribution} still carries the year-specific credit
   * for the control panel and recordings.
   */
  attribution: string;
  /** Ordered frames, oldest first. May be async for remote catalogs. */
  listFrames: () => TimelapseFrame[] | Promise<TimelapseFrame[]>;
}

export const EOX_S2CLOUDLESS_PROVIDER_ID = "eox-s2cloudless";

/**
 * The mosaic range starts at 2018: earlier EOX layers exist in the WMTS
 * capabilities but are unusable for a continuous timelapse — the unsuffixed
 * `s2cloudless_3857` layer is the 2016 mosaic, and `s2cloudless-2017_3857` is
 * published but serves blank placeholder tiles (~700 bytes) instead of
 * imagery, which would flash an empty year mid-animation.
 */
const EOX_FIRST_YEAR = 2018;
const EOX_LAST_YEAR = 2025;

/** The EOX WMTS layer identifier for a mosaic year (2017+ carry the suffix). */
function eoxLayerIdentifier(year: number): string {
  return `s2cloudless-${year}_3857`;
}

/**
 * EOX Sentinel-2 cloudless is CC BY 4.0, so every frame must credit EOX with
 * the mosaic's year. Kept per-frame (not one shared string) because the year
 * is part of the required credit. The app's Add Data sample uses the same
 * wording for its fixed 2025 layer (`EOX_S2CLOUDLESS_ATTRIBUTION` in
 * apps/geolibre-desktop/src/components/layout/add-data/constants.ts).
 */
function eoxAttribution(year: number): string {
  return (
    `Sentinel-2 cloudless ${year} by ` +
    '<a href="https://s2maps.eu" target="_blank" rel="noreferrer">EOX IT Services GmbH</a> ' +
    `(contains modified Copernicus Sentinel data ${year})`
  );
}

/**
 * EOX Sentinel-2 cloudless annual mosaics (2018–2025) — global, keyless,
 * CC BY 4.0. Sentinel-2's native 10 m resolution tops out around zoom 14, so
 * the source maxzoom is capped at 15 and MapLibre overzooms beyond it, which
 * keeps the pre-warmed 10-source stack from fetching needless deep tiles.
 */
export const eoxS2CloudlessProvider: TimelapseProvider = {
  id: EOX_S2CLOUDLESS_PROVIDER_ID,
  name: "Sentinel-2 cloudless (EOX)",
  attribution:
    `Sentinel-2 cloudless ${EOX_FIRST_YEAR}–${EOX_LAST_YEAR} by ` +
    '<a href="https://s2maps.eu" target="_blank" rel="noreferrer">EOX IT Services GmbH</a> ' +
    "(contains modified Copernicus Sentinel data)",
  listFrames: () => {
    const frames: TimelapseFrame[] = [];
    for (let year = EOX_FIRST_YEAR; year <= EOX_LAST_YEAR; year += 1) {
      frames.push({
        id: `s2cloudless-${year}`,
        label: String(year),
        year,
        tileUrlTemplate: `https://tiles.maps.eox.at/wmts/1.0.0/${eoxLayerIdentifier(year)}/default/g/{z}/{y}/{x}.jpg`,
        attribution: eoxAttribution(year),
        maxzoom: 15,
        tileSize: 256,
      });
    }
    return frames;
  },
};

export const NASA_GIBS_WELD_PROVIDER_ID = "nasa-gibs-landsat-weld";

/**
 * NASA GIBS publishes the global Landsat/WELD annual mosaic only for three
 * disjoint spans — 1983–1985, 1988–1990, 1998–2000 — with no imagery in the
 * gap years (1986–1987, 1991–1997, 2001+ serve a 404 placeholder, not tiles).
 * These are the exact `P1Y` dates from the layer's WMTS Time dimension; the
 * timelapse steps straight across the gaps (1985 → 1988 → 1998) rather than
 * flashing blank years. The underlying science product (GWELDYR v3.1) is a
 * fixed set of epochs, so this list is static rather than remotely discovered.
 */
const GIBS_WELD_YEARS = [
  1983, 1984, 1985, 1988, 1989, 1990, 1998, 1999, 2000,
] as const;

/** Native depth of the layer's GoogleMapsCompatible_Level12 matrix set. */
const GIBS_WELD_MAXZOOM = 12;

/** NASA asks that GIBS imagery credit EOSDIS; the year names the mosaic. */
function gibsWeldAttribution(year: number): string {
  return (
    `Landsat/WELD ${year} surface reflectance — imagery courtesy of ` +
    '<a href="https://www.earthdata.nasa.gov/data/catalog/lpcloud-gweldyr-031" ' +
    'target="_blank" rel="noreferrer">NASA EOSDIS GIBS</a>'
  );
}

/**
 * NASA GIBS Landsat/WELD "Corrected Reflectance (True Color)" global annual
 * surface-reflectance mosaics — global, keyless, 30 m Landsat. Complements the
 * EOX Sentinel-2 provider with historical years (1983–2000) that predate
 * Sentinel-2, at the cost of a sparse, gap-filled timeline (see
 * {@link GIBS_WELD_YEARS}). Tiles come from the EPSG:3857 WMTS endpoint in
 * `{z}/{y}/{x}` (WMTS TileRow/TileCol) order; the source maxzoom caps at the
 * Level12 matrix set's native depth and MapLibre overzooms past it.
 */
export const nasaGibsWeldProvider: TimelapseProvider = {
  id: NASA_GIBS_WELD_PROVIDER_ID,
  name: "Landsat annual (NASA GIBS)",
  attribution:
    "Landsat/WELD 1983–2000 surface reflectance — imagery courtesy of " +
    '<a href="https://www.earthdata.nasa.gov/data/catalog/lpcloud-gweldyr-031" ' +
    'target="_blank" rel="noreferrer">NASA EOSDIS GIBS</a>',
  listFrames: () =>
    GIBS_WELD_YEARS.map((year) => ({
      id: `gibs-weld-${year}`,
      label: String(year),
      year,
      tileUrlTemplate:
        "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/" +
        "Landsat_WELD_CorrectedReflectance_TrueColor_Global_Annual/default/" +
        `${year}-12-01/GoogleMapsCompatible_Level12/{z}/{y}/{x}.jpeg`,
      attribution: gibsWeldAttribution(year),
      maxzoom: GIBS_WELD_MAXZOOM,
      tileSize: 256,
    })),
};

export const NASA_GIBS_WELD_NDVI_PROVIDER_ID = "nasa-gibs-landsat-weld-ndvi";

/**
 * Representative bins of the WELD NDVI color ramp, sampled from GIBS's colormap
 * (a continuous 68-step gradient). NDVI is a continuous index, so these are
 * labelled ranges rather than discrete classes — enough to read the animation.
 */
const GIBS_WELD_NDVI_LEGEND: TimelapseLegendItem[] = [
  { color: "rgb(225,225,225)", label: "Water / non-vegetated (< 0)" },
  { color: "rgb(192,176,150)", label: "Sparse (0.0–0.2)" },
  { color: "rgb(143,183,21)", label: "Grass / shrub (0.2–0.4)" },
  { color: "rgb(51,131,0)", label: "Moderate (0.4–0.6)" },
  { color: "rgb(0,72,0)", label: "Dense (0.6–0.8)" },
  { color: "rgb(0,18,0)", label: "Very dense (0.8–1.0)" },
];

/** WELD NDVI shares the true-color layer's credit; the year names the mosaic. */
function gibsWeldNdviAttribution(year: number): string {
  return (
    `Landsat/WELD ${year} NDVI — imagery courtesy of ` +
    '<a href="https://www.earthdata.nasa.gov/data/catalog/lpcloud-gweldyr-031" ' +
    'target="_blank" rel="noreferrer">NASA EOSDIS GIBS</a>'
  );
}

/**
 * NASA GIBS Landsat/WELD NDVI (Normalized Difference Vegetation Index) global
 * annual — the vegetation-greenness companion to the true-color WELD provider,
 * from the same product and so the same sparse years ({@link GIBS_WELD_YEARS};
 * 1983–2000 with gaps, land-only, 30 m). Continuous index, shown with a binned
 * {@link GIBS_WELD_NDVI_LEGEND} so the green ramp is readable.
 */
export const nasaGibsWeldNdviProvider: TimelapseProvider = {
  id: NASA_GIBS_WELD_NDVI_PROVIDER_ID,
  name: "Landsat NDVI (NASA GIBS)",
  legend: GIBS_WELD_NDVI_LEGEND,
  attribution:
    "Landsat/WELD 1983–2000 NDVI — imagery courtesy of " +
    '<a href="https://www.earthdata.nasa.gov/data/catalog/lpcloud-gweldyr-031" ' +
    'target="_blank" rel="noreferrer">NASA EOSDIS GIBS</a>',
  listFrames: () =>
    GIBS_WELD_YEARS.map((year) => ({
      id: `gibs-weld-ndvi-${year}`,
      label: String(year),
      year,
      tileUrlTemplate:
        "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/" +
        "Landsat_WELD_NDVI_Global_Annual/default/" +
        `${year}-12-01/GoogleMapsCompatible_Level12/{z}/{y}/{x}.jpeg`,
      attribution: gibsWeldNdviAttribution(year),
      maxzoom: GIBS_WELD_MAXZOOM,
      tileSize: 256,
    })),
};

export const MODIS_LANDCOVER_PROVIDER_ID = "nasa-gibs-modis-landcover";

const MODIS_LANDCOVER_FIRST_YEAR = 2001;
const MODIS_LANDCOVER_LAST_YEAR = 2024;

/** Native depth of the layer's GoogleMapsCompatible_Level8 matrix set. */
const MODIS_LANDCOVER_MAXZOOM = 8;

/**
 * The MODIS IGBP 17-class legend, with the exact swatch colors GIBS renders
 * (read from its colormap, keyed by IGBP class 1–17). The panel shows this so
 * the categorical map is readable — unlike the imagery providers, the colors
 * are the data. Ordered by class number.
 */
const MODIS_IGBP_LEGEND: TimelapseLegendItem[] = [
  { color: "rgb(33,138,33)", label: "Evergreen needleleaf forest" },
  { color: "rgb(49,204,49)", label: "Evergreen broadleaf forest" },
  { color: "rgb(152,204,49)", label: "Deciduous needleleaf forest" },
  { color: "rgb(150,250,150)", label: "Deciduous broadleaf forest" },
  { color: "rgb(141,186,141)", label: "Mixed forest" },
  { color: "rgb(186,141,141)", label: "Closed shrublands" },
  { color: "rgb(245,222,179)", label: "Open shrublands" },
  { color: "rgb(218,235,157)", label: "Woody savannas" },
  { color: "rgb(255,213,0)", label: "Savannas" },
  { color: "rgb(240,185,103)", label: "Grasslands" },
  { color: "rgb(71,131,181)", label: "Permanent wetlands" },
  { color: "rgb(250,239,115)", label: "Croplands" },
  { color: "rgb(255,0,0)", label: "Urban and built-up" },
  { color: "rgb(153,147,86)", label: "Cropland / natural vegetation mosaic" },
  { color: "rgb(255,255,255)", label: "Permanent snow and ice" },
  { color: "rgb(191,191,189)", label: "Barren" },
  { color: "rgb(134,202,227)", label: "Water bodies" },
];

/** MODIS land cover is MCD12Q1; NASA asks that GIBS imagery credit EOSDIS. */
function modisLandCoverAttribution(year: number): string {
  return (
    `Land cover ${year} (MODIS MCD12Q1, IGBP) — data courtesy of ` +
    '<a href="https://www.earthdata.nasa.gov/data/catalog/lpcloud-mcd12q1-061" ' +
    'target="_blank" rel="noreferrer">NASA EOSDIS GIBS</a>'
  );
}

/**
 * NASA GIBS MODIS combined (Terra + Aqua) Land Cover Type, IGBP classification,
 * global annual (2001–2024) — a continuous 24-year categorical series that
 * shows land-cover change (deforestation, urban growth, cropland expansion).
 * Unlike the imagery providers this is thematic PNG with a fixed
 * {@link MODIS_IGBP_LEGEND}; it is coarse (Level8 matrix set) and best read as
 * a full-globe overlay rather than zoomed in.
 */
export const modisLandCoverProvider: TimelapseProvider = {
  id: MODIS_LANDCOVER_PROVIDER_ID,
  name: "Land cover (MODIS IGBP)",
  legend: MODIS_IGBP_LEGEND,
  attribution:
    "Land cover 2001–2024 (MODIS MCD12Q1, IGBP) — data courtesy of " +
    '<a href="https://www.earthdata.nasa.gov/data/catalog/lpcloud-mcd12q1-061" ' +
    'target="_blank" rel="noreferrer">NASA EOSDIS GIBS</a>',
  listFrames: () => {
    const frames: TimelapseFrame[] = [];
    for (
      let year = MODIS_LANDCOVER_FIRST_YEAR;
      year <= MODIS_LANDCOVER_LAST_YEAR;
      year += 1
    ) {
      frames.push({
        id: `modis-landcover-${year}`,
        label: String(year),
        year,
        tileUrlTemplate:
          "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/" +
          "MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual/default/" +
          `${year}-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png`,
        attribution: modisLandCoverAttribution(year),
        maxzoom: MODIS_LANDCOVER_MAXZOOM,
        tileSize: 256,
      });
    }
    return frames;
  },
};

const providers = new Map<string, TimelapseProvider>([
  [eoxS2CloudlessProvider.id, eoxS2CloudlessProvider],
  [nasaGibsWeldProvider.id, nasaGibsWeldProvider],
  [nasaGibsWeldNdviProvider.id, nasaGibsWeldNdviProvider],
  [modisLandCoverProvider.id, modisLandCoverProvider],
]);

/**
 * Register (or replace) a timelapse imagery provider. The extension point for
 * Earth Engine / Planetary Computer providers.
 */
export function registerTimelapseProvider(provider: TimelapseProvider): void {
  providers.set(provider.id, provider);
}

/**
 * Look up a provider by id, falling back to the built-in EOX provider so a
 * project saved with a provider that is no longer registered still opens.
 */
export function getTimelapseProvider(id?: string): TimelapseProvider {
  return (id && providers.get(id)) || eoxS2CloudlessProvider;
}

/** All registered providers, in registration order. */
export function listTimelapseProviders(): TimelapseProvider[] {
  return [...providers.values()];
}
