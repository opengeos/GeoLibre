// The standalone Measure panel.
// Split out of maplibre-components.ts (opengeos/GeoLibre#2633).

import {
  getActiveMeanRadiusMeters,
  getEllipsoid,
  meanRadiusMeters,
  useAppStore,
} from "@geolibre/core";
import type { MeasureControl, MeasureControlOptions } from "maplibre-gl-components";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../../types";
import {
  MEASURE_FILL_COLOR,
  MEASURE_LINE_COLOR,
  MEASURE_LINE_WIDTH,
} from "../lidar-measure-mirror";
import { attachTerrainMeasure, measurePanelElement, type TerrainMapLike } from "../terrain-measure";
import { getComponentsConstructors, type MeasureControlConstructor } from "./constructors";
import { refreshLidarMeasureMirror, setMeasureControlReader } from "./lidar-measure-link";

const measureControlPosition: GeoLibreMapControlPosition = "top-left";

const MEASURE_OPTIONS = {
  backgroundColor: "hsl(var(--popover))",
  className: "geolibre-measure-control",
  collapsed: false,
  fontColor: "hsl(var(--popover-foreground))",
  // Spelled out (they match the control's own defaults) because the LiDAR
  // measure mirror has to redraw this geometry in deck.gl with the same paint
  // — see lidar-measure-mirror.ts.
  lineColor: MEASURE_LINE_COLOR,
  lineWidth: MEASURE_LINE_WIDTH,
  fillColor: MEASURE_FILL_COLOR,
  maxHeight: 520,
  panelWidth: 260,
  position: measureControlPosition,
} satisfies MeasureControlOptions;

let measureControl: MeasureControl | null = null;
let measureTerrainDetach: (() => void) | null = null;
/** Drops the store subscription that follows the project's celestial body. */
let measureRadiusUnsubscribe: (() => void) | null = null;
/** The body the mounted Measure control's radius currently reflects. */
let measureEllipsoidId: string | null = null;
let measureControlMounted = false;
let measurePanelVisible = false;
const measurePanelListeners = new Set<() => void>();
setMeasureControlReader(() => measureControl);

// Standalone Measure panel, opened on demand from the Controls menu.
export function openMeasurePanel(app: GeoLibreAppAPI): void {
  void openStandaloneMeasureControl(app);
}

export function closeMeasurePanel(app: GeoLibreAppAPI): void {
  teardownMeasureControl(app);
}

export function isMeasurePanelVisible(): boolean {
  return measurePanelVisible;
}

export function subscribeMeasurePanel(listener: () => void): () => void {
  measurePanelListeners.add(listener);
  return () => measurePanelListeners.delete(listener);
}

async function openStandaloneMeasureControl(app: GeoLibreAppAPI): Promise<boolean> {
  const { MeasureControl: MeasureControlClass } = await getComponentsConstructors();

  measureControl ??= createMeasureControl(MeasureControlClass);

  if (!measureControlMounted) {
    const added = app.addMapControl(measureControl, measureControlPosition);
    if (!added) {
      measureControl = null;
      return false;
    }
    measureControlMounted = true;
    // Terrain-aware 3D readouts (surface distance/area) appended to the
    // control's panel; requires the panel from onAdd, so attach after mounting.
    // The Components plugin itself is MapLibre-only (no `engines`); the read
    // is reached from the STAC plugin's audit closure, and the readouts depend
    // on MapLibre's terrain either way.
    // engine-audit-allow: getMap-mapbox
    measureTerrainDetach = attachTerrainMeasure(
      measureControl,
      () => (app.getMap?.() ?? null) as TerrainMapLike | null,
    );
    makeMeasurePanelResizable(measureControl);
  }
  refreshLidarMeasureMirror(app);

  setTimeout(() => {
    // Guard against a teardown that nulled measureControl between addMapControl
    // succeeding and this deferred callback firing, which would otherwise mark
    // the panel visible even though the control no longer exists.
    if (!measureControl) return;
    measureControl.show();
    measureControl.expand();
    setMeasurePanelVisible(true);
  }, 0);
  return true;
}

function createMeasureControl(MeasureControlClass: MeasureControlConstructor): MeasureControl {
  // The control derives distances and areas from lon/lat angles scaled by a
  // radius that defaults to Earth's, so on a Moon/Mars project every readout
  // would be wrong by that body's radius ratio (GeoLibre#1128). Seed it with the
  // project's body and follow the planet switcher for the rest of the session.
  const control = new MeasureControlClass({
    ...MEASURE_OPTIONS,
    radius: getActiveMeanRadiusMeters(),
  });
  // Seed from the store rather than at module load: the body may already have
  // changed before the user first opens the panel, and a stale baseline would
  // swallow the switch *back* to that body as a no-op.
  measureEllipsoidId = useAppStore.getState().preferences.map.ellipsoidId;
  measureRadiusUnsubscribe?.();
  measureRadiusUnsubscribe = useAppStore.subscribe((state) => {
    const id = state.preferences.map.ellipsoidId;
    if (id === measureEllipsoidId) return;
    measureEllipsoidId = id;
    // Resolve the radius from the id in hand rather than the active-ellipsoid
    // singleton, so this does not depend on the store's own mirroring
    // subscription having run before ours.
    control.setRadius(meanRadiusMeters(getEllipsoid(id)));
  });
  return control;
}

/**
 * The MeasureControl's panel ships with a hard pixel max-height that forces
 * its content (measurement list, terrain section) to scroll. Let the panel
 * size to its content up to most of the viewport instead, and hand the user
 * the native bottom-right resize handle for manual control.
 */
function makeMeasurePanelResizable(control: MeasureControl): void {
  const panel = measurePanelElement(control);
  if (!panel) return;
  // Fit content instead of scrolling at the fixed cap, but never outgrow the
  // viewport; the map's own chrome needs the remaining room.
  panel.style.height = "auto";
  panel.style.maxHeight = "min(75vh, 900px)";
  // The native CSS resize handle (bottom-right in LTR, mirrored in RTL)
  // requires a non-visible overflow; content scrolls once the user shrinks
  // the panel below its natural size.
  panel.style.overflow = "auto";
  panel.style.resize = "both";
  panel.style.minWidth = "220px";
  panel.style.minHeight = "160px";
  panel.style.maxWidth = "min(90vw, 560px)";
}

export function teardownMeasureControl(app: GeoLibreAppAPI): void {
  measureTerrainDetach?.();
  measureTerrainDetach = null;
  measureRadiusUnsubscribe?.();
  measureRadiusUnsubscribe = null;
  if (measureControl && measureControlMounted) {
    app.removeMapControl(measureControl);
  }
  measureControl = null;
  measureControlMounted = false;
  refreshLidarMeasureMirror(app);
  setMeasurePanelVisible(false);
}

function setMeasurePanelVisible(visible: boolean): void {
  if (measurePanelVisible === visible) return;
  measurePanelVisible = visible;
  for (const listener of measurePanelListeners) {
    listener();
  }
}
