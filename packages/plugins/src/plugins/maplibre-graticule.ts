import type {
  Feature,
  FeatureCollection,
  LineString,
  Point,
} from "geojson";
import type {
  ExpressionSpecification,
  GeoJSONSource,
  IControl,
  LngLatBounds,
  Map as MapLibreMap,
} from "maplibre-gl";
import proj4, { type Converter } from "proj4";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

/**
 * Coordinate graticule plugin.
 *
 * Draws a lat/long reference grid (meridians + parallels) with coordinate
 * labels along the map edges, as native MapLibre `line` and `symbol` layers so
 * the grid is part of the GL canvas and is captured automatically by the Print
 * Layout export (PNG/PDF). All settings round-trip through the project file.
 */

export const GRATICULE_PLUGIN_ID = "maplibre-gl-graticule";

/**
 * Stable id of the graticule label symbol layer. Exported so the Print Layout
 * can detect an active graticule and fit the captured map without cropping
 * (the default crop would trim these edge labels).
 */
export const GRATICULE_LABEL_LAYER_ID = "geolibre-graticule-labels-layer";

const LINE_SOURCE_ID = "geolibre-graticule-lines-source";
const LABEL_SOURCE_ID = "geolibre-graticule-labels-source";
const LINE_LAYER_ID = "geolibre-graticule-lines-layer";
const LABEL_LAYER_ID = GRATICULE_LABEL_LAYER_ID;
const PANEL_ID = "geolibre-graticule-panel";

/**
 * User-facing strings for the settings panel and on-map control. This package
 * is framework-agnostic and cannot call react-i18next's `t()` directly, so the
 * host pushes translated values via {@link setGraticuleLabels} (see the pattern
 * used by `maplibre-reverse-geocode`). Defaults are English.
 */
export interface GraticuleLabels {
  title: string;
  /** Title getter pushed by the host so the panel header re-localizes live. */
  getTitle?: () => string;
  controlTitle: string;
  gridType: string;
  typeGeographic: string;
  typeUtm: string;
  spacing: string;
  spacingAuto: string;
  spacingFixed: string;
  interval: string;
  intervalMeters: string;
  lineColor: string;
  lineWidth: string;
  lineOpacity: string;
  dashedLines: string;
  showLabels: string;
  labelFormat: string;
  formatDecimal: string;
  formatDms: string;
  labelEdges: string;
  edgesLeftBottom: string;
  edgesAll: string;
  labelColor: string;
  labelSize: string;
}

export const DEFAULT_GRATICULE_LABELS: GraticuleLabels = {
  title: "Gridlines",
  controlTitle: "Gridlines settings",
  gridType: "Grid type",
  typeGeographic: "Geographic (lat/long)",
  typeUtm: "UTM (easting/northing)",
  spacing: "Spacing",
  spacingAuto: "Auto (by zoom)",
  spacingFixed: "Fixed interval",
  interval: "Interval (°)",
  intervalMeters: "Interval (m)",
  lineColor: "Line color",
  lineWidth: "Line width",
  lineOpacity: "Line opacity",
  dashedLines: "Dashed lines",
  showLabels: "Show labels",
  labelFormat: "Label format",
  formatDecimal: "Decimal degrees",
  formatDms: "Deg/Min/Sec",
  labelEdges: "Label edges",
  edgesLeftBottom: "Left + bottom",
  edgesAll: "All sides",
  labelColor: "Label color",
  labelSize: "Label size",
};

let labels: GraticuleLabels = { ...DEFAULT_GRATICULE_LABELS };

/**
 * Replace the user-facing strings (the host calls this with translations on
 * every language change). Pushes the new strings into the live control tooltip
 * and, if the settings panel is open, rebuilds its body so labels stay current.
 *
 * The panel header title is registered as a getter (`labels.getTitle?.() ??
 * labels.title`), so it re-localizes live alongside the body and control
 * tooltip whenever the host calls this function.
 */
export function setGraticuleLabels(next: Partial<GraticuleLabels>): void {
  labels = { ...labels, ...next };
  control?.updateLabels();
  if (panelContainer) buildPanelBody(panelContainer);
}

/** How coordinate labels are formatted. */
export type GraticuleLabelFormat = "dd" | "dms";

/** Which map edges carry coordinate labels. */
export type GraticuleLabelEdges = "left-bottom" | "all";

/**
 * Which coordinate reference the grid follows: a geographic lat/long graticule
 * (meridians + parallels in degrees) or a metric UTM grid (constant
 * easting/northing lines with metre labels and a zone designation).
 */
export type GraticuleGridType = "geographic" | "utm";

export interface GraticuleSettings {
  /** Geographic lat/long graticule or a metric UTM easting/northing grid. */
  gridType: GraticuleGridType;
  /** Auto spacing adapts to the zoom level; fixed uses {@link spacingDegrees}/{@link spacingMeters}. */
  spacingMode: "auto" | "fixed";
  /** Grid interval in degrees for the geographic grid when {@link spacingMode} is "fixed". */
  spacingDegrees: number;
  /** Grid interval in metres for the UTM grid when {@link spacingMode} is "fixed". */
  spacingMeters: number;
  lineColor: string;
  lineWidth: number;
  lineOpacity: number;
  /** Render grid lines dashed rather than solid. */
  lineDashed: boolean;
  showLabels: boolean;
  labelFormat: GraticuleLabelFormat;
  labelEdges: GraticuleLabelEdges;
  labelColor: string;
  labelSize: number;
}

export const DEFAULT_GRATICULE_SETTINGS: GraticuleSettings = {
  gridType: "geographic",
  spacingMode: "auto",
  spacingDegrees: 10,
  spacingMeters: 10000,
  lineColor: "#6b7280",
  lineWidth: 1,
  lineOpacity: 0.75,
  lineDashed: false,
  showLabels: true,
  labelFormat: "dd",
  labelEdges: "left-bottom",
  labelColor: "#374151",
  labelSize: 11,
};

