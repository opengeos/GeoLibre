// Read ICESat-2 and GEDI spaceborne LiDAR granules (HDF5) in the browser and
// turn their along-track footprints into GeoJSON points.
//
// Both missions store one record per footprint (an ICESat-2 segment, a GEDI
// shot) as parallel 1-D arrays inside a group per beam: `gt1l`..`gt3r` for
// ICESat-2, `BEAM0000`..`BEAM1011` for GEDI. The NetCDF reader skips those
// because it only renders 2-D grids, so this module reads them on its own:
// pick a product description by the file's `short_name`, read the latitude and
// longitude arrays of each beam, apply the product's quality flag and fill
// values, and attach the chosen fields as feature properties.
//
// The decoded file lives in h5wasm's in-memory filesystem, shared with the
// NetCDF reader through {@link loadH5wasm}.

import type { FeatureCollection, Point } from "geojson";
import { LocalizedError } from "../localized-error";
import {
  loadH5wasm,
  type H5Dataset,
  type H5File,
  type H5Group,
  type H5wasmModule,
} from "./local-netcdf";

/** The spaceborne LiDAR products this reader understands. */
export type SpaceborneLidarProductId = "ATL06" | "ATL08" | "GEDI_L2A" | "GEDI_L2B" | "GEDI_L4A";

/** One per-footprint field a product offers by default. */
export interface SpaceborneLidarFieldSpec {
  /** Dataset path relative to the beam group (e.g. `land_segments/canopy/h_canopy`). */
  path: string;
  /** Property name on the output features. Defaults to the path's last segment. */
  name?: string;
  /** For a 2-D dataset (e.g. GEDI `rh`), the column to read. */
  column?: number;
  /** Multiplier applied after reading (e.g. GEDI L2B `rh100` is in centimeters). */
  scale?: number;
}

/** A product's beam layout, coordinates, defaults, and quality filter. */
export interface SpaceborneLidarProductSpec {
  id: SpaceborneLidarProductId;
  mission: "ICESat-2" | "GEDI";
  /** Human-readable product name. */
  label: string;
  /** Matches the names of the file's top-level beam groups. */
  beamPattern: RegExp;
  /** Latitude dataset, relative to the beam group. */
  latPath: string;
  /** Longitude dataset, relative to the beam group. */
  lonPath: string;
  /** `delta_time` dataset (seconds since 2018-01-01T00:00:00Z), relative to the beam group. */
  timePath: string;
  /** Fields selected by default, in display order. */
  defaultFields: SpaceborneLidarFieldSpec[];
  /** The field a new layer is colored by. Must be one of {@link defaultFields}. */
  primaryField: string;
  /** The product's quality filter, applied when the caller asks for it. */
  quality: {
    /** Candidate dataset paths; the first one present in the file is used. */
    paths: string[];
    /** Whether a footprint with this flag value is kept. */
    keep: (value: number) => boolean;
  };
}

/** Product descriptions, keyed by id. */
export const SPACEBORNE_LIDAR_PRODUCTS: Record<
  SpaceborneLidarProductId,
  SpaceborneLidarProductSpec
