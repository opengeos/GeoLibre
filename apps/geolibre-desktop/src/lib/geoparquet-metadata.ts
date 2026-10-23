/**
 * Parsing the GeoParquet `geo` file-metadata block, and the Parquet 2.0 native
 * GEOMETRY/GEOGRAPHY logical type that supersedes parts of it.
 *
 * GeoLibre reads GeoParquet with `read_parquet`, not GDAL, so nothing in the
 * scan reports what the file actually declares: its version, the primary
 * geometry column, that column's encoding, its bounding box, whether it carries
 * a 1.1 `covering` bbox struct, and — the part that decides whether a layer
 * lands on the map at all — its CRS. All of that lives in the Parquet
 * file-level key/value metadata under the key `geo` (or, for 2.0 files, on the
 * geometry column's Parquet logical type).
 *
 * This module is the whole parsing half of that read, and is deliberately free
 * of DuckDB imports so every rule can be unit-tested on its own.
 * `geoparquet-crs.ts` is the thin SQL-building layer over it.
 *
 * Specification: https://geoparquet.org/releases/v1.1.0/
 */

/** How a geometry column's values are stored. */
export type GeoParquetEncoding =
  | "WKB"
  | "point"
  | "linestring"
  | "polygon"
  | "multipoint"
  | "multilinestring"
  | "multipolygon"
  // Any other spelling is kept verbatim rather than dropped, so an unknown
  // encoding can be reported to the user instead of silently read as WKB.
  | (string & {});

/** Whether the edges between two coordinates are straight lines or arcs. */
export type GeoParquetEdges = "planar" | "spherical";

/**
 * A geometry column's declared CRS, in the three states the specification
 * distinguishes plus the forms a resolved one can take.
 *
 * The distinction that matters is between an **absent** `crs` member and an
 * explicit `"crs": null`. The first is the specification default, OGC:CRS84.
 * The second declares that the coordinates are in *no known CRS at all* — the
 * data still has to be drawn somewhere, so it is drawn as it stands, but
 * nothing may claim an EPSG code for it.
 */
export type GeoParquetCrs =
  /** No `crs` member at all: the specification default, OGC:CRS84. */
  | { kind: "default" }
  /** An explicit `"crs": null`: no known CRS, so nothing to transform from. */
  | { kind: "undefined" }
  /** An authority-identified CRS from the PROJJSON `id` member. */
  | {
      kind: "authority";
      /** Upper-cased authority, e.g. `EPSG`, `ESRI`, `OGC`. */
      authority: string;
      /** The code as text: PROJJSON allows a number or a string. */
      code: string;
      /** The equivalent EPSG code, when there is one. */
      epsg: number | null;
      name?: string;
    }
  /** Id-less PROJJSON: the document itself is the CRS's identity. */
  | { kind: "projjson"; document: string; name?: string }
  /** A pre-1.0 draft's raw CRS string (WKT2, or an `AUTHORITY:CODE` spelling). */
  | { kind: "raw"; value: string }
  /** A logical-type CRS string in no recognised form. */
  | { kind: "unknown"; raw: string };

/** The GeoParquet 1.1 `covering.bbox` column, resolved to plain field names. */
export interface GeoParquetCovering {
  /** The struct column holding the four bbox fields. */
  root: string;
  xmin: string;
  ymin: string;
  xmax: string;
  ymax: string;
}

/** One entry of the `geo` document's `columns` map. */
export interface GeoParquetColumnMetadata {
  name: string;
  encoding: GeoParquetEncoding;
  geometryTypes: string[];
  /** Always the 2D box `[xmin, ymin, xmax, ymax]`, whatever the source arity. */
  bbox?: [number, number, number, number];
  covering?: GeoParquetCovering;
  crs: GeoParquetCrs;
  edges?: GeoParquetEdges;
  orientation?: string;
}

