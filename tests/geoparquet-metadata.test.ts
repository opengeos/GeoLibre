import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectGeometryColumn,
  SYNTHESIZED_GEOMETRY_COLUMN,
} from "../apps/geolibre-desktop/src/lib/duckdb-geometry";
import {
  nativeGeometryColumn,
  parquetLogicalTypesSql,
  PARQUET_SCHEMA_LOGICAL_TYPE_COLUMN,
  PARQUET_SCHEMA_NAME_COLUMN,
  readGeoParquetGeoMetadata,
} from "../apps/geolibre-desktop/src/lib/geoparquet-crs";
import {
  describeGeoParquet,
  geoParquetColumn,
  geoParquetCrsIdentifier,
  parseGeoParquetMetadata,
  parseLogicalTypeCrs,
  parseNativeGeometryLogicalType,
  type GeoParquetCrs,
} from "../apps/geolibre-desktop/src/lib/geoparquet-metadata";

/** The EPSG code a parsed CRS can honestly claim, or null. */
function crsEpsg(crs: GeoParquetCrs): number | null {
  return crs.kind === "authority" ? crs.epsg : null;
}

/** A `geo` document with one column carrying the given members. */
function geoDocument(column: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: "1.1.0",
    primary_column: "geometry",
    columns: { geometry: { encoding: "WKB", ...column } },
    ...extra,
  });
}

/** The single parsed column of a one-column `geo` document. */
function onlyColumn(column: Record<string, unknown>) {
  const parsed = parseGeoParquetMetadata(geoDocument(column));
  assert.ok(parsed, "document should parse");
  return parsed.columns[0];
}

describe("parseGeoParquetMetadata", () => {
  it("reads the document-level members", () => {
    const parsed = parseGeoParquetMetadata(geoDocument({}));
    assert.equal(parsed?.version, "1.1.0");
    assert.equal(parsed?.primaryColumn, "geometry");
    assert.deepEqual(
      parsed?.columns.map((column) => column.name),
      ["geometry"],
    );
  });

  it("returns null for a file with no, unreadable, or geometry-less metadata", () => {
    assert.equal(parseGeoParquetMetadata(null), null);
    assert.equal(parseGeoParquetMetadata(undefined), null);
    assert.equal(parseGeoParquetMetadata(""), null);
    assert.equal(parseGeoParquetMetadata("not json"), null);
    assert.equal(parseGeoParquetMetadata("[1, 2]"), null);
    assert.equal(parseGeoParquetMetadata("{}"), null);
    assert.equal(parseGeoParquetMetadata(JSON.stringify({ columns: {} })), null);
    assert.equal(parseGeoParquetMetadata(JSON.stringify({ columns: { geometry: null } })), null);
  });

  it("leaves absent document members null rather than guessing", () => {
    const parsed = parseGeoParquetMetadata(JSON.stringify({ columns: { g: {} } }));
    assert.equal(parsed?.version, null);
    assert.equal(parsed?.primaryColumn, null);
  });
});

describe("encoding", () => {
  it("defaults to WKB and normalises the WKB spellings", () => {
    assert.equal(onlyColumn({ encoding: undefined }).encoding, "WKB");
    assert.equal(onlyColumn({ encoding: "wkb" }).encoding, "WKB");
    assert.equal(onlyColumn({ encoding: "  WKB " }).encoding, "WKB");
    assert.equal(onlyColumn({ encoding: 42 }).encoding, "WKB");
  });

  it("lower-cases the GeoArrow encodings", () => {
    for (const encoding of [
      "point",
      "linestring",
      "polygon",
      "multipoint",
      "multilinestring",
      "multipolygon",
    ]) {
      assert.equal(onlyColumn({ encoding: encoding.toUpperCase() }).encoding, encoding);
    }
  });

  it("keeps an unknown encoding verbatim so it can be reported", () => {
    assert.equal(onlyColumn({ encoding: "geoarrow.box" }).encoding, "geoarrow.box");
  });
});

