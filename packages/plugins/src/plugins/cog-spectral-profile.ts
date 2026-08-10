/**
 * Per-pixel spectral profile for a multiband GeoTIFF / COG (issue #1818).
 *
 * GeoLibre could already chart a pixel's values across a band axis, but only for
 * NetCDF/HDF cubes. A stacked Landsat or Sentinel scene — the most common
 * multispectral data there is — got RGB band combination and single-value
 * Identify, and no way to see one pixel's response across every band.
 *
 * This module supplies the missing reader. The chart, the multi-point sampling
 * UI, the numbered map markers and the PNG/CSV export are all reused unchanged:
 * the returned shape deliberately matches `LocalNetcdfProfile` so the existing
 * profile store and chart accept it without knowing where it came from.
 *
 * Reads are range requests via geotiff.js, so only the tile containing the
 * clicked pixel is fetched rather than the whole scene.
 */

import { fromArrayBuffer, fromUrl } from "geotiff";
import proj4 from "proj4";

/** One pixel's values across a raster's bands, shaped for the profile chart. */
export interface CogSpectralProfile {
  axis: {
    /** Axis name shown on the chart's x-axis. */
    name: string;
    /** Number of entries along the axis — the band count. */
    size: number;
    /** Band numbers, or wavelengths when the file declares them. */
    values?: number[];
    /** Axis units, e.g. "nm" when wavelengths were found. */
    units?: string;
  };
  /** One value per band, null where the pixel is nodata or unreadable. */
  values: (number | null)[];
}

/** The subset of a geotiff.js image this module needs (kept narrow for tests). */
export interface ImageLike {
  getBoundingBox: () => number[];
  getWidth: () => number;
  getHeight: () => number;
  getSamplesPerPixel: () => number;
  getGeoKeys: () => Record<string, unknown> | undefined;
  getGDALNoData?: () => number | null;
  getFileDirectory: () => Record<string, unknown>;
  readRasters: (options: {
    window: number[];
    samples?: number[];
  }) => Promise<ArrayLike<ArrayLike<number>>>;
}

let geokeysParser: Promise<((keys: Record<string, unknown>) => string | null) | null> | null = null;

/**
 * Resolve a GeoTIFF's geokeys to a proj4 definition, reusing the same
 * `geotiff-geokeys-to-proj4` dependency the COG raster layer uses so a file that
 * renders correctly also profiles correctly. Returns null for a file whose
 * projection cannot be resolved; the caller then assumes the coordinates are
 * already geographic.
 */
async function projectionFor(geoKeys: Record<string, unknown> | undefined): Promise<string | null> {
  if (!geoKeys) return null;
  geokeysParser ??= import("geotiff-geokeys-to-proj4")
    .then((mod) => (keys: Record<string, unknown>) => {
      try {
        const projection = mod.toProj4(keys as never);
        // The `+axis=` directive makes proj4 swap easting/northing on some
        // CRSs, which would transpose the pixel lookup.
        return projection?.proj4 ? projection.proj4.replace(/\+axis=\w+\s*/g, "") : null;
      } catch {
        return null;
      }
    })
    .catch(() => null);
  const parse = await geokeysParser;
  return parse ? parse(geoKeys) : null;
}

/**
 * Per-band wavelengths out of the `GDAL_METADATA` tag.
 *
 * This is where GDAL and rasterio actually put them: one `<Item name="…"
 * sample="N">` per band inside an XML blob, rather than a flat array on the file
 * directory. A stacked Landsat or Sentinel scene written by either tool is the
 * target of this feature, so reading only the flat form would have meant the
 * wavelength axis never appearing for the files it was built for.
 *
 * Matched on the item names those tools write (`wavelength`, and the
 * `central_wavelength` STAC-derived exports use), case-insensitively. Parsed
 * with a regular expression rather than a DOM parser: this is one well-known
 * tag shape, `DOMParser` is not available in every runtime this package builds
 * for, and an XML parser on file-supplied content is a larger surface than the
 * data warrants.
 *
 * @param directory - The image's file directory.
 * @param bandCount - How many bands the image has.
 * @returns One wavelength per band in band order, or null when the tag is
 *   absent, unparseable, or does not cover exactly every band.
 */