/** A parsed `geo` file-metadata document. */
export interface GeoParquetMetadata {
  /** The declared spec version, e.g. `1.1.0`, or null when absent. */
  version: string | null;
  /** The declared primary geometry column, or null when absent. */
  primaryColumn: string | null;
  columns: GeoParquetColumnMetadata[];
}

/** The Parquet 2.0 native geospatial logical type on a geometry column. */
export interface NativeGeometryLogicalType {
  kind: "geometry" | "geography";
  /** The type's free-form CRS string, or null when it carries none. */
  crs: string | null;
  /** GEOGRAPHY edges are great-circle arcs; GEOMETRY edges are straight. */
  edges: GeoParquetEdges;
}

/** Inputs {@link describeGeoParquet} labels a file from. */
export interface GeoParquetDescriptionInput {
  /** The parsed `geo` block, or null when the file carries none. */
  metadata: GeoParquetMetadata | null;
  /** True when a column carries the Parquet GEOMETRY/GEOGRAPHY logical type. */
  hasNativeGeometryType?: boolean;
  /** True when the geometry was synthesized from a coordinate column pair. */
  synthesizedFromCoordinates?: boolean;
}

const GEOARROW_ENCODINGS = new Set([
  "point",
  "linestring",
  "polygon",
  "multipoint",
  "multilinestring",
  "multipolygon",
]);

/**
 * OGC's geographic CRS identifiers, which name lon/lat axis order on a datum an
 * EPSG code also names. PROJ resolves the EPSG spellings far more reliably, so
 * they are what the loader hands `ST_Transform`.
 */
const OGC_CRS_EPSG_CODES: Record<string, number> = {
  // OGC:CRS84 and its shorthand OGC:84 are WGS84 in lon/lat order.
  CRS84: 4326,
  "84": 4326,
  // NAD83 and NAD27 in lon/lat order.
  CRS83: 4269,
  CRS27: 4267,
};

/**
 * Parse the `geo` file-metadata document.
 *
 * @param metadataJson The document as text, or null/blank for a file with none.
 * @returns The parsed metadata, or null when the input is absent, is not JSON,
 *   or describes no geometry column (both of which mean "not a GeoParquet", not
 *   "a broken one" — the file must still load).
 */
export function parseGeoParquetMetadata(
  metadataJson: string | null | undefined,
): GeoParquetMetadata | null {
  if (!metadataJson) return null;

  let document: unknown;
  try {
    document = JSON.parse(metadataJson);
  } catch {
    // A `geo` key that is not JSON is not a GeoParquet document.
    return null;
  }
  if (!document || typeof document !== "object") return null;

  const raw = document as Record<string, unknown>;
  const columnEntries =
    raw.columns && typeof raw.columns === "object"
      ? Object.entries(raw.columns as Record<string, unknown>).filter(
          (entry): entry is [string, Record<string, unknown>] =>
            typeof entry[1] === "object" && entry[1] !== null,
        )
      : [];
  if (columnEntries.length === 0) return null;

  return {
    version: typeof raw.version === "string" ? raw.version : null,
    primaryColumn: typeof raw.primary_column === "string" ? raw.primary_column : null,
    columns: columnEntries.map(([name, column]) => parseColumn(name, column)),
  };
}

/**
 * The metadata entry for the geometry column being read: the named column when
 * the document describes it, else the one `primary_column` names, else the first
 * column listed (so a hand-written document with a single geometry column still
 * resolves).
 *
 * The named column comes first because a GeoParquet may hold several geometry
 * columns in different CRSs; transforming the column the loader read with the
 * primary column's CRS would place the layer somewhere else entirely.
 *
 * @param metadata A parsed document, or null.
 * @param geometryColumn The column the loader actually detected, when known.
 */
export function geoParquetColumn(
  metadata: GeoParquetMetadata | null,
  geometryColumn?: string,
): GeoParquetColumnMetadata | null {
  if (!metadata || metadata.columns.length === 0) return null;
  for (const wanted of [geometryColumn, metadata.primaryColumn]) {
    if (typeof wanted !== "string") continue;
    const named = metadata.columns.find((column) => column.name === wanted);
    if (named) return named;
  }
  return metadata.columns[0];
}

