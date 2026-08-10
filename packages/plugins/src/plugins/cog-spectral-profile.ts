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

import { fromUrl } from "geotiff";
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
 * Wavelengths for each band, when the file declares them.
 *
 * Landsat/Sentinel products written by common tooling put a per-band
 * `wavelength` in the GDAL metadata; ENVI-style headers use `wavelength` on the
 * file directory. Neither is guaranteed, so a file without them charts against
 * band number instead — which is still the useful axis, just less physical.
 */
function wavelengthsFor(image: ImageLike, bandCount: number): number[] | null {
  const directory = image.getFileDirectory();
  const raw = directory?.["wavelength"] ?? directory?.["Wavelength"];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\s]+/) : null;
  if (!list || list.length !== bandCount) return null;
  const values = list.map((entry) => Number.parseFloat(String(entry)));
  // Every entry must parse. Filtering the bad ones out instead would let a list
  // with one junk extra entry still match the band count, silently shifting
  // every following wavelength onto the wrong band.
  return values.every((value) => Number.isFinite(value)) ? values : null;
}

/**
 * Read one pixel's value in every band of a multiband GeoTIFF.
 *
 * @param url - The COG/GeoTIFF URL. Range requests fetch only what is needed.
 * @param lng - Longitude of the clicked point, in WGS84 degrees.
 * @param lat - Latitude of the clicked point, in WGS84 degrees.
 * @returns The profile, or null when the file has a single band, the point
 *   falls outside the raster, or the file cannot be read.
 */
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

async function openImage(url: string): Promise<ImageLike | null> {
  const cached = openedImages.get(url);
  if (cached) return cached;
  const opened = (async () => {
    try {
      const tiff = await fromUrl(url);
      return (await tiff.getImage()) as unknown as ImageLike;
    } catch {
      return null;
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

export async function readCogSpectralProfile(
  url: string,
  lng: number,
  lat: number,
): Promise<CogSpectralProfile | null> {
  const image = await openImage(url);
  if (!image) return null;
  try {
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