function gdalMetadataWavelengths(
  directory: Record<string, unknown> | undefined,
  bandCount: number,
): number[] | null {
  const xml = directory?.["GDAL_METADATA"];
  if (typeof xml !== "string" || !xml) return null;
  const bySample = new Map<number, number>();
  const item = /<Item\b([^>]*)>([^<]*)<\/Item>/gi;
  for (const match of xml.matchAll(item)) {
    const [, attributes, text] = match;
    const name = /\bname\s*=\s*"([^"]*)"/i.exec(attributes)?.[1]?.toLowerCase();
    if (name !== "wavelength" && name !== "central_wavelength") continue;
    // A wavelength with no `sample` is a dataset-level item, not a per-band one,
    // so it says nothing about which band it belongs to.
    const sample = Number.parseInt(/\bsample\s*=\s*"(\d+)"/i.exec(attributes)?.[1] ?? "", 10);
    const value = Number.parseFloat(text.trim());
    if (!Number.isInteger(sample) || !Number.isFinite(value)) continue;
    // First writer wins, so a file carrying both names does not have one
    // silently override the other halfway down the list.
    if (!bySample.has(sample)) bySample.set(sample, value);
  }
  // `sample` is 0-based, and every band has to be covered: a partial list would
  // put the bands it does cover at the wrong place on the axis.
  if (bySample.size !== bandCount) return null;
  const values: number[] = [];
  for (let band = 0; band < bandCount; band += 1) {
    const value = bySample.get(band);
    if (value === undefined) return null;
    values.push(value);
  }
  return values;
}

/**
 * Wavelengths for each band, when the file declares them.
 *
 * Two shapes, because two toolchains: GDAL/rasterio write per-band items into
 * `GDAL_METADATA`, while ENVI-style headers put a flat `wavelength` list on the
 * file directory. Neither is guaranteed, so a file with neither charts against
 * band number instead — which is still the useful axis, just less physical.
 */
function wavelengthsFor(image: ImageLike, bandCount: number): number[] | null {
  const directory = image.getFileDirectory();
  const fromGdal = gdalMetadataWavelengths(directory, bandCount);
  if (fromGdal) return fromGdal;
  const raw = directory?.["wavelength"] ?? directory?.["Wavelength"];
  // Trimmed before splitting: a leading space on " 443, 560, 665" would
  // otherwise produce an empty first element, fail the band-count match, and
  // drop a perfectly good wavelength list for being loosely formatted.
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.trim().split(/[,\s]+/)
      : null;
  if (!list || list.length !== bandCount) return null;
  const values = list.map((entry) => Number.parseFloat(String(entry)));
  // Every entry must parse. Filtering the bad ones out instead would let a list
  // with one junk extra entry still match the band count, silently shifting
  // every following wavelength onto the wrong band.
  return values.every((value) => Number.isFinite(value)) ? values : null;
}

/**
 * Fetches a whole file's bytes, for the fallback path below.
 *
 * The app's CORS/Tauri-aware fetch has this shape (`app.fetchArrayBuffer`); the
 * reader takes it as an argument rather than importing it, since this package
 * cannot depend on the desktop app.
 */
export type CogByteLoader = (url: string) => Promise<ArrayBuffer>;

/**
 * Opened images, keyed by URL.
 *
 * The workflow this exists for is repeated clicks on one scene ("click water,
 * click vegetation, click asphalt"), and `fromUrl` + `getImage` re-fetches the
 * header and IFD every time. Caching the promise means only the first click
 * pays for it. Bounded because a session realistically touches a handful of
 * rasters; the entries hold headers, not pixels.
 */
const openedImages = new Map<string, Promise<ImageLike | null>>();
const MAX_OPEN_IMAGES = 8;

/**
 * Band counts of images opened this session, keyed by URL.
 *
 * Outlives `openedImages` deliberately: it is two numbers, and its only reader
 * wants to know "can this layer ever chart?" without holding the image open.
 */
const bandCounts = new Map<string, number>();

/**
 * The band count for a URL already read this session, if any.
 *
 * Lets a caller skip the work — and the map marker — for a raster it has already
 * learned has a single band, which can never produce a profile. Null when this
 * URL has not been read yet, which is not the same as "unknown band count": the
 * first read is what fills it in.
 */
export function knownCogBandCount(url: string): number | null {
  return bandCounts.get(url) ?? null;
}

async function openImage(url: string, fetchBytes?: CogByteLoader): Promise<ImageLike | null> {
  const cached = openedImages.get(url);
  // Re-inserted on a hit so eviction is least-recently-used: without this the
  // map evicts whatever was opened first, which on a long session is as likely
  // to be the scene being clicked as a stale one.
  if (cached) {
    openedImages.delete(url);
    openedImages.set(url, cached);
    return cached;
  }
  const opened = (async () => {
    try {
      const tiff = await fromUrl(url);
      return (await tiff.getImage()) as unknown as ImageLike;
    } catch {
      // Range requests through the raw fetch geotiff.js uses are the fast path,
      // not the only one: a host without permissive CORS headers refuses them
      // outright, and in the desktop app that is exactly the file the map is
      // *displaying*, because rendering went through the native HTTP bypass (or
      // the dev raster proxy) instead. Falling back to the caller's fetch costs
      // the whole file rather than one tile, which is the same download the
      // layer already made to render, and the cache above means one click pays
      // it rather than every click.
      if (!fetchBytes) return null;
      try {
        const tiff = await fromArrayBuffer(await fetchBytes(url));
        return (await tiff.getImage()) as unknown as ImageLike;
      } catch {
        return null;
      }
    }
  })();
  if (openedImages.size >= MAX_OPEN_IMAGES) {
    const oldest = openedImages.keys().next();
    if (!oldest.done) openedImages.delete(oldest.value);
  }
  openedImages.set(url, opened);
  const image = await opened;
  // A failed open is not worth remembering: the next click should retry rather
  // than inherit a transient network error for the rest of the session.
  if (!image) openedImages.delete(url);
  return image;
}

