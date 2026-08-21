import type * as maplibregl from "maplibre-gl";

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

/**
 * A stable 64-bit (cyrb53-style) hash of arbitrary text, returned as a 16-char
 * hex string. Used to derive a deterministic image id from custom SVG markup;
 * the wider hash keeps the collision probability negligible even for many
 * distinct SVGs (a 32-bit hash would collide after ~65k strings, silently
 * reusing the first SVG's pixels for a colliding one).
 */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

// The custom-SVG source resolver lives in @geolibre/core so the map's sprite
// baker and the two legend renderers cannot disagree about what a marker's
// `markerSvg` means; re-exported here for the existing call sites.
export { resolveSvgSource } from "@geolibre/core";

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
const activeMaps = new Set<WeakRef<maplibregl.Map>>();

// Bound the registry so a long session of custom-SVG editing (each distinct
// markup hashes to a new id) can't grow it without limit. Built-in shapes and
// patterns have low cardinality and stay well under this.
const MAX_GENERATED_IMAGE_FACTORIES = 512;

/**
 * Register the factory that generates the image for `id`. Idempotent: re-running
 * with the same id keeps the existing factory (the id fully determines the
 * pixels, so any factory for it is equivalent). Evicts the oldest entry when the
 * cap is reached — safe because layer sync re-registers any id still in use, and
 * `styleimagemissing` re-fires if MapLibre later needs an evicted image.
 */
export function registerGeneratedImage(id: string, factory: GeneratedImageFactory): void {
  const isPlaceholder = !factories.has(id);
  if (factories.has(id)) return;
  if (factories.size >= MAX_GENERATED_IMAGE_FACTORIES) {
    const oldest = factories.keys().next().value;
    if (oldest !== undefined) factories.delete(oldest);
  }
  factories.set(id, factory);

  if (isPlaceholder) {
    for (const ref of [...activeMaps]) {
      const map = ref.deref();
      if (!map) {
        activeMaps.delete(ref);
        continue;
      }
      if (map.hasImage(id)) {
        try {
          map.removeImage(id);
        } catch {
          // Ignore
        }
        addGeneratedImage(map, id);
      }
    }
  }
}

const TRANSPARENT_1X1 = new Uint8Array([0, 0, 0, 0]);

function addGeneratedImage(map: maplibregl.Map, id: string): void {
  if (map.hasImage(id)) return;
  const factory = factories.get(id);
  if (!factory) {
    map.addImage(id, { width: 1, height: 1, data: TRANSPARENT_1X1 });
    return;
  }
  let result: ReturnType<GeneratedImageFactory>;
  try {
    result = factory();
  } catch {
    map.addImage(id, { width: 1, height: 1, data: TRANSPARENT_1X1 });
    return;
  }
  if (!result) {
    map.addImage(id, { width: 1, height: 1, data: TRANSPARENT_1X1 });
    return;
  }
  if (result instanceof Promise) {
    result
      .then((resolved) => {
        if (resolved && !map.hasImage(id)) {
          map.addImage(id, resolved.image, { pixelRatio: resolved.pixelRatio });
        } else if (!map.hasImage(id)) {
          map.addImage(id, { width: 1, height: 1, data: TRANSPARENT_1X1 });
        }
      })
      .catch(() => {
        if (!map.hasImage(id)) {
          map.addImage(id, { width: 1, height: 1, data: TRANSPARENT_1X1 });
        }
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
  activeMaps.add(new WeakRef(map));
  map.on("styleimagemissing", (event) => {
    addGeneratedImage(map, event.id);
  });
}
