// The standalone Measure panel.
// Split out of maplibre-components.ts (opengeos/GeoLibre#2633).

import {
  getActiveMeanRadiusMeters,
  getEllipsoid,
  meanRadiusMeters,
  registerMapClickClaim,
  useAppStore,
} from "@geolibre/core";
import type { MeasureControl, MeasureControlOptions } from "maplibre-gl-components";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibreMeasureAreaUnit,
  GeoLibreMeasureDistanceUnit,
  GeoLibreMeasureOptions,
} from "../../types";
import {
  MEASURE_FILL_COLOR,
  MEASURE_LINE_COLOR,
  MEASURE_LINE_WIDTH,
} from "../lidar-measure-mirror";
import { attachTerrainMeasure, measurePanelElement, type TerrainMapLike } from "../terrain-measure";
import { getComponentsConstructors, type MeasureControlConstructor } from "./constructors";
import { refreshLidarMeasureMirror, setMeasureControlReader } from "./lidar-measure-link";

const measureControlPosition: GeoLibreMapControlPosition = "top-left";

const MEASURE_DISTANCE_UNITS = [
  "meters",
  "kilometers",
  "miles",
  "feet",
  "yards",
  "nautical-miles",
] as const satisfies readonly GeoLibreMeasureDistanceUnit[];

const MEASURE_AREA_UNITS = [
  "square-meters",
  "square-kilometers",
  "square-miles",
  "hectares",
  "acres",
  "square-feet",
] as const satisfies readonly GeoLibreMeasureAreaUnit[];

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
/** Units the mounted control was built with; a change rebuilds it. */
let measureUnits = defaultMeasureUnits();
/** Removes the terrain section, or the pending wait to attach it on expand. */
let measureTerrainDetach: (() => void) | null = null;
/** Drops the store subscription that follows the project's celestial body. */
let measureRadiusUnsubscribe: (() => void) | null = null;
/** The body the mounted Measure control's radius currently reflects. */
let measureEllipsoidId: string | null = null;
let measureControlMounted = false;
let measurePanelVisible = false;
let measureRequest = 0;
const measurePanelListeners = new Set<() => void>();
setMeasureControlReader(() => measureControl);
// While the panel is open the control is drawing, and its clicks place
// vertices; Identify must not also open a popup for them (GeoLibre#3237).
registerMapClickClaim(
  () => measureControlMounted && (measureControl?.getState().isDrawing ?? false),
);

/**
 * Open the standalone Measure panel, from the Controls menu or a project.
 *
 * Without options it opens expanded with the tool armed, as the menu does.
 * `collapsed` opens only the ruler button, so a shared map does not start with
 * the panel over it and the viewer's first clicks placing points
 * (GeoLibre#3241). Units given for an already open control rebuild it, since
 * the control's unit dropdown only reads them when its panel is built.
 *
 * @param app - The host API.
 * @param options - Optional collapsed state and units.
 * @throws If an option has the wrong type or names an unknown unit.
 */
