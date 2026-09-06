/**
 * Maps the project's basemap onto imagery the Cesium globe can render.
 *
 * The 2D panes render `basemapStyleUrl` through MapLibre, which understands
 * vector GL styles and GeoLibre's `geolibre://` sentinels. Cesium understands
 * neither: it draws imagery from tile providers only. So a globe pane that
 * simply mounted the store basemap would show nothing, which is why the pane
 * used to hardcode Ion World Imagery (with a token) or OpenStreetMap (without)
 * and ignore the user's choice entirely — leaving a bright globe beside dark 2D
 * panes and breaking the "same map, different projection" promise the multi-map
 * grid makes.
 *
 * This module is the translation. It is deliberately **engine-free** — it
 * returns a plain descriptor and never imports Cesium — so it lives in
 * `@geolibre/core` beside the basemap catalogs it reads, the 2D and 3D
 * renderers share one source of truth, and the Cesium chunk boundary in
 * `vite.config.ts` stays intact.
 *
 * Three outcomes are possible, and the caller has to handle all three (see
 * {@link CesiumBasemapImagery}): tiles to draw, nothing to draw, or "no raster
 * equivalent exists — pick your own default".
 */

import { getPlanetaryBasemapByStyleUrl } from "./ellipsoids";
import { getRegionalBasemapByStyleUrl } from "./regional-basemaps";
import { BLANK_BASEMAP, DEFAULT_BASEMAP } from "./types";

/** Stable project IDs and the corresponding Cesium bundled thumbnails / ion assets. */
export const CESIUM_BASEMAPS = [
  { id: "project", name: "Project basemap", icon: "naturalEarthII.png" },
  { id: "natural-earth", name: "Natural Earth II", icon: "naturalEarthII.png" },
  { id: "bing-aerial", name: "Bing Maps Aerial", icon: "bingAerial.png", assetId: 2 },
  {
    id: "bing-labels",
    name: "Bing Maps Aerial with Labels",
    icon: "bingAerialLabels.png",
    assetId: 3,
  },
  { id: "bing-roads", name: "Bing Maps Roads", icon: "bingRoads.png", assetId: 4 },
  { id: "sentinel-2", name: "Sentinel-2", icon: "sentinel-2.png", assetId: 3954 },
  { id: "blue-marble", name: "Blue Marble", icon: "blueMarble.png", assetId: 3845 },
  { id: "earth-at-night", name: "Earth at night", icon: "earthAtNight.png", assetId: 3812 },
  {
    id: "google-satellite",
    name: "Google Maps Satellite",
    icon: "googleSatellite.png",
    assetId: 3830182,
  },
  {
    id: "google-labels",
    name: "Google Maps Satellite with Labels",
    icon: "googleSatelliteLabels.png",
    assetId: 3830183,
  },
  { id: "google-roads", name: "Google Maps Roadmap", icon: "googleRoadmap.png", assetId: 3830184 },
  {
    id: "google-contour",
    name: "Google Maps Contour",
    icon: "googleContour.png",
    assetId: 3830186,
  },
  { id: "azure-aerial", name: "Azure Maps Aerial", icon: "azureAerial.png", assetId: 3891168 },
  { id: "azure-roads", name: "Azure Maps Roads", icon: "azureRoads.png", assetId: 3891169 },
  {
    id: "esri-imagery",
    name: "ArcGIS World Imagery",
    icon: "ArcGisMapServiceWorldImagery.png",
    category: "Other",
    service: "World_Imagery",
  },
  {
    id: "esri-hillshade",
    name: "ArcGIS World Hillshade",
    icon: "ArcGisMapServiceWorldHillshade.png",
    category: "Other",
    service: "Elevation/World_Hillshade",
  },
  {
    id: "esri-ocean",
    name: "Esri World Ocean",
    icon: "ArcGisMapServiceWorldOcean.png",
    category: "Other",
    service: "Ocean/World_Ocean_Base",
  },
  { id: "osm", name: "OpenStreetMap", icon: "openStreetMap.png", category: "Other" },
  {
    id: "stadia-watercolor",
    name: "Stadia x Stamen Watercolor",
    icon: "stamenWatercolor.png",
    category: "Other",
    stadiaStyle: "stamen_watercolor",
    maximumLevel: 16,
    extension: "jpg",
  },
  {
    id: "stadia-toner",
    name: "Stadia x Stamen Toner",
    icon: "stamenToner.png",
    category: "Other",
    stadiaStyle: "stamen_toner",
    maximumLevel: 20,
    extension: "png",
  },
  {
    id: "stadia-smooth",
    name: "Stadia Alidade Smooth",
    icon: "stadiaAlidadeSmooth.png",
    category: "Other",
    stadiaStyle: "alidade_smooth",
    maximumLevel: 20,
    extension: "png",
  },
  {
    id: "stadia-dark",
    name: "Stadia Alidade Smooth Dark",
    icon: "stadiaAlidadeSmoothDark.png",
    category: "Other",
    stadiaStyle: "alidade_smooth_dark",
    maximumLevel: 20,
    extension: "png",
  },
] as const;

