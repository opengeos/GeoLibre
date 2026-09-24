import type { MapScaleUnit } from "@geolibre/core";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { ArcgisSdk, ArcgisView, ArcgisWidget } from "./arcgis-sdk";
import type { MapRenderSurface } from "./map-engine";
import { PlanetaryScaleControl } from "./planetary-scale-control";

/** The scale bar the ArcGIS engine mounts, with its unit settable in place. */
export interface ArcgisScaleBar extends ArcgisWidget {
  uiComponent: HTMLElement;
  setUnit(unit: MapScaleUnit): void;
}

/**
 * The 2D map's body-aware scale bar ({@link PlanetaryScaleControl}) on an
 * ArcGIS view, in place of the SDK's `ScaleBar`: the SDK's knows only metric
 * and imperial units, measures a `MapView` only and assumes Earth's radius.
 * This one measures around the view's centre, so it also reads in a scene
 * (hidden while the centre is off the globe), and draws nautical miles.
 *
 * @param sdk - The loaded SDK, for its property watching.
 * @param view - The view to measure.
 * @param surface - The engine's render surface, whose `unproject` it samples.
 * @param unit - The initial unit system.
 * @returns The widget to hand `view.ui.add` through its `uiComponent`.
 */
export function createArcgisScaleBar(
  sdk: ArcgisSdk,
  view: ArcgisView,
  surface: () => MapRenderSurface | null,
  unit: MapScaleUnit,
): ArcgisScaleBar {
  const control = new PlanetaryScaleControl({ maxWidth: 120, unit });
  const listeners = new Set<() => void>();
  // The control reads the container size and unprojects either side of the
  // centre on every `move`; the view's extent changes on every camera frame.
  const watch = sdk.reactiveUtils.watch(
    () => [view.ready, view.extent, view.width, view.height],
    () => {
      for (const listener of listeners) listener();
    },
  );
  const map = {
    // A destroyed view has no container; an unsized one hides the bar.
    getContainer: () => view.container ?? { clientWidth: 0, clientHeight: 0 },
    // A scene cannot unproject before it is ready (the SDK logs an error).
    unproject: ([x, y]: [number, number]) =>
      (view.ready ? surface()?.unproject([x, y]) : null) ?? { lng: Number.NaN, lat: Number.NaN },
    on: (_type: string, listener: () => void) => listeners.add(listener),
    off: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  const element = control.onAdd(map as unknown as MapLibreMap);
  return {
    uiComponent: element,
    setUnit(next) {
      control.setUnit(next);
      control.refresh();
    },
    destroy() {
      watch.remove();
      control.onRemove();
    },
  };
}