function parseColumn(name: string, column: Record<string, unknown>): GeoParquetColumnMetadata {
  const parsed: GeoParquetColumnMetadata = {
    name,
    encoding: parseEncoding(column.encoding),
    geometryTypes: Array.isArray(column.geometry_types)
      ? column.geometry_types.filter((value): value is string => typeof value === "string")
      : [],
    crs: parseColumnCrs(column),
  };
  const bbox = parseBbox(column.bbox);
  if (bbox) parsed.bbox = bbox;
  const covering = parseCovering(column.covering);
  if (covering) parsed.covering = covering;
  if (column.edges === "planar" || column.edges === "spherical") parsed.edges = column.edges;
  if (typeof column.orientation === "string") parsed.orientation = column.orientation;
  return parsed;
}

/**
 * Normalise the `encoding` member: `WKB` case-insensitively (writers differ),
 * the GeoArrow encodings lower-cased, anything else verbatim.
 */
function parseEncoding(encoding: unknown): GeoParquetEncoding {
  // WKB is the specification default for a column that omits the member.
  if (typeof encoding !== "string") return "WKB";
  const trimmed = encoding.trim();
  if (!trimmed) return "WKB";
  const lower = trimmed.toLowerCase();
  if (lower === "wkb") return "WKB";
  if (GEOARROW_ENCODINGS.has(lower)) return lower as GeoParquetEncoding;
  return trimmed;
}

/**
 * The 2D box of a `bbox` member of any dimensionality.
 *
 * The specification orders a bbox with **all the minima first**: 2D is
 * `[xmin, ymin, xmax, ymax]`, but 3D is `[xmin, ymin, zmin, xmax, ymax, zmax]`
 * and XYZM is `[xmin, ymin, zmin, mmin, xmax, ymax, zmax, mmax]`. Taking the
 * first four elements of a 3D box would put `zmin`/`xmax` into the `xmax`/`ymax`
 * slots and produce a box that is not merely wrong but usually inverted.
 */
function parseBbox(bbox: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(bbox)) return undefined;
  const values = bbox.filter((value): value is number => typeof value === "number");
  if (values.length !== bbox.length) return undefined;
  if (values.length === 4) return [values[0], values[1], values[2], values[3]];
  if (values.length === 6) return [values[0], values[1], values[3], values[4]];
  if (values.length === 8) return [values[0], values[1], values[4], values[5]];
  return undefined;
}

/**
 * The 1.1 `covering.bbox` member, accepted only in its canonical shape: four
 * `["<struct column>", "<field>"]` paths sharing one root struct.
 *
 * A deeper path, or four paths spread over different roots, is a layout no
 * reader can turn into a usable pruning predicate, so it is ignored rather than
 * half-resolved.
 */
function parseCovering(covering: unknown): GeoParquetCovering | undefined {
  const bbox = (covering as { bbox?: unknown } | null | undefined)?.bbox;
  if (!bbox || typeof bbox !== "object") return undefined;

  const paths = (["xmin", "ymin", "xmax", "ymax"] as const).map((part) => {
    const path = (bbox as Record<string, unknown>)[part];
    if (!Array.isArray(path) || path.length !== 2) return null;
    const [root, child] = path;
    if (typeof root !== "string" || typeof child !== "string") return null;
    return { root, child };
  });
  const [xmin, ymin, xmax, ymax] = paths;
  if (!xmin || !ymin || !xmax || !ymax) return undefined;
  if (ymin.root !== xmin.root || xmax.root !== xmin.root || ymax.root !== xmin.root) {
    return undefined;
  }
  return {
    root: xmin.root,
    xmin: xmin.child,
    ymin: ymin.child,
    xmax: xmax.child,
    ymax: ymax.child,
  };
}