// "Nice" grid intervals in degrees, largest first. Auto mode picks the largest
// step that still draws a useful number of lines across the viewport.
const NICE_STEPS = [
  45, 30, 20, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.025, 0.01, 0.005, 0.0025,
  0.001,
];

// "Nice" UTM grid intervals in metres, largest first (100 km down to 100 m).
// Auto mode picks the largest step that still draws a useful number of lines.
const NICE_METRIC_STEPS = [
  100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100,
];

let settings: GraticuleSettings = { ...DEFAULT_GRATICULE_SETTINGS };
let map: MapLibreMap | null = null;
let appRef: GeoLibreAppAPI | null = null;
let control: GraticuleControl | null = null;
let unsubscribeBasemap: (() => void) | null = null;
let unregisterPanel: (() => void) | null = null;
let moveHandler: (() => void) | null = null;
/** Re-reads the current settings into the open settings panel inputs. */
let syncPanel: (() => void) | null = null;
/** The mounted settings-panel container, so its strings can be rebuilt on a language change. */
let panelContainer: HTMLElement | null = null;

export function getGraticuleSettings(): GraticuleSettings {
  return { ...settings };
}

/**
 * Update graticule settings and immediately redraw. Unknown keys are ignored;
 * values are clamped/coerced by {@link normalizeGraticuleSettings}.
 */
export function setGraticuleSettings(patch: Partial<GraticuleSettings>): void {
  const prevGridType = settings.gridType;
  settings = normalizeGraticuleSettings({ ...settings, ...patch });
  update();
  // Switching grid type swaps which rows the panel shows (metre vs degree
  // interval, and the label format only applies to the geographic grid), so
  // rebuild the body rather than merely re-syncing the existing inputs.
  if (settings.gridType !== prevGridType && panelContainer) {
    buildPanelBody(panelContainer);
  } else {
    syncPanel?.();
  }
}

// ---------------------------------------------------------------------------
// Geometry generation
// ---------------------------------------------------------------------------

/**
 * Longitude range of the viewport, unwrapped so a view crossing the
 * antimeridian (where `getEast() < getWest()`) yields an increasing range
 * (e.g. west=170, east=190) that the meridian/parallel loops can iterate.
 */
function unwrappedLongitudeRange(bounds: LngLatBounds): {
  west: number;
  east: number;
} {
  const west = bounds.getWest();
  let east = bounds.getEast();
  if (east < west) east += 360;
  return { west, east };
}

/**
 * Pick an auto interval that draws roughly 4-12 grid lines across the view.
 * Uses the larger of the longitude/latitude spans so a tall (e.g. polar) view
 * does not end up with far more parallels than meridians.
 */
function autoStep(lonSpan: number, latSpan: number): number {
  const span = Math.max(Math.abs(lonSpan), Math.abs(latSpan)) || 0.001;
  for (const step of NICE_STEPS) {
    if (span / step >= 4) return step;
  }
  return NICE_STEPS[NICE_STEPS.length - 1];
}

/**
 * Pick an auto metric interval that draws roughly 4-12 UTM grid lines across
 * the view, using the larger of the easting/northing spans (in metres).
 */
export function autoMetricStep(eastingSpan: number, northingSpan: number): number {
  const span = Math.max(Math.abs(eastingSpan), Math.abs(northingSpan)) || 1;
  for (const step of NICE_METRIC_STEPS) {
    if (span / step >= 4) return step;
  }
  return NICE_METRIC_STEPS[NICE_METRIC_STEPS.length - 1];
}

/**
 * UTM zone number (1-60) for a longitude. Longitudes are normalized into
 * [-180, 180) first so unwrapped (antimeridian-crossing) values still map to a
 * valid zone. Note: this uses the regular 6°-wide zones and does not apply the
 * Norway/Svalbard exceptions (32V, 31-37X).
 */
export function utmZoneForLon(lon: number): number {
  const norm = (((lon + 180) % 360) + 360) % 360; // 0..360
  return Math.floor(norm / 6) + 1;
}

/**
 * UTM latitude-band letter (C-X, skipping I and O) for a latitude, or "" when
 * outside the UTM range (-80° to 84°). The northernmost band X spans 12°
 * (72°-84°) rather than the usual 8°.
 */
export function utmLatBand(lat: number): string {
  if (lat < -80 || lat > 84) return "";
  const bands = "CDEFGHJKLMNPQRSTUVWX";
  const idx = Math.min(Math.floor((lat + 80) / 8), bands.length - 1);
  return bands[idx];
}

/** UTM zone designation such as "37T" for a longitude/latitude. */
export function utmZoneDesignation(lon: number, lat: number): string {
  return `${utmZoneForLon(lon)}${utmLatBand(lat)}`;
}

/** proj4 definition string for a WGS84 UTM zone (northern or southern). */
function utmProjDef(zone: number, south: boolean): string {
  return `+proj=utm +zone=${zone}${south ? " +south" : ""} +datum=WGS84 +units=m +no_defs +type=crs`;
}

/** Format a UTM easting for display, e.g. `500000mE`. */
export function formatEasting(easting: number): string {
  return `${Math.round(easting)}mE`;
}

/** Format a UTM northing for display, e.g. `4649000mN`. */
export function formatNorthing(northing: number): string {
  return `${Math.round(northing)}mN`;
}

/**
 * Decimal places to show for a given interval, derived from the step's own
 * precision so labels are neither lossy (e.g. 1.25 shown as "1.3" for a 0.25
 * interval) nor needlessly long. Capped at 4 places.
 */
function decimalsForStep(step: number): number {
  const text = String(step);
  // Values JS serialises in scientific notation (e.g. "1e-7") have no ".", which
  // would wrongly read as 0 decimals. Such steps are below our 0.001 floor, so
  // cap at the maximum precision instead.
  if (text.includes("e") || text.includes("E")) return 4;
  const dot = text.indexOf(".");
  if (dot === -1) return 0;
  return Math.min(4, text.length - dot - 1);
}

