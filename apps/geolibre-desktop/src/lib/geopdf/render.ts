/**
 * Render a GeoPDF page's map frame into a georeferenced image layer (GH #3523).
 *
 * pdf.js draws the pixels (with the chosen PDF layers, its "optional content",
 * switched on or off); {@link readGeoPdfPages} supplies the georeference. The
 * frame is cropped out of the page, so the title, legend and margins of a map
 * sheet stay off the map, and its four corners are placed through the fitted
 * transform. pdf.js (~1.7 MB with its worker) loads on first use.
 */
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  applyUserToCrs,
  fitViewportTransform,
  primaryViewport,
  readGeoPdfPages,
  type GeoPdfPage,
} from "./georef";
import { geoPdfCrsConverters } from "./crs";

type OptionalContentConfig = Awaited<ReturnType<PDFDocumentProxy["getOptionalContentConfig"]>>;

/** A layer (optional content group) of the PDF. */
export interface GeoPdfLayer {
  id: string;
  name: string;
  /** Whether the PDF shows it when opened. */
  visible: boolean;
}

/** An opened GeoPDF, ready to render. */
export interface OpenedGeoPdf {
  pages: GeoPdfPage[];
  layers: GeoPdfLayer[];
  /** Index of the first georeferenced page, or -1 when none is. */
  firstGeoreferencedPage: number;
  /** Release pdf.js's worker and memory. */
  destroy: () => Promise<void>;
  /** @internal */
  pdf: PDFDocumentProxy;
  /** @internal */
  config: OptionalContentConfig | null;
}

/** A rendered map frame, placed by its corners. */
export interface RenderedGeoPdf {
  /** The image as a data URL (WebP where the browser encodes it, else PNG). */
  url: string;
  width: number;
  height: number;
  /** `[lng, lat]` of the image's top-left, top-right, bottom-right, bottom-left corners. */
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
  bounds: [number, number, number, number];
  /** The CRS the PDF is georeferenced in, e.g. "EPSG:32617". */
  crsLabel: string;
}

/** Raised when the page has no georeference GeoLibre can place. */
export class GeoPdfNotGeoreferencedError extends Error {}

/** The longest side, in pixels, a frame is rendered at. */
export const GEOPDF_MAX_SIDE = 4096;

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

/** Load pdf.js once, pointing it at its bundled worker. */
function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  pdfjsPromise ??= (async () => {
    const [pdfjs, worker] = await Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  })().catch((error) => {
    pdfjsPromise = null;
    throw error;
  });
  return pdfjsPromise;
}

/**
 * Serves pdf.js's wasm decoders (JPEG 2000, JBIG2, colour profiles) from the
 * app's own assets. pdf.js asks for them by file name from a directory, which
 * hashed build assets do not have, so each name maps to its bundled URL.
 */
class BundledBinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    if (kind !== "wasmUrl") throw new Error(`No bundled ${kind} data for ${filename}`);
    const loaders: Record<string, () => Promise<{ default: string }>> = {
      "openjpeg.wasm": () => import("pdfjs-dist/wasm/openjpeg.wasm?url"),
      "jbig2.wasm": () => import("pdfjs-dist/wasm/jbig2.wasm?url"),
      "qcms_bg.wasm": () => import("pdfjs-dist/wasm/qcms_bg.wasm?url"),
    };
    const load = loaders[filename];
    if (!load) throw new Error(`No bundled wasm named ${filename}`);
    const response = await fetch((await load()).default);
    if (!response.ok) throw new Error(`Could not load ${filename} (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

/**
 * Open a GeoPDF: read its georeference and its layers.
 *
 * Args:
 *   bytes: The PDF file.
 *
 * Returns:
 *   The opened document. Call `destroy` when done with it.
 *
 * Raises:
 *   PdfReadError: When the file structure cannot be read.
 *   GeoPdfNotGeoreferencedError: When no page is georeferenced.
 */
export async function openGeoPdf(bytes: Uint8Array): Promise<OpenedGeoPdf> {
  const pages = readGeoPdfPages(bytes);
  const firstGeoreferencedPage = pages.findIndex((page) => primaryViewport(page) !== null);
  if (firstGeoreferencedPage < 0)
    throw new GeoPdfNotGeoreferencedError("The PDF is not georeferenced");
  const pdfjs = await loadPdfjs();
  // pdf.js transfers the buffer to its worker, so hand it a copy.
  const pdf = await pdfjs.getDocument({
    data: bytes.slice(),
    useWorkerFetch: false,
    BinaryDataFactory: BundledBinaryDataFactory,
  }).promise;
  let config: OptionalContentConfig | null = null;
  const layers: GeoPdfLayer[] = [];
  try {
    config = await pdf.getOptionalContentConfig();
    for (const [id, group] of config) {
      layers.push({
        id: String(id),
        name: String(group?.name ?? id),
        visible: config.isVisible(group),
      });
    }
    const order = flattenOrder(config.getOrder());
    if (order.length) {
      const rank = new Map(order.map((id, i) => [id, i]));
      layers.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
    }
  } catch {
    config = null;
  }
  return {
    pages,
    layers,
    firstGeoreferencedPage,
    pdf,
    config,
    destroy: () => pdf.loadingTask.destroy(),
  };
}

/** The group ids of an optional-content `/Order` tree, in display order. */
function flattenOrder(order: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object" && "order" in node)
      walk((node as { order: unknown }).order);
    else if (typeof node === "string") out.push(node);
  };
  walk(order);
  return out;
}

/**
 * Render a page's map frame with the given layers hidden.
 *
 * Args:
 *   opened: The opened GeoPDF.
 *   pageIndex: Zero-based page index.
 *   hiddenLayers: Ids of the PDF layers to switch off.
 *   resolveEpsg: Resolves an EPSG code to a PROJ definition, or null.
 *
 * Returns:
 *   The rendered frame and its corners.
 *
 * Raises:
 *   GeoPdfNotGeoreferencedError: When the page is not georeferenced or its CRS
 *     cannot be resolved.
 */
export async function renderGeoPdfPage(
  opened: OpenedGeoPdf,
  pageIndex: number,
  hiddenLayers: ReadonlySet<string>,
  resolveEpsg: (code: number) => Promise<string | null>,
): Promise<RenderedGeoPdf> {
  const page = opened.pages[pageIndex];
  const vp = page ? primaryViewport(page) : null;
  if (!vp) throw new GeoPdfNotGeoreferencedError("This page is not georeferenced");
  const { default: proj4 } = await import("proj4");
  const converters = await geoPdfCrsConverters(vp.crs, resolveEpsg, proj4);
  if (!converters)
    throw new GeoPdfNotGeoreferencedError("The PDF's coordinate system is not supported");
  const userToCrs = fitViewportTransform(vp, converters.latLonToCrs);
  if (!userToCrs) throw new GeoPdfNotGeoreferencedError("The PDF's georeference is degenerate");

  const pdfPage = await opened.pdf.getPage(pageIndex + 1);
  // The frame's rectangle on the rendered (rotated, y-down) page at scale 1.
  const base = pdfPage.getViewport({ scale: 1 });
  const [x0, y0, x1, y1] = vp.bbox;
  const corners = [
    base.convertToViewportPoint(x0, y0),
    base.convertToViewportPoint(x1, y0),
    base.convertToViewportPoint(x1, y1),
    base.convertToViewportPoint(x0, y1),
  ];
  const minX = Math.min(...corners.map((p) => p[0]));
  const maxX = Math.max(...corners.map((p) => p[0]));
  const minY = Math.min(...corners.map((p) => p[1]));
  const maxY = Math.max(...corners.map((p) => p[1]));
  const scale = GEOPDF_MAX_SIDE / Math.max(maxX - minX, maxY - minY, 1);
  const viewport = pdfPage.getViewport({ scale });
  const width = Math.max(1, Math.round((maxX - minX) * scale));
  const height = Math.max(1, Math.round((maxY - minY) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const config = opened.config;
  if (config) {
    for (const layer of opened.layers) config.setVisibility(layer.id, !hiddenLayers.has(layer.id));
  }
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create a canvas to render the PDF");
  await pdfPage.render({
    // pdf.js draws into an opaque (no-alpha) context of a canvas it is given;
    // handing it our own context keeps the transparent background below.
    canvas: null,
    canvasContext: context,
    viewport,
    // Shift the frame's top-left corner to the canvas origin.
    transform: [1, 0, 0, 1, -minX * scale, -minY * scale],
    // Transparent outside what the PDF draws, so a single picked layer
    // overlays the map rather than hiding it under white paper.
    background: "rgba(0,0,0,0)",
    ...(config ? { optionalContentConfigPromise: Promise.resolve(config) } : {}),
  }).promise;
  pdfPage.cleanup();

  // Each canvas corner back to PDF user space, then through the fit.
  const toLngLat = (px: number, py: number): [number, number] => {
    const [u, v] = viewport.convertToPdfPoint(px + minX * scale, py + minY * scale);
    const [x, y] = applyUserToCrs(userToCrs, u, v);
    return converters.crsToWgs84(x, y);
  };
  const coordinates: RenderedGeoPdf["coordinates"] = [
    toLngLat(0, 0),
    toLngLat(width, 0),
    toLngLat(width, height),
    toLngLat(0, height),
  ];
  const lngs = coordinates.map((c) => c[0]);
  const lats = coordinates.map((c) => c[1]);
  const url = canvas.toDataURL("image/webp", 0.92);
  canvas.width = canvas.height = 0;
  return {
    url,
    width,
    height,
    coordinates,
    bounds: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)],
    crsLabel: converters.label,
  };
}