/** The `crs` member of one column entry, in its three specified states. */
function parseColumnCrs(column: Record<string, unknown>): GeoParquetCrs {
  if (!("crs" in column) || column.crs === undefined) return { kind: "default" };
  if (column.crs === null) return { kind: "undefined" };
  return parseCrsValue(column.crs);
}

/** A non-null `crs` value: PROJJSON, or a pre-1.0 draft's raw string. */
function parseCrsValue(crs: unknown): GeoParquetCrs {
  if (typeof crs === "string") {
    const trimmed = crs.trim();
    return trimmed ? { kind: "raw", value: trimmed } : { kind: "undefined" };
  }
  if (!crs || typeof crs !== "object") return { kind: "undefined" };

  const document = crs as Record<string, unknown>;
  const name = typeof document.name === "string" ? document.name : undefined;

  const id = projjsonId(document);
  if (id) {
    const { authority, code } = id;
    if (authority === "OGC") {
      const mapped = OGC_CRS_EPSG_CODES[code.toUpperCase()];
      if (mapped !== undefined) {
        return { kind: "authority", authority: "EPSG", code: String(mapped), epsg: mapped, name };
      }
    }
    const epsg = authority === "EPSG" && /^\d+$/.test(code) ? Number(code) : null;
    return { kind: "authority", authority, code, epsg, name };
  }

  // Id-less PROJJSON (a custom projection, or a geographic CRS on a datum with
  // no authority code) is identified by the document itself: PROJ parses
  // PROJJSON wherever it parses WKT, so ST_Transform still applies the datum
  // shift rather than the file being drawn at face value.
  return { kind: "projjson", document: JSON.stringify(crs), name };
}

/** The PROJJSON `id` member as an upper-cased authority and a textual code. */
function projjsonId(document: Record<string, unknown>): { authority: string; code: string } | null {
  const id = document.id;
  if (!id || typeof id !== "object") return null;
  const { authority, code } = id as { authority?: unknown; code?: unknown };
  if (typeof authority !== "string") return null;
  // PROJJSON allows the code as a number or a string; both spellings are seen
  // in the wild for the same CRS.
  if (typeof code !== "string" && typeof code !== "number") return null;
  const trimmedCode = String(code).trim();
  if (!trimmedCode) return null;
  return { authority: authority.trim().toUpperCase(), code: trimmedCode };
}

/**
 * Parse the free-form CRS string a Parquet 2.0 GEOMETRY/GEOGRAPHY logical type
 * carries. The Parquet specification leaves it deliberately open, so writers
 * disagree: PROJJSON, a JSON-quoted string, `EPSG:nnnn`, the CRS84 spellings and
 * `srid:0` are all in circulation.
 *
 * @param crs The logical type's CRS string, or null/undefined when it has none.
 */
export function parseLogicalTypeCrs(crs: string | null | undefined): GeoParquetCrs {
  // Absent means the Parquet default, which is OGC:CRS84 as in GeoParquet.
  if (crs === null || crs === undefined) return { kind: "default" };
  const trimmed = crs.trim();
  if (!trimmed) return { kind: "default" };

  const upper = trimmed.toUpperCase();
  if (upper === "OGC:CRS84" || upper === "CRS84" || upper === "EPSG:4326") {
    return { kind: "default" };
  }
  // `srid:0` is the "no SRID set" marker some writers emit, i.e. no known CRS.
  if (upper === "SRID:0") return { kind: "undefined" };

  if (trimmed.startsWith("{")) {
    try {
      const document: unknown = JSON.parse(trimmed);
      if (document && typeof document === "object") return parseCrsValue(document);
    } catch {
      // Not JSON after all; fall through to the remaining spellings.
    }
  }
  if (trimmed.startsWith('"')) {
    try {
      const inner: unknown = JSON.parse(trimmed);
      // A JSON-quoted plain string: unwrap it and apply the same rules.
      if (typeof inner === "string") return parseLogicalTypeCrs(inner);
    } catch {
      // Not JSON after all; fall through.
    }
  }
  const epsg = /^epsg:(\d+)$/i.exec(trimmed);
  if (epsg) {
    return {
      kind: "authority",
      authority: "EPSG",
      code: epsg[1],
      epsg: Number(epsg[1]),
    };
  }
  return { kind: "unknown", raw: trimmed };
}