function densifyLine(
  fixed: number,
  from: number,
  to: number,
  axis: "lon" | "lat",
  segments = 24,
): [number, number][] {
  const coords: [number, number][] = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = from + ((to - from) * i) / segments;
    coords.push(axis === "lon" ? [fixed, t] : [t, fixed]);
  }
  return coords;
}

function formatDms(value: number, positive: string, negative: string): string {
  const hemi = value === 0 ? "" : value > 0 ? positive : negative;
  const abs = Math.abs(value);
  let deg = Math.floor(abs);
  let min = Math.floor((abs - deg) * 60);
  let sec = Math.round((abs - deg - min / 60) * 3600);
  if (sec >= 60) {
    sec -= 60;
    min += 1;
  }
  if (min >= 60) {
    min -= 60;
    deg += 1;
  }
  const mm = String(min).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return `${deg}°${mm}'${ss}"${hemi}`;
}

export function formatLon(
  lon: number,
  step: number,
  format: GraticuleLabelFormat,
): string {
  // Normalize to [-180, 180] for display even when the map reports wrapped lons.
  let normalized = ((((lon + 180) % 360) + 360) % 360) - 180;
  if (Object.is(normalized, -0)) normalized = 0;
  if (format === "dms") return formatDms(normalized, "E", "W");
  const hemi = normalized === 0 ? "" : normalized > 0 ? "E" : "W";
  return `${Math.abs(normalized).toFixed(decimalsForStep(step))}°${hemi}`;
}

export function formatLat(
  lat: number,
  step: number,
  format: GraticuleLabelFormat,
): string {
  if (format === "dms") return formatDms(lat, "N", "S");
  const hemi = lat === 0 ? "" : lat > 0 ? "N" : "S";
  return `${Math.abs(lat).toFixed(decimalsForStep(step))}°${hemi}`;
}

interface GraticuleGeometry {
  lines: FeatureCollection<LineString>;
  labels: FeatureCollection<Point>;
  step: number;
}

/** Build the grid lines and edge labels for the current viewport. */
function buildGeometry(activeMap: MapLibreMap): GraticuleGeometry {
  if (settings.gridType === "utm") return buildUtmGeometry(activeMap);
  const bounds = activeMap.getBounds();
  const { west, east } = unwrappedLongitudeRange(bounds);
  // Mercator cannot show the poles; clamp parallels to the renderable range.
  const south = Math.max(bounds.getSouth(), -85);
  const north = Math.min(bounds.getNorth(), 85);
  const step =
    settings.spacingMode === "fixed"
      ? Math.max(0.0001, settings.spacingDegrees)
      : autoStep(east - west, north - south);

  const lineFeatures: Feature<LineString>[] = [];
  const labelFeatures: Feature<Point>[] = [];
  const showAllEdges = settings.labelEdges === "all";

  // Note: edge labels are positioned at the (possibly unwrapped) viewport bounds,
  // so for an antimeridian-crossing view their longitudes can exceed [-180, 180].
  // MapLibre renders these correctly in the continuous world; only a consumer of
  // the raw FeatureCollection (e.g. a future GeoJSON export) would need to wrap.

  // Meridians (constant longitude). The longitude range is unwrapped above so a
  // view crossing the antimeridian still fills the screen.
  const firstLon = Math.ceil(west / step) * step;
  const maxLines = 2000; // hard cap so a tiny fixed step cannot freeze the UI
  let count = 0;
  for (let lon = firstLon; lon <= east && count < maxLines; lon += step) {
    lineFeatures.push({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: densifyLine(lon, south, north, "lon") },
    });
    if (settings.showLabels) {
      labelFeatures.push(labelFeature(lon, south, formatLon(lon, step, settings.labelFormat), "bottom"));
      if (showAllEdges) {
        labelFeatures.push(labelFeature(lon, north, formatLon(lon, step, settings.labelFormat), "top"));
      }
    }
    count += 1;
  }

  // Parallels (constant latitude).
  const firstLat = Math.ceil(south / step) * step;
  count = 0;
  for (let lat = firstLat; lat <= north && count < maxLines; lat += step) {
    lineFeatures.push({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: densifyLine(lat, west, east, "lat") },
    });
    if (settings.showLabels) {
      labelFeatures.push(labelFeature(west, lat, formatLat(lat, step, settings.labelFormat), "left"));
      if (showAllEdges) {
        labelFeatures.push(labelFeature(east, lat, formatLat(lat, step, settings.labelFormat), "right"));
      }
    }
    count += 1;
  }

  return {
    lines: { type: "FeatureCollection", features: lineFeatures },
    labels: { type: "FeatureCollection", features: labelFeatures },
    step,
  };
}

/** Densification detail (points per line) for inverse-projected UTM grid lines. */
const UTM_LINE_SEGMENTS = 32;
/** Boundary samples per viewport edge when measuring a zone's UTM extent. */
const UTM_RANGE_SAMPLES = 8;

/**
 * Measure the easting/northing bounding box of a lat/long sub-rectangle by
 * sampling points along its boundary (UTM is nonlinear, so corners alone can
 * miss the extremes). Returns null if every projection failed.
 */
function utmExtent(
  toUtm: Converter,
  west: number,
  east: number,
  south: number,
  north: number,
): { eMin: number; eMax: number; nMin: number; nMax: number } | null {
  let eMin = Infinity;
  let eMax = -Infinity;
  let nMin = Infinity;
  let nMax = -Infinity;
  let any = false;
  for (let i = 0; i <= UTM_RANGE_SAMPLES; i += 1) {
    const fx = i / UTM_RANGE_SAMPLES;
    const lon = west + (east - west) * fx;
    const lat = south + (north - south) * fx;
    const samples: [number, number][] = [
      [lon, south],
      [lon, north],
      [west, lat],
      [east, lat],
    ];
    for (const [sampleLon, sampleLat] of samples) {
      try {
        const [e, n] = toUtm.forward([sampleLon, sampleLat]);
        if (!Number.isFinite(e) || !Number.isFinite(n)) continue;
        eMin = Math.min(eMin, e);
        eMax = Math.max(eMax, e);
        nMin = Math.min(nMin, n);
        nMax = Math.max(nMax, n);
        any = true;
      } catch {
        // Skip points proj4 cannot project (e.g. far outside the zone).
      }
    }
  }
  return any ? { eMin, eMax, nMin, nMax } : null;
}

