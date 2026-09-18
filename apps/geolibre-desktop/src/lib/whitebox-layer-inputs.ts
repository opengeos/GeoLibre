import type { GeoLibreLayer } from "@geolibre/core";
import type { WhiteboxToolParameter } from "@geolibre/processing";
import { parameterKind } from "./whitebox-param-kind";
import { fetchableUrl } from "./url-utils";

// The single home for "can this store layer fill this Whitebox parameter, and
// how do I get its bytes". Both entry points to the WASM runner share it: the
// Processing dialog (ProcessingDialog.tsx) and the scripting surface
// (lib/scripting/scriptingApi.ts, which backs m.run_whitebox_tool over every
// transport). Keeping one copy is what stops the dialog and the Python API from
// disagreeing about which layers are usable — a per-caller copy is how a layer
// that runs fine from the UI starts failing from a notebook.

/**
 * The path or URL a layer's data lives at, as the sidecar runner expects it.
 *
 * @param layer - A store layer.
 * @returns The source path/URL, or `""` when the layer carries neither.
 */
export function layerPath(layer: GeoLibreLayer): string {
  if (layer.sourcePath) return layer.sourcePath;
  const url = layer.source.url;
  if (typeof url === "string") return url;
  const tiles = layer.source.tiles;
  if (Array.isArray(tiles) && typeof tiles[0] === "string") return tiles[0];
  return "";
}

/**
 * Whether `layer` can fill `param`, matching the layer lists the Processing
 * dialog offers for each parameter kind.
 *
 * @param layer - A store layer.
 * @param param - The tool parameter the layer would fill.
 * @returns True when the layer is a valid input for that parameter.
 */
export function canUseLayerForParameter(
  layer: GeoLibreLayer,
  param: WhiteboxToolParameter,
): boolean {
  const kind = parameterKind(param);
  if (kind === "vector_in") {
    return Boolean(layer.geojson || layerPath(layer));
  }
  if (kind === "raster_in") {
    return ["raster", "cog", "wms", "wmts", "xyz", "zarr"].includes(layer.type);
  }
  if (kind === "lidar_in") return layer.type === "lidar";
  return Boolean(layerPath(layer));
}

/**
 * Fetch a raster/LiDAR layer's underlying bytes for the in-browser WASM runner.
 *
 * Candidates are resolved through {@link fetchableUrl}, so a wrapped source
 * scheme (`cog://https://.../x.tif`) is unwrapped rather than rejected.
 *
 * @param layer - The layer to read bytes from.
 * @returns The bytes, or null when the data is not directly fetchable (e.g. a
 *   desktop file path or a tile template), in which case the caller falls back
 *   to the sidecar.
 */
export async function fetchLayerBytes(layer: GeoLibreLayer): Promise<Uint8Array | null> {
  const src = layer.source as Record<string, unknown>;
  const tiles = Array.isArray(src.tiles) ? src.tiles : [];
  // localBytesUrl is a blob URL retaining a File-loaded raster's bytes (the
  // raster control's source.objectUrl, surfaced by the raster store sync);
  // prefer it so locally loaded rasters are WASM-runnable.
  const candidates = [layer.metadata.localBytesUrl, src.url, tiles[0], layer.sourcePath];
  for (const candidate of candidates) {
    const url = fetchableUrl(candidate);
    if (!url) continue;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length === 0 || bytes[0] === 0x3c) continue; // 0x3c '<' = HTML
      return bytes;
    } catch {
      // try the next candidate
    }
  }
  return null;
}
