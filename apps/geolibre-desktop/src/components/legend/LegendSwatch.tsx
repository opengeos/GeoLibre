/**
 * Swatch primitives for the on-map Legend panel: geometry-aware chips (point
 * circle / line stroke / polygon square / raster glyph), sized proportional
 * symbols, point-marker previews, and continuous gradient bars.
 *
 * Adapted from the GeoLens viewer legend design (Apache-2.0) to GeoLibre's
 * layer model.
 */
import { drawMarkerPath, resolveSvgSource, type MarkerShape } from "@geolibre/core";
import { Image as RasterIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import type { LayerSwatchShape } from "../../lib/layer-swatch";
import type { LegendMarker } from "../../lib/print-layout";

/** Neutral outline that reads on both light and dark themes. */
const OUTLINE = "rgba(107,114,128,0.6)";

/**
 * Largest radius / stroke width a proportional legend symbol is drawn at (px).
 *
 * A proportional row's `size` IS the radius the map paints for that value (and,
 * for markers, half the sprite's on-screen width — see `markerIconSizeValue` in
 * `@geolibre/map`), so below the cap the legend symbol is drawn at exactly the
 * size the reader sees on the map. The radius cap matches the style editor's
 * default max radius (24) so the common ramp is 1:1 rather than shrunk to
 * roughly half scale; ramps configured past it scale down as one entry.
 */
const MAX_SWATCH_RADIUS = 24;
const MAX_SWATCH_STROKE = 8;

/**
 * The scale that fits an entry's largest proportional symbol into the legend.
 * Applied to EVERY row of that entry so the drawn symbols keep the map's true
 * size ratios; clamping each radius on its own instead would flatten a 4 → 24px
 * ramp into 4 → 12 and make the classes look far closer in size than they are.
 */
function swatchScale(largest: number | undefined, size: number, cap: number): number {
  const reference = Math.max(largest ?? size, size);
  return reference > cap ? cap / reference : 1;
}

/**
 * A small geometry-aware swatch: point → filled circle, line → rounded stroke,
 * polygon → filled square, raster → image glyph. `size` overrides the symbol
 * size for proportional-symbol rows (circle radius / line width in px), and
 * `maxSize` is the largest `size` in the same entry so the whole set scales by
 * one factor and shares one box width (keeping the labels aligned).
 */
export function GeometrySwatch({
  shape,
  color,
  size,
  maxSize,
  opacity = 1,
}: {
  shape: LayerSwatchShape;
  color: string;
  size?: number;
  maxSize?: number;
  opacity?: number;
}) {
  const style = opacity < 1 ? { opacity } : undefined;

  if (shape === "raster") {
    return (
      <RasterIcon
        aria-hidden
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        style={style}
      />
    );
  }
  if (shape === "circle") {
    const scale = size !== undefined ? swatchScale(maxSize, size, MAX_SWATCH_RADIUS) : 1;
    // Proportional rows pass a radius; keep the smallest visible without
    // disturbing the shared scale of the rest.
    const r = size !== undefined ? Math.max(1.5, size * scale) : 5;
    // One box per entry: derived from the entry's largest symbol, not this row's.
    const box =
      size !== undefined
        ? Math.ceil(Math.max(r, Math.max(maxSize ?? size, size) * scale) * 2) + 2
        : 14;
    return (
      <svg
        width={box}
        height={box}
        viewBox={`0 0 ${box} ${box}`}
        className="shrink-0"
        style={style}
        aria-hidden="true"
      >
        <circle cx={box / 2} cy={box / 2} r={r} fill={color} stroke={OUTLINE} strokeWidth={1} />
      </svg>
    );
  }
  if (shape === "line") {
    const scale = size !== undefined ? swatchScale(maxSize, size, MAX_SWATCH_STROKE) : 1;
    const width = size !== undefined ? Math.max(1, size * scale) : 2.5;
    const box = size !== undefined ? 24 : 14;
    return (
      <svg width={box} height={14} className="shrink-0" style={style} aria-hidden="true">
        <line
          x1="1"
          y1="7"
          x2={box - 1}
          y2="7"
          stroke={color}
          strokeWidth={width}
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="h-3.5 w-3.5 shrink-0 rounded-sm border"
      style={{ backgroundColor: color, borderColor: OUTLINE, ...style }}
    />
  );
}

/** Chip edge length for a marker with no proportional size (px). */
const MARKER_CHIP_SIZE = 14;

/**
 * A point-marker preview: built-in shapes are traced with the same
 * {@link drawMarkerPath} the map's sprite baker uses, so the legend chip and
 * the on-map marker cannot disagree; custom SVG markers render as an image
 * whose source is resolved by the shared {@link resolveSvgSource} — inline
 * markup, a `data:` URL, and an `https:` URL are all valid `markerSvg` inputs,
 * and re-encoding the latter two as data URLs left the chip blank.
 *
 * `size` (a proportional row's radius) and `maxSize` (the entry's largest)
 * scale the marker exactly like {@link GeometrySwatch} scales a circle, so a
 * marker layer's size ramp reads at the map's true symbol widths.
 */
export function MarkerSwatch({
  marker,
  size,
  maxSize,
  opacity = 1,
}: {
  marker: LegendMarker;
  size?: number;
  maxSize?: number;
  opacity?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const style = opacity < 1 ? { opacity } : undefined;
  // The map draws a marker at the diameter its proportional radius spans, so
  // the chip box is 2×radius after the entry's shared fit-to-legend scale.
  const scale = size !== undefined ? swatchScale(maxSize, size, MAX_SWATCH_RADIUS) : 1;
  const box = size !== undefined ? Math.max(4, Math.round(size * scale * 2)) : MARKER_CHIP_SIZE;
  // One column width per entry, so labels stay aligned when rows differ in size.
  const boxWidth =
    size !== undefined
      ? Math.max(box, Math.round(Math.max(maxSize ?? size, size) * scale * 2))
      : MARKER_CHIP_SIZE;

  const svgSource = marker.shape === "custom" ? resolveSvgSource(marker.svg ?? "") : null;

  useEffect(() => {
    // A custom marker whose source resolved renders as an <img> below; one that
    // did not (an unsupported scheme — `pointMarkerSwatch` only rejects EMPTY
    // markup) falls through to this canvas, where drawMarkerPath traces its
    // documented default circle rather than leaving the chip blank.
    if (marker.shape === "custom" && svgSource) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const edge = canvas.width;
    ctx.clearRect(0, 0, edge, edge);
    drawMarkerPath(ctx, marker.shape as MarkerShape, edge);
    ctx.fillStyle = marker.color;
    ctx.fill();
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1;
    ctx.stroke();
  }, [marker, box, svgSource]);

  if (marker.shape === "custom" && svgSource) {
    return (
      <span
        aria-hidden="true"
        className="flex shrink-0 items-center justify-center"
        style={{ width: boxWidth, ...style }}
      >
        <img
          className="object-contain"
          style={{ width: box, height: box }}
          alt=""
          src={svgSource}
        />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center"
      style={{ width: boxWidth, ...style }}
    >
      <canvas ref={canvasRef} width={box} height={box} style={{ width: box, height: box }} />
    </span>
  );
}

/**
 * A continuous color bar with end labels (numeric range or Low/High), used for
 * heatmaps and continuous raster colormaps.
 */
export function GradientBar({
  colors,
  minLabel,
  maxLabel,
  opacity = 1,
}: {
  colors: string[];
  minLabel: string;
  maxLabel: string;
  opacity?: number;
}) {
  // `to right` follows the reading direction visually via the flipped labels
  // below in RTL, so the ramp itself can stay physical.
  const gradient = `linear-gradient(to right, ${colors.join(", ")})`;
  return (
    <div style={opacity < 1 ? { opacity } : undefined}>
      <div className="h-3 w-full rounded-sm" style={{ background: gradient }} />
      <div className="mt-0.5 flex justify-between" dir="ltr">
        <span className="text-[10px] text-muted-foreground">{minLabel}</span>
        <span className="text-[10px] text-muted-foreground">{maxLabel}</span>
      </div>
    </div>
  );
}
