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
  viewportsByArea,
  type GeoPdfPage,
  type GeoPdfViewport,
  type UserToCrs,
} from "./georef";
import { isAffineInMercator, planMercatorWarp, warpCorners, warpToMercator } from "./warp";
import type { GeoPdfCrsConverters } from "./crs";
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

/** Raised when the frame cannot be rendered or placed on the map. */
export class GeoPdfRenderError extends Error {}

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
const WASM_URLS: Record<string, () => Promise<{ default: string }>> = {
  "openjpeg.wasm": () => import("pdfjs-dist/wasm/openjpeg.wasm?url"),
  "jbig2.wasm": () => import("pdfjs-dist/wasm/jbig2.wasm?url"),
  "qcms_bg.wasm": () => import("pdfjs-dist/wasm/qcms_bg.wasm?url"),
};

/**
 * The predefined CMaps (CJK character encodings) a PDF may name without
 * embedding, emitted as separate assets and fetched only when a PDF asks.
 */
const CMAP_URLS = import.meta.glob<string>("../../../../../node_modules/pdfjs-dist/cmaps/*.bcmap", {
  query: "?url",
  import: "default",
});

/** The glob keys' directory prefix: pdfjs-dist is hoisted to the repo root. */
const CMAP_DIR = "../../../../../node_modules/pdfjs-dist/cmaps/";

class BundledBinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    let url: string | undefined;
    if (kind === "wasmUrl") url = (await WASM_URLS[filename]?.())?.default;
    else if (kind === "cMapUrl") url = await CMAP_URLS[`${CMAP_DIR}${filename}`]?.();
    if (!url) throw new Error(`No bundled ${kind} data named ${filename}`);
    const response = await fetch(url);
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
  const loadingTask = pdfjs.getDocument({
    data: bytes.slice(),
    useWorkerFetch: false,
    // Fetched through the factory, which needs these set to ask for them.
    cMapUrl: "bundled/",
    cMapPacked: true,
    BinaryDataFactory: BundledBinaryDataFactory,
  });
  let pdf: PDFDocumentProxy;
  try {
    pdf = await loadingTask.promise;
  } catch (error) {
    // Release the worker pdf.js started before it rejected.
    await loadingTask.destroy().catch(() => undefined);
    throw error;
  }
  let config: OptionalContentConfig | null = null;
  const layers: GeoPdfLayer[] = [];
  try {
    config = await pdf.getOptionalContentConfig();
    for (const [id, group] of config) {
      layers.push({
        id: String(id),
        name: String(group?.name ?? id),
        // The iterator yields group objects; isVisible() wants a content
        // descriptor and calls these visible.
        visible: group?.visible !== false,
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
  if (!page || page.viewports.length === 0) {
    throw new GeoPdfNotGeoreferencedError("This page is not georeferenced");
  }
  const { default: proj4 } = await import("proj4");
  // The largest viewport whose CRS and control points work: an unusable map
  // frame falls back to a smaller usable one (an inset) rather than failing.
  let chosen: { vp: GeoPdfViewport; converters: GeoPdfCrsConverters; userToCrs: UserToCrs } | null =
    null;
  for (const vp of viewportsByArea(page)) {
    const converters = await geoPdfCrsConverters(vp.crs, resolveEpsg, proj4);
    const userToCrs = converters ? fitViewportTransform(vp, converters.latLonToCrs) : null;
    if (converters && userToCrs) {
      chosen = { vp, converters, userToCrs };
      break;
    }
  }
  if (!chosen) {
    throw new GeoPdfNotGeoreferencedError("The PDF's coordinate system is not supported");
  }
  const { vp, converters, userToCrs } = chosen;

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
  const offsetX = minX * scale;
  const offsetY = minY * scale;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const config = opened.config;
  if (config) {
    // preserveRB false: the form's checkboxes are independent, so ticking two
    // layers of one radio-button group keeps both rather than switching.
    for (const layer of opened.layers) {
      config.setVisibility(layer.id, !hiddenLayers.has(layer.id), false);
    }
  }
  const context = canvas.getContext("2d");
  if (!context) throw new GeoPdfRenderError("Could not create a canvas to render the PDF");
  try {
    await pdfPage.render({
      // pdf.js draws into an opaque (no-alpha) context of a canvas it is
      // given; handing it our own context keeps the transparent background.
      canvas: null,
      canvasContext: context,
      viewport,
      // Shift the frame's top-left corner to the canvas origin.
      transform: [1, 0, 0, 1, -offsetX, -offsetY],
      // Transparent outside what the PDF draws, so a single picked layer
      // overlays the map rather than hiding it under white paper.
      background: "rgba(0,0,0,0)",
      ...(config ? { optionalContentConfigPromise: Promise.resolve(config) } : {}),
    }).promise;
  } finally {
    pdfPage.cleanup();
  }

  // PDF user space <-> canvas pixels.
  const userToPixel = (u: number, v: number): [number, number] => {
    const [px, py] = viewport.convertToViewportPoint(u, v);
    return [px - offsetX, py - offsetY];
  };
  maskToNeatline(context, vp, userToPixel);

  // Each canvas pixel back to PDF user space, then through the fit.
  const rawLngLat = (px: number, py: number): [number, number] => {
    const [u, v] = viewport.convertToPdfPoint(px + offsetX, py + offsetY);
    const [x, y] = applyUserToCrs(userToCrs, u, v);
    return converters.crsToWgs84(x, y);
  };
  // Keep longitudes continuous across the frame: a sheet across the
  // antimeridian would otherwise jump from 179 to -179 and plan a world-wide
  // raster. Longitudes are taken within 180 degrees of the frame's centre.
  const centerLng = rawLngLat(width / 2, height / 2)[0];
  const toLngLat = (px: number, py: number): [number, number] => {
    const [lng, lat] = rawLngLat(px, py);
    return [lng + 360 * Math.round((centerLng - lng) / 360), lat];
  };

  let output: HTMLCanvasElement = canvas;
  let coordinates: RenderedGeoPdf["coordinates"];
  if (isAffineInMercator(width, height, toLngLat)) {
    coordinates = [
      toLngLat(0, 0),
      toLngLat(width, 0),
      toLngLat(width, height),
      toLngLat(0, height),
    ];
  } else {
    // The map would bend this frame between its corners: resample it into a
    // north-up Web Mercator raster instead.
    const inverse = invertAffine(userToCrs);
    let plan: ReturnType<typeof planMercatorWarp>;
    try {
      plan = planMercatorWarp(width, height, toLngLat, GEOPDF_MAX_SIDE);
    } catch (error) {
      throw new GeoPdfRenderError(error instanceof Error ? error.message : String(error));
    }
    const warped = warpToMercator(context.getImageData(0, 0, width, height), plan, (lng, lat) => {
      const [x, y] = converters.wgs84ToCrs(lng, lat);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !inverse) return null;
      return userToPixel(...applyUserToCrs(inverse, x, y));
    });
    output = document.createElement("canvas");
    output.width = warped.width;
    output.height = warped.height;
    output
      .getContext("2d")
      ?.putImageData(new ImageData(warped.data, warped.width, warped.height), 0, 0);
    canvas.width = canvas.height = 0;
    coordinates = warpCorners(plan);
  }
  const lngs = coordinates.map((c) => c[0]);
  const lats = coordinates.map((c) => c[1]);
  const url = await canvasDataUrl(output);
  const result = {
    url,
    width: output.width,
    height: output.height,
    coordinates,
    bounds: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)] as [
      number,
      number,
      number,
      number,
    ],
    crsLabel: converters.label,
  };
  output.width = output.height = 0;
  return result;
}

