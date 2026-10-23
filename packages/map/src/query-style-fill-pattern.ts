import { sanitizeLayerStylePatch, type LayerStyle } from "@geolibre/core";

/** Stored on each fill layer so source-based ZIP dispatch preserves the binding. */
export const GEO_LIBRE_FILL_PATTERN_METADATA = "geolibre:fill-pattern";

type FillPatternStyle = Pick<LayerStyle, "fillPattern" | "fillPatternColor" | "fillPatternSvg">;

/** Read only the versioned pattern extension, never arbitrary LayerStyle fields. */
export function readQueryStyleFillPattern(
  metadata: unknown,
  warnings: string[],
): FillPatternStyle | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return;
  if (!Object.hasOwn(metadata, GEO_LIBRE_FILL_PATTERN_METADATA)) return;
  const value = (metadata as Record<string, unknown>)[GEO_LIBRE_FILL_PATTERN_METADATA];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>;
    const { fillPattern } = sanitizeLayerStylePatch({ fillPattern: candidate.fillPattern });
    if (
      candidate.version === 1 &&
      fillPattern !== undefined &&
      typeof candidate.fillPatternColor === "string" &&
      typeof candidate.fillPatternSvg === "string"
    ) {
      return {
        fillPattern,
        fillPatternColor: candidate.fillPatternColor,
        fillPatternSvg: candidate.fillPatternSvg,
      };
    }
  }
  warnings.push(
    "The GeoLibre fill pattern metadata is invalid or uses an unsupported version; the layer keeps its current fill pattern.",
  );
}
