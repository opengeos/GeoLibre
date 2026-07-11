import type { GeoLibreLayer, GeoLibreProject } from "@geolibre/core";
import { invoke } from "@tauri-apps/api/core";
import { addProtocol, type RequestParameters } from "maplibre-gl";
import { resolveUrlRedirect } from "./native-http";
import { isTauri } from "./tauri-io";

const XYZ_TILE_PROTOCOL = "geolibre-xyz";

let protocolRegistered = false;

export interface ResolvedXyzTileUrl {
  originalUrl: string;
  redirected: boolean;
  renderUrl: string;
  url: string;
}

export function normalizeTileUrlTemplate(url: string): string {
  return url
    .replace(/%7B([xyz])%7D/gi, (_, placeholder: string) => {
      return `{${placeholder.toLowerCase()}}`;
    })
    .replace(/\{([xyz])\}/gi, (_, placeholder: string) => {
      return `{${placeholder.toLowerCase()}}`;
    });
}

export function hasXyzTilePlaceholders(url: string): boolean {
  return ["x", "y", "z"].every((placeholder) =>
    url.includes(`{${placeholder}}`),
  );
}

export function createXyzTileUrlTemplate(url: string): ResolvedXyzTileUrl {
  const originalUrl = normalizeTileUrlTemplate(url.trim());
  if (!hasXyzTilePlaceholders(originalUrl)) {
    throw new Error(
      "Enter an XYZ tile URL template with {z}, {x}, and {y} placeholders.",
    );
  }

  return {
    originalUrl,
    redirected: false,
    renderUrl: originalUrl,
    url: originalUrl,
  };
}

export async function resolveXyzTileUrlTemplate(
  url: string,
  signal?: AbortSignal,
): Promise<ResolvedXyzTileUrl> {
  const originalUrl = normalizeTileUrlTemplate(url.trim());
  if (hasXyzTilePlaceholders(originalUrl)) {
    return {
      originalUrl,
      redirected: false,
      renderUrl: renderableXyzTileUrl(originalUrl),
      url: originalUrl,
    };
  }

  const resolvedUrl = normalizeTileUrlTemplate(
    await resolveShortXyzUrl(originalUrl, signal),
  );
  if (!hasXyzTilePlaceholders(resolvedUrl)) {
    throw new Error(
      "Enter an XYZ tile URL template with {z}, {x}, and {y} placeholders.",
    );
  }

  return {
    originalUrl,
    redirected: resolvedUrl !== originalUrl,
    renderUrl: renderableXyzTileUrl(resolvedUrl),
    url: resolvedUrl,
  };
}

export function registerXyzTileProtocol(): void {
  if (protocolRegistered || !isTauri()) return;

  addProtocol(XYZ_TILE_PROTOCOL, async (request) => {
    const url = parseXyzTileRequest(request);
    // This handler runs once per tile, so — unlike the one-shot native calls
    // routed through native-http — it deliberately calls `invoke` directly and
    // is NOT recorded in diagnostics: a fast pan over a tile server's coverage
    // edge returns 404s in bulk, and recording each would re-render the panel
    // per tile and evict more relevant entries from the 500-record ring buffer.
    const bytes = await invoke<number[] | Uint8Array>("fetch_url_bytes", {
      url,
    });
    const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return {
      data: array.buffer.slice(
        array.byteOffset,
        array.byteOffset + array.byteLength,
      ),
    };
  });
  protocolRegistered = true;
}

export async function resolveProjectXyzLayers(
  project: GeoLibreProject,
  signal?: AbortSignal,
): Promise<GeoLibreProject> {
  const results = await Promise.allSettled(
    project.layers.map((layer) => resolveProjectXyzLayer(layer, signal)),
  );
  const layers = results.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    if (!signal?.aborted) {
      console.warn("Could not resolve XYZ layer URL", result.reason);
    }
    return project.layers[index];
  });
  return { ...project, layers };
}