describe("bbox", () => {
  it("passes a 2D bbox through", () => {
    assert.deepEqual(onlyColumn({ bbox: [-5, 41, 10, 51] }).bbox, [-5, 41, 10, 51]);
  });

  it("reads a 3D bbox as [xmin, ymin, xmax, ymax], not the first four elements", () => {
    // The spec orders every bbox minima-first: 3D is
    // [xmin, ymin, zmin, xmax, ymax, zmax]. Taking [0..3] would yield
    // [-5, 41, 0, 10] — a box whose "ymax" is the minimum elevation.
    assert.deepEqual(onlyColumn({ bbox: [-5, 41, 0, 10, 51, 200] }).bbox, [-5, 41, 10, 51]);
  });

  it("reads an XYZM bbox as elements 0, 1, 4 and 5", () => {
    assert.deepEqual(onlyColumn({ bbox: [-5, 41, 0, 1, 10, 51, 200, 9] }).bbox, [-5, 41, 10, 51]);
  });

  it("ignores a bbox of any other arity, or one holding a non-number", () => {
    assert.equal(onlyColumn({ bbox: [-5, 41, 10] }).bbox, undefined);
    assert.equal(onlyColumn({ bbox: [] }).bbox, undefined);
    assert.equal(onlyColumn({ bbox: [-5, 41, "10", 51] }).bbox, undefined);
    assert.equal(onlyColumn({ bbox: "-5,41,10,51" }).bbox, undefined);
  });
});

describe("covering", () => {
  const bbox = {
    xmin: ["bbox", "xmin"],
    ymin: ["bbox", "ymin"],
    xmax: ["bbox", "xmax"],
    ymax: ["bbox", "ymax"],
  };

  it("resolves the canonical [root, child] layout", () => {
    assert.deepEqual(onlyColumn({ covering: { bbox } }).covering, {
      root: "bbox",
      xmin: "xmin",
      ymin: "ymin",
      xmax: "xmax",
      ymax: "ymax",
    });
  });

  it("accepts differently-named children under one root", () => {
    assert.deepEqual(
      onlyColumn({
        covering: {
          bbox: {
            xmin: ["envelope", "minx"],
            ymin: ["envelope", "miny"],
            xmax: ["envelope", "maxx"],
            ymax: ["envelope", "maxy"],
          },
        },
      }).covering,
      {
        root: "envelope",
        xmin: "minx",
        ymin: "miny",
        xmax: "maxx",
        ymax: "maxy",
      },
    );
  });

  it("ignores four paths spread over different roots", () => {
    assert.equal(
      onlyColumn({ covering: { bbox: { ...bbox, ymax: ["other", "ymax"] } } }).covering,
      undefined,
    );
  });

  it("ignores a path that is not exactly [root, child]", () => {
    assert.equal(
      onlyColumn({ covering: { bbox: { ...bbox, xmin: ["bbox"] } } }).covering,
      undefined,
    );
    assert.equal(
      onlyColumn({ covering: { bbox: { ...bbox, xmin: ["a", "b", "c"] } } }).covering,
      undefined,
    );
    assert.equal(
      onlyColumn({ covering: { bbox: { ...bbox, xmin: ["bbox", 0] } } }).covering,
      undefined,
    );
  });

  it("ignores an incomplete or malformed covering", () => {
    assert.equal(onlyColumn({ covering: {} }).covering, undefined);
    assert.equal(onlyColumn({ covering: { bbox: {} } }).covering, undefined);
    assert.equal(onlyColumn({ covering: null }).covering, undefined);
  });
});

describe("edges, orientation and geometry_types", () => {
  it("reads the members it recognises", () => {
    const column = onlyColumn({
      edges: "spherical",
      orientation: "counterclockwise",
      geometry_types: ["Polygon", "MultiPolygon"],
    });
    assert.equal(column.edges, "spherical");
    assert.equal(column.orientation, "counterclockwise");
    assert.deepEqual(column.geometryTypes, ["Polygon", "MultiPolygon"]);
  });

  it("ignores an unrecognised edges value and a non-array geometry_types", () => {
    assert.equal(onlyColumn({ edges: "geodesic" }).edges, undefined);
    assert.deepEqual(onlyColumn({ geometry_types: "Polygon" }).geometryTypes, []);
    assert.deepEqual(onlyColumn({ geometry_types: ["Polygon", 3] }).geometryTypes, ["Polygon"]);
  });
});

