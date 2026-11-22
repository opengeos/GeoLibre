import {
  estimateRasterDataBytes,
  MAX_CLIENT_RASTER_BYTES,
  readRasterData,
  type RasterData,
} from "@geolibre/processing";

export interface ClientRasterInputEntry {
  name: string;
  bytes: ArrayBuffer;
}

/** Map a secondary Raster Calculator parameter id (`b_path` / `c_path`) to its variable letter. */
export function secondaryRasterLetterForParam(paramId: string): "B" | "C" | null {
  if (paramId === "b_path") return "B";
  if (paramId === "c_path") return "C";
  return null;
}

/** Remove one secondary input letter from the record without mutating the original object. */
export function omitClientSecondaryInput(
  inputs: Record<string, ClientRasterInputEntry>,
  letter: string,
): Record<string, ClientRasterInputEntry> {
  if (!(letter in inputs)) return inputs;
  const next = { ...inputs };
  delete next[letter];
  return next;
}

/**
 * Validate combined decoded Float32 memory for primary + secondary inputs +
 * output before decoding secondary GeoTIFF buffers for client Raster Calculator.
 */
export async function loadClientAdditionalRasters(
  primary: Pick<RasterData, "width" | "height" | "bands">,
  entries: Record<string, ClientRasterInputEntry>,
  deps: {
    estimateBytes?: (bytes: ArrayBuffer) => Promise<number>;
    readRaster?: (bytes: ArrayBuffer) => Promise<RasterData>;
    maxBytes?: number;
  } = {},
): Promise<Record<string, RasterData> | undefined> {
  const keys = Object.keys(entries);
  if (keys.length === 0) return undefined;

  const estimateBytes = deps.estimateBytes ?? estimateRasterDataBytes;
  const readRaster = deps.readRaster ?? readRasterData;
  const maxBytes = deps.maxBytes ?? MAX_CLIENT_RASTER_BYTES;

  const primaryBytes =
    primary.width * primary.height * primary.bands.length * Float32Array.BYTES_PER_ELEMENT;
  const outputBytes = primary.width * primary.height * Float32Array.BYTES_PER_ELEMENT;
  let combinedBytes = primaryBytes + outputBytes;
  for (const entry of Object.values(entries)) {
    combinedBytes += await estimateBytes(entry.bytes);
    if (!Number.isFinite(combinedBytes) || combinedBytes > maxBytes) {
      throw new Error(
        "The combined calculator inputs are too large for the in-browser engine. " +
          "Use the sidecar (rasterio/GDAL) engine instead.",
      );
    }
  }

  const decoded: Record<string, RasterData> = {};
  for (const [letter, entry] of Object.entries(entries)) {
    decoded[letter] = await readRaster(entry.bytes);
  }
  return decoded;
}
