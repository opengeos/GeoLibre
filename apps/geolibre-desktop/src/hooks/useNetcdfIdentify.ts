import { useAppStore } from "@geolibre/core";
import maplibregl from "maplibre-gl";
import { useEffect } from "react";
import type { MapController } from "@geolibre/map";
import {
  getNetcdfLayerState,
  gridPixelAt,
  NETCDF_IMAGE_SOURCE_KIND,
  readNetcdfProfile,
} from "../lib/netcdf-image-symbology";
import { setNetcdfProfileReading } from "../lib/netcdf-profile-store";

/** How many significant digits a readout shows before falling back to exponent form. */
function formatValue(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude >= 1e6 || magnitude < 1e-3)) return value.toExponential(3);
  return Number(value.toFixed(6)).toString();
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
 */
export function useNetcdfIdentify(mapControllerRef: React.RefObject<MapController | null>): void {
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

    const handleClick = (event: maplibregl.MapMouseEvent) => {
      const state = getNetcdfLayerState(activeLayerId);
      if (!state) return;
      const pixel = gridPixelAt(state.grid, event.lngLat.lng, event.lngLat.lat);
      popup?.remove();
      popup = null;
      // A click outside the grid clears the readout rather than reporting the
      // nearest edge cell, which would be misleading far from the data.
      if (!pixel) {
        setNetcdfProfileReading(null);
        return;
      }

      const container = document.createElement("div");
      container.className = "space-y-0.5 text-xs";
      const rows: Array<[string, string]> = [
        [
          state.variable,
          pixel.value === null
            ? "no data"
            : `${formatValue(pixel.value)}${state.units ? ` ${state.units}` : ""}`,
        ],
        ["lon, lat", `${pixel.lng.toFixed(5)}, ${pixel.lat.toFixed(5)}`],
        ["row, col", `${pixel.row}, ${pixel.column}`],
      ];
      for (const [label, value] of rows) {
        const line = document.createElement("div");
        const name = document.createElement("span");
        name.className = "font-medium";
        name.textContent = `${label}: `;
        line.append(name, document.createTextNode(value));
        container.append(line);
      }

      popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false })
        .setLngLat(event.lngLat)
        .setDOMContent(container)
        .addTo(map);

      // A cube also yields the pixel's spectrum. Reading it walks the whole band
      // axis in the source file (~200 ms for an EMIT scene), so it runs after
      // the popup is already on screen.
      if (!state.profile) {
        setNetcdfProfileReading(null);
        return;
      }
      window.setTimeout(() => {
        const profile = readNetcdfProfile(activeLayerId, pixel.row, pixel.column);
        if (profile) {
          setNetcdfProfileReading({
            layerId: activeLayerId,
            variable: state.variable,
            units: state.units,
            lng: pixel.lng,
            lat: pixel.lat,
            profile,
          });
        }
      }, 0);
    };

    map.on("click", handleClick);
    return () => {
      map.off("click", handleClick);
      popup?.remove();
      canvas.style.cursor = previousCursor;
    };
  }, [activeLayerId, mapControllerRef]);
}