export type CesiumBasemapId = (typeof CESIUM_BASEMAPS)[number]["id"];

export function normalizeCesiumBasemap(value: unknown): CesiumBasemapId {
  return CESIUM_BASEMAPS.find((entry) => entry.id === value)?.id ?? "project";
}

/** Missing credentials fall back to the project background without changing the saved choice. */
export function availableCesiumBasemap(value: unknown, hasIonToken: boolean): CesiumBasemapId {
  const entry = CESIUM_BASEMAPS.find((entry) => entry.id === value);
  return entry && (!("assetId" in entry) || hasIonToken) ? entry.id : "project";
}

/**
 * What the globe should draw underneath the project's data layers.
 *
 * - `xyz` — a tile template to render, with the credit and zoom bounds that go
 *   with it.
 * - `none` — the user chose the blank basemap; draw a bare ellipsoid.
 * - `default` — this basemap has no raster equivalent (a custom style URL, a
 *   provider style, an offline archive). The renderer falls back to whatever it
 *   can offer, which is Ion World Imagery when a token is configured and
 *   OpenStreetMap otherwise.
 */
export type CesiumBasemapImagery =
  | { kind: "none" }
  | { kind: "default" }
  | { kind: "ion"; assetId: number }
  | { kind: "natural-earth" }
  | { kind: "arcgis"; url: string }
  | {
      kind: "xyz";
      /** Tile template with `{z}`/`{x}`/`{y}` placeholders. */
      template: string;
      /** Credentials are resolved at render time, never embedded in the descriptor. */
      apiKeyProvider?: "stadia";
      /** Credit to show on the globe, as the HTML the 2D map already uses. */
      attribution: string;
      /** Max native zoom of the source, so the globe overzooms rather than 404s. */
      maximumLevel?: number;
      /**
       * Tile row ordering. `"tms"` numbers rows from the bottom; absent means
       * standard XYZ. Cesium has no `scheme` option, so a TMS template needs
       * `{y}` swapped for its `{reverseY}` placeholder at render time.
       */
      scheme?: "tms";
      /**
       * A transparent overlay drawn directly above {@link template} — the
       * roads-and-labels tiles a hybrid basemap (Amap Hybrid) bakes in, so one
       * basemap selection still yields a labelled satellite globe.
       */
      overlayTemplate?: string;
    };

/**
 * A keyless raster basemap standing in for a vector style of the same tone.
 *
 * "Keyless" is the binding constraint, and it rules out most of the obvious
 * candidates: CARTO's raster endpoints (which the 2D basemap control still
 * lists) now stamp every tile with an "API KEY REQUIRED" watermark, and
 * Stadia/Stamen and Thunderforest have required keys for years. What is left
 * and still permissively licensed is OpenStreetMap's own tiles and EOX Maps'
 * WMTS layers (CC BY-SA), which between them cover the three tones GeoLibre's
 * vector basemaps span.
 */
interface RasterAnalogue {
  template: string;
  attribution: string;
  /** Max native zoom of the source; the globe overzooms past it rather than 404s. */
  maximumLevel: number;
}

const OSM_CREDIT =
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
/** EOX Maps serves these layers keyless under CC BY-SA 4.0. */
const EOX_CREDIT = '<a href="https://maps.eox.at">EOX Maps</a> (CC BY-SA 4.0)';