/**
 * Clear the pixels outside a viewport's neatline (`/Bounds`), so marks in the
 * corners of a non-rectangular map frame stay off the map. A neatline that is
 * the whole rectangle needs nothing.
 */
function maskToNeatline(
  context: CanvasRenderingContext2D,
  vp: GeoPdfViewport,
  userToPixel: (u: number, v: number) => [number, number],
): void {
  const { bounds } = vp;
  const isUnitSquare =
    bounds.length === 8 &&
    [0, 0, 0, 1, 1, 1, 1, 0].every((value, i) => Math.abs(bounds[i] - value) < 1e-6);
  const corners = new Set<string>();
  for (let i = 0; i + 1 < bounds.length; i += 2) corners.add(`${bounds[i]},${bounds[i + 1]}`);
  const fullSquare =
    isUnitSquare ||
    (corners.size === 4 && ["0,0", "0,1", "1,1", "1,0"].every((c) => corners.has(c)));
  if (fullSquare) return;
  const [x0, y0, x1, y1] = vp.bbox;
  context.save();
  context.globalCompositeOperation = "destination-in";
  context.beginPath();
  for (let i = 0; i + 1 < bounds.length; i += 2) {
    const [px, py] = userToPixel(x0 + bounds[i] * (x1 - x0), y0 + bounds[i + 1] * (y1 - y0));
    if (i === 0) context.moveTo(px, py);
    else context.lineTo(px, py);
  }
  context.closePath();
  context.fillStyle = "#000";
  context.fill();
  context.restore();
}

/** The inverse of a user-space transform, or null when it is singular. */
function invertAffine(t: UserToCrs): UserToCrs | null {
  const [a, b, c, d, e, f] = t;
  const det = b * f - c * e;
  if (!Number.isFinite(det) || det === 0) return null;
  return [(c * d - a * f) / det, f / det, -c / det, (a * e - b * d) / det, -e / det, b / det];
}

/**
 * Encode a canvas as a data URL (WebP where the browser encodes it, else PNG)
 * without blocking the main thread on the encode, as `toDataURL` would. The
 * data URL is what an image layer persists in the project.
 */
async function canvasDataUrl(canvas: HTMLCanvasElement): Promise<string> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp", 0.92),
  );
  if (!blob) return canvas.toDataURL("image/png");
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not encode the image"));
    reader.readAsDataURL(blob);
  });
}
