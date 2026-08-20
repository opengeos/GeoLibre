/**
 * Terrain-aware (3D) augmentation for the Measure tool.
 *
 * The upstream MeasureControl (maplibre-gl-components) reports planar
 * great-circle distances and spherical areas. This module listens to its
 * measurement events and, when ground elevations are available, appends a
 * "Terrain (3D)" section to the control's panel with the terrain-draped
 * surface distance (plus elevation gain/loss and range) for lines, or the
 * slope-corrected surface area (plus mean slope) for polygons — the way
 * Google Earth measures along the ground rather than through it.
 *
 * Elevations come from two sources, tried in order:
 *  1. The map's own terrain (`map.queryTerrainElevation`) when 3D terrain is
 *     enabled — instant and offline, but only where DEM tiles are loaded.
 *     MapLibre returns elevations multiplied by the terrain exaggeration, so
 *     values are divided back to true meters.
 *  2. The keyless Open-Meteo elevation API (already used by the Elevation
 *     Profile plugin), only when the active body is Earth.
 *
 * When neither source can provide elevations the section stays hidden and the
 * Measure tool behaves exactly as before.
 */

import {
  getActiveEllipsoid,
  getActiveMeanRadiusMeters,
  sampleMapTerrain,
  sampleRemoteElevations,
  type FetchLike,
  type TerrainMapLike,
} from "@geolibre/core";
import type { MeasureControl, Measurement } from "maplibre-gl-components";
import {
  buildAreaGrid,
  compassPoint,
  densifyLine,
  finalAzimuthDegrees,
  forwardAzimuthDegrees,
  isAntipodal,
  isDegenerateSegment,
  surfaceArea,
  surfaceDistance,
  type LngLat,
  type SurfaceAreaResult,
  type SurfaceDistanceResult,
} from "./terrain-measure-geometry";

/** Sample roughly every 30 m along a measured line… */
const LINE_SAMPLE_SPACING_METERS = 30;
/** …but never more than 200 samples per line (2 remote requests). */
const LINE_MAX_SAMPLES = 200;
/** At most ~256 grid samples across a measured polygon. */
const AREA_MAX_SAMPLES = 256;

/** Upstream unit ids (mirrors maplibre-gl-components' DistanceUnit/AreaUnit). */
type DistanceUnit = "meters" | "kilometers" | "miles" | "feet" | "yards" | "nautical-miles";
type AreaUnit =
  | "square-meters"
  | "square-kilometers"
  | "square-miles"
  | "hectares"
  | "acres"
  | "square-feet";

const DISTANCE_FACTORS: Record<DistanceUnit, number> = {
  meters: 1,
  kilometers: 1 / 1000,
  miles: 1 / 1609.344,
  feet: 1 / 0.3048,
  yards: 1 / 0.9144,
  "nautical-miles": 1 / 1852,
};

const AREA_FACTORS: Record<AreaUnit, number> = {
  "square-meters": 1,
  "square-kilometers": 1 / 1_000_000,
  "square-miles": 1 / 2_589_988.110336,
  hectares: 1 / 10_000,
  acres: 1 / 4046.8564224,
  "square-feet": 1 / 0.09290304,
};

const UNIT_SYMBOLS: Record<DistanceUnit | AreaUnit, string> = {
  meters: "m",
  kilometers: "km",
  feet: "ft",
  yards: "yd",
  miles: "mi",
  "nautical-miles": "nmi",
  "square-meters": "m²",
  "square-kilometers": "km²",
  hectares: "ha",
  "square-feet": "ft²",
  acres: "ac",
  "square-miles": "mi²",
};

/** Distance units whose users expect elevations in feet rather than meters. */
const IMPERIAL_DISTANCE_UNITS: ReadonlySet<DistanceUnit> = new Set(["miles", "feet", "yards"]);

const FEET_PER_METER = 1 / 0.3048;

/**
 * User-facing strings for the terrain section. Defaults are English; the
 * desktop shell pushes translated values via {@link setTerrainMeasureLabels}
 * since this package is framework-agnostic and has no react-i18next access.
 */
const terrainMeasureLabels = {
  title: "Terrain (3D)",
  surfaceDistance: "Surface distance",
  surfaceArea: "Surface area",
  elevationGainLoss: "Gain / loss",
  elevationRange: "Min / max elevation",
  meanSlope: "Mean slope",
  computing: "Computing terrain…",
  partialData: "Some samples had no terrain data",
  heading: "Heading",
  finalHeading: "Final heading",
  /**
   * `{{body}}` is replaced with the active celestial body's name. The name is a
   * standalone token after a colon rather than the object of a preposition,
   * because no single inline form can be right for every body in every
   * language (Georgian needs "მარსზე" not "მარსი-ზე"; German "auf dem Mars",
   * French "sur la Lune", Russian "на Марсе" all inflect or take an article).
   */
  bodyNote: "Measured on: {{body}} (spherical approximation)",
};

