// Generates a Protomaps basemap style for an extracted (or remote) PMTiles
// archive, so an offline basemap renders with proper cartography — water,
// roads, landcover, buildings, and labels — in a light/dark/etc. flavor,
// instead of the flat single-symbology overlay a raw PMTiles layer produces.
//
// The style is an inline MapLibre StyleSpecification (not a URL), applied as
// the basemap through a sentinel the map controller's resolveMapStyle expands
// via getOfflineBasemapStyle(). Glyphs and sprites default to app-bundled
// assets (see scripts/fetch-basemaps-assets.mjs) so it renders fully offline.
import { layers, namedFlavor } from "@protomaps/basemaps";
import type maplibregl from "maplibre-gl";

/** The Protomaps basemap flavors we expose. */
export const PROTOMAPS_FLAVORS = [
  "light",
  "dark",
  "white",
  "grayscale",
  "black",
] as const;

export type ProtomapsFlavor = (typeof PROTOMAPS_FLAVORS)[number];

/** Basemap style URLs of this form carry an inline offline-basemap style kept
 * in the registry below; resolveMapStyle expands them. */
export const OFFLINE_BASEMAP_SENTINEL_PREFIX = "geolibre://offline-basemap/";

/** Default location of the bundled Protomaps glyphs/sprites (served from the
 * app's public dir). Overridable for hosts served under a sub-path. */
const DEFAULT_ASSETS_BASE = "/basemaps-assets";

export interface ProtomapsBasemapStyleOptions {
  /** The archive source, a `pmtiles://…` URL (in-memory key or remote). */
  sourceUrl: string;
  flavor: ProtomapsFlavor;
  /** BCP-47 language for labels (default "en"). */
  lang?: string;
  /** Attribution string for the vector source. */
  attribution?: string;
  /** Base URL for the bundled glyphs/sprites (default `/basemaps-assets`). */
  assetsBaseUrl?: string;
}

/** Builds the inline MapLibre style for a Protomaps-schema PMTiles archive. */
export function buildProtomapsBasemapStyle(
  options: ProtomapsBasemapStyleOptions,
): maplibregl.StyleSpecification {
  const {
    sourceUrl,
    flavor,
    lang = "en",
    attribution = "© OpenStreetMap contributors",
    assetsBaseUrl = DEFAULT_ASSETS_BASE,
  } = options;
  const base = assetsBaseUrl.replace(/\/$/, "");
  return {
    version: 8,
    glyphs: `${base}/fonts/{fontstack}/{range}.pbf`,
    sprite: `${base}/sprites/v4/${flavor}`,
    sources: {
      protomaps: {
        type: "vector",
        url: sourceUrl.startsWith("pmtiles://")
          ? sourceUrl
          : `pmtiles://${sourceUrl}`,
        attribution,
      },
    },
    layers: layers("protomaps", namedFlavor(flavor), {
      lang,
    }) as maplibregl.LayerSpecification[],
  };
}

// Registry of runtime-generated offline basemap styles, keyed by sentinel URL.
// Lives on globalThis so it shares a lifetime with the map across module
// reloads (HMR). Session-scoped: a saved project stores the sentinel, but the
// backing style (and its in-memory PMTiles source) is gone on reload, so
// resolveMapStyle falls back to the default basemap then.
const REGISTRY_KEY = "__geolibreOfflineBasemapStyles";

function registry(): Map<string, maplibregl.StyleSpecification> {
  const scope = globalThis as typeof globalThis & {
    [REGISTRY_KEY]?: Map<string, maplibregl.StyleSpecification>;
  };
  if (!scope[REGISTRY_KEY]) scope[REGISTRY_KEY] = new Map();
  return scope[REGISTRY_KEY];
}

/**
 * Registers a generated style under a fresh sentinel URL and returns it. Set
 * it as the basemap (`setBasemapStyleUrl(sentinel)`) to apply the style.
 */
export function registerOfflineBasemapStyle(
  id: string,
  style: maplibregl.StyleSpecification,
): string {
  const sentinel = `${OFFLINE_BASEMAP_SENTINEL_PREFIX}${id}`;
  registry().set(sentinel, style);
  return sentinel;
}

/** The registered style for an offline-basemap sentinel, or null. */
export function getOfflineBasemapStyle(
  styleUrl: string | undefined,
): maplibregl.StyleSpecification | null {
  if (!styleUrl) return null;
  return registry().get(styleUrl) ?? null;
}

export function isOfflineBasemapSentinel(styleUrl: string | undefined): boolean {
  return Boolean(styleUrl?.startsWith(OFFLINE_BASEMAP_SENTINEL_PREFIX));
}
