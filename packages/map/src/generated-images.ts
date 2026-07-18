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

// Remote SVG sources we have already warned about, so the console message below
// fires once per distinct URL instead of on every image regeneration.
const warnedRemoteSvgSources = new Set<string>();

/**
 * Resolve user-supplied SVG input to an `Image.src`: inline markup (starting
 * with `<`) is encoded as a data URL; otherwise only `data:` and `http(s):`
 * URLs are accepted. Returns null for empty input or an unsupported scheme
 * (e.g. `file:`), which the caller treats as "no image" rather than letting an
 * arbitrary URL be loaded.
 *
 * Remote `http(s):` URLs are supported intentionally (custom marker/pattern
 * SVGs) but trigger a cross-origin request when rendered. Because a shared
 * `.geolibre.json` can carry such a URL, we log a one-time warning so the
 * outbound request is visible; prefer inline `<svg>` or `data:` in shared
 * projects.
 */
export function resolveSvgSource(markup: string): string | null {
  const trimmed = markup.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("<")) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(trimmed)}`;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    if (!warnedRemoteSvgSources.has(trimmed)) {
      warnedRemoteSvgSources.add(trimmed);
      console.warn(
        `[geolibre] Loading a custom SVG from a remote URL triggers a ` +
          `cross-origin request: ${trimmed}. Prefer inline <svg> markup or a ` +
          `data: URL in shared projects.`,
      );
    }
    return trimmed;
  }
  if (trimmed.startsWith("data:")) {
    return trimmed;
  }
  return null;
}

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
  if (factories.has(id)) return;
  if (factories.size >= MAX_GENERATED_IMAGE_FACTORIES) {
    const oldest = factories.keys().next().value;
    if (oldest !== undefined) factories.delete(oldest);
  }
  factories.set(id, factory);
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
