import type { GeoLibreLayer } from "@geolibre/core";
import {
  appendQuery,
  createWmsGetCapabilitiesUrl,
  fetchCapabilitiesText,
  normalizeWmsVersion,
  stripOgcOperationParams,
} from "../components/layout/add-data/helpers";
import { WMS_PROXY_PATH } from "../components/layout/add-data/constants";

/** One legend image for a single WMS layer. */
export interface WmsLegendEntry {
  /** The WMS layer name the legend describes. */
  layer: string;
  /** Image URL, usable directly as an `<img src>`. */
  url: string;
}

/** The WMS request fields a legend lookup needs, read from a layer's source. */
export interface WmsLegendSource {
  endpoint: string;
  layers: string[];
  styles: string[];
  version: string;
}

/**
 * Reads the WMS request fields from a layer, or null when it is not a WMS
 * layer with an endpoint and at least one named layer.
 *
 * @param layer - The layer to inspect.
 * @returns The legend lookup fields, or null.
 */
export function wmsLegendSource(layer: GeoLibreLayer): WmsLegendSource | null {
  if (layer.type !== "wms") return null;
  const source = layer.source;
  const text = (key: string) => (typeof source[key] === "string" ? (source[key] as string) : "");
  const endpoint = stripOgcOperationParams(text("url").trim(), "WMS");
  const styleList = text("styles").split(",");
  // Pair each style with its layer before dropping blank layer names, so a
  // LAYERS value such as "a,,b" keeps every remaining layer on its own style.
  const pairs = text("layers")
    .split(",")
    .map((name, index) => ({ name: name.trim(), style: (styleList[index] ?? "").trim() }))
    .filter((pair) => pair.name);
  const layers = pairs.map((pair) => pair.name);
  const styles = pairs.map((pair) => pair.style);
  if (!endpoint || layers.length === 0) return null;
  return { endpoint, layers, styles, version: normalizeWmsVersion(text("version")) };
}

/**
 * Builds a standard WMS `GetLegendGraphic` request URL for one layer.
 *
 * @param source - The WMS request fields.
 * @param layer - The layer name to request a legend for.
 * @param style - The style name; empty for the server default.
 * @returns The request URL.
 */
export function wmsGetLegendGraphicUrl(
  source: Pick<WmsLegendSource, "endpoint" | "version">,
  layer: string,
  style = "",
): string {
  const params: Array<[string, string]> = [
    ["SERVICE", "WMS"],
    ["REQUEST", "GetLegendGraphic"],
    ["VERSION", source.version],
    ["LAYER", layer],
    ["FORMAT", "image/png"],
  ];
  if (style) params.push(["STYLE", style]);
  return appendQuery(source.endpoint, params);
}

/**
 * Resolves an advertised legend href against the service endpoint and keeps it
 * only when it is an http(s) URL, so a capabilities document cannot hand the
 * `<img>` a `javascript:`, `data:` or `file:` address.
 */