describe("crs", () => {
  const crsOf = (column: Record<string, unknown>): GeoParquetCrs => onlyColumn(column).crs;

  it("distinguishes an absent crs member from an explicit null", () => {
    // Absent means the spec default, OGC:CRS84. Explicit null means the CRS is
    // undefined: the data is still drawn as CRS84 but nothing may claim so.
    assert.deepEqual(crsOf({}), { kind: "default" });
    assert.deepEqual(crsOf({ crs: undefined }), { kind: "default" });
    assert.deepEqual(crsOf({ crs: null }), { kind: "undefined" });
    assert.equal(crsEpsg(crsOf({ crs: null })), null);
    assert.equal(geoParquetCrsIdentifier(crsOf({ crs: null })), null);
  });

  it("reads the PROJJSON id with a numeric or string code", () => {
    assert.deepEqual(crsOf({ crs: { id: { authority: "EPSG", code: 2100 } } }), {
      kind: "authority",
      authority: "EPSG",
      code: "2100",
      epsg: 2100,
      name: undefined,
    });
    assert.equal(crsEpsg(crsOf({ crs: { id: { authority: "epsg", code: "2100" } } })), 2100);
  });

  it("keeps a non-EPSG authority without claiming an EPSG code", () => {
    const crs = crsOf({ crs: { id: { authority: "ESRI", code: 102100 } } });
    assert.equal(crsEpsg(crs), null);
    assert.equal(geoParquetCrsIdentifier(crs), "ESRI:102100");
  });

  it("maps the OGC geographic identifiers onto their EPSG codes", () => {
    // PROJ resolves the EPSG spellings far more reliably than OGC's own.
    assert.equal(crsEpsg(crsOf({ crs: { id: { authority: "OGC", code: "CRS84" } } })), 4326);
    assert.equal(crsEpsg(crsOf({ crs: { id: { authority: "OGC", code: "84" } } })), 4326);
    assert.equal(crsEpsg(crsOf({ crs: { id: { authority: "OGC", code: "CRS83" } } })), 4269);
    assert.equal(crsEpsg(crsOf({ crs: { id: { authority: "OGC", code: "CRS27" } } })), 4267);
  });

  it("keeps id-less PROJJSON as the document itself, whatever its type", () => {
    // ST_Transform takes a PROJJSON document wherever it takes WKT, so an
    // id-less CRS is handed over whole rather than reduced to an assumption.
    for (const document of [
      { type: "ProjectedCRS", name: "Custom Site Grid" },
      // A geographic CRS is already lon/lat degrees, but on an unstated datum:
      // passing the document lets PROJ apply the datum shift all the same.
      { type: "GeographicCRS", name: "Unknown datum" },
    ]) {
      const crs = crsOf({ crs: document });
      assert.deepEqual(crs, {
        kind: "projjson",
        document: JSON.stringify(document),
        name: document.name,
      });
      assert.equal(geoParquetCrsIdentifier(crs), JSON.stringify(document));
      assert.equal(crsEpsg(crs), null);
    }
  });

  it("passes a pre-1.0 WKT string through", () => {
    const wkt = 'PROJCS["Greek_Grid",GEOGCS["GCS_GGRS_1987"]]';
    assert.deepEqual(crsOf({ crs: wkt }), { kind: "raw", value: wkt });
    assert.equal(geoParquetCrsIdentifier(crsOf({ crs: wkt })), wkt);
  });

  it("treats a blank or non-object crs as undefined", () => {
    assert.deepEqual(crsOf({ crs: "   " }), { kind: "undefined" });
    assert.deepEqual(crsOf({ crs: 4326 }), { kind: "undefined" });
  });
});