> = {
  ATL06: {
    id: "ATL06",
    mission: "ICESat-2",
    label: "ICESat-2 ATL06 Land Ice Height",
    beamPattern: /^gt[123][lr]$/,
    latPath: "land_ice_segments/latitude",
    lonPath: "land_ice_segments/longitude",
    timePath: "land_ice_segments/delta_time",
    defaultFields: [
      { path: "land_ice_segments/h_li" },
      { path: "land_ice_segments/h_li_sigma" },
      { path: "land_ice_segments/fit_statistics/dh_fit_dx" },
      { path: "land_ice_segments/fit_statistics/snr" },
    ],
    primaryField: "h_li",
    // 0 = no quality problem flagged for the segment (ATL06 ATBD).
    quality: { paths: ["land_ice_segments/atl06_quality_summary"], keep: (v) => v === 0 },
  },
  ATL08: {
    id: "ATL08",
    mission: "ICESat-2",
    label: "ICESat-2 ATL08 Land and Vegetation Height",
    beamPattern: /^gt[123][lr]$/,
    latPath: "land_segments/latitude",
    lonPath: "land_segments/longitude",
    timePath: "land_segments/delta_time",
    defaultFields: [
      { path: "land_segments/terrain/h_te_best_fit" },
      { path: "land_segments/canopy/h_canopy" },
      { path: "land_segments/canopy/canopy_openness" },
      { path: "land_segments/terrain/terrain_slope" },
      { path: "land_segments/night_flag" },
      { path: "land_segments/segment_landcover" },
    ],
    primaryField: "h_te_best_fit",
    // ATL08 has no single quality summary; keep segments that resolved a
    // terrain height (the fill value marks segments with too few photons).
    quality: { paths: ["land_segments/terrain/h_te_best_fit"], keep: () => true },
  },
  GEDI_L2A: {
    id: "GEDI_L2A",
    mission: "GEDI",
    label: "GEDI L2A Elevation and Height Metrics",
    beamPattern: /^BEAM\d{4}$/,
    latPath: "lat_lowestmode",
    lonPath: "lon_lowestmode",
    timePath: "delta_time",
    defaultFields: [
      { path: "elev_lowestmode" },
      { path: "rh", column: 50, name: "rh50" },
      { path: "rh", column: 75, name: "rh75" },
      { path: "rh", column: 98, name: "rh98" },
      { path: "rh", column: 100, name: "rh100" },
      { path: "sensitivity" },
      { path: "num_detectedmodes" },
    ],
    primaryField: "rh98",
    // Version 2 names the flag `quality_flag`; version 3 `l2a_quality_flag_rel3`.
    quality: { paths: ["quality_flag", "l2a_quality_flag_rel3"], keep: (v) => v === 1 },
  },
  GEDI_L2B: {
    id: "GEDI_L2B",
    mission: "GEDI",
    label: "GEDI L2B Canopy Cover and Vertical Profile",
    beamPattern: /^BEAM\d{4}$/,
    latPath: "geolocation/lat_lowestmode",
    lonPath: "geolocation/lon_lowestmode",
    timePath: "geolocation/delta_time",
    defaultFields: [
      { path: "cover" },
      { path: "pai" },
      { path: "fhd_normal" },
      { path: "rh100", scale: 0.01 },
      { path: "geolocation/elev_lowestmode" },
      { path: "sensitivity" },
    ],
    primaryField: "cover",
    quality: { paths: ["l2b_quality_flag"], keep: (v) => v === 1 },
  },
  GEDI_L4A: {
    id: "GEDI_L4A",
    mission: "GEDI",
    label: "GEDI L4A Aboveground Biomass Density",
    beamPattern: /^BEAM\d{4}$/,
    latPath: "lat_lowestmode",
    lonPath: "lon_lowestmode",
    timePath: "delta_time",
    defaultFields: [
      { path: "agbd" },
      { path: "agbd_se" },
      { path: "elev_lowestmode" },
      { path: "sensitivity" },
    ],
    primaryField: "agbd",
    quality: { paths: ["l4_quality_flag"], keep: (v) => v === 1 },
  },
};

/** Every `short_name` spelling seen in the wild, mapped to a product. */
const SHORT_NAMES: Record<string, SpaceborneLidarProductId> = {
  ATL06: "ATL06",
  ATL08: "ATL08",
  GEDI_L2A: "GEDI_L2A",
  GEDI02_A: "GEDI_L2A",
  GEDI_L2B: "GEDI_L2B",
  GEDI02_B: "GEDI_L2B",
  GEDI_L4A: "GEDI_L4A",
  GEDI04_A: "GEDI_L4A",
};

/** The `delta_time` epoch of both missions, 2018-01-01T00:00:00Z, in ms. */
const DELTA_TIME_EPOCH_MS = Date.UTC(2018, 0, 1);

/** Mean Earth radius in meters, for along-track distance. */
const EARTH_RADIUS_M = 6_371_008.8;

/** GEDI writes these as fill values without always declaring `_FillValue`. */
const GEDI_FILL_VALUES = new Set([-9999, -999999]);

