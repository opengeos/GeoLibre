import type maplibregl from "maplibre-gl";

/**
 * Lazily-generated MapLibre sprite images (fill-pattern tiles and marker icons).
 *
 * GeoLibre has no static sprite sheet, so recolorable pattern/marker images are
 * drawn on a canvas on demand. A layer references an image by a deterministic id
 * (which encodes everything needed to regenerate it: shape/pattern + color +
 * size). When MapLibre cannot find that id it fires `styleimagemissing`; the
 * handler installed here looks up the registered factory, generates the image,
 * and calls `map.addImage`. This is the idiomatic MapLibre lazy-image pattern
 * and, because the handler lives on the map (not the style), it survives basemap
 * `setStyle` swaps that clear all images: the next render re-requests the id and
 * the image is regenerated.
 */

/** A bitmap accepted by `map.addImage`. */
export type GeneratedImage = Parameters<maplibregl.Map["addImage"]>[1];

/** The result of generating an image: the bitmap plus its sprite pixel ratio. */
export interface GeneratedImageResult {
  image: GeneratedImage;
  pixelRatio: number;
}

/** Produces an image synchronously, or asynchronously (e.g. rasterizing SVG). */
export type GeneratedImageFactory = () =>
  | GeneratedImageResult
  | Promise<GeneratedImageResult | null>
  | null;

// Keyed by the deterministic image id. Ids are unique per (pattern|shape, color,
// size), so a global registry is safe and shared across maps.
const factories = new Map<string, GeneratedImageFactory>();
const wiredMaps = new WeakSet<maplibregl.Map>();

/**
 * Register the factory that generates the image for `id`. Idempotent: re-running
 * with the same id keeps the existing factory (the id fully determines the
 * pixels, so any factory for it is equivalent).
 */
export function registerGeneratedImage(
  id: string,
  factory: GeneratedImageFactory,
): void {
  if (!factories.has(id)) factories.set(id, factory);
}

function addGeneratedImage(map: maplibregl.Map, id: string): void {
  if (map.hasImage(id)) return;
  const factory = factories.get(id);
  if (!factory) return;
  let result: ReturnType<GeneratedImageFactory>;
  try {
    result = factory();
  } catch {
    return;
  }
  if (!result) return;
  if (result instanceof Promise) {
    result
      .then((resolved) => {
        if (resolved && !map.hasImage(id)) {
          map.addImage(id, resolved.image, { pixelRatio: resolved.pixelRatio });
        }
      })
      .catch(() => {
        // SVG that fails to load is not fatal: the layer falls back to no
        // pattern/marker, which is acceptable.
      });
    return;
  }
  map.addImage(id, result.image, { pixelRatio: result.pixelRatio });
}

/**
 * Install the one-time `styleimagemissing` handler that materializes generated
 * images for this map. Safe to call on every sync; it wires the map only once.
 */
export function ensureGeneratedImageHandler(map: maplibregl.Map): void {
  if (wiredMaps.has(map)) return;
  // Guard against stub maps (unit tests) that do not implement the event API.
  if (typeof map.on !== "function") return;
  wiredMaps.add(map);
  map.on("styleimagemissing", (event) => {
    addGeneratedImage(map, event.id);
  });
}