/**
 * Display names for the celestial bodies, keyed by ellipsoid id. Empty by
 * default so {@link renderBodyNote} falls back to the ellipsoid's own name; the
 * desktop shell pushes the planet switcher's translated names via {@link
 * setTerrainMeasureBodyNames}, which read better here than the ellipsoid names
 * (plain "Mars", not "Mars (IAU 2000)" nested inside another parenthetical).
 */
const terrainMeasureBodyNames: Record<string, string> = {};

/** Override the celestial-body display names with translated text. */
export function setTerrainMeasureBodyNames(names: Record<string, string>): void {
  for (const [id, name] of Object.entries(names)) {
    if (name) terrainMeasureBodyNames[id] = name;
  }
}

/** Override the terrain-measure labels with translated text. */
export function setTerrainMeasureLabels(labels: Partial<typeof terrainMeasureLabels>): void {
  for (const [key, value] of Object.entries(labels)) {
    // Only overwrite when the caller actually supplied the key; an omitted key
    // keeps the English default rather than being blanked out.
    if (value !== undefined) terrainMeasureLabels[key as keyof typeof terrainMeasureLabels] = value;
  }
}

// The two elevation samplers now live in `@geolibre/core` so the status bar's
// pointer readout can share them (see core/src/elevation.ts). Re-exported here
// because this module was their original home and `tests/terrain-measure.test.ts`
// exercises them alongside the readout logic they feed.
export { sampleMapTerrain, sampleRemoteElevations, type TerrainMapLike };

/** The computed terrain readout for the most recent measurement. */
type TerrainReadout =
  | { kind: "distance"; measurementId: string; result: SurfaceDistanceResult }
  | { kind: "area"; measurementId: string; result: SurfaceAreaResult };

interface MeasureStateLike {
  distanceUnit: DistanceUnit;
  areaUnit: AreaUnit;
}

/** The private panel element of the upstream MeasureControl. */
interface MeasureControlInternals {
  _panel?: HTMLElement;
}

/**
 * The MeasureControl's panel element. `_panel` is a private member as of
 * maplibre-gl-components@0.25.x; if a future version renames it, everything
 * layered on the panel (the terrain section, the resize styling) silently
 * disappears while planar measuring keeps working — so warn loudly to catch
 * the regression when bumping the dependency. Shared by this module and
 * `makeMeasurePanelResizable` so an upstream rename needs one fix.
 */
export function measurePanelElement(control: MeasureControl): HTMLElement | null {
  const panel = (control as unknown as MeasureControlInternals)._panel;
  if (!panel) {
    console.warn(
      "MeasureControl: _panel not found; the Terrain (3D) section and panel " +
        "resize styling are inactive. Check maplibre-gl-components.",
    );
    return null;
  }
  return panel;
}

/**
 * Compute the terrain readout for a completed measurement, or null when no
 * elevation source produced any usable samples.
 */
export async function computeTerrainReadout(
  measurement: Measurement,
  map: TerrainMapLike | null,
  fetchImpl?: FetchLike,
): Promise<TerrainReadout | null> {
  const radius = getActiveMeanRadiusMeters();
  const coords: LngLat[] = measurement.points.map((p) => [p.lng, p.lat]);

  if (measurement.mode === "distance") {
    if (coords.length < 2) return null;
    const line = densifyLine(coords, LINE_SAMPLE_SPACING_METERS, LINE_MAX_SAMPLES, radius);
    const elevations = await sampleElevations(line.coords, map, fetchImpl);
    if (!elevations) return null;
    const result = surfaceDistance(line.distances, elevations);
    if (result.sampledCount === 0) return null;
    return { kind: "distance", measurementId: measurement.id, result };
  }

  if (coords.length < 3 || !measurement.area) return null;
  // Close the ring for the point-in-polygon test; drawn points are unclosed.
  const ring: LngLat[] = [...coords, coords[0]];
  const grid = buildAreaGrid(ring, AREA_MAX_SAMPLES, radius);
  if (!grid) return null;
  const elevations = await sampleElevations(grid.coords, map, fetchImpl);
  if (!elevations) return null;
  const result = surfaceArea(grid, elevations, measurement.area);
  if (!result) return null;
  return { kind: "area", measurementId: measurement.id, result };
}

