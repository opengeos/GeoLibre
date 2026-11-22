/**
 * Reading the georeference of a GeoPDF (GH #3523).
 *
 * The ISO 32000 geospatial extension (written by GDAL, QGIS, ArcGIS, Avenza
 * and GeoLibre's own Print Layout) puts a `/VP` array of viewports in the page
 * dictionary. A viewport's `/Measure` dictionary of subtype `/GEO` pairs points
 * in the unit square of the viewport's `/BBox` (`/LPTS`) with their latitude
 * and longitude (`/GPTS`) on the datum of the CRS named in `/GCS`. Fitting an
 * affine transform to those pairs in the CRS's projected space recovers the
 * map frame's georeference exactly.
 *
 * Kept free of pdf.js and of the DOM, so it is unit tested under node.
 */
import { nameOf, numberArray, PdfDocument, type PdfDict } from "./pdf-objects";

/** The CRS a GeoPDF viewport is georeferenced in, as written in `/GCS`. */
export interface GeoPdfCrs {
  /** `/Type /GEOGCS` (degrees) rather than `/PROJCS`. */
  geographic: boolean;
  epsg: number | null;
  wkt: string | null;
}

/** One georeferenced viewport of a page. */
export interface GeoPdfViewport {
  /** Viewport name (`/Name`), when given. */
  name: string | null;
  /**
   * The viewport rectangle in PDF user space, `[x0, y0, x1, y1]`, normalized
   * so `x0 <= x1` and `y0 <= y1` whatever corner order the PDF wrote.
   */
  bbox: [number, number, number, number];
  /**
   * Unit-square points of {@link bbox} paired with {@link gpts}, as
   * `[x, y, x, y, ...]`, measured from its `(x0, y0)` corner.
   */
  lpts: number[];
  /** Latitude/longitude pairs on the CRS's datum, as `[lat, lon, lat, lon, ...]`. */
  gpts: number[];
  /**
   * The neatline: the georeferenced area as a polygon in the unit square of
   * {@link bbox}, `[x, y, x, y, ...]`, measured like {@link lpts}. The whole
   * square when the PDF gives none.
   */
  bounds: number[];
  crs: GeoPdfCrs;
}

/** A page and its georeferenced viewports. */
export interface GeoPdfPage {
  /** Zero-based page index. */
  index: number;
  viewports: GeoPdfViewport[];
}

/** An affine map from PDF user space to CRS coordinates: `x = a + b*u + c*v`, `y = d + e*u + f*v`. */
export type UserToCrs = readonly [number, number, number, number, number, number];

/**
 * Read every page's georeferenced viewports.
 *
 * Args:
 *   bytes: The PDF file.
 *
 * Returns:
 *   One entry per page, in order. A page without a usable `/GEO` viewport has
 *   an empty `viewports` list.
 *
 * Raises:
 *   PdfReadError: When the file is not a PDF this reader can interpret.
 */
export function readGeoPdfPages(bytes: Uint8Array): GeoPdfPage[] {
  const doc = new PdfDocument(bytes);
  return doc.pages().map((page, index) => ({ index, viewports: readViewports(doc, page) }));
}

