import { Context } from "svgcanvas";
import { drawLayoutContext, pagePx, resolvePageSize, type LayoutOptions } from "./print-layout";

/**
 * Replay the layout as editable SVG text, paths, swatches and gradients.
 * Only captured map views and image-based marker icons remain embedded images.
 * This module is loaded on demand so PNG/PDF exports do not load svgcanvas.
 */
export function renderLayoutSvg(opts: LayoutOptions): string {
  const size = resolvePageSize(opts);
  const { width, height } = pagePx(size, 150);
  const ctx = new Context(width, height);
  const svg = ctx.getSvg();

  // svgcanvas ignores Canvas's optional maxWidth. Preserve the same text fit
  // as the preview while keeping the entire label editable in vector editors.
  const fillText = ctx.fillText.bind(ctx);
  ctx.fillText = (text, x, y, maxWidth) => {
    if (maxWidth !== undefined && maxWidth <= 0) return;
    fillText(text, x, y);
    if (maxWidth !== undefined && ctx.measureText(text).width > maxWidth) {
      const labels = svg.querySelectorAll("text");
      const label = labels[labels.length - 1];
      label.setAttribute("textLength", String(maxWidth));
      label.setAttribute("lengthAdjust", "spacingAndGlyphs");
    }
  };

  // CanvasImageSource also includes ImageBitmap and OffscreenCanvas, which
  // svgcanvas silently skips. Normalize all images to PNG canvases, ensuring
  // downloads never depend on external URLs or temporary blob URLs.
  const drawImage = ctx.drawImage.bind(ctx);
  const embedded = new Map<CanvasImageSource, HTMLCanvasElement>();
  ctx.drawImage = (source: CanvasImageSource, ...args: number[]) => {
    let canvas = embedded.get(source);
    if (!canvas) {
      if (source instanceof HTMLCanvasElement) {
        canvas = source;
      } else {
        canvas = document.createElement("canvas");
        const dimensions =
          source instanceof HTMLImageElement
            ? { width: source.naturalWidth, height: source.naturalHeight }
            : source instanceof HTMLVideoElement
              ? { width: source.videoWidth, height: source.videoHeight }
              : "displayWidth" in source
                ? { width: source.displayWidth, height: source.displayHeight }
                : source instanceof SVGImageElement
                  ? { width: source.width.baseVal.value, height: source.height.baseVal.value }
                  : { width: Number(source.width), height: Number(source.height) };
        canvas.width = dimensions.width;
        canvas.height = dimensions.height;
        const imageContext = canvas.getContext("2d");
        if (!imageContext) throw new Error("Cannot embed layout image");
        imageContext.drawImage(source, 0, 0);
      }
      embedded.set(source, canvas);
    }
    if (args.length === 2) drawImage(canvas, args[0], args[1]);
    else if (args.length === 4) drawImage(canvas, args[0], args[1], args[2], args[3]);
    else if (args.length === 8) {
      drawImage(canvas, args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7]);
    } else throw new Error("Invalid layout image dimensions");
  };

  drawLayoutContext(ctx, width, height, opts);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", `${size.width}${size.unit}`);
  svg.setAttribute("height", `${size.height}${size.unit}`);
  // Keep consecutive spaces and non-ASCII labels intact in SVG editors.
  svg.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
  return `<?xml version="1.0" encoding="UTF-8"?>\n${ctx.getSerializedSvg()}`;
}
