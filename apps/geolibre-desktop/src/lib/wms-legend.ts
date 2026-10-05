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
  /** Whether the URL came from the capabilities `<LegendURL>` or a GetLegendGraphic request. */
  origin: "capabilities" | "getlegendgraphic";
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
  const source = layer.source as Record<string, unknown> | undefined;
  const text = (key: string) => (typeof source?.[key] === "string" ? (source[key] as string) : "");
  const endpoint = stripOgcOperationParams(text("url").trim(), "WMS");
  const layers = text("layers")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (!endpoint || layers.length === 0) return null;
  const styles = text("styles")
    .split(",")
    .map((name) => name.trim());
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
 * Finds the `<LegendURL>` a capabilities document advertises for a layer's
 * style. A named style wins; otherwise the layer's first style is used.
 * Traversal is namespace-agnostic (WMS 1.1.1 and 1.3.0).
 *
 * @param doc - The parsed capabilities document.
 * @param layerName - The layer's `<Name>`.
 * @param styleName - The requested style, or empty for the default.
 * @returns The legend image URL, or null when none is advertised.
 */
export function findCapabilitiesLegendUrl(
  doc: Document,
  layerName: string,
  styleName: string,
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
    if (href?.trim()) return href.trim();
    return null;
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
    const advertised = doc ? findCapabilitiesLegendUrl(doc, layer, style) : null;
    return advertised
      ? { layer, url: advertised, origin: "capabilities" as const }
      : {
          layer,
          url: wmsGetLegendGraphicUrl(source, layer, style),
          origin: "getlegendgraphic" as const,
        };
  });
}