describe("geoParquetColumn", () => {
  const metadata = parseGeoParquetMetadata(
    JSON.stringify({
      primary_column: "geom_4326",
      columns: {
        geom_2100: { crs: { id: { authority: "EPSG", code: 2100 } } },
        geom_4326: { crs: { id: { authority: "EPSG", code: 4326 } } },
      },
    }),
  );

  it("prefers the named column, then the primary, then the first listed", () => {
    assert.equal(geoParquetColumn(metadata, "geom_2100")?.name, "geom_2100");
    assert.equal(geoParquetColumn(metadata, "not_described")?.name, "geom_4326");
    assert.equal(geoParquetColumn(metadata)?.name, "geom_4326");
    assert.equal(geoParquetColumn(null), null);
  });
});

describe("parseLogicalTypeCrs", () => {
  it("treats an absent, blank or CRS84-equivalent string as the default", () => {
    for (const value of [
      null,
      undefined,
      "",
      "   ",
      "OGC:CRS84",
      "ogc:crs84",
      "CRS84",
      "epsg:4326",
    ]) {
      assert.deepEqual(parseLogicalTypeCrs(value), { kind: "default" }, `for ${String(value)}`);
    }
  });

  it("reads an EPSG code", () => {
    assert.equal(crsEpsg(parseLogicalTypeCrs("EPSG:2154")), 2154);
    assert.equal(crsEpsg(parseLogicalTypeCrs("epsg:2154")), 2154);
  });

  it("reads an embedded PROJJSON document", () => {
    const crs = parseLogicalTypeCrs(
      JSON.stringify({
        type: "ProjectedCRS",
        id: { authority: "EPSG", code: 2154 },
      }),
    );
    assert.equal(crsEpsg(crs), 2154);
  });

  it("unwraps a JSON-quoted string and applies the same rules", () => {
    assert.equal(crsEpsg(parseLogicalTypeCrs('"EPSG:2154"')), 2154);
    assert.deepEqual(parseLogicalTypeCrs('"OGC:CRS84"'), { kind: "default" });
  });

  it("treats srid:0 as an undefined CRS", () => {
    assert.deepEqual(parseLogicalTypeCrs("srid:0"), { kind: "undefined" });
    assert.deepEqual(parseLogicalTypeCrs("SRID:0"), { kind: "undefined" });
  });

  it("reports anything else as unknown rather than assuming CRS84", () => {
    assert.deepEqual(parseLogicalTypeCrs("my-grid"), {
      kind: "unknown",
      raw: "my-grid",
    });
    // Malformed JSON falls through to the same answer rather than throwing.
    assert.deepEqual(parseLogicalTypeCrs("{oops"), {
      kind: "unknown",
      raw: "{oops",
    });
    assert.equal(geoParquetCrsIdentifier(parseLogicalTypeCrs("my-grid")), null);
  });
});

describe("parseNativeGeometryLogicalType", () => {
  // The exact strings DuckDB 1.5.4's `parquet_schema()` prints in its
  // `logical_type` column. For a file written with GEOPARQUET_VERSION 'V2':
  //
  //   geometry  BYTE_ARRAY  GeometryType(crs=<null>)  BLOB
  //
  // DuckDB has no per-geometry SRID, so its own writer always emits
  // `crs=<null>`; `<null>` therefore means "no CRS on the type", not "CRS84
  // was written". The rendering is DuckDB's, not a Parquet specification, so
  // the parse is deliberately loose about spacing and extra fields.
  it("reads the GEOMETRY logical type DuckDB 1.5.4 prints", () => {
    assert.deepEqual(parseNativeGeometryLogicalType("GeometryType(crs=<null>)"), {
      kind: "geometry",
      crs: null,
      edges: "planar",
    });
  });

  it("reads a CRS off the type", () => {
    assert.deepEqual(parseNativeGeometryLogicalType("GeometryType(crs=EPSG:2154)"), {
      kind: "geometry",
      crs: "EPSG:2154",
      edges: "planar",
    });
  });

  it("treats GEOGRAPHY as spherical edges and skips the algorithm field", () => {
    assert.deepEqual(
      parseNativeGeometryLogicalType("GeographyType(crs=EPSG:4326, algorithm=SPHERICAL)"),
      { kind: "geography", crs: "EPSG:4326", edges: "spherical" },
    );
  });

  it("returns null for every other logical type", () => {
    assert.equal(parseNativeGeometryLogicalType("StringType()"), null);
    assert.equal(parseNativeGeometryLogicalType(null), null);
    assert.equal(parseNativeGeometryLogicalType(undefined), null);
    assert.equal(parseNativeGeometryLogicalType("IntType(bitWidth=32, isSigned=true)"), null);
  });
});