export function openMeasurePanel(app: GeoLibreAppAPI, options?: GeoLibreMeasureOptions): void {
  const next = { ...measureUnits };
  const collapsed = options?.collapsed;
  if (collapsed !== undefined && typeof collapsed !== "boolean") {
    throw new Error("Measure collapsed must be a boolean");
  }
  const distanceUnit = options?.distanceUnit;
  if (distanceUnit !== undefined) {
    if (!(MEASURE_DISTANCE_UNITS as readonly unknown[]).includes(distanceUnit)) {
      throw new Error(`Measure distanceUnit must be one of ${MEASURE_DISTANCE_UNITS.join(", ")}`);
    }
    next.distanceUnit = distanceUnit;
  }
  const areaUnit = options?.areaUnit;
  if (areaUnit !== undefined) {
    if (!(MEASURE_AREA_UNITS as readonly unknown[]).includes(areaUnit)) {
      throw new Error(`Measure areaUnit must be one of ${MEASURE_AREA_UNITS.join(", ")}`);
    }
    next.areaUnit = areaUnit;
  }
  const unitsChanged =
    next.distanceUnit !== measureUnits.distanceUnit || next.areaUnit !== measureUnits.areaUnit;
  // Nothing to change on an open control: keep the viewer's collapsed state.
  if (!unitsChanged && collapsed === undefined && measureControlMounted) return;
  // A rebuild for new units keeps a folded ruler folded unless told otherwise.
  const wasCollapsed = measureControl?.getState().collapsed === true;
  if (unitsChanged && measureControl) removeMeasureControl(app);
  measureUnits = next;
  void openStandaloneMeasureControl(app, collapsed ?? (unitsChanged && wasCollapsed));
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

async function openStandaloneMeasureControl(
  app: GeoLibreAppAPI,
  collapsed: boolean,
  request = ++measureRequest,
): Promise<boolean> {
  const { MeasureControl: MeasureControlClass } = await getComponentsConstructors();
  if (request !== measureRequest) return false;

  measureControl ??= createMeasureControl(MeasureControlClass, collapsed);

  if (!measureControlMounted) {
    const added = app.addMapControl(measureControl, measureControlPosition);
    if (!added) {
      measureControl = null;
      // A unit change keeps the menu checked across the rebuild; a failed
      // remount must not leave it checked with no control on the map.
      setMeasurePanelVisible(false);
      return false;
    }
    measureControlMounted = true;
    measureTerrainDetach = attachMeasurePanelAddons(app, measureControl);
  }
  refreshLidarMeasureMirror(app);

  const control = measureControl;
  setTimeout(() => {
    // Guard against a teardown that nulled measureControl between addMapControl
    // succeeding and this deferred callback firing, which would otherwise mark
    // the panel visible even though the control no longer exists.
    if (request !== measureRequest || measureControl !== control) return;
    control.show();
    if (collapsed) control.collapse();
    else control.expand();
    setMeasurePanelVisible(true);
  }, 0);
  return true;
}

/**
 * Add the terrain readouts and resize styling to the control's panel.
 *
 * The control builds its panel on first expand, so a control mounted collapsed
 * has none yet; wait for that expand and attach then.
 *
 * @param app - The host API.
 * @param control - The mounted Measure control.
 * @returns Removes the add-ons, or the pending wait for the panel.
 */
function attachMeasurePanelAddons(app: GeoLibreAppAPI, control: MeasureControl): () => void {
  let detach: (() => void) | null = null;
  const attach = (): void => {
    // Terrain-aware 3D readouts (surface distance/area) appended to the
    // control's panel. The Components plugin itself is MapLibre-only (no
    // `engines`); the read is reached from the STAC plugin's audit closure, and
    // the readouts depend on MapLibre's terrain either way.
    // engine-audit-allow: getMap-mapbox
    detach = attachTerrainMeasure(control, () => (app.getMap?.() ?? null) as TerrainMapLike | null);
    makeMeasurePanelResizable(control);
  };
  if (!control.getState().collapsed) {
    attach();
    return () => detach?.();
  }
  const onExpand = (): void => {
    control.off("expand", onExpand);
    attach();
  };
  control.on("expand", onExpand);
  return () => {
    control.off("expand", onExpand);
    detach?.();
  };
}

function createMeasureControl(
  MeasureControlClass: MeasureControlConstructor,
  collapsed: boolean,
): MeasureControl {
  // The control derives distances and areas from lon/lat angles scaled by a
  // radius that defaults to Earth's, so on a Moon/Mars project every readout
  // would be wrong by that body's radius ratio (GeoLibre#1128). Seed it with the
  // project's body and follow the planet switcher for the rest of the session.
  const control = new MeasureControlClass({
    ...MEASURE_OPTIONS,
    ...measureUnits,
    collapsed,
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
  ++measureRequest;
  removeMeasureControl(app);
  measureUnits = defaultMeasureUnits();
  setMeasurePanelVisible(false);
}

function defaultMeasureUnits(): {
  distanceUnit: GeoLibreMeasureDistanceUnit;
  areaUnit: GeoLibreMeasureAreaUnit;
} {
  return { distanceUnit: "kilometers", areaUnit: "square-kilometers" };
}

/** Unmount and drop the control, leaving the menu's visibility state alone. */
function removeMeasureControl(app: GeoLibreAppAPI): void {
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
}

function setMeasurePanelVisible(visible: boolean): void {
  if (measurePanelVisible === visible) return;
  measurePanelVisible = visible;
  for (const listener of measurePanelListeners) {
    listener();
  }
}
