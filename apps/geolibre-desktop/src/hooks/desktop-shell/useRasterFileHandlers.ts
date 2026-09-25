import type { MapEngine } from "@geolibre/map";
import {
  addRasterToMap,
  setLocalRasterFileReader,
  setLocalRasterPicker,
  setNonTiledRasterHandler,
} from "@geolibre/plugins";
import {
  convertGeoTiffToCog,
  exceedsBrowserCogConversionLimit,
  geoTiffSampleCount,
  isTiff,
  LARGE_BROWSER_COG_CONVERSION_SAMPLES,
  readGeoTiffInfo,
} from "@geolibre/processing";
import type { TFunction } from "i18next";
import { useEffect, type RefObject } from "react";
import { isTauri, pickLocalRasterFiles, readRasterFileAtPath } from "../../lib/tauri-io";
import { createAppAPI } from "../usePlugins";

/**
 * Wires the raster plugin to the local filesystem (desktop) and to the in-browser
 * GeoTIFF-to-COG conversion offered when a striped GeoTIFF fails to load.
 *
 * @param mapControllerRef - The primary map engine.
 * @param t - The shell's translation function.
 */
export function useRasterFileHandlers(
  mapControllerRef: RefObject<MapEngine | null>,
  t: TFunction,
): void {
  // Let the raster plugin reach the local filesystem on desktop: re-read a
  // raster a saved project references by path, and open the native file dialog
  // instead of the panel's own <input type="file"> (whose File carries no path,
  // so the raster could never be restored). Both stay unregistered in the
  // browser, where the plugin keeps its existing behavior. See issue #1463.
  useEffect(() => {
    if (!isTauri()) return;
    setLocalRasterFileReader(readRasterFileAtPath);
    setLocalRasterPicker(pickLocalRasterFiles);
    return () => {
      setLocalRasterFileReader(null);
      setLocalRasterPicker(null);
    };
  }, []);

  // When a GeoTIFF fails to load because it is striped (not a tiled COG), offer
  // to convert it to a COG in the browser and load the result. Works for both a
  // local file and a remote URL (issue #916). The raster plugin detects the case
  // and hands us the bytes; the conversion and the prompt live here because this
  // layer has i18n and the client-side converter. See opengeos/GeoLibre#789.
  useEffect(() => {
    setNonTiledRasterHandler(async ({ name, bytesAreRemote, readBytes, dismiss }) => {
      try {
        // A remote source gets a single up-front prompt that names the download:
        // its size is unknown until it has been fetched, so prompting again after
        // the download (with dimensions) would just risk discarding a large file
        // the user already agreed to download. A local file resolves instantly,
        // so it defers to the post-read prompt below, which can pick the
        // large-raster warning now that the dimensions are cheap to read. See #916.
        if (bytesAreRemote && !window.confirm(t("raster.cogConvertRemoteConfirm", { name }))) {
          return;
        }
        // Read the source bytes in their own try so a failure to obtain them
        // reports a read/download problem rather than the misleading "could not
        // convert" message below, which assumes a conversion was attempted. For
        // a remote URL this is a network/timeout error or a RangeError when the
        // download is too large to allocate (rasterDownloadFailed names both);
        // for a local file it is the rare case of the blob URL being revoked
        // (e.g. the layer removed) before the read, so fall back to the generic
        // convert-failed message rather than the server-oriented download one.
        let bytes: Uint8Array;
        try {
          bytes = await readBytes();
        } catch (error) {
          console.error("[GeoLibre] Failed to read raster for conversion", error);
          window.alert(
            bytesAreRemote
              ? t("raster.rasterDownloadFailed", { name })
              : t("raster.cogConvertFailed", { name }),
          );
          return;
        }
        // A URL can answer 200 with non-GeoTIFF content (an auth/login or error
        // page), which downloads fine but is not convertible. Sniff the TIFF
        // signature up front so that surfaces as a clear "not a GeoTIFF" message
        // instead of the misleading "could not convert" one the parser would
        // otherwise trigger. isTiff accepts BigTIFF too, matching the wasm
        // reader/converter, so a valid >4 GiB raster is not wrongly rejected.
        if (!isTiff(bytes)) {
          window.alert(t("raster.rasterNotGeotiff", { name }));
          return;
        }
        const info = await readGeoTiffInfo(bytes);
        if (!info.ok) throw new Error("Not a readable GeoTIFF.");
        const samples = geoTiffSampleCount(info);
        if (exceedsBrowserCogConversionLimit(samples)) {
          console.warn(
            `[GeoLibre] Skipping in-browser COG conversion for "${name}": ${samples.toLocaleString()} decoded samples exceed the safe memory limit.`,
          );
          window.alert(t("raster.cogConvertTooLarge", { name }));
          return;
        }
        if (!bytesAreRemote) {
          // Local file: pick the prompt by size now that the header is cheap to
          // read, then confirm once. (A remote source already confirmed above.)
          const message =
            samples > LARGE_BROWSER_COG_CONVERSION_SAMPLES
              ? t("raster.cogConvertLargeConfirm", {
                  name,
                  width: info.width,
                  height: info.height,
                })
              : t("raster.cogConvertConfirm", { name });
          if (!window.confirm(message)) return;
        }
        const cog = await convertGeoTiffToCog(bytes);
        // The cast is required: TS types Uint8Array as Uint8Array<ArrayBufferLike>,
        // which is not directly assignable to BlobPart's ArrayBufferView.
        const file = new File([cog as BlobPart], name, {
          type: "image/tiff",
        });
        await addRasterToMap(createAppAPI(mapControllerRef), file, { name });
        // Drop the failed layer only after the replacement is fully loaded, so
        // any failure above (conversion or re-add) leaves the original errored
        // layer (and its message) in place.
        dismiss();
      } catch (error) {
        console.error("[GeoLibre] Failed to convert GeoTIFF to COG", error);
        window.alert(t("raster.cogConvertFailed", { name }));
      }
    });
    return () => setNonTiledRasterHandler(null);
  }, [mapControllerRef, t]);
}