/**
 * Parse the Parquet logical type DuckDB's `parquet_schema()` prints for a
 * geospatial column, or null for any other (or absent) logical type.
 *
 * DuckDB 1.5.4 renders these as `GeometryType(crs=<null>)` and
 * `GeographyType(crs=..., algorithm=...)`, with `<null>` standing for an absent
 * CRS. The rendering is not part of any specification, so the match is kept
 * deliberately loose: the type name decides, and a CRS that cannot be read still
 * leaves a usable "this column is native geospatial" answer.
 *
 * @param logicalType The `logical_type` cell from `parquet_schema()`.
 */
export function parseNativeGeometryLogicalType(
  logicalType: unknown,
): NativeGeometryLogicalType | null {
  if (typeof logicalType !== "string") return null;
  const match = /^\s*(geometry|geography)type\s*\(([\s\S]*)\)\s*$/i.exec(logicalType);
  if (!match) return null;
  const kind = match[1].toLowerCase() as "geometry" | "geography";
  const crsMatch = /(?:^|[(,\s])crs=([\s\S]*?)(?:,\s*[a-z_]+=|$)/i.exec(match[2]);
  const raw = crsMatch?.[1]?.trim() ?? "";
  return {
    kind,
    // `<null>` is how DuckDB prints an unset CRS; treat it as absent.
    crs: !raw || raw === "<null>" ? null : raw,
    // A GEOGRAPHY column's edges are great-circle arcs by definition.
    edges: kind === "geography" ? "spherical" : "planar",
  };
}

/**
 * A one-line label for what a file actually is, for the layer info surface:
 * `GeoParquet 1.1.0`, `GeoParquet 2.0.0 + native GEOMETRY logical type`,
 * `GeoParquet 2.0 (native GEOMETRY logical type, no geo metadata)`,
 * `none (guessed WKB column, CRS assumed OGC:CRS84)` or
 * `none (points synthesized from coordinate columns)`.
 *
 * A pure function of the parsed inputs, so the label is testable without a file.
 */
export function describeGeoParquet(input: GeoParquetDescriptionInput): string {
  const { metadata, hasNativeGeometryType = false, synthesizedFromCoordinates = false } = input;
  if (metadata) {
    const version = metadata.version ?? "unknown";
    return hasNativeGeometryType
      ? `GeoParquet ${version} + native GEOMETRY logical type`
      : `GeoParquet ${version}`;
  }
  if (hasNativeGeometryType) {
    return "GeoParquet 2.0 (native GEOMETRY logical type, no geo metadata)";
  }
  if (synthesizedFromCoordinates) {
    return "none (points synthesized from coordinate columns)";
  }
  return "none (guessed WKB column, CRS assumed OGC:CRS84)";
}

/**
 * The CRS in the `AUTHORITY:CODE` (or PROJJSON / WKT) form `ST_Transform`
 * accepts, or null when there is nothing to transform from — the two states
 * that mean "already in GeoJSON's convention" (`default`, `undefined`) and an
 * unparseable logical-type string.
 */
export function geoParquetCrsIdentifier(crs: GeoParquetCrs): string | null {
  switch (crs.kind) {
    case "authority":
      // The EPSG spelling when there is one: PROJ resolves it far more
      // reliably than OGC's or ESRI's own identifiers.
      return crs.epsg !== null ? `EPSG:${crs.epsg}` : `${crs.authority}:${crs.code}`;
    case "projjson":
      return crs.document;
    case "raw":
      return crs.value;
    default:
      return null;
  }
}
