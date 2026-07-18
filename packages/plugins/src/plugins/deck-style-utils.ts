import type { LayerStyle } from "@geolibre/core";

export type StyledDeckLayerLike = {
  clone?: (props: Record<string, unknown>) => StyledDeckLayerLike;
  props?: Record<string, unknown>;
};

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function colorToRgba(color: string, alpha: number): [number, number, number, number] {
  const normalized = color.trim();
  // The Style panel's ColorField can emit the "transparent" sentinel
  // (TRANSPARENT_COLOR in @geolibre/ui); render it invisible instead of
  // letting it fall through to the invalid-color fallback blue.
  if (normalized.toLowerCase() === "transparent") return [0, 0, 0, 0];
  const hex =
    normalized.length === 4 && normalized.startsWith("#")
      ? `#${normalized[1]}${normalized[1]}${normalized[2]}${normalized[2]}${normalized[3]}${normalized[3]}`
      : normalized;
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return [59, 130, 246, Math.round(clamp(alpha, 0, 1) * 255)];

  const value = Number.parseInt(match[1], 16);
  return [
    (value >> 16) & 255,
    (value >> 8) & 255,
    value & 255,
    Math.round(clamp(alpha, 0, 1) * 255),
  ];
}

export function pointRadiusMaxPixels(style: LayerStyle): number {
  return style.circleRadius * 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
