/**
 * Swatch primitives for the on-map Legend panel: geometry-aware chips (point
 * circle / line stroke / polygon square / raster glyph), sized proportional
 * symbols, point-marker previews, and continuous gradient bars.
 *
 * Adapted from the GeoLens viewer legend design (Apache-2.0) to GeoLibre's
 * layer model.
 */
import { drawMarkerPath, type MarkerShape } from "@geolibre/core";
import { Image as RasterIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import type { LayerSwatchShape } from "../../lib/layer-swatch";
import type { LegendMarker } from "../../lib/print-layout";

/** Neutral outline that reads on both light and dark themes. */
const OUTLINE = "rgba(107,114,128,0.6)";

/** Largest radius / stroke width a proportional legend symbol is drawn at (px). */
const MAX_SWATCH_RADIUS = 12;
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

/**
 * A point-marker preview: built-in shapes are traced with the same
 * {@link drawMarkerPath} the map's sprite baker uses, so the legend chip and
 * the on-map marker cannot disagree; custom SVG markers render as an image.
 */
export function MarkerSwatch({ marker, opacity = 1 }: { marker: LegendMarker; opacity?: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const style = opacity < 1 ? { opacity } : undefined;

  useEffect(() => {
    if (marker.shape === "custom") return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const size = canvas.width;
    ctx.clearRect(0, 0, size, size);
    drawMarkerPath(ctx, marker.shape as MarkerShape, size);
    ctx.fillStyle = marker.color;
    ctx.fill();
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1;
    ctx.stroke();
  }, [marker]);

  if (marker.shape === "custom" && marker.svg) {
    return (
      <img
        aria-hidden="true"
        className="h-3.5 w-3.5 shrink-0 object-contain"
        style={style}
        alt=""
        src={`data:image/svg+xml;utf8,${encodeURIComponent(marker.svg)}`}
      />
    );
  }
  return (
    <canvas
      ref={canvasRef}
      width={14}
      height={14}
      className="h-3.5 w-3.5 shrink-0"
      style={style}
      aria-hidden="true"
    />
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