function readViewports(doc: PdfDocument, page: PdfDict): GeoPdfViewport[] {
  const list = doc.resolve(page.get("VP"));
  if (!Array.isArray(list)) return [];
  const out: GeoPdfViewport[] = [];
  for (const item of list) {
    const vp = doc.dict(item);
    if (!vp) continue;
    const measure = doc.dict(vp.get("Measure"));
    if (!measure || nameOf(doc.resolve(measure.get("Subtype"))) !== "GEO") continue;
    const bbox = numberArray(doc, vp.get("BBox"));
    // /Bounds (default: the unit square) is the neatline polygon, not a list
    // of control points, so a viewport without /LPTS is skipped rather than
    // guessing which points /GPTS pairs with. GDAL, Adobe and Avenza write it.
    const bounds = numberArray(doc, measure.get("Bounds")) ?? [0, 0, 0, 1, 1, 1, 1, 0];
    const lpts = numberArray(doc, measure.get("LPTS"));
    const gpts = numberArray(doc, measure.get("GPTS"));
    const gcs = doc.dict(measure.get("GCS"));
    if (!bbox || bbox.length !== 4 || !lpts || !gpts || !gcs) continue;
    if (lpts.length !== gpts.length || gpts.length < 6 || gpts.length % 2) continue;
    const epsgValue = doc.resolve(gcs.get("EPSG"));
    const wkt = doc.resolve(gcs.get("WKT"));
    const epsg =
      typeof epsgValue === "number" && Number.isInteger(epsgValue) && epsgValue > 0
        ? epsgValue
        : typeof wkt === "string"
          ? wktEpsg(wkt)
          : null;
    const name = doc.resolve(vp.get("Name"));
    // /LPTS and /Bounds are fractions of the BBox measured from its first
    // corner towards its second, as GDAL reads them. Writers disagree on the
    // corner order (Global Mapper writes the top edge first), so flip each
    // axis written high-to-low into the normalized box rather than mirroring
    // the map.
    const flipU = bbox[0] > bbox[2];
    const flipV = bbox[1] > bbox[3];
    const toNormalized = (points: number[]) =>
      points.map((value, i) => ((i % 2 === 0 ? flipU : flipV) ? 1 - value : value));
    out.push({
      name: typeof name === "string" ? name : null,
      bbox: [
        Math.min(bbox[0], bbox[2]),
        Math.min(bbox[1], bbox[3]),
        Math.max(bbox[0], bbox[2]),
        Math.max(bbox[1], bbox[3]),
      ],
      lpts: toNormalized(lpts),
      gpts,
      bounds: toNormalized(
        bounds.length >= 6 && bounds.length % 2 === 0 ? bounds : [0, 0, 0, 1, 1, 1, 1, 0],
      ),
      crs: {
        geographic: nameOf(doc.resolve(gcs.get("Type"))) === "GEOGCS",
        epsg,
        wkt: typeof wkt === "string" && wkt.trim() ? wkt.trim() : null,
      },
    });
  }
  return out;
}

/**
 * The EPSG code a WKT names for the whole CRS: an `AUTHORITY["EPSG", N]`
 * (WKT 1) or `ID["EPSG", N]` (WKT 2) that is a direct child of the outermost
 * object. Authorities nested deeper (the datum's, a unit's) are ignored, and
 * brackets inside quoted names do not count.
 *
 * Args:
 *   wkt: The WKT.
 *
 * Returns:
 *   The code, or null when the root carries none.
 */
export function wktEpsg(wkt: string): number | null {
  let depth = 0;
  let inQuote = false;
  let tokenStart = -1;
  for (let i = 0; i < wkt.length; i++) {
    const ch = wkt[i];
    if (inQuote) {
      // WKT escapes a quote inside a name by doubling it.
      if (ch === '"') {
        if (wkt[i + 1] === '"') i++;
        else inQuote = false;
      }
      continue;
    }
    if (ch === '"') {
      inQuote = true;
    } else if (ch === "[" || ch === "(") {
      if (depth === 1 && tokenStart >= 0) {
        const keyword = wkt.slice(tokenStart, i).trim().toUpperCase();
        if (keyword === "AUTHORITY" || keyword === "ID") {
          const match = /^\s*"EPSG"\s*,\s*"?(\d+)"?/i.exec(wkt.slice(i + 1));
          if (match) return Number(match[1]);
        }
      }
      depth++;
      tokenStart = -1;
    } else if (ch === "]" || ch === ")") {
      depth--;
      tokenStart = -1;
    } else if (ch === ",") {
      tokenStart = -1;
    } else if (tokenStart < 0 && /[A-Za-z_]/.test(ch)) {
      tokenStart = i;
    }
  }
  return null;
}

/**
 * A page's georeferenced viewports, largest first (a map sheet can carry a
 * small inset or locator map too). The renderer takes the first one whose
 * CRS and control points it can use.
 *
 * Args:
 *   page: The page.
 *
 * Returns:
 *   The viewports in descending area.
 */
export function viewportsByArea(page: GeoPdfPage): GeoPdfViewport[] {
  const area = (vp: GeoPdfViewport) => (vp.bbox[2] - vp.bbox[0]) * (vp.bbox[3] - vp.bbox[1]);
  return [...page.viewports].sort((a, b) => area(b) - area(a));
}

/**
 * The page's map viewport: the largest georeferenced one (a map sheet can
 * carry a small inset or locator map too).
 *
 * Args:
 *   page: The page.
 *
 * Returns:
 *   The viewport, or null when the page is not georeferenced.
 */
export function primaryViewport(page: GeoPdfPage): GeoPdfViewport | null {
  let best: GeoPdfViewport | null = null;
  let bestArea = 0;
  for (const vp of page.viewports) {
    const area = (vp.bbox[2] - vp.bbox[0]) * (vp.bbox[3] - vp.bbox[1]);
    if (area > bestArea) {
      best = vp;
      bestArea = area;
    }
  }
  return best;
}

