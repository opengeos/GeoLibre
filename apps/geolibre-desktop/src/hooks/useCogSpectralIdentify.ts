import { useEffect } from "react";
import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import type * as maplibregl from "maplibre-gl";
import { knownCogBandCount, readCogSpectralProfile } from "@geolibre/plugins/cog-spectral-profile";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import {
  addNetcdfProfileSample,
  removeNetcdfProfileSample,
  setNetcdfProfileSampleProfile,
} from "../lib/netcdf-profile-store";
import { fetchRemoteArrayBuffer } from "./usePlugins";

/**
 * Charts a clicked pixel's values across every band of a multiband COG
 * (issue #1818).
 *
 * The COG Identify path already reports the clicked pixel's band values in a
 * popup (see `useRasterIdentify`, which drives the raster control's inspector).
 * What it could not do is show the *shape* of that response across bands, which
 * is the operation introductory remote sensing turns on: click water, click
 * vegetation, click asphalt, compare the three curves.
 *
 * Everything downstream is reused rather than rebuilt — the profile store, the
 * chart, the numbered map markers, the floating window, the PNG/CSV export are
 * all shared with the NetCDF cube path, because the reader returns the same
 * shape. This hook is only the bridge from a map click to that store.
 *
 * Mounted once at the app shell, alongside the other identify hooks.
 */
export function useCogSpectralIdentify(
  mapControllerRef: React.RefObject<MapController | null>,
  mapReadyGeneration: number,
): void {
  const { t } = useTranslation();
  // One selector, one scan of the layer list, like useNetcdfIdentify: the three
  // fields are read from the same layer, so finding it three times was three
  // subscriptions and three scans to answer one question. `useShallow` is what
  // keeps returning an object from being a new reference on every store change.
  const { activeCogId, cogUrl, cogName } = useAppStore(
    useShallow((s): { activeCogId: string | null; cogUrl: string | null; cogName: string } => {
      const layer = s.identifyLayerId
        ? s.layers.find((item) => item.id === s.identifyLayerId)
        : undefined;
      if (layer?.type !== "cog") return { activeCogId: null, cogUrl: null, cogName: "" };
      // `source` is a union across layer kinds, so narrow to the string form
      // rather than trusting a `url` that is not on every member.
      const url = (layer.source as { url?: unknown } | undefined)?.url;
      return {
        activeCogId: layer.id,
        cogUrl: typeof url === "string" && url ? url : null,
        cogName: layer.name ?? "",
      };
    }),
  );

  useEffect(() => {
    const map = mapControllerRef.current?.getMap();
    if (!map || !activeCogId || !cogUrl) return;

    const handleClick = (event: maplibregl.MapMouseEvent) => {
      const { lng, lat } = event.lngLat;
      // A single-band raster -- a DEM, a grayscale scene -- has no spectrum, so
      // every click on one would add a marker and take it away again a moment
      // later. Once the first read has told us the band count, skip the marker
      // entirely rather than flashing one per click. The first click on such a
      // layer still flashes, because the count is not known until something has
      // read the file.
      const bandCount = knownCogBandCount(cogUrl);
      if (bandCount !== null && bandCount < 2) return;

      // The marker and list entry go in immediately so the click registers on
      // the map; the profile is attached when the range requests resolve.
      const sampleId = addNetcdfProfileSample({
        layerId: activeCogId,
        // `||`, not `??`: a project authored by hand or by another tool can
        // carry an empty name, which would leave the chart's title blank.
        variable: cogName || t("netcdfProfile.rasterFallbackName"),
        lng,
        lat,
      });

      // Deliberately not discarded on teardown, matching useNetcdfIdentify: the
      // effect tears down whenever the identify target *or the layer's name*
      // changes, and short-circuiting here would leave the marker already in the
      // store permanently profile-less -- a numbered point with no line, which
      // is exactly the stuck-load appearance this is trying to avoid. The
      // store's own guards make it safe: both calls below no-op for a sample
      // that has since been cleared or aged off the cap.
      void readCogSpectralProfile(cogUrl, lng, lat, {
        // Only used if geotiff.js's range requests are refused: the desktop app
        // renders COGs from hosts with no CORS headers at all by going through
        // the native HTTP path, and without this the layer would display while
        // every click on it silently produced no profile.
        fetchBytes: fetchRemoteArrayBuffer,
      }).then((profile) => {
        if (profile) {
          setNetcdfProfileSampleProfile(sampleId, profile);
          return;
        }
        // Nothing to chart here: a single-band raster, a click outside the
        // raster, an all-nodata pixel, or a failed read. Drop only this sample,
        // not the layer's whole session -- an all-nodata pixel sits right beside
        // valid data on any cloud-masked or rotated scene, and wiping the
        // comparison the user just built would be a poor answer to one stray click.
        removeNetcdfProfileSample(sampleId);
      });
    };

    map.on("click", handleClick);
    return () => {
      map.off("click", handleClick);
    };
    // mapReadyGeneration re-runs this once the map exists, matching the other
    // identify hooks — the ref is empty on the first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapControllerRef, mapReadyGeneration, activeCogId, cogUrl, cogName, t]);
}