/**
 * Build a metric UTM grid (constant easting/northing lines) for the current
 * viewport. The viewport is split into 6°-wide UTM zones; each zone's lines are
 * generated in projected metres and inverse-projected back to lng/lat so they
 * follow the true grid curvature in Web Mercator. Labels show easting/northing
 * in metres plus a per-zone designation (e.g. "37T").
 */
function buildUtmGeometry(activeMap: MapLibreMap): GraticuleGeometry {
  const bounds = activeMap.getBounds();
  const { west, east } = unwrappedLongitudeRange(bounds);
  // Clamp parallels to the UTM validity range (and Mercator's renderable band).
  const south = Math.max(bounds.getSouth(), -80);
  const north = Math.min(bounds.getNorth(), 84);

  const lineFeatures: Feature<LineString>[] = [];
  const labelFeatures: Feature<Point>[] = [];
  const showAllEdges = settings.labelEdges === "all";
  const step =
    settings.spacingMode === "fixed"
      ? Math.max(1, settings.spacingMeters)
      : 0; // per-zone auto step is computed below; 0 is a placeholder
  let reportedStep = step;
  const maxLines = 2000; // shared cap across all zones so a tiny step can't freeze the UI
  let count = 0;

  if (north <= south) {
    return {
      lines: { type: "FeatureCollection", features: lineFeatures },
      labels: { type: "FeatureCollection", features: labelFeatures },
      step: reportedStep || settings.spacingMeters,
    };
  }

  const centerLat = (south + north) / 2;

  // UTM northing restarts at the equator (northern zones measure up from 0,
  // southern zones down from a 10,000,000 m false northing), so a viewport that
  // straddles the equator must be split into per-hemisphere bands and projected
  // with the matching hemisphere convention in each.
  const bands: { south: number; north: number; useSouth: boolean }[] = [];
  if (south < 0) bands.push({ south, north: Math.min(north, 0), useSouth: true });
  if (north > 0) bands.push({ south: Math.max(south, 0), north, useSouth: false });
  if (bands.length === 0) bands.push({ south, north, useSouth: centerLat < 0 });

  // Walk the viewport longitude range zone by zone. Zone boundaries sit every
  // 6° from -180°; align to the zone edge at or before `west` (works for the
  // unwrapped, possibly >180° range produced by an antimeridian-crossing view).
  const firstZoneWest = Math.floor((west + 180) / 6) * 6 - 180;
  for (
    let zoneWest = firstZoneWest;
    zoneWest < east && count < maxLines;
    zoneWest += 6
  ) {
    const zoneEast = zoneWest + 6;
    const clipWest = Math.max(zoneWest, west);
    const clipEast = Math.min(zoneEast, east);
    if (clipEast <= clipWest) continue;
    const zone = utmZoneForLon(zoneWest + 3);

    for (const band of bands) {
      if (band.north <= band.south || count >= maxLines) continue;
      let toUtm: Converter;
      let toLngLat: Converter;
      try {
        const def = utmProjDef(zone, band.useSouth);
        toUtm = proj4("EPSG:4326", def);
        toLngLat = proj4(def, "EPSG:4326");
      } catch {
        continue;
      }

      const extent = utmExtent(toUtm, clipWest, clipEast, band.south, band.north);
      if (!extent) continue;
      const { eMin, eMax, nMin, nMax } = extent;
      const zoneStep =
        settings.spacingMode === "fixed"
          ? step
          : autoMetricStep(eMax - eMin, nMax - nMin);
      reportedStep = zoneStep;

      // Inverse-project a projected point, wrapping its longitude into the
      // zone's (possibly unwrapped, antimeridian-crossing) range before clipping
      // so a zone's grid does not bleed into its neighbour and an antimeridian
      // view does not drop points that proj4 reports in [-180, 180]. Returns
      // null when the point falls outside the zone.
      const project = (e: number, n: number): [number, number] | null => {
        try {
          const projected = toLngLat.forward([e, n]);
          let lon = projected[0];
          const lat = projected[1];
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
          while (lon < clipWest - 180) lon += 360;
          while (lon > clipEast + 180) lon -= 360;
          if (lon < clipWest - 1e-6 || lon > clipEast + 1e-6) return null;
          return [lon, lat];
        } catch {
          return null;
        }
      };

      // The equator split hands each viewport edge to a single band, so a band
      // only carries the bottom/top easting label when it reaches that edge.
      const bandAtSouth = band.south === south;
      const bandAtNorth = band.north === north;

      // Constant-easting lines (run north-south), densified along northing.
      const firstE = Math.ceil(eMin / zoneStep) * zoneStep;
      for (let e = firstE; e <= eMax && count < maxLines; e += zoneStep) {
        const coords: [number, number][] = [];
        for (let i = 0; i <= UTM_LINE_SEGMENTS; i += 1) {
          const n = nMin + ((nMax - nMin) * i) / UTM_LINE_SEGMENTS;
          const point = project(e, n);
          if (point) coords.push(point);
        }
        if (coords.length < 2) continue;
        lineFeatures.push({
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: coords },
        });
        if (settings.showLabels) {
          // Snap the label onto the viewport edge (matching the geographic grid)
          // so the line's endpoint sits under the label text rather than poking
          // out beside it, where a short line stub would read as a stray "-".
          if (bandAtSouth) {
            labelFeatures.push(
              labelFeature(coords[0][0], south, formatEasting(e), "bottom"),
            );
          }
          if (showAllEdges && bandAtNorth) {
            const top = coords[coords.length - 1];
            labelFeatures.push(labelFeature(top[0], north, formatEasting(e), "top"));
          }
        }
        count += 1;
      }

      // Constant-northing lines (run east-west), densified along easting.
      const firstN = Math.ceil(nMin / zoneStep) * zoneStep;
      for (let n = firstN; n <= nMax && count < maxLines; n += zoneStep) {
        const coords: [number, number][] = [];
        for (let i = 0; i <= UTM_LINE_SEGMENTS; i += 1) {
          const e = eMin + ((eMax - eMin) * i) / UTM_LINE_SEGMENTS;
          const point = project(e, n);
          if (point) coords.push(point);
        }
        if (coords.length < 2) continue;
        lineFeatures.push({
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: coords },
        });
        if (settings.showLabels) {
          // Snap onto the zone's west/east boundary so the line endpoint tucks
          // under the label text instead of showing a stub beside it.
          labelFeatures.push(
            labelFeature(clipWest, coords[0][1], formatNorthing(n), "left"),
          );
          if (showAllEdges) {
            const right = coords[coords.length - 1];
            labelFeatures.push(labelFeature(clipEast, right[1], formatNorthing(n), "right"));
          }
        }
        count += 1;
      }
    }

    // Draw the zone's western boundary meridian as a grid line. Each zone's
    // easting lines stop short of the 6° boundary (their eastings are multiples
    // of the step, not the zone edge), so without this the two neighbouring
    // grids leave an empty strip at the boundary. Meridians are straight in Web
    // Mercator, so two points suffice. `zoneWest > west` restricts this to
    // boundaries actually inside the view (the leftmost partial zone begins off
    // screen), and interior boundaries are shared, so drawing each zone's west
    // edge covers every visible boundary exactly once.
    if (zoneWest > west && count < maxLines) {
      lineFeatures.push({
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [
            [zoneWest, south],
            [zoneWest, north],
          ],
        },
      });
      count += 1;
    }

    // One zone-designation label per visible zone, centred along the top edge.
    if (settings.showLabels) {
      const zoneCenterLon = (clipWest + clipEast) / 2;
      labelFeatures.push(
        labelFeature(
          zoneCenterLon,
          north,
          utmZoneDesignation(zoneCenterLon, centerLat),
          "top",
        ),
      );
    }
  }

  return {
    lines: { type: "FeatureCollection", features: lineFeatures },
    labels: { type: "FeatureCollection", features: labelFeatures },
    step: reportedStep || settings.spacingMeters,
  };
}

