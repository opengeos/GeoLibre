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
 *
 * Lives here (rather than beside the map's sprite baker) because every surface
 * that previews a custom marker — the map, the Print Layout legend, the on-map
 * Legend panel — must resolve the same input the same way. A second, local
 * `data:image/svg+xml,…` wrapper is exactly what left URL and `data:` markers
 * blank in the on-map legend while the map drew them fine.
 *
 * @param markup - Raw SVG markup, a `data:` URL, or an `http(s)` URL.
 * @returns An `Image.src` value, or `null` when nothing loadable was given.
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