/** One beam in an opened granule. */
export interface SpaceborneLidarBeam {
  /** Group name, e.g. `gt1l` or `BEAM0101`. */
  name: string;
  /** `strong`/`weak` for ICESat-2, `power`/`coverage` for GEDI, or null. */
  type: string | null;
  /** Footprints in the beam before any filtering. */
  count: number;
}

/** A per-footprint field that can be attached to the output features. */
export interface SpaceborneLidarField {
  /** Dataset path relative to the beam group. */
  path: string;
  /** Property name on the output features. */
  name: string;
  /** For a 2-D dataset, the column read. */
  column?: number;
  /** Multiplier applied after reading. */
  scale?: number;
  /** CF/ICESat-2 `units` attribute, when the file has one. */
  units?: string;
  /** `long_name` or `description`, when the file has one. */
  description?: string;
  /** Whether the product selects this field by default. */
  isDefault: boolean;
}

/** Options for {@link SpaceborneLidarFile.readFootprints}. */
export interface SpaceborneLidarReadOptions {
  /** Beam names to read; defaults to every beam. */
  beams?: string[];
  /** Fields to attach; defaults to the product's default fields. */
  fields?: Array<Pick<SpaceborneLidarField, "path" | "name" | "column" | "scale">>;
  /** Apply the product's quality filter. Defaults to true. */
  qualityFilter?: boolean;
  /**
   * Keep only footprints inside `[west, south, east, north]` (degrees). A west
   * edge greater than the east edge wraps across the antimeridian.
   */
  bbox?: readonly [number, number, number, number];
  /**
   * Upper bound on the number of features. When more footprints pass the
   * filters, every beam is thinned by the same stride so tracks stay even.
   */
  maxPoints?: number;
}

/** Properties every output feature carries, besides the selected fields. */
export interface SpaceborneLidarBaseProperties {
  beam: string;
  beam_type: string | null;
  /** Acquisition time (UTC, ISO 8601). */
  time: string | null;
  /** Distance along the beam's track from its first footprint, in kilometers. */
  distance_km: number;
}

/** The result of {@link SpaceborneLidarFile.readFootprints}. */
export interface SpaceborneLidarFootprints {
  geojson: FeatureCollection<Point>;
  /** Footprints in the selected beams before filtering. */
  total: number;
  /** Footprints that passed the quality and extent filters. */
  matched: number;
  /** Features in {@link geojson}, after thinning to `maxPoints`. */
  kept: number;
  /** The thinning stride used (1 when nothing was dropped). */
  stride: number;
  /** Per-beam kept counts, in beam order. */
  perBeam: Array<{ beam: string; kept: number }>;
}

/** An opened ICESat-2/GEDI granule. Call {@link close} when done. */
export interface SpaceborneLidarFile {
  product: SpaceborneLidarProductSpec;
  beams: SpaceborneLidarBeam[];
  /**
   * The fields that can be attached: the product's defaults that exist in this
   * file first, then every other 1-D numeric dataset aligned with the beam's
   * footprints, sorted by path.
   */
  listFields(): SpaceborneLidarField[];
  /** Read the selected beams' footprints as GeoJSON points. */
  readFootprints(options?: SpaceborneLidarReadOptions): SpaceborneLidarFootprints;
  close(): void;
}

/** h5wasm's group/file objects also expose their HDF5 attributes. */
interface H5WithAttrs {
  attrs?: Record<string, { value: unknown }>;
}

let fileCounter = 0;

/**
 * Identify a spaceborne LiDAR product from a `short_name` or a file name.
 *
 * @param shortName The root `short_name` attribute, if the file has one.
 * @param fileName The file name, used when the attribute is missing.
 * @returns The product id, or null when neither names a supported product.
 */