function labelFeature(
  lon: number,
  lat: number,
  label: string,
  anchor: "top" | "bottom" | "left" | "right",
): Feature<Point> {
  return {
    type: "Feature",
    properties: { label, anchor },
    geometry: { type: "Point", coordinates: [lon, lat] },
  };
}

// ---------------------------------------------------------------------------
// MapLibre layer management
// ---------------------------------------------------------------------------

/** Cached result of {@link pickTextFont}; invalidated on basemap change. */
let cachedTextFont: string[] | null = null;

/**
 * Reuse a font that the active basemap style already ships so the label glyphs
 * are guaranteed to load (basemaps bundle different fonts, so a hard-coded name
 * would 404 on some of them). The result is cached because the font is stable
 * until the basemap changes, and `applyStyleProps` runs on every settings tweak
 * (e.g. dragging the colour picker), which would otherwise rescan every style
 * layer hundreds of times.
 */
function pickTextFont(activeMap: MapLibreMap): string[] {
  if (cachedTextFont) return cachedTextFont;
  let fallback: string[] | null = null;
  try {
    const styleLayers = activeMap.getStyle()?.layers ?? [];
    for (const layer of styleLayers) {
      if (layer.id === LABEL_LAYER_ID) continue;
      if (layer.type !== "symbol") continue;
      const font = (layer.layout as { "text-font"?: string[] } | undefined)?.[
        "text-font"
      ];
      if (!Array.isArray(font) || font.length === 0) continue;
      // Prefer an upright regular face; keep the first usable font as a fallback
      // for styles that only ship italic/bold faces.
      if (font.every((f) => !/italic|bold/i.test(f))) return font;
      if (!fallback) fallback = font;
    }
  } catch {
    // getStyle can throw before the style is ready; fall through to the default.
  }
  cachedTextFont = fallback ?? ["Open Sans Regular", "Arial Unicode MS Regular"];
  return cachedTextFont;
}

