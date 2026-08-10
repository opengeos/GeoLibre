import { useEffect } from "react";
import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import type maplibregl from "maplibre-gl";
import { readCogSpectralProfile } from "@geolibre/plugins/cog-spectral-profile";
import {
  addNetcdfProfileSample,
  clearNetcdfProfileSamplesForLayer,
  setNetcdfProfileSampleProfile,
} from "../lib/netcdf-profile-store";

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
  // One selector returning a primitive, matching useRasterIdentify: Zustand
  // re-renders only when the resolved id changes.
  const activeCogId = useAppStore((s): string | null => {
    if (!s.identifyLayerId) return null;
    const layer = s.layers.find((item) => item.id === s.identifyLayerId);
    return layer?.type === "cog" ? layer.id : null;
  });
  const cogUrl = useAppStore((s): string | null => {
    if (!s.identifyLayerId) return null;
    const layer = s.layers.find((item) => item.id === s.identifyLayerId);
    if (layer?.type !== "cog") return null;
    // `source` is a union across layer kinds, so narrow to the string form
    // rather than trusting a `url` that is not on every member.
    const url = (layer.source as { url?: unknown } | undefined)?.url;
    return typeof url === "string" && url ? url : null;
  });
  const cogName = useAppStore((s): string | null => {
    if (!s.identifyLayerId) return null;
    return s.layers.find((item) => item.id === s.identifyLayerId)?.name ?? null;
  });

  useEffect(() => {
    const map = mapControllerRef.current?.getMap();
    if (!map || !activeCogId || !cogUrl) return;

    // Reads in flight when the hook tears down (identify switched off, layer
    // removed) must not attach to whatever the store holds by then.
    let disposed = false;

    const handleClick = (event: maplibregl.MapMouseEvent) => {
      const { lng, lat } = event.lngLat;
      // The marker and list entry go in immediately so the click registers on
      // the map; the profile is attached when the range requests resolve.
      const sampleId = addNetcdfProfileSample({
        layerId: activeCogId,
        variable: cogName ?? "Raster",
        lng,
        lat,
      });

      void readCogSpectralProfile(cogUrl, lng, lat).then((profile) => {
        if (disposed) return;
        if (profile) {
          setNetcdfProfileSampleProfile(sampleId, profile);
          return;
        }
        // Single-band rasters and clicks outside the raster have nothing to
        // chart. Leaving a permanently profile-less marker in the list would
        // read as a stuck load, so drop the layer's samples instead.
        clearNetcdfProfileSamplesForLayer(activeCogId);
      });
    };

    map.on("click", handleClick);
    return () => {
      disposed = true;
      map.off("click", handleClick);
    };
    // mapReadyGeneration re-runs this once the map exists, matching the other
    // identify hooks — the ref is empty on the first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapControllerRef, mapReadyGeneration, activeCogId, cogUrl, cogName]);
}
