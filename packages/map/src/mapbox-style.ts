/**
 * Adapter that makes Mapbox-hosted styles loadable by MapLibre.
 *
 * The basemap control (`maplibre-gl-basemap-control`) offers eight Mapbox
 * styles whose descriptors live at
 * `https://api.mapbox.com/styles/v1/mapbox/<styleId>?access_token=<token>`.
 * Those descriptors are Mapbox-flavored GL styles and MapLibre cannot consume
 * them as-is, for two reasons:
 *
 *  1. **`mapbox://` URLs.** The sprite, glyphs and vector/raster sources are
 *     addressed with Mapbox's private scheme (`mapbox://sprites/mapbox/...`,
 *     `mapbox://fonts/mapbox/...`, `mapbox://mapbox.satellite`). MapLibre has no
 *     resolver for it, so every one of those requests fails and the map renders
 *     empty even when the descriptor itself loads.
 *  2. **`projection: { name: … }`.** Mapbox names its projection `name`;
 *     MapLibre's spec calls it `type`. MapLibre's style validator rejects the
 *     unknown property with `name: unknown property "name"` and — because
 *     `Style._load` bails on the first validation failure — abandons the whole
 *     style, blanking the map.
 *
 * The control handles both itself when it applies a style (it passes a
 * `transformStyle`), but GeoLibre is store-driven: the basemap change is written
 * to `basemapStyleUrl` and re-applied by {@link MapController}, and a reopened
 * project or a split-view pane applies the saved URL with no control involved at
 * all. So the rewrite has to live on GeoLibre's own style path, which is here.
 *
 * The access token is read back out of the style URL's `access_token` query
 * parameter, which is exactly where the control put it — that keeps this module
 * free of credential plumbing and makes a saved project self-contained.
 */

import type * as maplibregl from "maplibre-gl";

/** Host serving both the style descriptors and the `mapbox://` redirect targets. */
const MAPBOX_API_HOST = "api.mapbox.com";
const MAPBOX_STYLE_PATH_PREFIX = "/styles/v1/";

/**
 * Whether a basemap style URL points at a Mapbox-hosted style descriptor, and
 * therefore needs {@link loadMapboxStyle} rather than a plain `setStyle(url)`.
 *
 * @param styleUrl - The basemap style URL (or a GeoLibre sentinel, which never
 *   matches).
 * @returns True for `https://api.mapbox.com/styles/v1/…` URLs.
 */
export function isMapboxStyleUrl(styleUrl: string | undefined): boolean {
  if (!styleUrl) return false;
  let parsed: URL;
  try {
    parsed = new URL(styleUrl);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.hostname === MAPBOX_API_HOST &&
    parsed.pathname.startsWith(MAPBOX_STYLE_PATH_PREFIX)
  );
}

/**
 * Extracts the Mapbox access token the style URL carries.
 *
 * @param styleUrl - A Mapbox style descriptor URL.
 * @returns The raw (decoded) token, or an empty string when the URL has none.
 */
export function mapboxAccessTokenFromStyleUrl(styleUrl: string): string {
  try {
    return new URL(styleUrl).searchParams.get("access_token")?.trim() ?? "";
  } catch {
    return "";
  }
}

/**
 * A Mapbox style URL with its credentials stripped, safe to put in a log line.
 *
 * Every Mapbox URL here carries the user's `access_token` in its query string,
 * so the raw URL must never reach the console (or anything that captures it).
 * The path alone identifies which style failed, which is all a log needs.
 *
 * @param styleUrl - A Mapbox style descriptor URL.
 * @returns The URL's path, or `"(unparseable URL)"` when it is not a URL.
 */
