import type { MarkerShape } from "./types";

/**
 * Trace the outline of a built-in marker {@link MarkerShape} onto a 2D canvas
 * path, centered in a `size`×`size` box. The caller supplies the fill/stroke;
 * this only builds the path (via `beginPath`/`closePath`), so it stays free of
 * any DOM other than the passed context and can be shared by the map's sprite
 * baker (`@geolibre/map`) and the Print Layout legend renderer.
 *
 * `"custom"` (SVG) markers have no built-in path and are handled by the caller
 * (rasterized separately); passing one draws the default circle so the marker
 * never vanishes silently.
 *
 * @param ctx - Any 2D path-drawing context (a real `CanvasRenderingContext2D`
 *   satisfies this structurally).
 * @param shape - The built-in marker shape to trace.
 * @param size - The box edge length in pixels; the shape is inset slightly so a
 *   stroke is not clipped at the edge.
 */
export function drawMarkerPath(
  ctx: CanvasRenderingContext2D,
  shape: MarkerShape,
  size: number,
): void {
  const c = size / 2;
  // Leave a small inset so the stroke is not clipped at the tile edge.
  const r = c * 0.82;
  ctx.beginPath();
  switch (shape) {
    case "square":
      ctx.rect(c - r, c - r, r * 2, r * 2);
      break;
    case "triangle":
      ctx.moveTo(c, c - r);
      ctx.lineTo(c + r, c + r);
      ctx.lineTo(c - r, c + r);
      ctx.closePath();
      break;
    case "diamond":
      ctx.moveTo(c, c - r);
      ctx.lineTo(c + r, c);
      ctx.lineTo(c, c + r);
      ctx.lineTo(c - r, c);
      ctx.closePath();
      break;
    case "star": {
      const outer = r;
      const inner = r * 0.42;
      for (let point = 0; point < 10; point += 1) {
        const radius = point % 2 === 0 ? outer : inner;
        const angle = (Math.PI / 5) * point - Math.PI / 2;
        const x = c + radius * Math.cos(angle);
        const y = c + radius * Math.sin(angle);
        if (point === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      break;
    }
    case "cross": {
      const arm = r * 0.42;
      ctx.moveTo(c - arm, c - r);
      ctx.lineTo(c + arm, c - r);
      ctx.lineTo(c + arm, c - arm);
      ctx.lineTo(c + r, c - arm);
      ctx.lineTo(c + r, c + arm);
      ctx.lineTo(c + arm, c + arm);
      ctx.lineTo(c + arm, c + r);
      ctx.lineTo(c - arm, c + r);
      ctx.lineTo(c - arm, c + arm);
      ctx.lineTo(c - r, c + arm);
      ctx.lineTo(c - r, c - arm);
      ctx.lineTo(c - arm, c - arm);
      ctx.closePath();
      break;
    }
    case "pin": {
      // A teardrop: a circle bowl with a point at the bottom.
      const bowlR = r * 0.7;
      const bowlY = c - r * 0.2;
      ctx.moveTo(c, c + r);
      ctx.quadraticCurveTo(c - bowlR, bowlY + bowlR * 0.4, c - bowlR, bowlY);
      ctx.arc(c, bowlY, bowlR, Math.PI, Math.PI * 2);
      ctx.quadraticCurveTo(c + bowlR, bowlY + bowlR * 0.4, c, c + r);
      ctx.closePath();
      break;
    }
    case "circle":
    default:
      ctx.arc(c, c, r, 0, Math.PI * 2);
  }
}
