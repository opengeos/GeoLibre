import type { LocalNetcdfProfile } from "@geolibre/plugins";

/** One sampled pixel's profile, with where it came from. */
export interface NetcdfProfileReading {
  /** The layer the pixel was read from. */
  layerId: string;
  /** The variable profiled, for the chart's title. */
  variable: string;
  /** The variable's CF `units`, when it declares any. */
  units?: string;
  /** The sampled cell's centre. */
  lng: number;
  lat: number;
  /** The values along the profile axis. */
  profile: LocalNetcdfProfile;
}

/**
 * How many sampled pixels the chart keeps. Past this the oldest is dropped, so
 * a long clicking session stays readable and bounded (each reading holds a few
 * hundred numbers, so the cost is the chart's legibility, not memory).
 */
export const MAX_PROFILE_READINGS = 6;

let readings: NetcdfProfileReading[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Append a sampled pixel's profile, or clear the panel when passed null.
 *
 * Readings from a *different* layer replace the list rather than joining it:
 * two variables share no y-axis, so charting them together would be misleading.
 *
 * @param reading - The new reading, or null to clear.
 */
export function setNetcdfProfileReading(reading: NetcdfProfileReading | null): void {
  if (!reading) {
    if (readings.length === 0) return;
    readings = [];
    emit();
    return;
  }
  const sameLayer = readings.filter((item) => item.layerId === reading.layerId);
  readings = [...sameLayer, reading].slice(-MAX_PROFILE_READINGS);
  emit();
}

/** Drop every sampled profile. */
export function clearNetcdfProfileReadings(): void {
  setNetcdfProfileReading(null);
}

/** The current readings, for `useSyncExternalStore`. */
export function getNetcdfProfileReadings(): NetcdfProfileReading[] {
  return readings;
}

/** Subscribe to reading changes, for `useSyncExternalStore`. */
export function subscribeNetcdfProfileReadings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
