import type { LoadedModel } from "./tauri-io";

/**
 * Pure, dependency-free helpers for turning a KML `<Model>` into deck.gl
 * scenegraph inputs. Kept separate from `kml-model-layer.ts` (which pulls in the
 * plugins/deck.gl runtime) so this logic can be unit tested.
 */

/**
 * Collapse a KML `<Scale>` (x/y/z) into the single factor the scenegraph layer
 * applies. Uniform scale is the common case (all three equal); a non-uniform
 * scale is averaged so the model still renders at a sensible overall size.
 *
 * @param scale - The per-axis scale factors.
 * @returns A single positive scale factor (1 when the average is not positive).
 */
export function kmlModelUniformScale(scale: { x: number; y: number; z: number }): number {
  const average = (scale.x + scale.y + scale.z) / 3;
  return average > 0 ? average : 1;
}

/** Base file name without directory or extension (e.g. "a/town.kmz" -> "town"). */
export function modelNameFromPath(path: string): string {
  return (path.split(/[\\/]/).pop() ?? path).replace(/\.[^.]+$/, "");
}

/**
 * The single scenegraph data row for a model: its location, altitude, heading
 * (as bearing), and collapsed scale factor.
 *
 * @param model - A resolved KML model descriptor.
 * @returns The row consumed by the scenegraph layer's field mapping.
 */
export function kmlModelRow(model: LoadedModel): {
  lng: number;
  lat: number;
  altitude: number;
  bearing: number;
  scale: number;
} {
  return {
    lng: model.longitude,
    lat: model.latitude,
    altitude: model.altitude,
    bearing: model.heading,
    scale: kmlModelUniformScale(model.scale),
  };
}

/**
 * Large KML models such as geological cross-sections often encode depth/elevation
 * as positive local-up coordinates from the model origin. In deck.gl that makes
 * the whole wall tower into the sky. For kilometer-scale vertical models, shift
 * the converted scene down so its top aligns with the KML anchor altitude; leave
 * normal building-scale models untouched.
 */
export function kmlModelTranslation(model: LoadedModel): [number, number, number] {
  const min = Number.isFinite(model.verticalMinMeters) ? model.verticalMinMeters : 0;
  const max = Number.isFinite(model.verticalMaxMeters) ? model.verticalMaxMeters : 0;
  const verticalSpan = max - min;
  if (verticalSpan < 1000 || max <= 0) return [0, 0, 0];
  return [0, 0, -max * kmlModelUniformScale(model.scale)];
}

// Meters per degree of latitude (WGS84 mean). Longitude degrees shrink by
// cos(latitude), so a fixed meter extent spans more longitude near the poles.
const METERS_PER_DEGREE_LAT = 111320;

/**
 * A geographic extent around the model that frames the whole thing on load.
 *
 * A KML `<Location>` anchors the model's *origin*, which for SketchUp/Google
 * Earth exports is often a corner of a mesh that spans kilometers (a building,
 * a terrain slice, a geological cross-section). A fixed tiny box around that
 * corner would leave the model mostly off-screen — the user has to zoom way out
 * to find it — so the extent grows with the model's `radiusMeters`. Models with
 * no known extent fall back to a small point pad.
 *
 * `radiusMeters` is measured on the unscaled GLB, but the scenegraph renders
 * the model scaled by `kmlModelUniformScale(model.scale)` (see
 * {@link kmlModelRow}), so apply that same factor here or a non-default
 * `<Scale>` would under- or over-frame the model.
 *
 * @param model - A resolved KML model descriptor.
 * @param minPad - Minimum half-width of the extent in degrees (used when the
 *   model is tiny or its extent is unknown).
 * @returns `[west, south, east, north]` in WGS84 degrees.
 */
export function kmlModelBounds(
  model: LoadedModel,
  minPad = 0.002,
): [number, number, number, number] {
  const radius =
    Number.isFinite(model.radiusMeters) && model.radiusMeters > 0
      ? model.radiusMeters * kmlModelUniformScale(model.scale) * 1.1 // scaled, with breathing room
      : 0;
  const latPad = Math.max(minPad, radius / METERS_PER_DEGREE_LAT);
  // Guard the cosine against a divide-by-zero at the poles.
  const cosLat = Math.max(Math.cos((model.latitude * Math.PI) / 180), 1e-6);
  const lngPad = Math.max(minPad, radius / (METERS_PER_DEGREE_LAT * cosLat));
  return [
    model.longitude - lngPad,
    model.latitude - latPad,
    model.longitude + lngPad,
    model.latitude + latPad,
  ];
}

/**
 * The display name for a model layer, falling back to a path-derived name.
 *
 * By the time a {@link LoadedModel} reaches here its `name` was already
 * resolved to a non-empty string upstream (`kmlModelName` in `tauri-io.ts`,
 * which also does index-based disambiguation for unnamed models), so the
 * fallback below is defensive — it only fires for a directly-constructed
 * `LoadedModel` with an empty name (as in the unit tests).
 */
export function kmlModelDisplayName(model: LoadedModel): string {
  // `||` (not `??`) so an empty name falls back to a path-derived one.
  return model.name || `${modelNameFromPath(model.path)} model`;
}