describe("parquetLogicalTypesSql and nativeGeometryColumn", () => {
  it("selects the schema element names and logical types of one file", () => {
    const sql = parquetLogicalTypesSql("o'brien.parquet");
    assert.match(sql, /parquet_schema\('o''brien\.parquet'\)/);
    assert.match(
      sql,
      new RegExp(`SELECT ${PARQUET_SCHEMA_NAME_COLUMN}, ${PARQUET_SCHEMA_LOGICAL_TYPE_COLUMN}`),
    );
    assert.match(sql, new RegExp(`WHERE ${PARQUET_SCHEMA_LOGICAL_TYPE_COLUMN} IS NOT NULL`));
  });

  it("finds the named geospatial column, else the first one", () => {
    const rows = [
      { name: "loc_id", logical_type: "StringType()" },
      { name: "geom_a", logical_type: "GeometryType(crs=EPSG:2154)" },
      {
        name: "geom_b",
        logical_type: "GeographyType(crs=<null>, algorithm=SPHERICAL)",
      },
    ];
    assert.equal(nativeGeometryColumn(rows)?.column, "geom_a");
    assert.equal(crsEpsg(nativeGeometryColumn(rows)!.parsedCrs), 2154);
    const geography = nativeGeometryColumn(rows, "geom_b");
    assert.equal(geography?.kind, "geography");
    assert.equal(geography?.edges, "spherical");
    assert.deepEqual(geography?.parsedCrs, { kind: "default" });
  });

  it("returns null when nothing in the schema is geospatial", () => {
    assert.equal(nativeGeometryColumn([{ name: "loc_id", logical_type: "StringType()" }]), null);
    assert.equal(nativeGeometryColumn([]), null);
  });
});

describe("describeGeoParquet", () => {
  const metadata = parseGeoParquetMetadata(geoDocument({}));

  it("labels a file that carries a geo block", () => {
    assert.equal(describeGeoParquet({ metadata }), "GeoParquet 1.1.0");
    assert.equal(
      describeGeoParquet({ metadata, hasNativeGeometryType: true }),
      "GeoParquet 1.1.0 + native GEOMETRY logical type",
    );
    assert.equal(
      describeGeoParquet({
        metadata: parseGeoParquetMetadata('{"columns":{"g":{}}}'),
      }),
      "GeoParquet unknown",
    );
  });

  it("labels a file that carries only the native logical type", () => {
    assert.equal(
      describeGeoParquet({ metadata: null, hasNativeGeometryType: true }),
      "GeoParquet 2.0 (native GEOMETRY logical type, no geo metadata)",
    );
  });

  it("labels the two guessed routes", () => {
    assert.equal(
      describeGeoParquet({ metadata: null }),
      "none (guessed WKB column, CRS assumed OGC:CRS84)",
    );
    assert.equal(
      describeGeoParquet({ metadata: null, synthesizedFromCoordinates: true }),
      "none (points synthesized from coordinate columns)",
    );
  });
});

// --- Variant-driven checks -------------------------------------------------
//
// One case per GeoParquet variant the app has to read. Each carries the `geo`
// document a writer would emit, the `DESCRIBE SELECT * FROM read_parquet(...)`
// rows DuckDB 1.5.4 (spatial loaded) reports for it, and the `parquet_schema()`
// logical types — so the parser is exercised over real-world shapes with no
// Parquet reader and no committed binary fixtures. The Parquet files these were
// taken from are written in-test by the sidecar suite
// (`backend/geolibre_server/tests/test_geoparquet_detection.py`) and the desktop
// cargo tests (`native_duckdb.rs`).

