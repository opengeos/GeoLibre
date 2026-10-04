import {
  BLANK_BASEMAP,
  DEFAULT_BASEMAP,
  getPlanetaryBasemapByStyleUrl,
  getRegionalBasemapByStyleUrl,
  isRegionalBasemapSentinel,
  PLANETARY_BASEMAP_SENTINEL_PREFIX,
  type PlanetaryBasemap,
  type RegionalBasemap,
} from "@geolibre/core";
import type * as maplibregl from "maplibre-gl";
import { getOfflineBasemapStyle, isOfflineBasemapSentinel } from "./protomaps-basemap";

// Resolves a project's basemap style URL to what a GL map can load: GeoLibre's
// `geolibre://` sentinels (blank, planetary, offline, regional) expand to
// inline style documents, and anything else passes through as a URL. Shared
// by the MapLibre controller and the Mapbox canvas.

export const BLANK_BACKGROUND_LAYER_ID = "geolibre-blank-background";
const BLANK_BACKGROUND_COLOR = "#ffffff";
const DARK_BLANK_BACKGROUND_COLOR = "#262626";

/** Theme-aware default used when a Blank background has no saved custom color. */
export function defaultBlankBackgroundColor(
  dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
): string {
  return dark ? DARK_BLANK_BACKGROUND_COLOR : BLANK_BACKGROUND_COLOR;
}

export function createBlankMapStyle(): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [
      {
        id: BLANK_BACKGROUND_LAYER_ID,
        type: "background",
        paint: {
          "background-color": BLANK_BACKGROUND_COLOR,
        },
      },
    ],
  };
}

/**
 * Whether a basemap style URL is one of GeoLibre's internal sentinels rather
 * than something fetchable. Every sentinel kind — planetary (`geolibre://
 * basemap/`), offline (`geolibre://offline-basemap/`), and regional
 * (`geolibre://regional-basemap/`) — is expanded to an inline style by
 * {@link resolveMapStyle} and would throw if handed to `fetch`.
 *
 * Matching on the scheme rather than enumerating the three prefixes keeps a
 * fourth sentinel kind from silently reintroducing that fetch, and covers a
 * sentinel whose id no longer resolves (which the per-kind lookups miss).
 */
export function isGeoLibreSentinelStyleUrl(styleUrl: string | undefined): boolean {
  return Boolean(styleUrl?.startsWith("geolibre://"));
}

export function resolveMapStyle(
  styleUrl: string | undefined,
): string | maplibregl.StyleSpecification {
  if (styleUrl === BLANK_BASEMAP) return createBlankMapStyle();
  const offline = getOfflineBasemapStyle(styleUrl);
  // Return a fresh copy (like the planetary path below builds a new object each
  // call): MapLibre normalises/mutates the style it's handed, and the registry
  // holds a single shared object — in split/compare view two Map instances
  // resolve the same sentinel, so handing both the same object would let them
  // corrupt each other's style state.
  if (offline) return structuredClone(offline);
  // An offline-basemap sentinel with no registered style (e.g. a project saved
  // with one, reopened in a fresh session where the in-memory archive is gone)
  // must not be fetched as a URL. Fall back to the default basemap.
  if (isOfflineBasemapSentinel(styleUrl)) {
    console.warn(
      `Offline basemap "${styleUrl}" is not available in this session; falling back to the default basemap.`,
    );
    return DEFAULT_BASEMAP;
  }
  const planetary = getPlanetaryBasemapByStyleUrl(styleUrl);
  if (planetary) return createPlanetaryMapStyle(planetary);
  // A planetary sentinel that no longer resolves (e.g. a project saved with a
  // basemap id that has since been renamed) must not be handed to MapLibre as a
  // style URL — it would try to fetch the `geolibre://` sentinel and blank the
  // map. Fall back to the default basemap instead.
  if (styleUrl?.startsWith(PLANETARY_BASEMAP_SENTINEL_PREFIX)) {
    console.warn(`Unknown planetary basemap "${styleUrl}"; falling back to the default basemap.`);
    return DEFAULT_BASEMAP;
  }
  const regional = getRegionalBasemapByStyleUrl(styleUrl);
  if (regional) return createRegionalMapStyle(regional);
  // Same guard as the planetary path: a regional sentinel that no longer
  // resolves must not be handed to MapLibre as a style URL.
  if (isRegionalBasemapSentinel(styleUrl)) {
    console.warn(`Unknown regional basemap "${styleUrl}"; falling back to the default basemap.`);
    return DEFAULT_BASEMAP;
  }
  return styleUrl ?? DEFAULT_BASEMAP;
}