function ensureLayers(activeMap: MapLibreMap): void {
  if (!activeMap.getSource(LINE_SOURCE_ID)) {
    activeMap.addSource(LINE_SOURCE_ID, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!activeMap.getSource(LABEL_SOURCE_ID)) {
    activeMap.addSource(LABEL_SOURCE_ID, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!activeMap.getLayer(LINE_LAYER_ID)) {
    activeMap.addLayer({
      id: LINE_LAYER_ID,
      type: "line",
      source: LINE_SOURCE_ID,
      paint: {},
    });
  }
  if (!activeMap.getLayer(LABEL_LAYER_ID)) {
    activeMap.addLayer({
      id: LABEL_LAYER_ID,
      type: "symbol",
      source: LABEL_SOURCE_ID,
      layout: {},
      paint: {},
    });
  }
}

function applyStyleProps(activeMap: MapLibreMap): void {
  activeMap.setPaintProperty(LINE_LAYER_ID, "line-color", settings.lineColor);
  activeMap.setPaintProperty(LINE_LAYER_ID, "line-width", settings.lineWidth);
  activeMap.setPaintProperty(LINE_LAYER_ID, "line-opacity", settings.lineOpacity);
  // Setting the dash array to undefined reverts to a solid line; a literal like
  // [1] would render as a 1px dotted line that is almost invisible.
  activeMap.setPaintProperty(
    LINE_LAYER_ID,
    "line-dasharray",
    settings.lineDashed ? [2, 2] : undefined,
  );

  const anchor: ExpressionSpecification = ["get", "anchor"];
  activeMap.setLayoutProperty(LABEL_LAYER_ID, "visibility", settings.showLabels ? "visible" : "none");
  activeMap.setLayoutProperty(LABEL_LAYER_ID, "text-field", ["get", "label"]);
  activeMap.setLayoutProperty(LABEL_LAYER_ID, "text-font", pickTextFont(activeMap));
  activeMap.setLayoutProperty(LABEL_LAYER_ID, "text-size", settings.labelSize);
  activeMap.setLayoutProperty(LABEL_LAYER_ID, "text-anchor", anchor);
  activeMap.setLayoutProperty(LABEL_LAYER_ID, "text-allow-overlap", true);
  activeMap.setLayoutProperty(LABEL_LAYER_ID, "text-ignore-placement", true);
  // Nudge each label inward off the very edge it sits on.
  activeMap.setLayoutProperty(LABEL_LAYER_ID, "text-offset", [
    "match",
    anchor,
    "bottom",
    ["literal", [0, -0.5]],
    "top",
    ["literal", [0, 0.5]],
    "left",
    ["literal", [0.5, 0]],
    "right",
    ["literal", [-0.5, 0]],
    ["literal", [0, 0]],
  ]);
  activeMap.setPaintProperty(LABEL_LAYER_ID, "text-color", settings.labelColor);
  // Derive the halo from the label colour's luminance so labels stay legible on
  // both light and dark basemaps (a fixed white halo rings dark text awkwardly).
  activeMap.setPaintProperty(
    LABEL_LAYER_ID,
    "text-halo-color",
    contrastingHalo(settings.labelColor),
  );
  activeMap.setPaintProperty(LABEL_LAYER_ID, "text-halo-width", 1.2);
}

/** Return a dark or light halo that contrasts with the given `#rrggbb` colour. */
function contrastingHalo(hex: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return "#ffffff";
  const value = Number.parseInt(match[1], 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? "#1f2937" : "#ffffff";
}

let idlePending = false;

/**
 * Ensure the style is ready before drawing. When it is still loading, queue a
 * single full {@link update} for the next `idle` event rather than one per call,
 * so rapid setting changes during load do not stack up redundant redraws.
 */
function whenStyleReady(activeMap: MapLibreMap): boolean {
  if (activeMap.isStyleLoaded()) return true;
  if (!idlePending) {
    idlePending = true;
    activeMap.once("idle", () => {
      idlePending = false;
      update();
    });
  }
  return false;
}

/** Rebuild the grid geometry from the current viewport (no style changes). */
function refreshGeometry(): void {
  if (!map) return;
  const activeMap = map;
  if (!whenStyleReady(activeMap)) return;
  ensureLayers(activeMap);
  const geometry = buildGeometry(activeMap);
  (activeMap.getSource(LINE_SOURCE_ID) as GeoJSONSource | undefined)?.setData(
    geometry.lines,
  );
  (activeMap.getSource(LABEL_SOURCE_ID) as GeoJSONSource | undefined)?.setData(
    geometry.labels,
  );
}

/**
 * Recompute geometry and re-apply styling. Use after a settings or basemap
 * change; plain pan/zoom should call {@link refreshGeometry} so the style
 * properties (colours, widths, fonts) are not needlessly re-diffed on the GPU.
 */
function update(): void {
  if (!map) return;
  if (!whenStyleReady(map)) return;
  refreshGeometry();
  applyStyleProps(map);
}

function teardownLayers(activeMap: MapLibreMap): void {
  if (activeMap.getLayer(LABEL_LAYER_ID)) activeMap.removeLayer(LABEL_LAYER_ID);
  if (activeMap.getLayer(LINE_LAYER_ID)) activeMap.removeLayer(LINE_LAYER_ID);
  if (activeMap.getSource(LABEL_SOURCE_ID)) activeMap.removeSource(LABEL_SOURCE_ID);
  if (activeMap.getSource(LINE_SOURCE_ID)) activeMap.removeSource(LINE_SOURCE_ID);
}

// ---------------------------------------------------------------------------
// On-map control button (opens the settings panel)
// ---------------------------------------------------------------------------

class GraticuleControl implements IControl {
  private container: HTMLElement | null = null;
  private button: HTMLButtonElement | null = null;

  onAdd(): HTMLElement {
    const container = document.createElement("div");
    container.className =
      "maplibregl-ctrl maplibregl-ctrl-group geolibre-graticule-ctrl";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "geolibre-graticule-button";
    button.innerHTML = GRID_ICON_SVG;
    button.addEventListener("click", () => appRef?.openRightPanel?.(PANEL_ID));
    container.appendChild(button);
    this.container = container;
    this.button = button;
    this.updateLabels();
    return container;
  }

  /** Refresh the tooltip/aria-label so they follow a language change. */
  updateLabels(): void {
    if (!this.button) return;
    this.button.title = labels.controlTitle;
    this.button.setAttribute("aria-label", labels.controlTitle);
  }

  onRemove(): void {
    this.container?.parentNode?.removeChild(this.container);
    this.container = null;
    this.button = null;
  }
}

const GRID_ICON_SVG = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2" y="2" width="14" height="14" rx="1"/><line x1="6.7" y1="2" x2="6.7" y2="16"/><line x1="11.3" y1="2" x2="11.3" y2="16"/><line x1="2" y1="6.7" x2="16" y2="6.7"/><line x1="2" y1="11.3" x2="16" y2="11.3"/></svg>`;

// ---------------------------------------------------------------------------
// Settings panel (plain DOM, per the plugin contract)
// ---------------------------------------------------------------------------

/**
 * Host entry point: track the container so a language change can rebuild it, fill
 * it, and return a cleanup that only clears state if it still owns the panel
 * (guards against a second render landing before the first cleanup fires).
 */
function renderPanel(container: HTMLElement): () => void {
  panelContainer = container;
  buildPanelBody(container);
  return () => {
    if (panelContainer === container) {
      panelContainer = null;
      syncPanel = null;
    }
  };
}

/** (Re)build the panel's controls into `container` using the current strings. */
function buildPanelBody(container: HTMLElement): void {
  container.innerHTML = "";
  // Tag the panel so the host can theme its native form controls (the host
  // applies `color-scheme: dark` to these in dark mode; see index.css).
  container.classList.add("geolibre-graticule-panel");
  container.style.padding = "12px";
  container.style.display = "flex";
  container.style.flexDirection = "column";
  container.style.gap = "12px";
  container.style.fontSize = "13px";

  const controls: Array<() => void> = [];

  const addRow = (labelText: string, input: HTMLElement): HTMLElement => {
    const row = document.createElement("label");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.justifyContent = "space-between";
    row.style.gap = "8px";
    const span = document.createElement("span");
    span.textContent = labelText;
    row.appendChild(span);
    row.appendChild(input);
    container.appendChild(row);
    return row;
  };

  const select = (
    labelText: string,
    options: Array<{ value: string; label: string }>,
    get: () => string,
    set: (value: string) => void,
  ): void => {
    const el = document.createElement("select");
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      el.appendChild(o);
    }
    el.value = get();
    el.addEventListener("change", () => set(el.value));
    controls.push(() => {
      el.value = get();
    });
    addRow(labelText, el);
  };

  const number = (
    labelText: string,
    attrs: { min: number; max: number; step: number },
    get: () => number,
    set: (value: number) => void,
    // Optional predicate; when it returns true the row is grayed out and the
    // input is disabled (e.g. Interval has no effect while Spacing is Auto).
    isDisabled?: () => boolean,
  ): void => {
    const el = document.createElement("input");
    el.type = "number";
    el.min = String(attrs.min);
    el.max = String(attrs.max);
    el.step = String(attrs.step);
    el.style.width = "84px";
    el.value = String(get());
    el.addEventListener("change", () => {
      const v = Number(el.value);
      if (Number.isFinite(v)) set(v);
    });
    // Pressing Enter releases focus; the resulting blur fires the change event
    // above, which commits the value, so map navigation hotkeys are no longer
    // trapped in the field.
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") el.blur();
    });
    const row = addRow(labelText, el);
    const applyDisabled = (): void => {
      const disabled = isDisabled?.() ?? false;
      el.disabled = disabled;
      row.style.opacity = disabled ? "0.5" : "";
      // The disabled input shows `not-allowed` on its own, but the label text
      // beside it would otherwise keep the default cursor; set it on the whole
      // row so hovering anywhere signals the control is inactive.
      row.style.cursor = disabled ? "not-allowed" : "";
    };
    applyDisabled();
    controls.push(() => {
      el.value = String(get());
      applyDisabled();
    });
  };

  const color = (
    labelText: string,
    get: () => string,
    set: (value: string) => void,
  ): void => {
    const el = document.createElement("input");
    el.type = "color";
    el.value = get();
    el.addEventListener("input", () => set(el.value));
    controls.push(() => {
      el.value = get();
    });
    addRow(labelText, el);
  };

  const checkbox = (
    labelText: string,
    get: () => boolean,
    set: (value: boolean) => void,
  ): void => {
    const el = document.createElement("input");
    el.type = "checkbox";
    el.checked = get();
    el.addEventListener("change", () => set(el.checked));
    controls.push(() => {
      el.checked = get();
    });
    addRow(labelText, el);
  };

  select(
    labels.gridType,
    [
      { value: "geographic", label: labels.typeGeographic },
      { value: "utm", label: labels.typeUtm },
    ],
    () => settings.gridType,
    (v) => setGraticuleSettings({ gridType: v as GraticuleGridType }),
  );
  select(
    labels.spacing,
    [
      { value: "auto", label: labels.spacingAuto },
      { value: "fixed", label: labels.spacingFixed },
    ],
    () => settings.spacingMode,
    (v) => setGraticuleSettings({ spacingMode: v as GraticuleSettings["spacingMode"] }),
  );
  if (settings.gridType === "utm") {
    number(
      labels.intervalMeters,
      { min: 100, max: 1000000, step: 100 },
      () => settings.spacingMeters,
      (v) => setGraticuleSettings({ spacingMeters: v }),
      // Auto spacing is purely zoom-driven, so the interval has no effect there.
      () => settings.spacingMode === "auto",
    );
  } else {
    number(
      labels.interval,
      // A fine step keeps clamped/default values (e.g. 10, 0.25) valid for the
      // native number input rather than reading as step mismatches.
      { min: 0.001, max: 45, step: 0.001 },
      () => settings.spacingDegrees,
      (v) => setGraticuleSettings({ spacingDegrees: v }),
      // Auto spacing is purely zoom-driven, so the interval has no effect there.
      () => settings.spacingMode === "auto",
    );
  }
  color(labels.lineColor, () => settings.lineColor, (v) => setGraticuleSettings({ lineColor: v }));
  number(
    labels.lineWidth,
    { min: 0.1, max: 6, step: 0.1 },
    () => settings.lineWidth,
    (v) => setGraticuleSettings({ lineWidth: v }),
  );
  number(
    labels.lineOpacity,
    { min: 0, max: 1, step: 0.05 },
    () => settings.lineOpacity,
    (v) => setGraticuleSettings({ lineOpacity: v }),
  );
  checkbox(labels.dashedLines, () => settings.lineDashed, (v) => setGraticuleSettings({ lineDashed: v }));
  checkbox(labels.showLabels, () => settings.showLabels, (v) => setGraticuleSettings({ showLabels: v }));
  // The label format (decimal vs DMS) only applies to the geographic grid; UTM
  // labels are always metric easting/northing values.
  if (settings.gridType !== "utm") {
    select(
      labels.labelFormat,
      [
        { value: "dd", label: labels.formatDecimal },
        { value: "dms", label: labels.formatDms },
      ],
      () => settings.labelFormat,
      (v) => setGraticuleSettings({ labelFormat: v as GraticuleLabelFormat }),
    );
  }
  select(
    labels.labelEdges,
    [
      { value: "left-bottom", label: labels.edgesLeftBottom },
      { value: "all", label: labels.edgesAll },
    ],
    () => settings.labelEdges,
    (v) => setGraticuleSettings({ labelEdges: v as GraticuleLabelEdges }),
  );
  color(labels.labelColor, () => settings.labelColor, (v) => setGraticuleSettings({ labelColor: v }));
  number(
    labels.labelSize,
    { min: 6, max: 28, step: 1 },
    () => settings.labelSize,
    (v) => setGraticuleSettings({ labelSize: v }),
  );

  syncPanel = () => {
    for (const sync of controls) sync();
  };
}

