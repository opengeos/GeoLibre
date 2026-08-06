import type { LocalNetcdfProfile } from "@geolibre/plugins";

/** One pixel sampled with Identify, and its profile once that read resolves. */
export interface NetcdfProfileSample {
  /** Stable identity, used to attach the deferred profile read and key markers. */
  id: number;
  /** The layer the pixel was read from. */
  layerId: string;
  /** The variable sampled, for the chart's title. */
  variable: string;
  /** The variable's CF `units`, when it declares any. */
  units?: string;
  /** The sampled cell's centre. */
  lng: number;
  lat: number;
  /**
   * 1-based position in the sampling session, shown on the map marker and in
   * the legend. Assigned once and never renumbered, so a point keeps its label
   * and its color when an older point falls off the cap.
   */
  order: number;
  /**
   * The values along the profile axis, once read. Absent while the read is in
   * flight, and for a 2-D grid that has no band axis to walk — those pixels
   * still appear as markers and in the list, they just chart nothing.
   */
  profile?: LocalNetcdfProfile;
}

/**
 * How many sampled pixels the store keeps. Past this the oldest is dropped, so
 * a long clicking session stays readable and bounded (each reading holds a few
 * hundred numbers, so the cost is the chart's legibility, not memory).
 */
export const MAX_PROFILE_SAMPLES = 6;

let samples: NetcdfProfileSample[] = [];
/** Whether the chart is detached into the floating window over the map. */
let poppedOut = false;
/**
 * Feeds `id`. Never reset, unlike `orderCounter`: a profile read in flight when
 * the list is cleared still resolves against whatever id it was issued, so
 * recycling ids would let that stale read attach its spectrum to an unrelated
 * later sample that happened to reuse the number.
 */
let idCounter = 0;
/** Feeds `order`; reset with the list so marker labels restart at 1. */
let orderCounter = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Record a clicked pixel, and return the id to attach its profile to.
 *
 * Samples from a *different* layer replace the list rather than joining it: two
 * variables share no y-axis, so charting them together would be misleading.
 * That also keeps the list single-layer, which is what lets the floating window
 * chart "the current samples" without tracking a layer of its own.
 *
 * @param sample - The clicked pixel, without the fields the store assigns.
 * @returns The new sample's id.
 */
export function addNetcdfProfileSample(sample: Omit<NetcdfProfileSample, "id" | "order">): number {
  const sameLayer = samples.filter((item) => item.layerId === sample.layerId);
  // A layer switch starts a fresh session, so numbering restarts at 1 rather
  // than continuing from the discarded layer's count.
  if (sameLayer.length !== samples.length) orderCounter = 0;
  idCounter += 1;
  orderCounter += 1;
  const added: NetcdfProfileSample = { ...sample, id: idCounter, order: orderCounter };
  samples = [...sameLayer, added].slice(-MAX_PROFILE_SAMPLES);
  emit();
  return added.id;
}

/**
 * Attach a resolved profile to a sample.
 *
 * A no-op when that sample is gone (cleared, or dropped past the cap), which is
 * what makes a slow read safe to leave running: a result the user has moved on
 * from lands nowhere instead of charting a stale pixel.
 *
 * @param id - The sample the profile was read for.
 * @param profile - The values along the profile axis.
 */
export function setNetcdfProfileSampleProfile(id: number, profile: LocalNetcdfProfile): void {
  if (!samples.some((item) => item.id === id)) return;
  samples = samples.map((item) => (item.id === id ? { ...item, profile } : item));
  emit();
}

/** Drop every sampled pixel, and with it the markers and the chart. */
export function clearNetcdfProfileSamples(): void {
  if (samples.length === 0 && !poppedOut) return;
  samples = [];
  orderCounter = 0;
  // The window charts the samples, so leaving it open would strand an empty
  // frame over the map.
  poppedOut = false;
  emit();
}

/**
 * Drop only the pixels sampled from one layer.
 *
 * What an off-grid click should clear: the identify target's own points, not a
 * chart another layer's panel is still showing. The list holds one layer at a
 * time, so clearing it wholesale would take that other layer's samples with it
 * whenever the user switched identify targets before landing a hit on the new one.
 *
 * @param layerId - The layer whose samples to drop.
 */
export function clearNetcdfProfileSamplesForLayer(layerId: string): void {
  const kept = samples.filter((item) => item.layerId !== layerId);
  if (kept.length === samples.length) return;
  samples = kept;
  // Emptied by this clear, so restart numbering and dock the (now empty) window,
  // exactly as a full clear would.
  if (kept.length === 0) {
    orderCounter = 0;
    poppedOut = false;
  }
  emit();
}

/** The current samples, for `useSyncExternalStore`. */
export function getNetcdfProfileSamples(): NetcdfProfileSample[] {
  return samples;
}

/** Whether the chart is detached into the floating window. */
export function isNetcdfProfilePoppedOut(): boolean {
  return poppedOut;
}

/**
 * Detach the chart into the floating window over the map, or dock it back into
 * the Style panel.
 *
 * @param value - True to float the chart, false to dock it.
 */
export function setNetcdfProfilePoppedOut(value: boolean): void {
  if (poppedOut === value) return;
  poppedOut = value;
  emit();
}

/** Subscribe to sample or pop-out changes, for `useSyncExternalStore`. */
export function subscribeNetcdfProfile(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