export function redactMapboxStyleUrl(styleUrl: string): string {
  try {
    const parsed = new URL(styleUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "(unparseable URL)";
  }
}

/**
 * Rewrites a single `mapbox://` URL to its public HTTPS equivalent.
 *
 * Mirrors the three forms Mapbox styles use — sprites, font stacks, and tileset
 * sources — and returns anything else untouched, so an already-HTTPS URL (or a
 * scheme added by a future style) passes through unchanged.
 *
 * @param url - The URL taken from the style descriptor.
 * @param encodedAccessToken - The URI-encoded Mapbox access token.
 * @returns The resolved HTTPS URL, or the input when it is not a `mapbox://` URL.
 */
export function resolveMapboxInternalUrl(url: string, encodedAccessToken: string): string {
  const sprite = /^mapbox:\/\/sprites\/([^/]+)\/(.+)$/.exec(url);
  if (sprite) {
    return `https://${MAPBOX_API_HOST}/styles/v1/${sprite[1]}/${sprite[2]}/sprite?access_token=${encodedAccessToken}`;
  }

  const fonts = /^mapbox:\/\/fonts\/([^/]+)\/(.+)$/.exec(url);
  if (fonts) {
    return `https://${MAPBOX_API_HOST}/fonts/v1/${fonts[1]}/${fonts[2]}?access_token=${encodedAccessToken}`;
  }

  if (url.startsWith("mapbox://")) {
    // Everything else is a tileset id (possibly a comma-joined list), served as
    // TileJSON from the v4 endpoint. The returned TileJSON carries tile URLs
    // that already include the token, so nothing downstream needs rewriting.
    return `https://${MAPBOX_API_HOST}/v4/${url.slice("mapbox://".length)}.json?secure&access_token=${encodedAccessToken}`;
  }

  return url;
}

/** Resolves the `sprite` field, which is either one URL or a named list. */
function resolveMapboxSprite(
  sprite: maplibregl.StyleSpecification["sprite"],
  encodedAccessToken: string,
): maplibregl.StyleSpecification["sprite"] {
  if (typeof sprite === "string") return resolveMapboxInternalUrl(sprite, encodedAccessToken);
  if (Array.isArray(sprite)) {
    return sprite.map((entry) => ({
      ...entry,
      url: resolveMapboxInternalUrl(entry.url, encodedAccessToken),
    }));
  }
  return sprite;
}

/**
 * Converts a Mapbox style descriptor into one MapLibre accepts.
 *
 * Resolves every `mapbox://` URL (sources, sprite, glyphs) against the public
 * HTTPS endpoints and replaces Mapbox's `projection: { name: … }` with the
 * MapLibre spelling. The projection is pinned to `mercator` rather than
 * translated: `MapController.enforceProjection` re-applies the user's own
 * globe/mercator preference as soon as the style loads, so carrying Mapbox's
 * choice over would only be overwritten a moment later.
 *
 * @param style - The descriptor as fetched from Mapbox.
 * @param accessToken - The raw Mapbox access token.
 * @returns A new style object; the input is not mutated.
 */
export function transformMapboxStyle(
  style: maplibregl.StyleSpecification,
  accessToken: string,
): maplibregl.StyleSpecification {
  const encodedAccessToken = encodeURIComponent(accessToken);
  const sources = Object.fromEntries(
    Object.entries(style.sources ?? {}).map(([id, source]) => {
      if (
        source &&
        typeof source === "object" &&
        "url" in source &&
        typeof source.url === "string"
      ) {
        return [id, { ...source, url: resolveMapboxInternalUrl(source.url, encodedAccessToken) }];
      }
      return [id, source];
    }),
  ) as maplibregl.StyleSpecification["sources"];

  return {
    ...style,
    glyphs:
      typeof style.glyphs === "string"
        ? resolveMapboxInternalUrl(style.glyphs, encodedAccessToken)
        : style.glyphs,
    sprite: resolveMapboxSprite(style.sprite, encodedAccessToken),
    projection: { type: "mercator" },
    sources,
  };
}

/**
 * Fetches a Mapbox style descriptor and returns it in MapLibre form.
 *
 * @param styleUrl - A Mapbox style URL, including its `access_token` parameter.
 * @param signal - Optional abort signal for a superseded basemap change.
 * @returns The transformed style, ready for `map.setStyle(style, { validate: false })`.
 * @throws When the descriptor cannot be fetched (bad token, offline, 404).
 */
export async function loadMapboxStyle(
  styleUrl: string,
  signal?: AbortSignal,
): Promise<maplibregl.StyleSpecification> {
  const response = await fetch(styleUrl, { signal });
  if (!response.ok) {
    throw new Error(`Mapbox style request failed (${response.status} ${response.statusText})`);
  }
  const style = (await response.json()) as maplibregl.StyleSpecification;
  return transformMapboxStyle(style, mapboxAccessTokenFromStyleUrl(styleUrl));
}