// ---------------------------------------------------------------------------
// Settings normalization (project state is opaque JSON)
// ---------------------------------------------------------------------------

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Canonicalize a color string to lowercase `#rrggbb`, expanding the `#rgb`
 * shorthand. Returns null for anything else (including 5/7-digit values and
 * `#rrggbbaa` alpha, which the native color input cannot display).
 */
function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const color = value.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(color);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return /^#[0-9a-f]{6}$/.test(color) ? color : null;
}

export function normalizeGraticuleSettings(value: unknown): GraticuleSettings {
  const v = (value ?? {}) as Partial<GraticuleSettings>;
  const d = DEFAULT_GRATICULE_SETTINGS;
  return {
    gridType: v.gridType === "utm" ? "utm" : "geographic",
    spacingMode: v.spacingMode === "fixed" ? "fixed" : "auto",
    spacingDegrees: clampNumber(v.spacingDegrees, 0.001, 45, d.spacingDegrees),
    spacingMeters: clampNumber(v.spacingMeters, 100, 1000000, d.spacingMeters),
    lineColor: normalizeHexColor(v.lineColor) ?? d.lineColor,
    lineWidth: clampNumber(v.lineWidth, 0.1, 6, d.lineWidth),
    lineOpacity: clampNumber(v.lineOpacity, 0, 1, d.lineOpacity),
    lineDashed: typeof v.lineDashed === "boolean" ? v.lineDashed : d.lineDashed,
    showLabels: typeof v.showLabels === "boolean" ? v.showLabels : d.showLabels,
    labelFormat: v.labelFormat === "dms" ? "dms" : "dd",
    labelEdges: v.labelEdges === "all" ? "all" : "left-bottom",
    labelColor: normalizeHexColor(v.labelColor) ?? d.labelColor,
    labelSize: clampNumber(v.labelSize, 6, 28, d.labelSize),
  };
}

