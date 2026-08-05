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
  clearNetcdfProfileReadingsForLayer,
  setNetcdfProfileReading,
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
 * When the layer came from a cube, the same click also reads that pixel's values
 * along the band axis and hands them to the spectral profile panel.
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
    // The deferred profile read below captures this click's layer and pixel, so
    // a pending one must be dropped when the identify target changes or another
    // click lands — otherwise a stale read overwrites the newer reading.
    let profileTimeout: number | null = null;
    /** Drops the in-flight profile read's result, if one is outstanding. */
    let cancelProfile: (() => void) | null = null;

    const handleClick = (event: maplibregl.MapMouseEvent) => {
      const state = getNetcdfLayerState(activeLayerId);
      if (!state) return;
      const pixel = gridPixelAt(state.grid, event.lngLat.lng, event.lngLat.lat);
      popup?.remove();
      popup = null;
      if (profileTimeout !== null) window.clearTimeout(profileTimeout);
      profileTimeout = null;
      cancelProfile?.();
      cancelProfile = null;
      // A click outside the grid clears the readout rather than reporting the
      // nearest edge cell, which would be misleading far from the data.
      if (!pixel) {
        clearNetcdfProfileReadingsForLayer(activeLayerId);
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

      // A cube also yields the pixel's spectrum. Reading it walks the whole band
      // axis in the source file (~200 ms for an EMIT scene), so it runs after
      // the popup is already on screen.
      if (!state.profile) {
        clearNetcdfProfileReadingsForLayer(activeLayerId);
        return;
      }
      profileTimeout = window.setTimeout(() => {
        profileTimeout = null;
        // A remote read is a worker round trip over range requests, so this can
        // take tens of seconds; `cancelled` drops a result the user has moved on
        // from rather than charting a stale pixel.
        let cancelled = false;
        cancelProfile = () => {
          cancelled = true;
        };
        void readNetcdfProfile(activeLayerId, pixel.row, pixel.column).then((profile) => {
          if (profile && !cancelled) {
            setNetcdfProfileReading({
              layerId: activeLayerId,
              variable: state.variable,
              units: state.units,
              lng: pixel.lng,
              lat: pixel.lat,
              profile,
            });
          }
        });
      }, 0);
    };

    map.on("click", handleClick);
    return () => {
      map.off("click", handleClick);
      if (profileTimeout !== null) window.clearTimeout(profileTimeout);
      cancelProfile?.();
      popup?.remove();
      canvas.style.cursor = previousCursor;
    };
  }, [activeLayerId, mapControllerRef, mapReadyGeneration, t]);
}