export function detectSpaceborneLidarProduct(
  shortName: string | undefined,
  fileName?: string,
): SpaceborneLidarProductId | null {
  const fromAttr = shortName ? SHORT_NAMES[shortName.trim().toUpperCase()] : undefined;
  if (fromAttr) return fromAttr;
  const base = (fileName ?? "").split(/[\\/]/).pop()?.toUpperCase() ?? "";
  if (base.startsWith("ATL06")) return "ATL06";
  if (base.startsWith("ATL08")) return "ATL08";
  // ORNL DAAC prefixes L4A names with the collection, e.g.
  // `GEDI_L4A_AGB_Density_V2_1.GEDI04_A_...`, so search rather than anchor.
  if (base.includes("GEDI02_A")) return "GEDI_L2A";
  if (base.includes("GEDI02_B")) return "GEDI_L2B";
  if (base.includes("GEDI04_A")) return "GEDI_L4A";
  return null;
}

/**
 * Open an ICESat-2 (ATL06/ATL08) or GEDI (L2A/L2B/L4A) granule.
 *
 * The buffer is handed to h5wasm's in-memory filesystem without a copy, so the
 * caller must not reuse it afterwards.
 *
 * @param buffer The raw HDF5 bytes.
 * @param fileName The file name, used to identify the product when the file
 *   carries no `short_name` attribute.
 * @returns The opened granule.
 * @throws If the bytes are not HDF5 or not a supported product.
 */
export async function openSpaceborneLidar(
  buffer: ArrayBuffer,
  fileName?: string,
): Promise<SpaceborneLidarFile> {
  const mod = await loadH5wasm();
  const fsPath = `geolibre-spaceborne-lidar-${fileCounter++}.h5`;
  // canOwn lets the filesystem keep the bytes instead of copying them, which
  // halves peak memory for multi-gigabyte GEDI L2A granules.
  mod.FS.writeFile(fsPath, new Uint8Array(buffer), { canOwn: true });
  let file: H5File | null = null;
  try {
    file = new mod.File(fsPath, "r");
    // The File constructor does not throw on non-HDF5 input; listing does.
    file.keys();
    return SpaceborneLidarGranule.create(mod, file, fsPath, fileName);
  } catch (err) {
    try {
      file?.close();
    } catch {
      /* best effort */
    }
    try {
      mod.FS.unlink(fsPath);
    } catch {
      /* best effort */
    }
    throw err instanceof LocalizedError
      ? err
      : new LocalizedError(
          "spaceborneLidar.errors.notHdf5",
          "Could not read the file as HDF5. ({{detail}})",
          { detail: err instanceof Error ? err.message : String(err) },
          { cause: err },
        );
  }
}

class SpaceborneLidarGranule implements SpaceborneLidarFile {
  private constructor(
    private readonly mod: H5wasmModule,
    private readonly file: H5File,
    private readonly fsPath: string,
    readonly product: SpaceborneLidarProductSpec,
    readonly beams: SpaceborneLidarBeam[],
  ) {}

  /**
   * Identify the product and list its beams.
   *
   * @param mod The loaded h5wasm module.
   * @param file The open HDF5 file.
   * @param fsPath The file's path in h5wasm's filesystem.
   * @param fileName The original file name, for product detection.
   * @returns The granule.
   * @throws LocalizedError if the product is unsupported or has no beams.
   */
  static create(
    mod: H5wasmModule,
    file: H5File,
    fsPath: string,
    fileName: string | undefined,
  ): SpaceborneLidarGranule {
    const shortName =
      stringAttr(file, "short_name") ??
      stringAttr(tryGet(file, "METADATA/DatasetIdentification"), "shortName");
    const id = detectSpaceborneLidarProduct(shortName, fileName);
    if (!id) {
      throw shortName
        ? new LocalizedError(
            "spaceborneLidar.errors.unsupportedProduct",
            "Not a supported ICESat-2 or GEDI product (found {{found}}). Supported: ATL06, ATL08, GEDI L2A, GEDI L2B, GEDI L4A.",
            { found: shortName },
          )
        : new LocalizedError(
            "spaceborneLidar.errors.unrecognizedProduct",
            "Not a recognized ICESat-2 or GEDI product. Supported: ATL06, ATL08, GEDI L2A, GEDI L2B, GEDI L4A.",
          );
    }
    const product = SPACEBORNE_LIDAR_PRODUCTS[id];
    const beams: SpaceborneLidarBeam[] = [];
    for (const name of file.keys().sort()) {
      if (!product.beamPattern.test(name)) continue;
      const group = tryGet(file, name);
      if (!isGroup(group)) continue;
      // ATL08 omits `land_segments` from a beam with no land footprints.
      const lat = tryGet(group, product.latPath);
      if (!isDataset(lat)) continue;
      const count = datasetShape(lat)[0] ?? 0;
      if (count === 0) continue;
      beams.push({ name, type: beamType(product, group), count });
    }
    if (beams.length === 0) {
      throw new LocalizedError(
        "spaceborneLidar.errors.noBeams",
        "The {{product}} file has no beams with footprints.",
        { product: product.label },
      );
    }
    return new SpaceborneLidarGranule(mod, file, fsPath, product, beams);
  }