/**
 * Field-by-field comparison against the defaults (rather than `JSON.stringify`,
 * which would silently break if a field were added to one object but not the
 * other, or if property order diverged).
 */
function settingsEqual(a: GraticuleSettings, b: GraticuleSettings): boolean {
  return (
    a.gridType === b.gridType &&
    a.spacingMode === b.spacingMode &&
    a.spacingDegrees === b.spacingDegrees &&
    a.spacingMeters === b.spacingMeters &&
    a.lineColor === b.lineColor &&
    a.lineWidth === b.lineWidth &&
    a.lineOpacity === b.lineOpacity &&
    a.lineDashed === b.lineDashed &&
    a.showLabels === b.showLabels &&
    a.labelFormat === b.labelFormat &&
    a.labelEdges === b.labelEdges &&
    a.labelColor === b.labelColor &&
    a.labelSize === b.labelSize
  );
}

function isDefaultSettings(value: GraticuleSettings): boolean {
  return settingsEqual(value, DEFAULT_GRATICULE_SETTINGS);
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export const maplibreGraticulePlugin: GeoLibrePlugin = {
  id: GRATICULE_PLUGIN_ID,
  name: "Gridlines",
  version: "0.1.0",
  activate: (app: GeoLibreAppAPI) => {
    const activeMap = app.getMap?.();
    if (!activeMap) return false;
    map = activeMap;
    appRef = app;

    update();

    // Plain pan/zoom only needs new geometry, not a full style re-apply.
    moveHandler = () => refreshGeometry();
    activeMap.on("moveend", moveHandler);

    // setStyle (basemap change) drops our sources/layers, so rebuild afterward.
    // The new basemap may ship different fonts, so drop the cached one.
    unsubscribeBasemap = app.onBasemapChange(() => {
      if (!map) return;
      cachedTextFont = null;
      map.once("idle", () => update());
    });

    unregisterPanel =
      app.registerRightPanel?.({
        id: PANEL_ID,
        title: () => labels.getTitle?.() ?? labels.title,
        dock: "right-of-style",
        render: (container) => renderPanel(container),
      }) ?? null;

    control = new GraticuleControl();
    const added = app.addMapControl(control, "top-right");
    if (!added) {
      control = null;
    }
    app.openRightPanel?.(PANEL_ID);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    if (moveHandler && map) map.off("moveend", moveHandler);
    moveHandler = null;
    unsubscribeBasemap?.();
    unsubscribeBasemap = null;
    if (control) {
      app.removeMapControl(control);
      control = null;
    }
    unregisterPanel?.();
    unregisterPanel = null;
    syncPanel = null;
    panelContainer = null;
    // Clear any pending idle flag so a rapid re-activation can queue its own
    // deferred draw instead of waiting on the previous run's stale listener.
    idlePending = false;
    cachedTextFont = null;
    if (map) teardownLayers(map);
    map = null;
    appRef = null;
  },
  getProjectState: () => (isDefaultSettings(settings) ? undefined : { ...settings }),
  applyProjectState: (_app: GeoLibreAppAPI, state: unknown) => {
    const next = normalizeGraticuleSettings(state);
    // Skip the redraw when nothing changed (e.g. the host resets a fresh project
    // to defaults that already match what is in memory).
    if (settingsEqual(settings, next)) return false;
    settings = next;
    update();
    syncPanel?.();
  },
};