const eoxLayer = (layer: string, extension: string): string =>
  `https://tiles.maps.eox.at/wmts/1.0.0/${layer}/default/g/{z}/{y}/{x}.${extension}`;

/** Colourful streets — the tone of Liberty and Bright. */
const STREETS: RasterAnalogue = {
  template: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: OSM_CREDIT,
  maximumLevel: 19,
};

/** Light and muted — the tone of Positron and the pale Protomaps flavors. */
const LIGHT: RasterAnalogue = {
  template: eoxLayer("terrain-light_3857", "jpg"),
  attribution: `Terrain Light · ${OSM_CREDIT} · ${EOX_CREDIT}`,
  maximumLevel: 16,
};

/**
 * Dark — the tone of Dark, Fiord, and the dark Protomaps flavors. NASA's Black
 * Marble night lights is the one keyless dark raster basemap left, and it suits
 * a globe: the point of matching here is that a dark project does not end up
 * with a glaring bright globe in the corner.
 */
const DARK: RasterAnalogue = {
  template: eoxLayer("blackmarble_3857", "jpg"),
  attribution: `Black Marble © NASA Earth Observatory · ${EOX_CREDIT}`,
  // A low-resolution global product; past this the globe blurs rather than 404s.
  maximumLevel: 8,
};

/** Raster analogue per OpenFreeMap style name (the last path segment). */
const OPENFREEMAP_ANALOGUES: Record<string, RasterAnalogue> = {
  liberty: STREETS,
  bright: STREETS,
  positron: LIGHT,
  dark: DARK,
  fiord: DARK,
};

/** Raster analogue per Protomaps v5 flavor. */
const PROTOMAPS_ANALOGUES: Record<string, RasterAnalogue> = {
  light: LIGHT,
  white: LIGHT,
  grayscale: LIGHT,
  dark: DARK,
  black: DARK,
};

function toImagery(analogue: RasterAnalogue): CesiumBasemapImagery {
  return {
    kind: "xyz",
    template: analogue.template,
    attribution: analogue.attribution,
    maximumLevel: analogue.maximumLevel,
  };
}

/**
 * Whether two descriptors would draw the same thing.
 *
 * Descriptors are built fresh on every call, so two basemaps resolving to the
 * same analogue — OpenFreeMap `liberty` and `bright` are both the streets
 * tone — yield equal but distinct objects. A renderer that remembers the
 * descriptor it drew (to skip redundant work) must compare by value: a
 * reference check would miss that case and tear down and re-add an identical
 * tile provider, costing a flash and a round of re-requested tiles for no
 * visible change.
 */
export function sameCesiumImagery(a: CesiumBasemapImagery, b: CesiumBasemapImagery): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "arcgis" && b.kind === "arcgis") return a.url === b.url;
  if (a.kind === "ion" && b.kind === "ion") return a.assetId === b.assetId;
  // `none` and `default` carry no fields, so matching kinds is the whole test.
  if (a.kind !== "xyz" || b.kind !== "xyz") return true;
  return (
    a.template === b.template &&
    a.apiKeyProvider === b.apiKeyProvider &&
    a.attribution === b.attribution &&
    a.maximumLevel === b.maximumLevel &&
    a.scheme === b.scheme &&
    a.overlayTemplate === b.overlayTemplate
  );
}

/**
 * `decodeURIComponent` that reports failure instead of throwing. A URL keeps a
 * malformed escape (`%E0%A4`) in its pathname quite happily, but decoding one
 * throws `URIError` — and this runs inside a React render, so an unhandled throw
 * would take the globe pane down instead of falling through to the default.
 */
function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/**
 * The raster analogue for a vector GL style URL, or undefined when the style is
 * not one GeoLibre ships (a provider style, a user's own URL, a Mapbox style).
 * Matching on host + path rather than searching the URL for "dark"/"light"
 * keeps an unrelated style whose *key* happens to contain one of those words
 * from being mapped to the wrong tone.
 */