/**
 * Read one pixel's value in every band of a multiband GeoTIFF.
 *
 * @param url - The COG/GeoTIFF URL. Range requests fetch only what is needed.
 * @param lng - Longitude of the clicked point, in WGS84 degrees.
 * @param lat - Latitude of the clicked point, in WGS84 degrees.
 * @param options.fetchBytes - Whole-file fetch used only when the range
 *   requests fail, for hosts the browser will not let this read directly.
 * @returns The profile, or null when the file has a single band, the point
 *   falls outside the raster, or the file cannot be read.
 */
export async function readCogSpectralProfile(
  url: string,
  lng: number,
  lat: number,
  options?: { fetchBytes?: CogByteLoader },
): Promise<CogSpectralProfile | null> {
  const image = await openImage(url, options?.fetchBytes);
  if (!image) return null;
  try {
    const bandCount = image.getSamplesPerPixel();
    if (Number.isFinite(bandCount)) bandCounts.set(url, bandCount);
    return await readProfileFromImage(image, lng, lat);
  } catch {
    // Metadata accessors throw on a malformed file -- getBoundingBox does so
    // when the image carries no affine transform -- and the caller treats a
    // rejection as an unresolved sample rather than a missing one.
    return null;
  }
}

/**
 * The reader's logic, separated from opening the file so the pixel indexing,
 * nodata handling and axis selection can be tested against a stub image rather
 * than a real GeoTIFF served over HTTP.
 */
export async function readProfileFromImage(
  image: ImageLike,
  lng: number,
  lat: number,
): Promise<CogSpectralProfile | null> {
  const bandCount = image.getSamplesPerPixel();
  // A single-band raster has no spectrum to chart; Identify's existing value
  // readout already covers it.
  if (!Number.isFinite(bandCount) || bandCount < 2) return null;

  const bbox = image.getBoundingBox();
  if (bbox.length !== 4) return null;

  // Project the click into the raster's own CRS before indexing into it.
  let x = lng;
  let y = lat;
  const geoKeys = image.getGeoKeys();
  const hasGeoKeys = Boolean(geoKeys && Object.keys(geoKeys).length > 0);
  const definition = await projectionFor(geoKeys);
  if (definition) {
    try {
      [x, y] = proj4("EPSG:4326", definition, [lng, lat]) as [number, number];
    } catch {
      return null;
    }
  } else if (hasGeoKeys) {
    // The file declares a CRS but no proj4 definition came back. Falling
    // through would index the raster with degrees as if they were its own
    // units, producing a confident reading of the wrong pixel.
    //
    // Unreachable through geotiff-geokeys-to-proj4's own output today -- it
    // returns a definition (falling back to longlat) even for user-defined and
    // unsupported keys, reporting the problem in a separate errors object. The
    // reachable case is the dynamic import itself failing, where treating the
    // file as geographic would be a guess.
    return null;
  }

  const [minX, minY, maxX, maxY] = bbox as [number, number, number, number];
  const width = image.getWidth();
  const height = image.getHeight();
  const column = Math.floor(((x - minX) / (maxX - minX)) * width);
  // Raster rows run north to south, so the y axis is inverted against the bbox.
  const row = Math.floor(((maxY - y) / (maxY - minY)) * height);
  if (!Number.isFinite(column) || !Number.isFinite(row)) return null;
  if (column < 0 || column >= width || row < 0 || row >= height) return null;

  let rasters: ArrayLike<ArrayLike<number>>;
  try {
    rasters = await image.readRasters({ window: [column, row, column + 1, row + 1] });
  } catch {
    return null;
  }

  const nodata = image.getGDALNoData?.() ?? null;
  const values: (number | null)[] = [];
  for (let band = 0; band < bandCount; band += 1) {
    const value = rasters[band]?.[0];
    values.push(
      typeof value === "number" && Number.isFinite(value) && (nodata === null || value !== nodata)
        ? value
        : null,
    );
  }
  // Every band nodata means the click landed on a masked pixel; charting a flat
  // line of nulls says nothing, so report it as no profile.
  if (values.every((value) => value === null)) return null;

  const wavelengths = wavelengthsFor(image, bandCount);
  return {
    axis: wavelengths
      ? { name: "wavelength", size: bandCount, values: wavelengths, units: "nm" }
      : {
          name: "band",
          size: bandCount,
          values: Array.from({ length: bandCount }, (_, i) => i + 1),
        },
    values,
  };
}
