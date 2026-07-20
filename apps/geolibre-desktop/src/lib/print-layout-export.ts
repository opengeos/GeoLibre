/**
 * Print layout capture, legend building, and export (PNG / PDF).
 *
 * {@link buildLegend} is a pure transform from layers to legend entries and is
 * unit tested. {@link captureMapImage} reads the live map's canvases, and the
 * export helpers rasterize {@link drawLayout} at print resolution.
 */
import { zipSync } from "fflate";
import jsPDF from "jspdf";
import { drawLayout, pageMm, pagePx, resolvePageSize, type LayoutOptions } from "./print-layout";
import type { MapEngineClient } from "@geolibre/map";
import type { PrintExtent } from "./print-extent";
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

/**
 * A geographic crop box as \`[west, south, east, north]\`.
 */
export type CaptureClip = PrintExtent;

/** Capture a composited map snapshot through the engine viewport port. */
export async function captureMapImage(
  client: MapEngineClient,
  clip?: CaptureClip | null,
): Promise<CapturedMap> {
  const result = await client.viewport.capture({
    ...(clip ? { bounds: clip } : {}),
    hideOverlayIds: ["print-extent"],
  });
  return {
    image: result.canvas,
    width: result.width,
    height: result.height,
    metersPerPixel: result.metersPerPixel,
    bearingDeg: result.bearing,
  };
}

/**
 * Rasterize a layout to an offscreen canvas. Millimetre paper sizes render at
 * the given DPI; pixel/screen sizes render at their exact pixel dimensions.
 */
function renderToCanvas(opts: LayoutOptions, dpi: number): HTMLCanvasElement {
  const size = resolvePageSize(opts);
  const { width, height } = pagePx(size, dpi);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
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
 * Render the layout and copy it to the system clipboard as a PNG image
 * (GH #773), so users can paste it straight into a document without saving a
 * file first.
 *
 * Uses the async Clipboard API (`navigator.clipboard.write`) with a
 * `ClipboardItem`. The PNG blob is supplied as a promise so the write is
 * initiated synchronously inside the originating user gesture, which Safari
 * requires; Chromium-based browsers and Tauri webviews accept it too.
 *
 * @throws If the Clipboard image API is unavailable (e.g. an insecure context
 *   or an older browser) or the browser denies the write, so the dialog can
 *   surface an error instead of silently doing nothing.
 */
export async function copyLayoutToClipboard(opts: LayoutOptions, dpi = 150): Promise<void> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    throw new Error("Clipboard image copy is not supported in this browser");
  }
  // Build the PNG blob inside a promise handed to ClipboardItem so the
  // clipboard write stays within the user gesture (required by Safari).
  const blob = (async () => {
    const canvas = renderToCanvas(opts, dpi);
    const png = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/png"),
    );
    if (!png) throw new Error("Failed to render PNG for the clipboard");
    return png;
  })();
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
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
  const size = resolvePageSize(opts);
  const { widthMm, heightMm } = pageMm(size);
  const canvas = renderToCanvas(opts, dpi);
  // Derive the orientation from the resolved dimensions rather than opts: custom
  // sizes ignore the orientation toggle, and pixel presets are stored portrait-
  // first, so the toggle alone can disagree with the actual page shape. jsPDF
  // normalizes the format array to match the orientation (portrait forces
  // width <= height), so the two must be consistent or the page gets rotated.
  const pdf = new jsPDF({
    orientation: widthMm >= heightMm ? "landscape" : "portrait",
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
    browserTypes: [{ description: "PDF Document", accept: { "application/pdf": [".pdf"] } }],
    mimeType: "application/pdf",
  });
}

/**
 * Per-page hooks for an atlas export (GH #1291). The dialog owns the map
 * driving (fit the coverage feature, wait for tiles, capture) and the token
 * substitution, so the export loop here stays a pure page iterator.
 */
