/**
 * Print layout capture, legend building, and export (PNG / PDF).
 *
 * {@link buildLegend} is a pure transform from layers to legend entries and is
 * unit tested. {@link captureMapImage} reads the live map's canvases, and the
 * export helpers rasterize {@link drawLayout} at print resolution.
 */
import jsPDF from "jspdf";
import {
  drawLayout,
  pageDimensionsMm,
  type LayoutOptions,
} from "./print-layout";

export { buildLegend } from "./print-legend";

export interface CapturedMap {
  image: HTMLCanvasElement;
  width: number;
  height: number;
  /** Ground metres per device pixel of the captured image, at map centre. */
  metersPerPixel: number;
  bearingDeg: number;
}

interface MapLike {
  getCanvas(): HTMLCanvasElement;
  getContainer(): HTMLElement;
  getBearing(): number;
  unproject(point: [number, number]): { lng: number; lat: number };
}

/**
 * Capture the current map view as a single composited canvas. All `<canvas>`
 * elements inside the map container (the MapLibre base canvas plus any deck.gl
 * overlay) are drawn in DOM order so the snapshot matches what is on screen.
 *
 * @param map - The MapLibre map instance.
 * @returns The composited image plus the ground scale and bearing needed to
 *   render a scale bar and north arrow.
 */
export function captureMapImage(map: MapLike): CapturedMap {
  const base = map.getCanvas();
  const out = document.createElement("canvas");
  out.width = base.width;
  out.height = base.height;
  const ctx = out.getContext("2d");
  if (ctx) {
    const canvases = map.getContainer().querySelectorAll("canvas");
    canvases.forEach((c) => {
      try {
        ctx.drawImage(c, 0, 0, out.width, out.height);
      } catch {
        // A tainted or zero-size canvas is skipped rather than aborting.
      }
    });
  }

  const cssWidth = base.clientWidth || base.width;
  const cssHeight = base.clientHeight || base.height;
  const midY = cssHeight / 2;
  const span = Math.min(100, cssWidth / 2);
  const left = map.unproject([cssWidth / 2 - span / 2, midY]);
  const right = map.unproject([cssWidth / 2 + span / 2, midY]);
  const metersPerCssPx = haversineMeters(left, right) / span;
  const dpr = cssWidth > 0 ? out.width / cssWidth : 1;
  const metersPerPixel = dpr > 0 ? metersPerCssPx / dpr : metersPerCssPx;

  return {
    image: out,
    width: out.width,
    height: out.height,
    metersPerPixel,
    bearingDeg: map.getBearing(),
  };
}

function haversineMeters(
  a: { lng: number; lat: number },
  b: { lng: number; lat: number },
): number {
  const R = 6371008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Rasterize a layout to an offscreen canvas at the given DPI. */
function renderToCanvas(opts: LayoutOptions, dpi: number): HTMLCanvasElement {
  const { widthMm, heightMm } = pageDimensionsMm(
    opts.paperSize,
    opts.orientation,
  );
  const pxPerMm = dpi / 25.4;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(widthMm * pxPerMm);
  canvas.height = Math.round(heightMm * pxPerMm);
  drawLayout(canvas, opts);
  return canvas;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Export the layout as a PNG file at the given DPI (default 150). */
export async function exportLayoutPng(
  opts: LayoutOptions,
  filename: string,
  dpi = 150,
): Promise<void> {
  const canvas = renderToCanvas(opts, dpi);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png"),
  );
  if (!blob) throw new Error("Failed to render PNG");
  triggerDownload(blob, filename);
}

/** Export the layout as a PDF file at the given DPI (default 150). */
export function exportLayoutPdf(
  opts: LayoutOptions,
  filename: string,
  dpi = 150,
): void {
  const { widthMm, heightMm } = pageDimensionsMm(
    opts.paperSize,
    opts.orientation,
  );
  const canvas = renderToCanvas(opts, dpi);
  // Provide already-oriented page dimensions and keep portrait orientation so
  // jsPDF does not swap width/height a second time.
  const pdf = new jsPDF({ unit: "mm", format: [widthMm, heightMm] });
  pdf.addImage(
    canvas.toDataURL("image/png"),
    "PNG",
    0,
    0,
    widthMm,
    heightMm,
    undefined,
    "FAST",
  );
  pdf.save(filename);
}
