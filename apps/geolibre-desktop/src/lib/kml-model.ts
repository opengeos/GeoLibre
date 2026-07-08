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
export function kmlModelUniformScale(scale: {
  x: number;
  y: number;
  z: number;
}): number {
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
 * A small padded extent around the model's point so "Zoom to layer" frames it
 * instead of snapping to a single point at maximum zoom.
 *
 * @param model - A resolved KML model descriptor.
 * @param pad - Half-width of the extent in degrees.
 * @returns `[west, south, east, north]` in WGS84 degrees.
 */
export function kmlModelBounds(
  model: LoadedModel,
  pad = 0.002,
): [number, number, number, number] {
  return [
    model.longitude - pad,
    model.latitude - pad,
    model.longitude + pad,
    model.latitude + pad,
  ];
}

/** The display name for a model layer, falling back to a path-derived name. */
export function kmlModelName(model: LoadedModel): string {
  // `||` (not `??`) so an empty name falls back to a path-derived one.
  return model.name || `${modelNameFromPath(model.path)} model`;
}