function vectorStyleAnalogue(styleUrl: string): RasterAnalogue | undefined {
  let parsed: URL;
  try {
    parsed = new URL(styleUrl);
  } catch {
    return undefined;
  }
  if (parsed.hostname === "tiles.openfreemap.org") {
    // https://tiles.openfreemap.org/styles/<name>
    const name = parsed.pathname.split("/").filter(Boolean).at(-1);
    return name ? OPENFREEMAP_ANALOGUES[name] : undefined;
  }
  if (parsed.hostname === "api.protomaps.com") {
    // https://api.protomaps.com/styles/v5/<flavor>/<lang>.json?key=…
    const segments = parsed.pathname.split("/").filter(Boolean);
    const flavor = segments[0] === "styles" ? segments[2] : undefined;
    const decoded = flavor ? safeDecode(flavor) : undefined;
    return decoded ? PROTOMAPS_ANALOGUES[decoded] : undefined;
  }
  return undefined;
}

/**
 * Translate a basemap style URL into imagery for the Cesium globe.
 *
 * Planetary and regional basemaps are already raster tile sets, so they carry
 * straight over — the globe shows the same Mars/Moon/Amap tiles the 2D panes
 * do. GeoLibre's own vector styles map to a keyless raster basemap of matching
 * tone, so switching the project to a dark basemap darkens the globe too.
 * Everything else reports `default`, leaving the choice of fallback imagery to
 * the renderer (which knows whether an Ion token is configured).
 *
 * A `geolibre://` sentinel that no longer resolves is treated as the default
 * basemap, mirroring what `resolveMapStyle` does for the 2D map rather than
 * handing the sentinel onward as if it were fetchable.
 *
 * @param styleUrl - The project's `basemapStyleUrl`.
 * @returns What the globe should draw beneath the data layers.
 */
export function basemapToCesiumImagery(
  styleUrl: string | undefined,
  cesiumBasemap: CesiumBasemapId = "project",
): CesiumBasemapImagery {
  const entry = CESIUM_BASEMAPS.find((entry) => entry.id === cesiumBasemap);
  if (entry && "service" in entry) {
    return {
      kind: "arcgis",
      url: `https://services.arcgisonline.com/ArcGIS/rest/services/${entry.service}/MapServer`,
    };
  }
  if (entry && "stadiaStyle" in entry) {
    return {
      kind: "xyz",
      template: `https://tiles.stadiamaps.com/tiles/${entry.stadiaStyle}/{z}/{x}/{y}.${entry.extension}`,
      maximumLevel: entry.maximumLevel,
      apiKeyProvider: "stadia",
      attribution:
        '<a href="https://stadiamaps.com/">© Stadia Maps</a> ' +
        (entry.stadiaStyle.startsWith("stamen_")
          ? '<a href="https://stamen.com/">© Stamen Design</a> '
          : "") +
        '<a href="https://openmaptiles.org/">© OpenMapTiles</a> ' +
        '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>',
    };
  }
  if (entry && "assetId" in entry) return { kind: "ion", assetId: entry.assetId };
  if (cesiumBasemap === "natural-earth") return { kind: "natural-earth" };
  if (cesiumBasemap === "osm") return toImagery(STREETS);
  if (styleUrl === BLANK_BASEMAP) return { kind: "none" };
  const url = styleUrl ?? DEFAULT_BASEMAP;

  const planetary = getPlanetaryBasemapByStyleUrl(url);
  if (planetary) {
    return {
      kind: "xyz",
      template: planetary.tileUrl,
      attribution: planetary.attribution,
      maximumLevel: planetary.maxZoom,
      ...(planetary.scheme ? { scheme: planetary.scheme } : {}),
    };
  }

  const regional = getRegionalBasemapByStyleUrl(url);
  if (regional) {
    return {
      kind: "xyz",
      template: regional.tileUrl,
      attribution: regional.attribution,
      maximumLevel: regional.maxZoom,
      ...(regional.scheme ? { scheme: regional.scheme } : {}),
      ...(regional.overlayTileUrl ? { overlayTemplate: regional.overlayTileUrl } : {}),
    };
  }

  // Every remaining sentinel kind — an offline PMTiles archive, a planetary or
  // regional id that has since been renamed — has no raster form to show, so
  // fall back the way the 2D map does instead of leaving the globe blank.
  // Reading the fallback back out of DEFAULT_BASEMAP keeps the two in step if
  // the default ever changes.
  const analogue = vectorStyleAnalogue(url.startsWith("geolibre://") ? DEFAULT_BASEMAP : url);
  return analogue ? toImagery(analogue) : { kind: "default" };
}
