import { isMapClickClaimed, useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import type * as maplibregl from "maplibre-gl";
import { isNativeZarrRenderer } from "@geolibre/plugins";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { createEnginePopup, engineStyleMap } from "../lib/engine-style-map";
import { readZarrIdentifyRows } from "../lib/zarr-identify";

/**
 * Identify for Zarr data cubes: while the Identify tool targets a Zarr layer, a
 * click reads the cube's value under the cursor for the slice on screen and
 * shows it with the slice's date and the clicked location.
 *
 * The value comes from the renderer's own `queryData` (via `queryZarrLayer`),
 * which already holds the store's grid and masks fill values, so no extra
 * reader or download is involved. MapCanvas bails for Zarr layers so the two
 * never both handle a click.
 *
 * @param mapControllerRef - The live map controller.
 * @param mapReadyGeneration - Bumped by the shell each time the map (re)initialises,
 *   so the click handler attaches for an identify target set before the map loaded.
 */
export function useZarrIdentify(
  mapControllerRef: React.RefObject<MapEngine | null>,
  mapReadyGeneration: number,
): void {
  const { t } = useTranslation();
  const activeLayerId = useAppStore((s) => {
    if (!s.identifyLayerId) return null;
    const layer = s.layers.find((item) => item.id === s.identifyLayerId);
    // The ArcGIS and Cesium renderers draw Zarr natively, with no query path.
    if (isNativeZarrRenderer(s.primaryRenderer)) return null;
    return layer?.type === "zarr" ? layer.id : null;
  });

  useEffect(() => {
    const engine = mapControllerRef.current;
    const map = engineStyleMap(engine);
    if (!activeLayerId || !map) return;

    const canvas = map.getCanvas();
    const previousCursor = canvas.style.cursor;
    canvas.style.cursor = "crosshair";
    let popup: maplibregl.Popup | null = null;
    let controller: AbortController | null = null;

    const handleClick = (event: maplibregl.MapMouseEvent) => {
      // A drawing map tool (Measure, the Geo Editor) owns the click.
      if (isMapClickClaimed()) return;
      const layer = useAppStore.getState().layers.find((item) => item.id === activeLayerId);
      if (!layer) return;
      controller?.abort();
      const current = new AbortController();
      controller = current;
      popup?.remove();
      popup = null;
      const lngLat: [number, number] = [event.lngLat.lng, event.lngLat.lat];
      void readZarrIdentifyRows(
        layer,
        lngLat,
        { nodata: t("netcdfIdentify.noData"), coordinates: t("netcdfIdentify.coordinates") },
        current.signal,
      )
        .then((rows) => {
          // A newer click (or teardown) superseded this read. A click outside the
          // grid shows nothing rather than an empty popup.
          if (current.signal.aborted || controller !== current || !rows) return;
          const container = document.createElement("div");
          container.className = "space-y-0.5 text-xs";
          for (const [label, value] of rows) {
            const line = document.createElement("div");
            const name = document.createElement("span");
            name.className = "font-medium";
            name.textContent = `${label}: `;
            line.append(name, document.createTextNode(value));
            container.append(line);
          }
          // The shared identify class themes the popup for dark mode.
          popup = createEnginePopup(engine, {
            className: "geolibre-identify-popup",
            closeButton: true,
            closeOnClick: false,
          })
            .setLngLat(event.lngLat)
            .setDOMContent(container)
            .addTo(map);
        })
        .catch(() => {
          // An aborted or failed read leaves the map as it was.
        });
    };

    map.on("click", handleClick);
    return () => {
      map.off("click", handleClick);
      controller?.abort();
      controller = null;
      popup?.remove();
      canvas.style.cursor = previousCursor;
    };
  }, [activeLayerId, mapControllerRef, mapReadyGeneration, t]);
}
