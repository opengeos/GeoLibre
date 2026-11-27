import { useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import {
  addRasterToMap,
  setLocalRasterFileReader,
  setLocalRasterPicker,
  setNonTiledRasterHandler,
  setOverviewlessRasterHandler,
  setUnrestorableRasterHandler,
  type NonTiledRasterRequest,
} from "@geolibre/plugins/maplibre-raster";
import {
  convertGeoTiffToCog,
  exceedsBrowserCogConversionLimit,
  geoTiffSampleCount,
  isTiff,
  LARGE_BROWSER_COG_CONVERSION_SAMPLES,
  readGeoTiffInfo,
} from "@geolibre/processing";
import type { TFunction } from "i18next";
import { useEffect, useRef, type RefObject } from "react";
import { dismissNotification, notify, useNotificationStore } from "../../lib/notify";
import { notifyUnrestorableRasters } from "../../lib/local-raster-notices";
import { startProjectImportSession } from "../../lib/project-import-session";
import { isTauri, pickLocalRasterFiles, readRasterFileAtPath } from "../../lib/tauri-io";
import { createAppAPI } from "../usePlugins";

/**
 * Wires the raster plugin to the local filesystem (desktop) and to the in-browser
 * GeoTIFF-to-COG conversion offered when a striped GeoTIFF fails to load, or
 * when a tiled one without overviews is too large to draw zoomed out.
 *
 * @param mapControllerRef - The primary map engine.
 * @param t - The shell's translation function.
 */
export function useRasterFileHandlers(
  mapControllerRef: RefObject<MapEngine | null>,
  t: TFunction,
): void {
  const translateRef = useRef(t);
  useEffect(() => {
    translateRef.current = t;
  }, [t]);

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

  // Tell the user which local rasters a reopened project dropped: their data
  // was never saved (always on the web), or the saved file could not be read.
  useEffect(() => {
    setUnrestorableRasterHandler(notifyUnrestorableRasters);
    return () => setUnrestorableRasterHandler(null);
  }, []);

  // When a GeoTIFF fails to load because it is striped (not a tiled COG), offer
  // to convert it to a COG in the browser and load the result. Works for both a
  // local file and a remote URL (issue #916). The raster plugin detects the case
  // and hands us the bytes; the conversion and the prompt live here because this
  // layer has i18n and the client-side converter. See opengeos/GeoLibre#789.
  useEffect(() => {
    const conversions = new Set<AbortController>();
    // `confirmed` skips the prompts: the overview-less notice's "Convert to
    // COG" button is the user's consent already.
    const convertToCog = async (
      { layerId, name, bytesAreRemote, readBytes, dismiss }: NonTiledRasterRequest,
      confirmed: boolean,
    ) => {
      const controller = new AbortController();
      conversions.add(controller);
      // The converted raster belongs to the project it came from: opening
      // another one cancels the conversion, so the result never lands in (or
      // reports an error to) the project that replaced it. The session judges
      // replacement by the same rule as a project import; the controller also
      // carries the notice's Cancel and the unmount.
      const session = startProjectImportSession();
      session.signal.addEventListener("abort", () => controller.abort(), { once: true });
      let notice: string | undefined;
      try {
        // A remote source gets a single up-front prompt that names the download:
        // its size is unknown until it has been fetched, so prompting again after
        // the download (with dimensions) would just risk discarding a large file
        // the user already agreed to download. A local file resolves instantly,
        // so it defers to the post-read prompt below, which can pick the
        // large-raster warning now that the dimensions are cheap to read. See #916.
        if (
          !confirmed &&
          bytesAreRemote &&
          !window.confirm(translateRef.current("raster.cogConvertRemoteConfirm", { name }))
        ) {
          // Declined: the striped layer can never draw, so do not leave it
          // behind as an empty row in the Layers panel.
          dismiss();
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
          if (controller.signal.aborted) return;
          console.error("[GeoLibre] Failed to read raster for conversion", error);
          notify.error(
            bytesAreRemote
              ? translateRef.current("raster.rasterDownloadFailed", { name })
              : translateRef.current("raster.cogConvertFailed", { name }),
            { error },
          );
          return;
        }
        controller.signal.throwIfAborted();
        // A URL can answer 200 with non-GeoTIFF content (an auth/login or error
        // page), which downloads fine but is not convertible. Sniff the TIFF
        // signature up front so that surfaces as a clear "not a GeoTIFF" message
        // instead of the misleading "could not convert" one the parser would
        // otherwise trigger. isTiff accepts BigTIFF too, matching the wasm
        // reader/converter, so a valid >4 GiB raster is not wrongly rejected.
        if (!isTiff(bytes)) {
          // A data problem, not an app fault, so a warning (no "Report issue").
          notify.warning(translateRef.current("raster.rasterNotGeotiff", { name }));
          return;
        }
        const info = await readGeoTiffInfo(bytes);
        controller.signal.throwIfAborted();
        if (!info.ok) throw new Error("Not a readable GeoTIFF.");
        const samples = geoTiffSampleCount(info);
        if (exceedsBrowserCogConversionLimit(samples)) {
          console.warn(
            `[GeoLibre] Skipping in-browser COG conversion for "${name}": ${samples.toLocaleString()} decoded samples exceed the safe memory limit.`,
          );
          notify.warning(translateRef.current("raster.cogConvertTooLarge", { name }));
          return;
        }
        const large = samples > LARGE_BROWSER_COG_CONVERSION_SAMPLES;
        // A button press is consent to convert, not to the memory cost of a
        // large raster, so that warning still shows on the confirmed path.
        if (!bytesAreRemote && (!confirmed || large)) {
          // Local file: pick the prompt by size now that the header is cheap to
          // read, then confirm once. (A remote source already confirmed above.)
          const message = large
            ? translateRef.current("raster.cogConvertLargeConfirm", {
                name,
                width: info.width,
                height: info.height,
              })
            : translateRef.current("raster.cogConvertConfirm", { name });
          if (!window.confirm(message)) {
            // A striped layer can never draw, so declining drops it. A
            // confirmed (overview-less) one still draws zoomed in: keep it.
            if (!confirmed) dismiss();
            return;
          }
        }
        controller.signal.throwIfAborted();
        notice = notify.info(translateRef.current("raster.cogConverting", { name }), {
          durationMs: null,
          pinned: true,
          dedupeKey: `cog-conversion-${crypto.randomUUID()}`,
          action: {
            label: translateRef.current("common.cancel"),
            onClick: () => controller.abort(),
          },
        });
        // readBytes returns a fresh buffer; transferring it avoids another
        // full-size allocation without detaching the original raster's data.
        const cog = await convertGeoTiffToCog(bytes, {
          signal: controller.signal,
          transferInput: true,
        });
        controller.signal.throwIfAborted();
        if (notice) dismissNotification(notice);
        notice = undefined;
        // The user may have removed the source layer while it converted; adding
        // the result would bring back a layer they just deleted.
        if (!useAppStore.getState().layers.some((layer) => layer.id === layerId)) return;
        // The cast is required: TS types Uint8Array as Uint8Array<ArrayBufferLike>,
        // which is not directly assignable to BlobPart's ArrayBufferView.
        const file = new File([cog as BlobPart], name, {
          type: "image/tiff",
        });
        await addRasterToMap(createAppAPI(mapControllerRef), file, {
          name,
          signal: controller.signal,
        });
        // A replaced project may reuse the original raster's id, so the
        // dismissal below must not run against it.
        controller.signal.throwIfAborted();
        // Drop the failed layer only after the replacement is fully loaded, so
        // any failure above (conversion or re-add) leaves the original errored
        // layer (and its message) in place.
        dismiss();
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error("[GeoLibre] Failed to convert GeoTIFF to COG", error);
        notify.error(translateRef.current("raster.cogConvertFailed", { name }), { error });
      } finally {
        session.dispose();
        if (notice) dismissNotification(notice);
        conversions.delete(controller);
      }
    };
    setNonTiledRasterHandler((request) => convertToCog(request, false));
    // A tiled GeoTIFF without overviews loads, but the tiler can only read it
    // at full resolution and refuses a read that large, so it is blank until
    // zoomed well in. Say why, and offer the conversion when the browser can
    // hold it; otherwise point at the desktop GDAL tools.
    const noticeCleanups = new Set<() => void>();
    setOverviewlessRasterHandler((request) => {
      const t = translateRef.current;
      const convertible =
        !request.bytesAreRemote && !exceedsBrowserCogConversionLimit(geoTiffSampleCount(request));
      const id = notify.warning(t("raster.overviewlessNotice", { name: request.name }), {
        description: t(
          convertible ? "raster.overviewlessConvertHint" : "raster.overviewlessGdalHint",
        ),
        durationMs: null,
        // Not pinned: one notice per overview-less layer could otherwise fill
        // the capped queue and push out later error toasts.
        dedupeKey: `overviewless-raster-${request.layerId}`,
        action: convertible
          ? {
              label: t("raster.overviewlessConvertAction"),
              onClick: () => void convertToCog(request, true),
            }
          : undefined,
      });
      // The notice stays until dismissed, so tie it to its layer: once the
      // layer leaves the project, or another project opens (which may reuse
      // the id), its button would act on a revoked blob URL or the wrong layer.
      const session = startProjectImportSession();
      const layerGone = () => !useAppStore.getState().layers.some((l) => l.id === request.layerId);
      const noticeGone = () =>
        !useNotificationStore.getState().notifications.some((n) => n.id === id);
      const unsubscribers: Array<() => void> = [];
      const cleanup = () => {
        for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
        session.dispose();
        noticeCleanups.delete(cleanup);
        // On unmount the notice would otherwise outlive the handlers its
        // button calls into (a no-op when it is already gone).
        dismissNotification(id);
      };
      const check = () => {
        if (session.signal.aborted || layerGone()) dismissNotification(id);
        if (noticeGone()) cleanup();
      };
      unsubscribers.push(useAppStore.subscribe(check), useNotificationStore.subscribe(check));
      session.signal.addEventListener("abort", check, { once: true });
      noticeCleanups.add(cleanup);
      check();
    });
    return () => {
      setNonTiledRasterHandler(null);
      setOverviewlessRasterHandler(null);
      for (const cleanup of noticeCleanups) cleanup();
      for (const controller of conversions) controller.abort();
    };
  }, [mapControllerRef]);
}