/**
 * A raster style for a {@link RegionalBasemap} — today the mainland-China
 * providers, whose tiles are ordinary Web-Mercator images (XYZ, or TMS when
 * `scheme` says so). A basemap with an `overlayTileUrl` (Amap Hybrid) stacks
 * its transparent roads-and-labels tiles above the imagery, so one selection
 * gives a labeled satellite basemap.
 *
 * Unlike the planetary styles this uses a light background rather than black:
 * these cover Earth, so a gap should read as missing map, not as space.
 */
function createRegionalMapStyle(basemap: RegionalBasemap): maplibregl.StyleSpecification {
  const rasterSource = (tiles: string, withAttribution: boolean) =>
    ({
      type: "raster",
      tiles: [tiles],
      tileSize: 256,
      maxzoom: basemap.maxZoom,
      ...(basemap.scheme ? { scheme: basemap.scheme } : {}),
      // Credit the provider once; repeating it on the overlay would print the
      // same attribution twice in the map's attribution control.
      ...(withAttribution ? { attribution: basemap.attribution } : {}),
    }) satisfies maplibregl.RasterSourceSpecification;

  return {
    version: 8,
    sources: {
      "regional-basemap": rasterSource(basemap.tileUrl, true),
      ...(basemap.overlayTileUrl
        ? { "regional-basemap-overlay": rasterSource(basemap.overlayTileUrl, false) }
        : {}),
    },
    layers: [
      {
        id: BLANK_BACKGROUND_LAYER_ID,
        type: "background",
        paint: { "background-color": BLANK_BACKGROUND_COLOR },
      },
      { id: "regional-basemap", type: "raster", source: "regional-basemap" },
      ...(basemap.overlayTileUrl
        ? [
            {
              id: "regional-basemap-overlay",
              type: "raster" as const,
              source: "regional-basemap-overlay",
            },
          ]
        : []),
    ],
  };
}

/**
 * A single-source raster style for a celestial body — the Moon/Mars mosaics or
 * the Earth satellite imagery the planet switcher uses. The tiles are images in
 * that body's Web-Mercator scheme (XYZ, or TMS when `basemap.scheme` says so),
 * so MapLibre renders them like any raster basemap. A dark background shows
 * through at zoom levels the source doesn't cover, matching how the planetary
 * tiles fade to black at the poles (and reading as space around the globe).
 */
function createPlanetaryMapStyle(basemap: PlanetaryBasemap): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {
      "planetary-basemap": {
        type: "raster",
        tiles: [basemap.tileUrl],
        tileSize: 256,
        maxzoom: basemap.maxZoom,
        // OpenPlanetaryMap's S3 mosaics are TMS (flipped Y); the CARTO named
        // maps are XYZ. MapLibre defaults to "xyz" when scheme is omitted.
        ...(basemap.scheme ? { scheme: basemap.scheme } : {}),
        attribution: basemap.attribution,
      },
    },
    layers: [
      {
        id: BLANK_BACKGROUND_LAYER_ID,
        type: "background",
        paint: { "background-color": "#000000" },
      },
      {
        id: "planetary-basemap",
        type: "raster",
        source: "planetary-basemap",
      },
    ],
  };
}
