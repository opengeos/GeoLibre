/**
 * Detection for the upstream "striped, not tiled" GeoTIFF failure.
 *
 * Split out of `maplibre-raster.ts` so it can be imported (and tested) without
 * pulling in `maplibre-gl` and the raster control's DOM setup.
 */

/**
 * Whether a raster load error is the upstream "striped, not tiled" failure.
 *
 * maplibre-gl-raster (re-verified against v0.12.0) rejects non-tiled GeoTIFFs
 * with a message containing "not tiled"; this is the only signal it exposes, so
 * the match is coupled to that wording. Re-verify it (and broaden if needed)
 * when bumping the dependency -- a reworded message degrades to the plain
 * error, not a crash.
 *
 * @param error - The error the control recorded on the layer.
 * @returns True when the layer failed only because the GeoTIFF is striped.
 */
export function isNonTiledRasterError(error: Error | null | undefined): boolean {
  return error != null && /not tiled/i.test(error.message);
}

/**
 * Whether a rejection from `addRasterToMap` is the recoverable
 * "striped, not tiled" case.
 *
 * `addRaster` rejects for this, but the layer it already created stays on the
 * map on purpose: the raster control's `error` handler passes it to the
 * registered non-tiled handler, which offers to convert it to a COG. Callers
 * that batch raster adds (the QGIS and ArcGIS Pro project importers) must
 * therefore treat this rejection as "still in progress" rather than as a failed
 * layer, or they report an unsupported format for a raster the app is about to
 * convert.
 *
 * @param error - The value `addRasterToMap` rejected with.
 * @returns True when the raster is being handed to the COG conversion handler.
 */
export function isRecoverableNonTiledRasterError(error: unknown): boolean {
  return error instanceof Error && isNonTiledRasterError(error);
}