/**
 * Fit the affine transform from PDF user space to the viewport CRS's
 * coordinates, by least squares over every LPTS/GPTS pair.
 *
 * Args:
 *   vp: The viewport.
 *   latLonToCrs: A GPTS latitude/longitude (on the CRS's datum) to CRS
 *     coordinates; the identity (as `[lon, lat]`) for a geographic CRS.
 *
 * Returns:
 *   The transform, or null when the points are degenerate (collinear).
 */
export function fitViewportTransform(
  vp: GeoPdfViewport,
  latLonToCrs: (lat: number, lon: number) => [number, number],
): UserToCrs | null {
  const [x0, y0, x1, y1] = vp.bbox;
  const width = x1 - x0;
  const height = y1 - y0;
  if (!(width > 0) || !(height > 0)) return null;
  // Fit in the viewport's unit square, where the points are O(1) wherever the
  // frame sits on the page, then fold the bbox scale and offset back in: the
  // singularity test would otherwise grow with the page offset.
  const rows: { u: number; v: number; x: number; y: number }[] = [];
  for (let i = 0; i + 1 < vp.lpts.length; i += 2) {
    const [x, y] = latLonToCrs(vp.gpts[i], vp.gpts[i + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    rows.push({ u: vp.lpts[i], v: vp.lpts[i + 1], x, y });
  }
  if (rows.length < 3) return null;
  // Centre the CRS values too, so large eastings keep their precision.
  const cx = rows.reduce((sum, r) => sum + r.x, 0) / rows.length;
  const cy = rows.reduce((sum, r) => sum + r.y, 0) / rows.length;
  let n = 0;
  let su = 0;
  let sv = 0;
  let suu = 0;
  let svv = 0;
  let suv = 0;
  let sx = 0;
  let sux = 0;
  let svx = 0;
  let sy = 0;
  let suy = 0;
  let svy = 0;
  for (const { u, v, x: rawX, y: rawY } of rows) {
    const x = rawX - cx;
    const y = rawY - cy;
    n++;
    su += u;
    sv += v;
    suu += u * u;
    svv += v * v;
    suv += u * v;
    sx += x;
    sux += u * x;
    svx += v * x;
    sy += y;
    suy += u * y;
    svy += v * y;
  }
  const m = [
    [n, su, sv],
    [su, suu, suv],
    [sv, suv, svv],
  ];
  const a = solve3(m, [sx, sux, svx]);
  const d = solve3(m, [sy, suy, svy]);
  if (!a || !d) return null;
  // x = cx + a0 + a1*(u - x0)/W + a2*(v - y0)/H, and likewise for y.
  return [
    cx + a[0] - (a[1] * x0) / width - (a[2] * y0) / height,
    a[1] / width,
    a[2] / height,
    cy + d[0] - (d[1] * x0) / width - (d[2] * y0) / height,
    d[1] / width,
    d[2] / height,
  ];
}

/** Solve a 3x3 linear system by Cramer's rule; null when singular. */
function solve3(m: number[][], r: number[]): [number, number, number] | null {
  const det = (k: number[][]) =>
    k[0][0] * (k[1][1] * k[2][2] - k[1][2] * k[2][1]) -
    k[0][1] * (k[1][0] * k[2][2] - k[1][2] * k[2][0]) +
    k[0][2] * (k[1][0] * k[2][1] - k[1][1] * k[2][0]);
  const base = det(m);
  // The matrix is built from unit-square points, so its entries are O(count).
  const scale = Math.max(...m.flat().map(Math.abs), 1);
  if (!Number.isFinite(base) || Math.abs(base) < 1e-9 * scale ** 3) return null;
  const column = (c: number) => m.map((row, i) => row.map((value, j) => (j === c ? r[i] : value)));
  return [det(column(0)) / base, det(column(1)) / base, det(column(2)) / base];
}

/**
 * Apply a user-space transform.
 *
 * Args:
 *   t: The transform.
 *   u: PDF user-space x.
 *   v: PDF user-space y.
 *
 * Returns:
 *   CRS `[x, y]`.
 */
export function applyUserToCrs(t: UserToCrs, u: number, v: number): [number, number] {
  return [t[0] + t[1] * u + t[2] * v, t[3] + t[4] * u + t[5] * v];
}