interface GeoParquetCase {
  /** What a writer produces, and why it is worth pinning. */
  name: string;
  /** The file's `geo` key, or null when it has none. */
  geo: string | null;
  versionLabel: string;
  version: string | null;
  primaryColumn: string | null;
  encoding: string | null;
  geometryTypes: string[];
  crs: { kind: string; epsg: number | null };
  sourceCrs: string | null;
  bbox: number[] | null;
  covering: Record<string, string> | null;
  edges: string | null;
  detectionRoute: string;
  geometryColumn?: string;
  coordinateColumns?: { x: string; y: string };
  nativeLogicalType?: { kind: string; crs: string | null; edges: string };
  /** What `parquet_schema()` prints for each element that carries one. */
  logicalTypes: Record<string, string>;
  schema: { column_name: string; column_type: string }[];
}

const cases: GeoParquetCase[] = [
  {
    name: "DuckDB's default GeoParquet output: 1.0.0, WKB, no covering",
    geo: `{
      "version": "1.0.0",
      "primary_column": "geometry",
      "columns": {
        "geometry": {
          "encoding": "WKB",
          "geometry_types": ["Point"],
          "bbox": [-71.2, 42.2, -70.82000000000001, 42.48235294117647]
        }
      }
    }`,
    versionLabel: "GeoParquet 1.0.0",
    version: "1.0.0",
    primaryColumn: "geometry",
    encoding: "WKB",
    geometryTypes: ["Point"],
    crs: { kind: "default", epsg: null },
    sourceCrs: null,
    bbox: [-71.2, 42.2, -70.82000000000001, 42.48235294117647],
    covering: null,
    edges: null,
    detectionRoute: "primary-column",
    geometryColumn: "geometry",
    logicalTypes: {},
    schema: [
      { column_name: "geometry", column_type: "GEOMETRY('ogc:crs84')" },
      { column_name: "id", column_type: "BIGINT" },
      { column_name: "name", column_type: "VARCHAR" },
    ],
  },
  {
    name: "1.1.0 with a declared covering bbox struct, EPSG:26986",
    geo: `{
      "version": "1.1.0",
      "primary_column": "geometry",
      "columns": {
        "geometry": {
          "encoding": "WKB",
          "geometry_types": ["Polygon"],
          "crs": {
            "type": "ProjectedCRS",
            "name": "NAD83 / Massachusetts Mainland",
            "id": { "authority": "EPSG", "code": 26986 }
          },
          "edges": "planar",
          "orientation": "counterclockwise",
          "bbox": [219985.0, 889985.0, 221775.0, 890175.0],
          "covering": {
            "bbox": {
              "xmin": ["bbox", "xmin"],
              "ymin": ["bbox", "ymin"],
              "xmax": ["bbox", "xmax"],
              "ymax": ["bbox", "ymax"]
            }
          }
        }
      }
    }`,
    versionLabel: "GeoParquet 1.1.0",
    version: "1.1.0",
    primaryColumn: "geometry",
    encoding: "WKB",
    geometryTypes: ["Polygon"],
    crs: { kind: "authority", epsg: 26986 },
    sourceCrs: "EPSG:26986",
    bbox: [219985.0, 889985.0, 221775.0, 890175.0],
    covering: { root: "bbox", xmin: "xmin", ymin: "ymin", xmax: "xmax", ymax: "ymax" },
    edges: "planar",
    detectionRoute: "primary-column",
    geometryColumn: "geometry",
    logicalTypes: { loc_id: "StringType()" },
    schema: [
      { column_name: "geometry", column_type: "GEOMETRY('epsg:26986')" },
      {
        column_name: "bbox",
        column_type: "STRUCT(xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE)",
      },
      { column_name: "id", column_type: "BIGINT" },
      { column_name: "loc_id", column_type: "VARCHAR" },
    ],
  },
  {
    name: "DuckDB GEOPARQUET_VERSION 'V2': a 2.0.0 geo block AND the Parquet GEOMETRY logical type",
    geo: `{
      "version": "2.0.0",
      "primary_column": "geometry",
      "columns": {
        "geometry": {
          "encoding": "WKB",
          "geometry_types": ["Point"],
          "bbox": [-71.2, 42.2, -70.82000000000001, 42.48235294117647]
        }
      }
    }`,
    versionLabel: "GeoParquet 2.0.0 + native GEOMETRY logical type",
    version: "2.0.0",
    primaryColumn: "geometry",
    encoding: "WKB",
    geometryTypes: ["Point"],
    crs: { kind: "default", epsg: null },
    sourceCrs: null,
    bbox: [-71.2, 42.2, -70.82000000000001, 42.48235294117647],
    covering: null,
    edges: null,
    detectionRoute: "primary-column",
    geometryColumn: "geometry",
    nativeLogicalType: { kind: "geometry", crs: null, edges: "planar" },
    // What DuckDB 1.5.4's parquet_schema() prints for a 2.0 file: the CRS
    // member is spelled `<null>`, not an empty string or a missing member.
    logicalTypes: { geometry: "GeometryType(crs=<null>)" },
    schema: [
      { column_name: "geometry", column_type: "GEOMETRY" },
      { column_name: "id", column_type: "BIGINT" },
    ],
  },
  {
    name: 'an explicit "crs": null — an undefined CRS, not the CRS84 default',
    geo: `{
      "version": "1.1.0",
      "primary_column": "geometry",
      "columns": {
        "geometry": {
          "encoding": "WKB",
          "geometry_types": ["Point"],
          "crs": null,
          "bbox": [0.0, 0.0, 2400.0, 500.0]
        }
      }
    }`,
    versionLabel: "GeoParquet 1.1.0",
    version: "1.1.0",
    primaryColumn: "geometry",
    encoding: "WKB",
    geometryTypes: ["Point"],
    crs: { kind: "undefined", epsg: null },
    sourceCrs: null,
    bbox: [0.0, 0.0, 2400.0, 500.0],
    covering: null,
    edges: null,
    detectionRoute: "primary-column",
    geometryColumn: "geometry",
    logicalTypes: {},
    schema: [
      { column_name: "geometry", column_type: "GEOMETRY" },
      { column_name: "id", column_type: "BIGINT" },
    ],
  },
  {
    name: "a 6-element 3D geo.bbox: [xmin, ymin, zmin, xmax, ymax, zmax]",
    geo: `{
      "version": "1.0.0",
      "primary_column": "geometry",
      "columns": {
        "geometry": {
          "encoding": "WKB",
          "geometry_types": ["Point Z"],
          "bbox": [-71.2, 42.2, 0.0, -70.82, 42.48235294117647, 49.0]
        }
      }
    }`,
    versionLabel: "GeoParquet 1.0.0",
    version: "1.0.0",
    primaryColumn: "geometry",
    encoding: "WKB",
    geometryTypes: ["Point Z"],
    crs: { kind: "default", epsg: null },
    sourceCrs: null,
    // The 3D bbox collapses to its 2D members: a reader that takes the first
    // four would get [xmin, ymin, zmin, xmax] and draw nothing.
    bbox: [-71.2, 42.2, -70.82, 42.48235294117647],
    covering: null,
    edges: null,
    detectionRoute: "primary-column",
    geometryColumn: "geometry",
    logicalTypes: {},
    schema: [
      { column_name: "geometry", column_type: "GEOMETRY('ogc:crs84')" },
      { column_name: "id", column_type: "BIGINT" },
    ],
  },
  {
    name: "plain Parquet: a WKB blob named `geom`, with no geo key at all",
    geo: null,
    versionLabel: "none (guessed WKB column, CRS assumed OGC:CRS84)",
    version: null,
    primaryColumn: null,
    encoding: null,
    geometryTypes: [],
    crs: { kind: "default", epsg: null },
    sourceCrs: null,
    bbox: null,
    covering: null,
    edges: null,
    detectionRoute: "wkb-column-name",
    geometryColumn: "geom",
    logicalTypes: {},
    schema: [
      { column_name: "geom", column_type: "BLOB" },
      { column_name: "id", column_type: "BIGINT" },
    ],
  },
  {
    name: "no geometry at all: a lon/lat pair of doubles, assumed OGC:CRS84",
    geo: null,
    versionLabel: "none (points synthesized from coordinate columns)",
    version: null,
    primaryColumn: null,
    encoding: null,
    geometryTypes: [],
    crs: { kind: "default", epsg: null },
    sourceCrs: null,
    bbox: null,
    covering: null,
    edges: null,
    detectionRoute: "coordinate-columns",
    coordinateColumns: { x: "lon", y: "lat" },
    logicalTypes: {},
    schema: [
      { column_name: "lon", column_type: "DOUBLE" },
      { column_name: "lat", column_type: "DOUBLE" },
      { column_name: "id", column_type: "BIGINT" },
      { column_name: "name", column_type: "VARCHAR" },
    ],
  },
];

