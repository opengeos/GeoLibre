/**
 * Client-side GeoTIFF/COG export for the Georeferencer, via gdal3.js.
 *
 * The DOM/WASM-bound glue lives here (kept out of the pure `georeference.ts` lib
 * so that stays unit-testable). The two-step warp is the standard GCP workflow:
 *   1. gdal_translate -gcp …  → stamp the control points onto the raster
 *   2. gdalwarp -of COG …      → resample to a Cloud-Optimized GeoTIFF
 */
import {
  buildGcpTranslateArgs,
  type GCP,
  type GeoTransform,
  warpArgsForTransform,
} from "./georeference";
import { loadGdal } from "./gdal-loader";

/** Map a MIME type to a file extension GDAL uses to pick the input driver. */
function extForMime(mime: string): string {
  if (mime.includes("png")) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("tiff")) return "tif";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  return "png";
}

/** Turn the image data URL into a File whose extension drives GDAL's driver. */
async function dataUrlToFile(dataUrl: string, baseName: string): Promise<File> {
  const blob = await (await fetch(dataUrl)).blob();
  return new File([blob], `${baseName}.${extForMime(blob.type)}`, {
    type: blob.type,
  });
}

/**
 * Warp a non-georeferenced image to a Cloud-Optimized GeoTIFF using the GCPs,
 * entirely in the browser. Returns the GeoTIFF bytes.
 */
export async function exportGeoTiff(
  imageDataUrl: string,
  baseName: string,
  gcps: GCP[],
  transform: GeoTransform,
): Promise<Uint8Array> {
  const Gdal = await loadGdal();
  const file = await dataUrlToFile(imageDataUrl, baseName);
  const opened = await Gdal.open(file);
  const ds = opened.datasets[0];
  if (!ds) throw new Error("GDAL could not open the image.");

  // Track opened datasets so they're always closed (free the WASM-FS handles),
  // even on the error paths — otherwise repeated exports leak memory.
  const open: Awaited<ReturnType<typeof Gdal.open>>["datasets"] = [ds];
  try {
    // 1) Stamp the GCPs into a self-contained GeoTIFF.
    const withGcps = await Gdal.gdal_translate(ds, buildGcpTranslateArgs(gcps), "gcps.tif");
    // Round-trip through bytes to reopen as a fresh dataset (robust across the
    // gdal3.js virtual filesystem) before warping.
    const gcpBytes = await Gdal.getFileBytes(withGcps);
    const reopened = await Gdal.open(
      new File([gcpBytes as BlobPart], "gcps.tif", { type: "image/tiff" }),
    );
    const gcpDs = reopened.datasets[0];
    if (!gcpDs) throw new Error("GDAL could not apply the control points.");
    open.push(gcpDs);

    // 2) Warp to a Cloud-Optimized GeoTIFF.
    const warped = await Gdal.gdalwarp(gcpDs, warpArgsForTransform(transform), "georeferenced.tif");
    return await Gdal.getFileBytes(warped);
  } finally {
    for (const d of open) {
      await Gdal.close(d).catch(() => undefined);
    }
  }
}
