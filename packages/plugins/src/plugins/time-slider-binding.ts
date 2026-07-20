import { addGranularityUnits, type TimeBinding } from "@geolibre/core";

export {
  addGranularityUnits,
  buildTimeBinding,
  detectTimeProperties,
  detectValueKind,
  parseTimeValue,
  pickGranularity,
  type TimeBinding,
  type TimeGranularity,
  type TimePropertyCandidate,
  type TimeValueKind,
  type TimeWindow,
} from "@geolibre/core";

/**
 * MapLibre adapter expression for a time binding. This stays outside core:
 * ArcGIS will translate the same {@link TimeBinding} into a `FeatureFilter`.
 */
export function buildTimeFilter(binding: TimeBinding, date: Date): unknown[] {
  const { window, property, valueKind } = binding;
  const lowerMs = addGranularityUnits(date, window.unit, -window.before).getTime();
  const upperMs = addGranularityUnits(date, window.unit, window.after).getTime();

  if (valueKind === "epochMs" || valueKind === "epochS") {
    const scale = valueKind === "epochS" ? 0.001 : 1;
    const value = ["to-number", ["get", property]];
    return ["all", [">=", value, lowerMs * scale], ["<", value, upperMs * scale]];
  }

  // Compare a fixed-length leading slice of the ISO text on both sides so a
  // trailing `Z`, a `.SSS` milliseconds fraction, or a timezone offset cannot
  // break the boundary comparison: `YYYY-MM-DD` for date-only,
  // `YYYY-MM-DDTHH:MM:SS` for datetimes. Timestamps are therefore compared by
  // their wall-clock text and should use a consistent representation (UTC is
  // recommended); mixed explicit offsets are not normalized.
  const boundLength = valueKind === "isoDate" ? 10 : 19;
  const toBound = (ms: number): string => new Date(ms).toISOString().slice(0, boundLength);
  // `to-string` coerces missing/null values to "" so the comparison never
  // throws on a feature that lacks the property; "" sorts before any real
  // timestamp, so undated features fall outside every window.
  const value = ["slice", ["to-string", ["get", property]], 0, boundLength];
  return ["all", [">=", value, toBound(lowerMs)], ["<", value, toBound(upperMs)]];
}
