/** How coordinate labels are formatted. */
export type GraticuleLabelFormat = "dd" | "dms";

/** Which map edges carry coordinate labels. */
export type GraticuleLabelEdges = "left-bottom" | "all";

/** Coordinate reference used to construct a grid. */
export type GraticuleGridType = "geographic" | "utm";

/** Serializable gridline style and geometry preferences. */
export interface GraticuleSettings {
  gridType: GraticuleGridType;
  spacingMode: "auto" | "fixed";
  spacingDegrees: number;
  spacingMeters: number;
  lineColor: string;
  lineWidth: number;
  lineOpacity: number;
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

/** User-facing strings supplied by the host for a gridline control. */
export interface GraticuleLabels {
  title: string;
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

const NICE_METRIC_STEPS = [100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100];

/** Pick an auto UTM interval that draws roughly 4-12 grid lines across a view. */
export function autoMetricStep(eastingSpan: number, northingSpan: number): number {
  const span = Math.max(Math.abs(eastingSpan), Math.abs(northingSpan)) || 1;
  for (const step of NICE_METRIC_STEPS) {
    if (span / step >= 4) return step;
  }
  return NICE_METRIC_STEPS[NICE_METRIC_STEPS.length - 1];
}

/** Map a longitude to a regular 6°-wide UTM zone (1-60). */
export function utmZoneForLon(lon: number): number {
  const norm = (((lon + 180) % 360) + 360) % 360;
  return Math.floor(norm / 6) + 1;
}

/** Return the UTM latitude-band letter, or an empty string outside UTM coverage. */
export function utmLatBand(lat: number): string {
  if (lat < -80 || lat > 84) return "";
  const bands = "CDEFGHJKLMNPQRSTUVWX";
  const idx = Math.min(Math.floor((lat + 80) / 8), bands.length - 1);
  return bands[idx];
}

/** Format a UTM zone designation such as `37T`. */
export function utmZoneDesignation(lon: number, lat: number): string {
  return `${utmZoneForLon(lon)}${utmLatBand(lat)}`;
}

export function formatEasting(easting: number): string {
  return `${Math.round(easting)}mE`;
}

export function formatNorthing(northing: number): string {
  return `${Math.round(northing)}mN`;
}

function decimalsForStep(step: number): number {
  const text = String(step);
  if (text.includes("e") || text.includes("E")) return 4;
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : Math.min(4, text.length - dot - 1);
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
  return `${deg}°${String(min).padStart(2, "0")}'${String(sec).padStart(2, "0")}"${hemi}`;
}

export function formatLon(lon: number, step: number, format: GraticuleLabelFormat): string {
  let normalized = ((((lon + 180) % 360) + 360) % 360) - 180;
  if (Object.is(normalized, -0)) normalized = 0;
  if (format === "dms") return formatDms(normalized, "E", "W");
  const hemi = normalized === 0 ? "" : normalized > 0 ? "E" : "W";
  return `${Math.abs(normalized).toFixed(decimalsForStep(step))}°${hemi}`;
}

export function formatLat(lat: number, step: number, format: GraticuleLabelFormat): string {
  if (format === "dms") return formatDms(lat, "N", "S");
  const hemi = lat === 0 ? "" : lat > 0 ? "N" : "S";
  return `${Math.abs(lat).toFixed(decimalsForStep(step))}°${hemi}`;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const color = value.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(color);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return /^#[0-9a-f]{6}$/.test(color) ? color : null;
}

/** Normalize opaque project JSON to a safe, complete gridline configuration. */
export function normalizeGraticuleSettings(value: unknown): GraticuleSettings {
  const candidate = (value ?? {}) as Partial<GraticuleSettings>;
  const defaults = DEFAULT_GRATICULE_SETTINGS;
  return {
    gridType: candidate.gridType === "utm" ? "utm" : "geographic",
    spacingMode: candidate.spacingMode === "fixed" ? "fixed" : "auto",
    spacingDegrees: clampNumber(candidate.spacingDegrees, 0.001, 45, defaults.spacingDegrees),
    spacingMeters: clampNumber(candidate.spacingMeters, 100, 1000000, defaults.spacingMeters),
    lineColor: normalizeHexColor(candidate.lineColor) ?? defaults.lineColor,
    lineWidth: clampNumber(candidate.lineWidth, 0.1, 6, defaults.lineWidth),
    lineOpacity: clampNumber(candidate.lineOpacity, 0, 1, defaults.lineOpacity),
    lineDashed:
      typeof candidate.lineDashed === "boolean" ? candidate.lineDashed : defaults.lineDashed,
    showLabels:
      typeof candidate.showLabels === "boolean" ? candidate.showLabels : defaults.showLabels,
    labelFormat: candidate.labelFormat === "dms" ? "dms" : "dd",
    labelEdges: candidate.labelEdges === "all" ? "all" : "left-bottom",
    labelColor: normalizeHexColor(candidate.labelColor) ?? defaults.labelColor,
    labelSize: clampNumber(candidate.labelSize, 6, 28, defaults.labelSize),
  };
}

export function graticuleSettingsEqual(a: GraticuleSettings, b: GraticuleSettings): boolean {
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
