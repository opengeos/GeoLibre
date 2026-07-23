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

/**
 * A small geometry-aware swatch: point → filled circle, line → rounded stroke,
 * polygon → filled square, raster → image glyph. `size` overrides the symbol
 * size for proportional-symbol rows (circle radius / line width in px).
 */
export function GeometrySwatch({
  shape,
  color,
  size,
  opacity = 1,
}: {
  shape: LayerSwatchShape;
  color: string;
  size?: number;
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
    // Proportional rows pass a radius; cap it so the largest class still fits.
    const r = Math.max(2, Math.min(size ?? 5, 11));
    const box = size !== undefined ? 24 : 14;
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
    const width = Math.max(1.5, Math.min(size ?? 2.5, 8));
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