  close(): void {
    try {
      this.file.close();
    } catch {
      /* best effort */
    }
    try {
      this.mod.FS.unlink(this.fsPath);
    } catch {
      /* best effort */
    }
  }

  listFields(): SpaceborneLidarField[] {
    // Fields are listed from the largest beam: every beam of a product shares
    // the same layout, and the largest is the least likely to be degenerate.
    const reference = [...this.beams].sort((a, b) => b.count - a.count)[0];
    const group = tryGet(this.file, reference.name) as H5Group;
    const count = reference.count;
    const out: SpaceborneLidarField[] = [];
    const seen = new Set<string>();

    for (const spec of this.product.defaultFields) {
      const ds = tryGet(group, spec.path);
      if (!isDataset(ds) || !isNumeric(ds)) continue;
      const shape = datasetShape(ds);
      if (shape[0] !== count) continue;
      if (spec.column !== undefined && (shape.length !== 2 || spec.column >= shape[1])) continue;
      const name = spec.name ?? lastSegment(spec.path);
      seen.add(fieldKey(spec.path, spec.column));
      out.push({
        path: spec.path,
        name,
        ...(spec.column !== undefined ? { column: spec.column } : {}),
        ...(spec.scale !== undefined ? { scale: spec.scale } : {}),
        ...describe(ds, spec.scale),
        isDefault: true,
      });
    }

    const coordinatePaths = new Set([this.product.latPath, this.product.lonPath]);
    const extra: SpaceborneLidarField[] = [];
    walkDatasets(group, "", (path, ds) => {
      if (seen.has(fieldKey(path)) || coordinatePaths.has(path)) return;
      if (!isNumeric(ds)) return;
      const shape = datasetShape(ds);
      if (shape.length !== 1 || shape[0] !== count) return;
      extra.push({ path, name: lastSegment(path), ...describe(ds), isDefault: false });
    });
    extra.sort((a, b) => a.path.localeCompare(b.path));
    return dedupeNames([...out, ...extra]);
  }

