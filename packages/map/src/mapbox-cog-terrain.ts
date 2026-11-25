import { encodeRgbaToPng, type CogDemSourceRegistration } from "./cog-dem-source";

const MAPBOX_COG_DEM_HOST = "cog-dem.geolibre.invalid";
const MAPBOX_COG_DEM_URL_RE = new RegExp(
  `^https://${MAPBOX_COG_DEM_HOST.replace(/\./g, "\\.")}/([^/]+)/(\\d+)/(\\d+)/(\\d+)\\.png$`,
);

export interface MapboxCogDemEntry {
  registration: CogDemSourceRegistration;
  encodePng: (rgba: Uint8ClampedArray) => Promise<ArrayBuffer>;
}

const registry = new Map<string, MapboxCogDemEntry>();
let nextRegistrationId = 0;

/**
 * Convert raw PNG bytes into a `data:image/png;base64,...` URL that Mapbox GL's
 * worker can fetch directly without needing cross-thread `blob:` revocation.
 */
export function pngBytesToDataUrl(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (typeof Buffer !== "undefined") {
    return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

export interface RegisteredMapboxCogDem {
  id: string;
  tileUrlTemplate: string;
  unregister: () => void;
}

/**
 * Register a COG DEM source so {@link transformMapboxCogDemRequest} serves its
 * Terrarium PNG tiles to Mapbox GL's `raster-dem` source.
 */
export function registerMapboxCogDem(
  registration: CogDemSourceRegistration,
  encodePng: (rgba: Uint8ClampedArray) => Promise<ArrayBuffer> = encodeRgbaToPng,
): RegisteredMapboxCogDem {
  const id = String(++nextRegistrationId);
  registry.set(id, { registration, encodePng });
  return {
    id,
    tileUrlTemplate: `https://${MAPBOX_COG_DEM_HOST}/${id}/{z}/{x}/{y}.png`,
    unregister: () => {
      registry.delete(id);
    },
  };
}

/**
 * Async `transformRequest` hook for `mapboxgl.Map`. Passes non-COG-DEM URLs
 * straight through synchronously, and intercepts synthetic COG DEM tile URLs
 * to render Terrarium PNG tiles on demand.
 */
export function transformMapboxCogDemRequest(
  url: string,
  _resourceType?: string,
  options?: { signal?: AbortSignal },
): Promise<{ url: string }> | { url: string } {
  const match = MAPBOX_COG_DEM_URL_RE.exec(url);
  if (!match) return { url };
  const [, id, zStr, xStr, yStr] = match;
  const entry = registry.get(id);
  if (!entry) {
    return Promise.reject(new Error("The Mapbox COG DEM source is no longer available."));
  }
  const z = Number(zStr);
  const x = Number(xStr);
  const y = Number(yStr);
  return (async () => {
    if (options?.signal?.aborted) {
      throw new Error("Aborted");
    }
    const rgba = await entry.registration.renderTile(z, x, y);
    if (options?.signal?.aborted) {
      throw new Error("Aborted");
    }
    const png = await entry.encodePng(rgba);
    return { url: pngBytesToDataUrl(png) };
  })();
}
