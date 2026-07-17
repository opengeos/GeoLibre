/**
 * Print layout capture, legend building, and export (PNG / PDF).
 *
 * {@link buildLegend} is a pure transform from layers to legend entries and is
 * unit tested. {@link captureMapImage} reads the live map's canvases, and the
 * export helpers rasterize {@link drawLayout} at print resolution.
 */
import { zipSync } from "fflate";
import jsPDF from "jspdf";
import { isFullViewportMapCanvas } from "./print-capture";
import {
  drawLayout,
  pageMm,
  pagePx,
  resolvePageSize,
  type LayoutOptions,
} from "./print-layout";
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

interface MapLike {
  getCanvas(): HTMLCanvasElement;
  getContainer(): HTMLElement;
  getBearing(): number;
  unproject(point: [number, number]): { lng: number; lat: number };
  project(lngLat: [number, number]): { x: number; y: number };
  /** Force a synchronous redraw so the preserved drawing buffer is current. */
  redraw?(): void;
}

/**
 * A geographic crop box as `[west, south, east, north]`. Aliased to
 * {@link PrintExtent} (the draw tool's type) so the two stay a single concept.
 */
export type CaptureClip = PrintExtent;

/** Axis-aligned bounding rect (in CSS pixels) of a geographic extent's four
 * projected corners. A north-up box maps to an exact rect; a rotated box maps
 * to its bounding rectangle. */
function projectClipRectCss(
  map: Pick<MapLike, "project">,
  clip: CaptureClip,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const [w, s, e, n] = clip;
  const corners: [number, number][] = [
    [w, n],
    [e, n],
    [e, s],
    [w, s],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const corner of corners) {
    const p = map.project(corner);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Crop a composited capture to the CSS-pixel rectangle of a geographic extent.
 * Returns `null` when the projected rect is degenerate or falls entirely
 * outside the viewport, so the caller can fail rather than silently export the
 * full viewport at a scale measured for the (off-screen) clip centre.
 */
function cropCaptureToClip(
  source: HTMLCanvasElement,
  rectCss: { minX: number; minY: number; maxX: number; maxY: number },
  dpr: number,
): HTMLCanvasElement | null {
  // CSS px -> device px, clamped to the captured buffer.
  const x0 = Math.max(0, Math.floor(rectCss.minX * dpr));
  const y0 = Math.max(0, Math.floor(rectCss.minY * dpr));
  const x1 = Math.min(source.width, Math.ceil(rectCss.maxX * dpr));
  const y1 = Math.min(source.height, Math.ceil(rectCss.maxY * dpr));
  const cw = x1 - x0;
  const ch = y1 - y0;
  if (cw < 1 || ch < 1) return null;
  const cropped = document.createElement("canvas");
  cropped.width = cw;
  cropped.height = ch;
  const cctx = cropped.getContext("2d");
  if (!cctx) return null;
  cctx.drawImage(source, x0, y0, cw, ch, 0, 0, cw, ch);
  return cropped;
}

/**
 * Capture the current map view as a single composited canvas. All `<canvas>`
 * elements inside the map container (the MapLibre base canvas plus any deck.gl
 * overlay) are drawn in DOM order so the snapshot matches what is on screen.
 *
 * @param map - The MapLibre map instance.
 * @param clip - Optional geographic extent to crop the snapshot to (GH #523);
 *   when omitted the full viewport is captured.
 * @returns The composited image plus the ground scale and bearing needed to
 *   render a scale bar and north arrow.
 */
export function captureMapImage(map: MapLike, clip?: CaptureClip | null): CapturedMap {
  // Force a synchronous render first. MapLibre only paints on demand, so when
  // the Print Layout modal opens without any recent camera movement the
  // preserved drawing buffer can be stale or cleared -- which surfaced as a
  // blank map (only the cartographic furniture rendered). redraw() guarantees
  // the latest frame, including all active layers, is in the buffer we read.
  try {
    map.redraw?.();
  } catch {
    // A redraw failure (e.g. a transient GL state issue) must not block the
    // capture; fall through and read whatever is in the buffer.
  }
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
    // Skip the decorative effects overlay (the effects plugin's space /
    // starfield / atmosphere canvases). They are full-viewport but sit *behind*
    // the map by z-index, so compositing them in DOM order would draw them over
    // the map and blank it out -- which is exactly what happened to the globe
    // in the print preview. They are a screen aesthetic, not map content.
    if (c.classList.contains("geolibre-effects-canvas")) return;
    // Composite only the full-viewport render surfaces (the MapLibre base
    // canvas and any deck.gl overlay). Map controls also add canvases to the
    // container -- the raster colorbar/colormap previews, the lidar profile
    // chart -- and stretching one of those over the page would overwrite the
    // map with, for example, a horizontal colormap ramp.
    if (!isFullViewportMapCanvas(c, base)) return;
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
  const dpr = cssWidth > 0 ? out.width / cssWidth : 1;

  // Measure the ground resolution at the centre of the region that will end up
  // in the output. When cropping, that is the clip rect *clamped to the
  // viewport* (the exported image is the visible part), not the full geographic
  // extent: sampling at the full-extent centre would misreport the scale for an
  // extent that is off-centre or partially off-screen. Otherwise use the
  // viewport centre.
  const rectCss = clip ? projectClipRectCss(map, clip) : null;
  let centerX = cssWidth / 2;
  let centerY = cssHeight / 2;
  if (rectCss) {
    // For a clip partially panned off-screen, this clamped centre lands toward
    // the viewport edge rather than the drawn extent's true centre, so the
    // reported scale can be marginally off (it varies only with latitude in Web
    // Mercator, so the error is small). Acceptable for this preview/export use.
    centerX = (Math.max(0, rectCss.minX) + Math.min(cssWidth, rectCss.maxX)) / 2;
    centerY = (Math.max(0, rectCss.minY) + Math.min(cssHeight, rectCss.maxY)) / 2;
  }
  const span = Math.min(100, cssWidth / 2);
  const left = map.unproject([centerX - span / 2, centerY]);
  const right = map.unproject([centerX + span / 2, centerY]);
  const metersPerCssPx = haversineMeters(left, right) / span;
  const metersPerPixel = dpr > 0 ? metersPerCssPx / dpr : metersPerCssPx;

  // Cropping changes the image dimensions but not the per-device-pixel ground
  // resolution, so metersPerPixel carries through unchanged. A null crop means
  // the extent is entirely off-screen: throw so the dialog reports a capture
  // error instead of silently exporting the wrong (full-viewport) area.
  let image = out;
  if (rectCss) {
    const cropped = cropCaptureToClip(out, rectCss, dpr);
    if (!cropped) {
      // null = the extent is off-screen, or a 2D context could not be acquired.
      throw new Error(
        "Could not crop to the print extent (it may be outside the map view, or a canvas context was unavailable)",
      );
    }
    image = cropped;
  }

  return {
    image,
    width: image.width,
    height: image.height,
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
export async function copyLayoutToClipboard(
  opts: LayoutOptions,
  dpi = 150,
): Promise<void> {
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
    browserTypes: [
      { description: "PDF Document", accept: { "application/pdf": [".pdf"] } },
    ],
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
    browserTypes: [
      { description: "PDF Document", accept: { "application/pdf": [".pdf"] } },
    ],
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
    name.normalize("NFC").replace(/[ .]+$/g, "").toLowerCase();
  for (let i = 0; i < total; i++) {
    onProgress?.(i + 1, total);
    const opts = await optionsForPage(i);
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
    browserTypes: [
      { description: "ZIP Archive", accept: { "application/zip": [".zip"] } },
    ],
    mimeType: "application/zip",
  });
}