  readFootprints(options: SpaceborneLidarReadOptions = {}): SpaceborneLidarFootprints {
    const wanted = options.beams ? new Set(options.beams) : null;
    const beams = this.beams.filter((beam) => !wanted || wanted.has(beam.name));
    const fields = dedupeNames(
      (options.fields ?? this.listFields().filter((field) => field.isDefault)).map((field) => ({
        ...field,
        name: field.name ?? lastSegment(field.path),
        isDefault: false,
      })),
    );
    const qualityFilter = options.qualityFilter ?? true;
    const bbox = options.bbox;

    // Pass 1: coordinates, distance, and the filter mask for every beam.
    const selections = beams.map((beam) => {
      const group = tryGet(this.file, beam.name) as H5Group;
      const lat = readNumbers(tryGet(group, this.product.latPath));
      const lon = readNumbers(tryGet(group, this.product.lonPath));
      const distance = alongTrackKm(lat, lon);
      const quality = qualityFilter ? this.qualityValues(group) : null;
      const indices: number[] = [];
      for (let i = 0; i < lat.length; i++) {
        const y = lat[i];
        const x = lon[i];
        if (!validCoordinate(x, y)) continue;
        if (quality && !quality(i)) continue;
        if (bbox && !insideBbox(x, y, bbox)) continue;
        indices.push(i);
      }
      return { beam, group, lat, lon, distance, indices };
    });

    const total = beams.reduce((sum, beam) => sum + beam.count, 0);
    const matched = selections.reduce((sum, s) => sum + s.indices.length, 0);
    const maxPoints =
      options.maxPoints !== undefined && options.maxPoints > 0
        ? Math.max(1, Math.floor(options.maxPoints))
        : Infinity;
    const stride = matched > maxPoints ? Math.ceil(matched / maxPoints) : 1;

    // Pass 2: read only the span of each field that holds kept footprints. A
    // track crosses an extent once, so the span is usually a small slice.
    const features: FeatureCollection<Point>["features"] = [];
    const perBeam: SpaceborneLidarFootprints["perBeam"] = [];
    // The stride runs over all beams' matches as one sequence, so restarting it
    // per beam cannot keep an extra footprint from each beam past the cap.
    let matchedOffset = 0;
    for (const { beam, group, lat, lon, distance, indices } of selections) {
      const offset = matchedOffset;
      matchedOffset += indices.length;
      const kept = stride === 1 ? indices : indices.filter((_, k) => (offset + k) % stride === 0);
      perBeam.push({ beam: beam.name, kept: kept.length });
      if (kept.length === 0) continue;
      const lo = kept[0];
      const hi = kept[kept.length - 1] + 1;
      const time = readSpan(tryGet(group, this.product.timePath), lo, hi);
      const columns = fields.map((field) => ({
        name: field.name,
        values: readFieldSpan(tryGet(group, field.path), field, lo, hi, this.product.mission),
      }));
      for (const i of kept) {
        const properties: Record<string, unknown> = {
          beam: beam.name,
          beam_type: beam.type,
          time: time ? isoTime(time[i - lo]) : null,
          distance_km: round(distance[i], 4),
        };
        for (const column of columns) {
          properties[column.name] = column.values ? column.values[i - lo] : null;
        }
        features.push({
          type: "Feature",
          // A stable id lets the map select a footprint unambiguously (and the
          // along-track profile link to it); property matching cannot.
          id: features.length,
          geometry: { type: "Point", coordinates: [round(lon[i], 7), round(lat[i], 7)] },
          properties,
        });
      }
    }

    return {
      geojson: { type: "FeatureCollection", features },
      total,
      matched,
      kept: features.length,
      stride,
      perBeam,
    };
  }

  /**
   * The quality predicate for one beam, or null when the file lacks the flag
   * (an older or trimmed granule), in which case nothing is filtered.
   */
  private qualityValues(group: H5Group): ((index: number) => boolean) | null {
    for (const path of this.product.quality.paths) {
      const ds = tryGet(group, path);
      if (!isDataset(ds)) continue;
      const values = readNumbers(ds);
      const fill = fillValue(ds);
      const keep = this.product.quality.keep;
      return (index) => {
        const v = values[index];
        return !isFill(v, fill, this.product.mission) && keep(v);
      };
    }
    return null;
  }
}

/**
 * Cumulative great-circle distance along a track, in kilometers. Invalid
 * coordinates carry the previous distance forward.
 *
 * @param lat Latitudes in degrees.
 * @param lon Longitudes in degrees.
 * @returns One distance per footprint, starting at 0.
 */
export function alongTrackKm(lat: ArrayLike<number>, lon: ArrayLike<number>): Float64Array {
  const out = new Float64Array(lat.length);
  let total = 0;
  let prev = -1;
  for (let i = 0; i < lat.length; i++) {
    if (validCoordinate(lon[i], lat[i])) {
      if (prev >= 0) total += haversineM(lat[prev], lon[prev], lat[i], lon[i]) / 1000;
      prev = i;
    }
    out[i] = total;
  }
  return out;
}

/** Great-circle distance between two points, in meters. */
function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Whether a point falls inside a `[west, south, east, north]` box. Both the
 * wrapped (west > east) and the map's unwrapped (east > 180) spellings of an
 * antimeridian crossing are accepted; a box 360° or wider spans every longitude.
 */