describe("GeoParquet variants", () => {
  for (const expected of cases) {
    describe(expected.name, () => {
      const geoJson = expected.geo;
      const hasNativeGeometryType = Object.values(expected.logicalTypes).some(
        (type) => parseNativeGeometryLogicalType(type) !== null,
      );

      it("parses its geo metadata as expected", () => {
        const parsed = parseGeoParquetMetadata(geoJson);
        assert.equal(parsed?.version ?? null, expected.version);
        assert.equal(parsed?.primaryColumn ?? null, expected.primaryColumn);
        const column = geoParquetColumn(parsed);
        assert.equal(column?.encoding ?? null, expected.encoding);
        assert.deepEqual(column?.geometryTypes ?? [], expected.geometryTypes);
        assert.deepEqual(column?.bbox ?? null, expected.bbox ? expected.bbox : null);
        assert.deepEqual(column?.covering ?? null, expected.covering);
        assert.equal(column?.edges ?? null, expected.edges);
      });

      it("resolves its CRS as expected", () => {
        const geo = readGeoParquetGeoMetadata(geoJson);
        assert.equal(geo.crs.kind, expected.crs.kind);
        assert.equal(crsEpsg(geo.crs), expected.crs.epsg);
        assert.equal(geo.sourceCrs, expected.sourceCrs);
      });

      it("takes the expected detection route", () => {
        const parsed = parseGeoParquetMetadata(geoJson);
        const detected = detectGeometryColumn(expected.schema, {
          primaryColumn: parsed?.primaryColumn ?? undefined,
          allowCoordinateColumns: true,
        });
        assert.ok(detected, "a geometry must be detected");
        if (expected.detectionRoute === "coordinate-columns") {
          assert.equal(detected.column, SYNTHESIZED_GEOMETRY_COLUMN);
          assert.deepEqual(detected.coordinateColumns, expected.coordinateColumns);
        } else {
          assert.equal(detected.column, expected.geometryColumn);
          assert.equal(detected.coordinateColumns, undefined);
        }
      });

      it("is labelled as expected", () => {
        assert.equal(
          describeGeoParquet({
            metadata: parseGeoParquetMetadata(geoJson),
            hasNativeGeometryType,
            synthesizedFromCoordinates: expected.detectionRoute === "coordinate-columns",
          }),
          expected.versionLabel,
        );
      });

      it("reports its native logical type, when it has one", () => {
        const rows = Object.entries(expected.logicalTypes).map(([name, logical_type]) => ({
          name,
          logical_type,
        }));
        const native = nativeGeometryColumn(rows);
        if (!expected.nativeLogicalType) {
          assert.equal(native, null);
          return;
        }
        assert.equal(native?.kind, expected.nativeLogicalType.kind);
        assert.equal(native?.crs, expected.nativeLogicalType.crs);
        assert.equal(native?.edges, expected.nativeLogicalType.edges);
      });
    });
  }
});
