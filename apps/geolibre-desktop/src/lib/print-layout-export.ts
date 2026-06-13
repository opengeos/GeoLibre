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
import { saveBinaryFileWithFallback } from "./tauri-io";

export {
  applyLegendConfig,
  buildLegend,
  legendEditorRows,
  reorderLegendEntry,
  setLegendItemLabel,
  toggleLegendItemHidden,
  type LegendEditorRow,
} from "./print-legend";

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
  // Throw rather than return a blank canvas: the dialog's recapture() catch then
  // surfaces a clear error instead of letting the user export a white page.
  if (!ctx) {
    throw new Error("Could not acquire a 2D canvas context for map capture");
  }
  const canvases = map.getContainer().querySelectorAll("canvas");
  canvases.forEach((c) => {
    try {
      ctx.drawImage(c, 0, 0, out.width, out.height);
    } catch (err) {
      // The base map canvas is unrecoverable (most likely cross-origin tile
      // CORS tainting it): propagate so the dialog reports an error instead of
      // exporting a blank page. A tainted/zero-size overlay (deck.gl) is only
      // cosmetic, so skip it.
      if (c === base) throw err;
    }
  });

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

async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png"),
  );
  if (!blob) throw new Error("Failed to render PNG");
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Export the layout as a PNG file at the given DPI (default 150).
 *
 * Routes through {@link saveBinaryFileWithFallback} so it works in the Tauri
 * desktop app (native save dialog + filesystem write) as well as the browser
 * build, where anchor-style downloads are unavailable in the webview.
 *
 * @returns The saved file name, or null if the user cancelled the save dialog.
 */
export async function exportLayoutPng(
  opts: LayoutOptions,
  filename: string,
  dpi = 150,
): Promise<string | null> {
  const canvas = renderToCanvas(opts, dpi);
  const bytes = await canvasToPngBytes(canvas);
  return saveBinaryFileWithFallback(bytes, {
    defaultName: filename,
    filters: [{ name: "PNG Image", extensions: ["png"] }],
    browserTypes: [{ description: "PNG Image", accept: { "image/png": [".png"] } }],
    mimeType: "image/png",
  });
}

/**
 * Export the layout as a PDF file at the given DPI (default 150).
 *
 * Generates the PDF bytes with jsPDF and saves them through
 * {@link saveBinaryFileWithFallback}; `jsPDF.save()` does not work inside the
 * Tauri webview because it relies on an anchor download.
 *
 * @returns The saved file name, or null if the user cancelled the save dialog.
 */
export async function exportLayoutPdf(
  opts: LayoutOptions,
  filename: string,
  dpi = 150,
): Promise<string | null> {
  const { widthMm, heightMm } = pageDimensionsMm(
    opts.paperSize,
    opts.orientation,
  );
  const canvas = renderToCanvas(opts, dpi);
  // Pass the orientation explicitly: jsPDF normalizes the format array to match
  // the orientation (portrait forces width <= height), so an oriented format
  // alone would be rotated back to portrait.
  const pdf = new jsPDF({
    orientation: opts.orientation,
    unit: "mm",
    format: [widthMm, heightMm],
  });
  // Pass the canvas directly so jsPDF reads its pixels without an intermediate
  // base64 data URL (synchronous and ~33% larger in memory).
  pdf.addImage(canvas, "PNG", 0, 0, widthMm, heightMm, undefined, "FAST");
  const bytes = new Uint8Array(pdf.output("arraybuffer"));
  return saveBinaryFileWithFallback(bytes, {
    defaultName: filename,
    filters: [{ name: "PDF Document", extensions: ["pdf"] }],
    browserTypes: [
      { description: "PDF Document", accept: { "application/pdf": [".pdf"] } },
    ],
    mimeType: "application/pdf",
  });
}