function insideBbox(
  x: number,
  y: number,
  [west, south, east, north]: readonly [number, number, number, number],
): boolean {
  if (y < south || y > north) return false;
  if (west <= east && east - west >= 360) return true;
  const w = wrapLongitude(west);
  const e = wrapLongitude(east);
  return w <= e ? x >= w && x <= e : x >= w || x <= e;
}

/** Bring a longitude into [-180, 180], keeping +180 as-is. */
function wrapLongitude(lon: number): number {
  if (lon >= -180 && lon <= 180) return lon;
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** A finite longitude/latitude pair within the valid ranges. */
function validCoordinate(x: number, y: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(y) <= 90 && Math.abs(x) <= 180;
}

/** Convert a `delta_time` (seconds since 2018-01-01Z) to an ISO timestamp. */
function isoTime(seconds: number): string | null {
  if (!Number.isFinite(seconds) || Math.abs(seconds) > 1e10) return null;
  return new Date(DELTA_TIME_EPOCH_MS + seconds * 1000).toISOString();
}

/** Whether a value is a fill: the declared `_FillValue`, float max, or a GEDI sentinel. */
function isFill(value: number, fill: number | null, mission: "ICESat-2" | "GEDI"): boolean {
  if (!Number.isFinite(value) || Math.abs(value) >= 1e38) return true;
  if (fill !== null && value === fill) return true;
  return mission === "GEDI" && GEDI_FILL_VALUES.has(value);
}

/** Read a whole 1-D dataset as numbers (64-bit integers are narrowed). */
function readNumbers(ds: unknown): ArrayLike<number> {
  if (!isDataset(ds)) return [];
  return toNumbers(ds.value);
}

/** Read `[lo, hi)` of a 1-D dataset as numbers, or null when it is missing. */
function readSpan(ds: unknown, lo: number, hi: number): ArrayLike<number> | null {
  if (!isDataset(ds)) return null;
  return toNumbers(ds.slice([[lo, hi]]));
}

/**
 * Read `[lo, hi)` of a field as display values: fills become null, the scale is
 * applied, and float32 noise is trimmed so `12.3` does not print as
 * `12.300000190734863`. 64-bit integers (GEDI `shot_number`) are kept exact as
 * strings, since they exceed the safe integer range.
 */
function readFieldSpan(
  ds: unknown,
  field: { column?: number; scale?: number },
  lo: number,
  hi: number,
  mission: "ICESat-2" | "GEDI",
): Array<number | string | null> | null {
  if (!isDataset(ds) || !isNumeric(ds)) return null;
  const shape = datasetShape(ds);
  const raw =
    field.column !== undefined && shape.length === 2
      ? ds.slice([
          [lo, hi],
          [field.column, field.column + 1],
        ])
      : ds.slice([[lo, hi]]);
  if (raw instanceof BigInt64Array || raw instanceof BigUint64Array) {
    // Compare against the raw attribute: a 64-bit fill loses precision as a number.
    const fill = scalar(ds.attrs["_FillValue"]?.value);
    return Array.from(raw, (v) =>
      (typeof fill === "bigint" && v === fill) ||
      // A number past 2^53 already lost its exact value; it cannot name one id.
      (typeof fill === "number" && Number.isSafeInteger(fill) && v === BigInt(fill))
        ? null
        : v.toString(),
    );
  }
  const values = toNumbers(raw);
  const fill = fillValue(ds);
  const scale = field.scale ?? 1;
  const isFloat32 = ds.metadata.type === 1 && ds.metadata.size === 4;
  const out = new Array<number | null>(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (isFill(v, fill, mission)) {
      out[i] = null;
      continue;
    }
    const scaled = v * scale;
    out[i] = isFloat32 || scale !== 1 ? Number(scaled.toPrecision(7)) : scaled;
  }
  return out;
}

/** Coerce h5wasm output to a numeric array-like. */
function toNumbers(value: unknown): ArrayLike<number> {
  if (value instanceof BigInt64Array || value instanceof BigUint64Array) {
    return Float64Array.from(value, Number);
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return value as unknown as ArrayLike<number>;
  }
  if (Array.isArray(value)) return value.map(Number);
  return typeof value === "number" ? [value] : [];
}

/** Round to a number of decimals. */
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** A dataset's shape, from whichever property h5wasm populated. */
function datasetShape(ds: H5Dataset): number[] {
  return ds.shape ?? ds.metadata.shape ?? [];
}

/** Integer or float datasets; strings, compounds and enums are skipped. */
function isNumeric(ds: H5Dataset): boolean {
  return ds.metadata.type === 0 || ds.metadata.type === 1;
}

/** The declared `_FillValue`, when numeric. */
function fillValue(ds: H5Dataset): number | null {
  const value = scalar(ds.attrs["_FillValue"]?.value);
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" ? value : null;
}

/** Units and description from a dataset's attributes. */
function describe(ds: H5Dataset, scale?: number): { units?: string; description?: string } {
  const units = stringAttr(ds, "units");
  const description = stringAttr(ds, "long_name") ?? stringAttr(ds, "description");
  return {
    // GEDI L2B `rh100` is stored in centimeters and scaled to meters on read.
    ...(units ? { units: scale === 0.01 && units === "cm" ? "m" : units } : {}),
    ...(description ? { description } : {}),
  };
}

/** The beam's power class from its attributes. */
function beamType(product: SpaceborneLidarProductSpec, group: H5Group): string | null {
  if (product.mission === "ICESat-2") {
    const type = stringAttr(group, "atlas_beam_type");
    return type ? type.toLowerCase() : null;
  }
  const description = stringAttr(group, "description")?.toLowerCase() ?? "";
  if (description.includes("power")) return "power";
  if (description.includes("coverage")) return "coverage";
  return null;
}

/** Visit every dataset under a group, depth first. */
function walkDatasets(
  group: H5Group,
  prefix: string,
  visit: (path: string, ds: H5Dataset) => void,
): void {
  for (const key of group.keys()) {
    const entity = tryGet(group, key);
    const path = prefix ? `${prefix}/${key}` : key;
    if (isDataset(entity)) visit(path, entity);
    else if (isGroup(entity)) walkDatasets(entity, path, visit);
  }
}

/**
 * Make property names unique: the first field with a name keeps it, and later
 * ones fall back to their full path. Defaults are listed first, so a product's
 * default names (and its primary field) stay stable.
 */
function dedupeNames<T extends { path: string; name: string }>(fields: T[]): T[] {
  const used = new Set<string>();
  return fields.map((field) => {
    const name = used.has(field.name) ? field.path.replaceAll("/", "_") : field.name;
    used.add(name);
    return name === field.name ? field : { ...field, name };
  });
}

/** Identity of a field: its path plus the column for 2-D datasets. */
function fieldKey(path: string, column?: number): string {
  return column === undefined ? path : `${path}[${column}]`;
}

/** The last `/`-separated segment of a path. */
function lastSegment(path: string): string {
  return path.split("/").pop() ?? path;
}

/** Read a string attribute from a dataset, group, or file. */
function stringAttr(entity: unknown, name: string): string | undefined {
  if (typeof entity !== "object" || entity === null) return undefined;
  let attrs: H5WithAttrs["attrs"];
  try {
    attrs = (entity as H5WithAttrs).attrs;
  } catch {
    return undefined;
  }
  const value = scalar(attrs?.[name]?.value);
  return typeof value === "string" ? value : undefined;
}

/** The first element of an array-valued attribute, or the value itself. */
function scalar(value: unknown): unknown {
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return (value as unknown as ArrayLike<unknown>)[0];
  }
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Look up a child entity, returning null if h5wasm throws (missing or broken link). */
function tryGet(group: H5Group, path: string): unknown {
  try {
    return group.get(path) ?? null;
  } catch {
    return null;
  }
}

function isDataset(value: unknown): value is H5Dataset {
  return (
    typeof value === "object" &&
    value !== null &&
    "metadata" in value &&
    typeof (value as H5Dataset).slice === "function"
  );
}

function isGroup(value: unknown): value is H5Group {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as H5Group).keys === "function" &&
    typeof (value as H5Group).get === "function"
  );
}
