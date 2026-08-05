import { useAppStore } from "@geolibre/core";
import maplibregl from "maplibre-gl";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { MapController } from "@geolibre/map";
import {
  displayUnits,
  getNetcdfLayerState,
  gridPixelAt,
  NETCDF_IMAGE_SOURCE_KIND,
  readNetcdfProfile,
} from "../lib/netcdf-image-symbology";
import {
  addNetcdfProfileSample,
  clearNetcdfProfileSamplesForLayer,
  setNetcdfProfileSampleProfile,
} from "../lib/netcdf-profile-store";

/**
 * How many significant digits a readout shows before falling back to exponent form.
 *
 * Finer than `NetcdfProfilePanel`'s same-named helper on purpose: this is the
 * value for the one pixel the user clicked, so it keeps full precision, where the
 * panel's is formatting chart tick labels that have to stay short.
 */
function formatValue(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude >= 1e6 || magnitude < 1e-3)) return value.toExponential(3);
  return Number(value.toFixed(6)).toString();
}

/** A value with its units appended, when the variable declares meaningful ones. */
function formatReading(value: number, units: string | undefined): string {
  const unit = displayUnits(units);
  return unit ? `${formatValue(value)} ${unit}` : formatValue(value);
}

/**
 * Bridges the store's `identifyLayerId` to a NetCDF image layer's retained grid.
 *
 * The counterpart of `useRasterIdentify` for the layers the NetCDF dialog bakes
 * to pixels. Those have no queryable features and no raster-control registration,
 * but the decoded slice is already in memory for the symbology panel, so a click
 * is a nearest-cell lookup rather than a fetch: the readout is instant and works
 * offline.
 *
 * Every click inside the grid is also recorded as a sampled point, which puts a
 * numbered marker on the map. When the layer came from a cube, the click reads
 * that pixel's values along the band axis too and attaches them to the point,
 * which is what the spectral profile charts.
 *
 * Mounted once at the app shell, alongside `useRasterIdentify`. MapCanvas bails
 * for these layers so the two never both handle a click.
 *
 * @param mapControllerRef - The live map controller.
 * @param mapReadyGeneration - Bumped by the shell each time the map (re)initialises.
 *   A ref's `.current` becoming non-null does not re-run an effect, so without
 *   this the click handler would never attach for an identify target set before
 *   the map finished loading.
 */
export function useNetcdfIdentify(
  mapControllerRef: React.RefObject<MapController | null>,
  mapReadyGeneration: number,
): void {
  const { t } = useTranslation();
  // One selector returning a primitive: Zustand re-renders only when the
  // resolved id changes, not on every unrelated layer mutation.
  const activeLayerId = useAppStore((s) => {
    if (!s.identifyLayerId) return null;
    const layer = s.layers.find((item) => item.id === s.identifyLayerId);
    return layer?.metadata.sourceKind === NETCDF_IMAGE_SOURCE_KIND ? layer.id : null;
  });

  useEffect(() => {
    const map = mapControllerRef.current?.getMap();
    if (!activeLayerId || !map) return;

    const canvas = map.getCanvas();
    const previousCursor = canvas.style.cursor;
    canvas.style.cursor = "crosshair";
    let popup: maplibregl.Popup | null = null;
    // Each deferred read below is addressed to the point it was started for, so
    // several can be in flight at once; they are tracked only so a read that has
    // not started yet is not started after teardown.
    //
    // A read already in flight is deliberately *not* discarded on teardown: the
    // effect tears down whenever the identify target changes, and switching away
    // and back during a read that takes tens of seconds would otherwise leave
    // that point permanently profile-less even though the fetch completed. The
    // store's own guard is what makes this safe — a result for a point that has
    // since been cleared or aged off the cap lands nowhere.
    const profileTimeouts = new Set<number>();

    const handleClick = (event: maplibregl.MapMouseEvent) => {
      const state = getNetcdfLayerState(activeLayerId);
      if (!state) return;
      const pixel = gridPixelAt(state.grid, event.lngLat.lng, event.lngLat.lat);
      popup?.remove();
      popup = null;
      // A click outside the grid clears the readout rather than reporting the
      // nearest edge cell, which would be misleading far from the data.
      if (!pixel) {
        clearNetcdfProfileSamplesForLayer(activeLayerId);
        return;
      }

      const container = document.createElement("div");
      container.className = "space-y-0.5 text-xs";
      const rows: Array<[string, string]> = [
        [
          state.variable,
          pixel.value === null
            ? t("netcdfIdentify.noData")
            : formatReading(pixel.value, state.units),
        ],
        [t("netcdfIdentify.coordinates"), `${pixel.lng.toFixed(5)}, ${pixel.lat.toFixed(5)}`],
        [t("netcdfIdentify.cell"), `${pixel.row}, ${pixel.column}`],
      ];
      for (const [label, value] of rows) {
        const line = document.createElement("div");
        const name = document.createElement("span");
        name.className = "font-medium";
        name.textContent = `${label}: `;
        line.append(name, document.createTextNode(value));
        container.append(line);
      }

      // The same class MapCanvas gives the feature/pixel identify popup: without
      // it MapLibre's own always-white `.maplibregl-popup-content` survives, and
      // the rows below — which inherit the theme foreground — render white on
      // white in dark mode.
      popup = new maplibregl.Popup({
        className: "geolibre-identify-popup",
        closeButton: true,
        closeOnClick: false,
      })
        .setLngLat(event.lngLat)
        .setDOMContent(container)
        .addTo(map);

      // The point goes in before the (slow) profile read, so its marker lands on
      // the map with the popup rather than a beat later.
      const sampleId = addNetcdfProfileSample({
        layerId: activeLayerId,
        variable: state.variable,
        units: state.units,
        lng: pixel.lng,
        lat: pixel.lat,
      });

      // A cube also yields the pixel's spectrum. Reading it walks the whole band
      // axis in the source file (~200 ms for an EMIT scene), so it runs after
      // the popup is already on screen. A 2-D grid has no band axis, so the point
      // stays profile-less: still a marker and a list entry, just no line.
      if (!state.profile) return;
      const timeout = window.setTimeout(() => {
        profileTimeouts.delete(timeout);
        // A remote read is a worker round trip over range requests, so this can
        // take tens of seconds. Nothing cancels it: the result is addressed to
        // this point, and attaching to a point that has since been cleared or
        // aged off the cap is a no-op, so a stale read lands nowhere.
        void readNetcdfProfile(activeLayerId, pixel.row, pixel.column).then((profile) => {
          if (profile) setNetcdfProfileSampleProfile(sampleId, profile);
        });
      }, 0);
      profileTimeouts.add(timeout);
    };

    map.on("click", handleClick);
    return () => {
      map.off("click", handleClick);
      for (const timeout of profileTimeouts) window.clearTimeout(timeout);
      profileTimeouts.clear();
      popup?.remove();
      canvas.style.cursor = previousCursor;
    };
  }, [activeLayerId, mapControllerRef, mapReadyGeneration, t]);
}
