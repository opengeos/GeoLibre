import { styleValue, type GeoLibreLayer } from "@geolibre/core";
import { markerIconSizeValue, renderMarkerCanvas } from "@geolibre/map";
import type { StoryMarkerImage } from "./storymap-export";

/**
 * Bake the marker sprite of every marker-enabled GeoJSON layer, so the story
 * map export draws the same pins, stars, or custom SVGs the map shows instead
 * of plain circles (#2597). Uses the map's own marker renderer, so shape,
 * color, and size match. A layer whose sprite cannot be baked (a custom SVG
 * that fails to load, or a canvas that cannot be read back) is left out and
 * exports as a circle.
 *
 * @param layers The layers being exported.
 * @returns The baked sprites, keyed by layer id.
 */
export async function bakeStoryMarkerImages(
  layers: GeoLibreLayer[],
): Promise<Record<string, StoryMarkerImage>> {
  const images: Record<string, StoryMarkerImage> = {};
  await Promise.all(
    layers.map(async (layer) => {
      if (layer.type !== "geojson" || !styleValue(layer.style, "markerEnabled")) return;
      try {
        const baked = await renderMarkerCanvas(layer.style);
        if (!baked) return;
        images[layer.id] = {
          dataUrl: baked.canvas.toDataURL("image/png"),
          pixelRatio: baked.pixelRatio,
          iconSize: markerIconSizeValue(layer.style),
        };
      } catch {
        // A tainted canvas (cross-origin SVG) cannot be serialized; fall back.
      }
    }),
  );
  return images;
}