async function resolveProjectXyzLayer(
  layer: GeoLibreLayer,
  signal?: AbortSignal,
): Promise<GeoLibreLayer> {
  if (layer.type !== "xyz") return layer;

  const url = getSavedXyzUrl(layer);
  if (!url) {
    return layer;
  }

  const hasShortUrlMetadata =
    typeof layer.metadata.originalUrl === "string" &&
    layer.metadata.originalUrl.trim().length > 0;
  const normalizedUrl = normalizeTileUrlTemplate(url);
  const tileUrl =
    hasShortUrlMetadata || !hasXyzTilePlaceholders(normalizedUrl)
      ? await resolveXyzTileUrlTemplate(url, signal)
      : createXyzTileUrlTemplate(url);
  return {
    ...layer,
    source: {
      ...layer.source,
      tiles: [tileUrl.renderUrl],
      url: tileUrl.originalUrl,
    },
    metadata: {
      ...layer.metadata,
      originalUrl:
        tileUrl.redirected || layer.metadata.originalUrl
          ? tileUrl.originalUrl
          : undefined,
      resolvedUrl: tileUrl.redirected ? tileUrl.url : undefined,
      sourceKind: layer.metadata.sourceKind ?? "xyz-url",
    },
  };
}

function getSavedXyzUrl(layer: GeoLibreLayer): string | null {
  const originalUrl = layer.metadata.originalUrl;
  if (typeof originalUrl === "string" && originalUrl.trim()) {
    return originalUrl;
  }

  const sourceUrl = layer.source.url;
  if (typeof sourceUrl === "string" && sourceUrl.trim()) {
    return sourceUrl;
  }

  const tiles = layer.source.tiles;
  if (Array.isArray(tiles) && typeof tiles[0] === "string") {
    return tiles[0];
  }

  return null;
}

function renderableXyzTileUrl(url: string): string {
  // Tauri allows HTTPS image tiles via CSP, so keep the browser/WebView tile
  // path. Routing every XYZ tile through IPC makes slow tile servers affect
  // desktop responsiveness.
  return url;
}

function parseXyzTileRequest(request: RequestParameters): string {
  const url = new URL(request.url);
  const template = url.searchParams.get("url");
  if (!template) {
    throw new Error("Invalid XYZ tile URL.");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 3) {
    throw new Error("Invalid XYZ tile coordinates.");
  }

  return template
    .replace(/\{z\}/g, parts[0])
    .replace(/\{x\}/g, parts[1])
    .replace(/\{y\}/g, parts[2]);
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

async function resolveShortXyzUrl(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!isHttpUrl(url)) return url;

  if (isTauri()) {
    try {
      return await resolveShortXyzUrlWithFetch(url, signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      console.warn("Falling back to desktop URL resolver", error);
    }

    return resolveUrlRedirect(url, { context: "XYZ URL resolve" });
  }

  return resolveShortXyzUrlWithFetch(url, signal);
}

async function resolveShortXyzUrlWithFetch(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(url, {
    headers: { Accept: "application/json, text/plain;q=0.9, */*;q=0.8" },
    redirect: "follow",
    signal,
  });
  const resolvedUrl = urlFromResolverResponse(response);
  if (resolvedUrl) return resolvedUrl;

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    const bodyUrl = await urlFromResolverBody(response);
    if (bodyUrl) return bodyUrl;
  }

  return response.url || url;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function urlFromResolverResponse(response: Response): string | null {
  const resolvedUrl = normalizeTileUrlTemplate(response.url);
  return resolvedUrl && hasXyzTilePlaceholders(resolvedUrl)
    ? resolvedUrl
    : null;
}

async function urlFromResolverBody(response: Response): Promise<string | null> {
  const text = (await response.text()).trim();
  if (!text) return null;

  const jsonUrl = urlFromResolverJson(text);
  if (jsonUrl) return jsonUrl;

  return isHttpUrl(text) ? text : null;
}

function urlFromResolverJson(text: string): string | null {
  try {
    const value = JSON.parse(text) as unknown;
    return urlFromJsonValue(value);
  } catch {
    return null;
  }
}

function urlFromJsonValue(value: unknown): string | null {
  if (typeof value === "string" && isHttpUrl(value)) return value;
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  for (const key of ["url", "tileUrl", "tile_url"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && isHttpUrl(candidate)) {
      return candidate;
    }
  }

  const tiles = record.tiles;
  if (
    Array.isArray(tiles) &&
    typeof tiles[0] === "string" &&
    isHttpUrl(tiles[0])
  ) {
    return tiles[0];
  }

  return null;
}