function resolveLegendHref(href: string, baseUrl?: string): string | null {
  try {
    const url = new URL(href, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Finds the `<LegendURL>` a capabilities document advertises for a layer's
 * style. A named style wins; otherwise the layer's first style is used.
 * Traversal is namespace-agnostic (WMS 1.1.1 and 1.3.0).
 *
 * @param doc - The parsed capabilities document.
 * @param layerName - The layer's `<Name>`.
 * @param styleName - The requested style, or empty for the default.
 * @param baseUrl - The service endpoint, used to resolve a relative href.
 * @returns The legend image URL (http or https), or null when none is advertised.
 */
export function findCapabilitiesLegendUrl(
  doc: Document,
  layerName: string,
  styleName: string,
  baseUrl?: string,
): string | null {
  const layers = doc.getElementsByTagNameNS("*", "Layer");
  for (let i = 0; i < layers.length; i += 1) {
    const layer = layers[i];
    const name = Array.from(layer.children).find((child) => child.localName === "Name");
    if (name?.textContent?.trim() !== layerName) continue;
    const styles = Array.from(layer.children).filter((child) => child.localName === "Style");
    const chosen =
      styles.find(
        (style) =>
          Array.from(style.children)
            .find((child) => child.localName === "Name")
            ?.textContent?.trim() === styleName,
      ) ?? styles[0];
    const legend = chosen?.getElementsByTagNameNS("*", "LegendURL")[0];
    const resource = legend?.getElementsByTagNameNS("*", "OnlineResource")[0];
    const href =
      resource?.getAttribute("xlink:href") ??
      resource?.getAttributeNS("http://www.w3.org/1999/xlink", "href") ??
      resource?.getAttribute("href");
    // A layer can appear more than once (nested groups); keep looking when
    // this match has no usable legend.
    const resolved = href?.trim() ? resolveLegendHref(href.trim(), baseUrl) : null;
    if (resolved) return resolved;
  }
  return null;
}

/**
 * Resolves a legend image URL for every layer of a WMS layer record. The
 * capabilities `<LegendURL>` is preferred; a layer without one (or a service
 * whose capabilities cannot be read) falls back to `GetLegendGraphic`.
 *
 * @param source - The WMS request fields.
 * @param signal - Optional abort signal.
 * @returns One legend entry per requested layer.
 */
export async function resolveWmsLegends(
  source: WmsLegendSource,
  signal?: AbortSignal,
): Promise<WmsLegendEntry[]> {
  let doc: Document | null = null;
  try {
    const { ok, text } = await fetchCapabilitiesText(
      createWmsGetCapabilitiesUrl(source.endpoint),
      WMS_PROXY_PATH,
      signal,
    );
    if (ok || /^\s*</.test(text)) {
      const parsed = new DOMParser().parseFromString(text, "application/xml");
      if (!parsed.querySelector("parsererror")) doc = parsed;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    // Capabilities unreadable (CORS, timeout): GetLegendGraphic is still worth trying.
  }
  return source.layers.map((layer, index) => {
    const style = source.styles[index] ?? "";
    const advertised = doc ? findCapabilitiesLegendUrl(doc, layer, style, source.endpoint) : null;
    return { layer, url: advertised ?? wmsGetLegendGraphicUrl(source, layer, style) };
  });
}

/** Escapes a value for use inside a double-quoted HTML attribute. */
function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Builds the HTML shown by a map HTML control for a set of legend images: one
 * `<img>` per layer, on a white plate so transparent server-drawn legends stay
 * readable on any map style, with the layer name above it when there are
 * several.
 *
 * @param entries - The resolved legend images.
 * @returns The HTML string.
 */
export function wmsLegendHtml(entries: WmsLegendEntry[]): string {
  const blocks = entries.map((entry) => {
    const label =
      entries.length > 1
        ? `<div style="font-size:11px;font-weight:600;margin:0 0 2px 0;">${escapeHtmlAttribute(entry.layer)}</div>`
        : "";
    const image = `<img src="${escapeHtmlAttribute(entry.url)}" alt="${escapeHtmlAttribute(entry.layer)}" style="max-width:100%;background:#fff;padding:2px;border-radius:2px;">`;
    return `<div style="margin:0 0 6px 0;">${label}${image}</div>`;
  });
  return `<div style="padding:4px;">${blocks.join("")}</div>`;
}

/** `layer.metadata` key holding a user-supplied legend image URL. */
export const WMS_LEGEND_IMAGE_METADATA_KEY = "legendImageUrl";

/**
 * Validates a user-entered legend image URL: trimmed, absolute, http(s) only
 * (a `javascript:`, `data:` or `file:` address is rejected).
 *
 * @param input - The text the user typed.
 * @returns The normalized URL, or null when it is not usable.
 */
export function parseLegendImageUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Reads the legend image URL a user saved on a layer, if it is still valid.
 *
 * @param layer - The layer to inspect.
 * @returns The saved URL, or null.
 */
export function savedLegendImageUrl(layer: GeoLibreLayer): string | null {
  const value = layer.metadata?.[WMS_LEGEND_IMAGE_METADATA_KEY];
  return typeof value === "string" ? parseLegendImageUrl(value) : null;
}