export interface AtlasExportSource {
  /** Number of pages to export; must be at least 1. */
  total: number;
  /**
   * Produce the fully-resolved layout options for one page (0-based). Called
   * sequentially, one page at a time, so implementations may drive the live
   * map between calls.
   */
  optionsForPage: (pageIndex: number) => Promise<LayoutOptions>;
  /** Progress callback fired before each page renders (1-based `current`). */
  onProgress?: (current: number, total: number) => void;
}

/**
 * Export an atlas as one multi-page PDF: every coverage feature becomes a page
 * rendered through the same layout pipeline as the single-page export.
 *
 * @returns The saved file name, or null if the user cancelled the save dialog.
 */
export async function exportAtlasPdf(
  source: AtlasExportSource,
  filename: string,
  dpi = 150,
): Promise<string | null> {
  const { total, optionsForPage, onProgress } = source;
  if (total < 1) throw new Error("Atlas export needs at least one page");
  let pdf: jsPDF | null = null;
  for (let i = 0; i < total; i++) {
    onProgress?.(i + 1, total);
    const opts = await optionsForPage(i);
    const size = resolvePageSize(opts);
    const { widthMm, heightMm } = pageMm(size);
    const orientation = widthMm >= heightMm ? "landscape" : "portrait";
    const canvas = renderToCanvas(opts, dpi);
    if (!pdf) {
      pdf = new jsPDF({ orientation, unit: "mm", format: [widthMm, heightMm] });
    } else {
      // The page size is fixed while the dialog iterates, but pass it per page
      // anyway so a mid-export change can never mis-scale the remaining pages.
      pdf.addPage([widthMm, heightMm], orientation);
    }
    pdf.addImage(canvas, "PNG", 0, 0, widthMm, heightMm, undefined, "FAST");
  }
  const bytes = new Uint8Array((pdf as jsPDF).output("arraybuffer"));
  return saveBinaryFileWithFallback(bytes, {
    defaultName: filename,
    filters: [{ name: "PDF Document", extensions: ["pdf"] }],
    browserTypes: [{ description: "PDF Document", accept: { "application/pdf": [".pdf"] } }],
    mimeType: "application/pdf",
  });
}

/**
 * Export an atlas as a zip of per-page PNGs (one entry per coverage feature).
 * Entry names come from `entryName` (already token-substituted and sanitized
 * by the dialog); collisions are disambiguated with a `-2`, `-3`, ... suffix
 * so no page silently overwrites another.
 *
 * @returns The saved file name, or null if the user cancelled the save dialog.
 */
export async function exportAtlasPngZip(
  source: AtlasExportSource,
  entryName: (pageIndex: number) => string,
  filename: string,
  dpi = 150,
): Promise<string | null> {
  const { total, optionsForPage, onProgress } = source;
  if (total < 1) throw new Error("Atlas export needs at least one page");
  const files: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  // Compare names the way common filesystems do on extraction (Windows/macOS
  // are case-insensitive and drop trailing dots/spaces), so "CA" and "Ca"
  // pages cannot silently overwrite each other when the zip is unpacked.
  const collisionKey = (name: string) =>
    name
      .normalize("NFC")
      .replace(/[ .]+$/g, "")
      .toLowerCase();
  for (let i = 0; i < total; i++) {
    onProgress?.(i + 1, total);
    const opts = await source.optionsForPage(i);
    const canvas = renderToCanvas(opts, dpi);
    const bytes = await canvasToPngBytes(canvas);
    const base = entryName(i) || String(i + 1);
    let name = base;
    for (let suffix = 2; used.has(collisionKey(name)); suffix++) {
      name = `${base}-${suffix}`;
    }
    used.add(collisionKey(name));
    files[`${name}.png`] = bytes;
  }
  // PNG payloads are already compressed; store them instead of re-deflating.
  const zipped = zipSync(files, { level: 0 });
  return saveBinaryFileWithFallback(zipped, {
    defaultName: filename,
    filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
    browserTypes: [{ description: "ZIP Archive", accept: { "application/zip": [".zip"] } }],
    mimeType: "application/zip",
  });
}