/**
 * Sample elevations for the given points: map terrain first, the remote API
 * (Earth only) when terrain is off or produced nothing usable. Returns null
 * when no source is available.
 */
async function sampleElevations(
  points: LngLat[],
  map: TerrainMapLike | null,
  fetchImpl?: FetchLike,
): Promise<(number | null)[] | null> {
  const fromTerrain = sampleMapTerrain(map, points);
  if (fromTerrain && fromTerrain.some((e) => e !== null)) return fromTerrain;
  if (getActiveEllipsoid().id !== "earth") return null;
  const fromRemote = await sampleRemoteElevations(points, fetchImpl);
  return fromRemote.some((e) => e !== null) ? fromRemote : null;
}

function formatNumber(value: number): string {
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatDistanceValue(meters: number, unit: DistanceUnit): string {
  const factor = DISTANCE_FACTORS[unit] ?? 1;
  const symbol = UNIT_SYMBOLS[unit] ?? "m";
  return `${formatNumber(meters * factor)} ${symbol}`;
}

function formatAreaValue(squareMeters: number, unit: AreaUnit): string {
  const factor = AREA_FACTORS[unit] ?? 1;
  const symbol = UNIT_SYMBOLS[unit] ?? "m²";
  return `${formatNumber(squareMeters * factor)} ${symbol}`;
}

/** Elevations follow the distance unit's family: feet for imperial, else meters. */
function formatElevationValue(meters: number, unit: DistanceUnit): string {
  if (IMPERIAL_DISTANCE_UNITS.has(unit)) {
    return `${Math.round(meters * FEET_PER_METER)} ft`;
  }
  return `${Math.round(meters)} m`;
}

/** Rows of the rendered terrain section, as label/value pairs. */
export function terrainReadoutRows(
  readout: TerrainReadout,
  units: MeasureStateLike,
): Array<[string, string]> {
  if (readout.kind === "distance") {
    const { result } = readout;
    const rows: Array<[string, string]> = [
      [
        terrainMeasureLabels.surfaceDistance,
        formatDistanceValue(result.surfaceMeters, units.distanceUnit),
      ],
      [
        terrainMeasureLabels.elevationGainLoss,
        `↑ ${formatElevationValue(result.gainMeters, units.distanceUnit)}  ↓ ${formatElevationValue(result.lossMeters, units.distanceUnit)}`,
      ],
    ];
    if (result.minElevationMeters !== null && result.maxElevationMeters !== null) {
      rows.push([
        terrainMeasureLabels.elevationRange,
        `${formatElevationValue(result.minElevationMeters, units.distanceUnit)} / ${formatElevationValue(result.maxElevationMeters, units.distanceUnit)}`,
      ]);
    }
    return rows;
  }
  const { result } = readout;
  return [
    [terrainMeasureLabels.surfaceArea, formatAreaValue(result.surfaceSquareMeters, units.areaUnit)],
    [terrainMeasureLabels.meanSlope, `${result.meanSlopeDegrees.toFixed(1)}°`],
  ];
}

/**
 * Bearing rows for a measured line, as label/value pairs — empty for anything
 * that is not a line of at least two points.
 *
 * Deliberately independent of the terrain readout: a bearing is pure geometry
 * on the measured coordinates, so it must not disappear when terrain data is
 * unavailable (off-Earth, no DEM tiles, no network), which is exactly when the
 * terrain section hides itself.
 *
 * For a multi-point path this reports the overall first-to-last bearing rather
 * than one row per segment: a twenty-point path would otherwise bury the panel.
 * The final bearing is added only when it differs from the initial one by a
 * degree or more, which on a short line it never does — it is a long-geodesic
 * concern, and showing "310 deg / 310 deg" everywhere would be noise.
 */
export function bearingRows(measurement: {
  mode: string;
  points: Array<{ lng: number; lat: number }>;
}): Array<[string, string]> {
  if (measurement.mode !== "distance" || measurement.points.length < 2) return [];
  const first = measurement.points[0];
  const last = measurement.points[measurement.points.length - 1];
  const a: LngLat = [first.lng, first.lat];
  const b: LngLat = [last.lng, last.lat];
  // Coincident endpoints have no direction, and antipodal ones lie on
  // infinitely many great circles, so neither has a bearing worth reporting.
  if (isDegenerateSegment(a, b) || isAntipodal(a, b)) return [];

  // Rounded modulo 360, not toFixed(0): an azimuth of 359.6 renders as "360" on
  // its own, which is not a bearing anyone writes and disagrees with the "N"
  // the compass label gives it.
  const renderAzimuth = (degrees: number): string =>
    `${Math.round(degrees) % 360}\u00b0 ${compassPoint(degrees)}`;

  const initial = forwardAzimuthDegrees(a, b);
  const rows: Array<[string, string]> = [[terrainMeasureLabels.heading, renderAzimuth(initial)]];
  // Both conditions are needed, and they guard opposite failures: the rendered
  // values must differ (or the second row repeats the first verbatim), *and*
  // the true convergence must be at least a degree (or bearings 0.2 apart that
  // straddle a rounding boundary, say 45.4 and 45.6, earn a row for nothing).
  const final = finalAzimuthDegrees(a, b);
  const convergence = Math.abs(((final - initial + 540) % 360) - 180);
  if (convergence >= 1 && renderAzimuth(final) !== renderAzimuth(initial)) {
    rows.push([terrainMeasureLabels.finalHeading, renderAzimuth(final)]);
  }
  return rows;
}

/** Whether the readout should carry the partial-data footnote. */
export function terrainReadoutIsPartial(readout: TerrainReadout): boolean {
  return readout.result.missingCount > 0;
}

/**
 * Attach the terrain section to a mounted MeasureControl. Returns a detach
 * function that unsubscribes and removes the injected DOM. Call after the
 * control has been added to the map (its panel exists from `onAdd`).
 */
export function attachTerrainMeasure(
  control: MeasureControl,
  getMap: () => TerrainMapLike | null,
): () => void {
  const panel = measurePanelElement(control);
  if (!panel) {
    return () => {};
  }

  const section = document.createElement("div");
  section.className = "geolibre-terrain-measure";
  section.style.borderTop = "1px solid hsl(var(--border))";
  // The panel's children carry their own margins (it has no padding), so
  // inset the section on all sides to keep text off the panel border.
  section.style.margin = "8px 12px 12px";
  section.style.paddingTop = "8px";
  section.style.display = "none";
  section.style.fontSize = "12px";
  panel.appendChild(section);

  // On a non-Earth project every readout above is scaled to that body's radius
  // (GeoLibre#1128). Say so, so a planetary user can tell a corrected number
  // from an Earth one rather than having to trust the basemap they are looking
  // at. Hidden on Earth, where there is nothing to disclose.
  const bodyNote = document.createElement("div");
  bodyNote.className = "geolibre-measure-body-note";
  bodyNote.style.margin = "8px 12px 12px";
  bodyNote.style.fontSize = "11px";
  bodyNote.style.opacity = "0.7";
  bodyNote.style.display = "none";
  panel.appendChild(bodyNote);

  const renderBodyNote = (): void => {
    const ellipsoid = getActiveEllipsoid();
    if (ellipsoid.id === "earth") {
      bodyNote.style.display = "none";
      bodyNote.textContent = "";
      return;
    }
    bodyNote.style.display = "block";
    bodyNote.textContent = terrainMeasureLabels.bodyNote.replace(
      "{{body}}",
      terrainMeasureBodyNames[ellipsoid.id] ?? ellipsoid.name,
    );
  };
  renderBodyNote();

  // Bearing lives in its own section above the terrain one. It resolves
  // synchronously from the measured coordinates, so it appears the instant the
  // line is drawn and stays visible when the terrain section hides itself for
  // want of elevation data.
  const bearingSection = document.createElement("div");
  bearingSection.className = "geolibre-measure-bearing";
  bearingSection.style.margin = "8px 12px 0";
  bearingSection.style.display = "none";
  bearingSection.style.fontSize = "12px";
  panel.insertBefore(bearingSection, section);

  const readoutRow = (label: string, value: string): HTMLElement => {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.justifyContent = "space-between";
    row.style.gap = "8px";
    row.style.marginTop = "2px";
    const labelEl = document.createElement("span");
    labelEl.style.opacity = "0.75";
    labelEl.textContent = label;
    const valueEl = document.createElement("span");
    valueEl.style.fontWeight = "600";
    valueEl.textContent = value;
    row.append(labelEl, valueEl);
    return row;
  };

  // Which measurement the bearing rows currently describe, so removing *that*
  // measurement clears them (and removing a different one leaves them alone).
  let bearingMeasurementId: string | null = null;

  const renderBearing = (measurement: Measurement | null): void => {
    const rows = measurement ? bearingRows(measurement) : [];
    bearingMeasurementId = rows.length > 0 ? (measurement?.id ?? null) : null;
    bearingSection.replaceChildren();
    if (rows.length === 0) {
      bearingSection.style.display = "none";
      return;
    }
    bearingSection.style.display = "block";
    for (const [label, value] of rows) bearingSection.appendChild(readoutRow(label, value));
  };

  let current: TerrainReadout | null = null;
  // The measurement whose computation is still in flight; tracked separately
  // from `current` (which stays null until the promise resolves) so a removal
  // during the "Computing terrain…" window can cancel the pending work too.
  let pendingMeasurementId: string | null = null;
  let requestToken = 0;

  const hide = (): void => {
    current = null;
    section.style.display = "none";
    section.replaceChildren();
  };

  const render = (): void => {
    if (!current) {
      hide();
      return;
    }
    const units = control.getState() as unknown as MeasureStateLike;
    section.replaceChildren();
    section.style.display = "block";
    section.appendChild(sectionTitle());
    for (const [label, value] of terrainReadoutRows(current, units)) {
      section.appendChild(readoutRow(label, value));
    }
    if (terrainReadoutIsPartial(current)) {
      const note = document.createElement("div");
      note.style.opacity = "0.6";
      note.style.marginTop = "4px";
      note.textContent = terrainMeasureLabels.partialData;
      section.appendChild(note);
    }
  };

  const showComputing = (): void => {
    section.replaceChildren();
    section.style.display = "block";
    section.appendChild(sectionTitle());
    const note = document.createElement("div");
    note.style.opacity = "0.6";
    note.textContent = terrainMeasureLabels.computing;
    section.appendChild(note);
  };

  const computeFor = (measurement: Measurement): void => {
    const token = ++requestToken;
    pendingMeasurementId = measurement.id;
    // Drop the previous readout now: it no longer matches what the section
    // shows ("Computing…"), and a stale id here would let the removal of an
    // older measurement cancel this newer in-flight computation.
    current = null;
    showComputing();
    computeTerrainReadout(measurement, getMap())
      .then((readout) => {
        if (token !== requestToken) return;
        pendingMeasurementId = null;
        current = readout;
        render();
      })
      .catch(() => {
        if (token !== requestToken) return;
        pendingMeasurementId = null;
        hide();
      });
  };

  const onDrawEnd = (event: { measurement?: Measurement }): void => {
    const measurement = event.measurement;
    if (!measurement) return;
    renderBearing(measurement);
    computeFor(measurement);
  };

  const onClear = (): void => {
    requestToken += 1;
    pendingMeasurementId = null;
    renderBearing(null);
    hide();
  };

  const onMeasurementRemove = (event: { measurement?: Measurement }): void => {
    const removedId = event.measurement?.id;
    if (!removedId) return;
    if (bearingMeasurementId === removedId) renderBearing(null);
    if (current?.measurementId === removedId || pendingMeasurementId === removedId) {
      requestToken += 1;
      pendingMeasurementId = null;
      hide();
    }
  };

  const onUnitChange = (): void => {
    if (current) render();
  };

  // The control recomputes its own distances/areas when the project's celestial
  // body changes (GeoLibre#1128), but the terrain readout is a cached result of
  // our own maths against that body's radius — a unit re-render would keep
  // showing the previous body's surface distance/area. Recompute it instead.
  const onRadiusChange = (): void => {
    renderBodyNote();
    const measurementId = current?.measurementId ?? pendingMeasurementId;
    if (!measurementId) return;
    const measurement = control
      .getMeasurements()
      .find((candidate) => candidate.id === measurementId);
    if (!measurement) return;
    computeFor(measurement);
  };

  control.on("drawend", onDrawEnd);
  control.on("clear", onClear);
  control.on("measurementremove", onMeasurementRemove);
  control.on("unitchange", onUnitChange);
  control.on("radiuschange", onRadiusChange);

  return () => {
    requestToken += 1;
    control.off("drawend", onDrawEnd);
    control.off("clear", onClear);
    control.off("measurementremove", onMeasurementRemove);
    control.off("unitchange", onUnitChange);
    control.off("radiuschange", onRadiusChange);
    bodyNote.remove();
    bearingSection.remove();
    section.remove();
  };
}

function sectionTitle(): HTMLElement {
  const title = document.createElement("div");
  title.style.fontWeight = "700";
  title.style.marginBottom = "2px";
  title.textContent = terrainMeasureLabels.title;
  return title;
}
