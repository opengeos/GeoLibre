/**
 * Apache Iceberg vector support (pure half).
 *
 * Iceberg tables are read through DuckDB's `iceberg` extension plus `spatial`:
 * `iceberg_scan()` (or a table in an ATTACHed REST catalog) yields the rows,
 * and `ST_AsGeoJSON` turns the geometry column into features. This module holds
 * everything that is *not* DuckDB — the persisted layer config, the table
 * selection rule, and the SQL builders — so it stays importable under the node
 * test runner and by the eagerly-loaded UI shell. The engine half lives in
 * `iceberg-loader.ts`, which pulls in DuckDB-WASM.
 *
 * Iceberg tables are routinely far larger than anything else GeoLibre ingests,
 * so a load is always **explicit and bounded**: the user picks a table, the row
 * limit caps the materialized GeoJSON, and the resulting layer is deliberately
 * excluded from timer-driven refresh (see `supportsAutoRefresh` in
 * `layer-refresh.ts`). Re-reading a table is a manual action.
 */

import type { FeatureCollection } from "geojson";
import type { GeoLibreLayer } from "@geolibre/core";
import { quoteIdentifier, quoteSqlString } from "./duckdb-geometry";

/** `metadata.sourceKind` tag carried by every layer loaded from an Iceberg table. */
export const ICEBERG_SOURCE_KIND = "iceberg-table";

/**
 * Alias the REST catalog is ATTACHed under. Fixed (rather than derived from the
 * warehouse name) so the persisted table SQL is stable across sessions: the
 * loader always attaches to this name before running a catalog-mode scan.
 */
export const ICEBERG_CATALOG_ALIAS = "geolibre_iceberg";

/** Rows materialized per load when the user does not choose otherwise. */
export const DEFAULT_ICEBERG_ROW_LIMIT = 5_000;

/**
 * Hard ceiling on the row limit. The result is materialized as an in-memory
 * GeoJSON FeatureCollection and embedded in the saved project, so a limit past
 * this stops being a limit at all — the browser runs out of memory first.
 */
export const MAX_ICEBERG_ROW_LIMIT = 1_000_000;

/**
 * How the table is reached: a single table addressed by its metadata location,
 * or a table inside an ATTACHed Iceberg REST catalog.
 */
export type IcebergMode = "table" | "catalog";

/** One table a catalog exposes (or the single table of a direct location). */
export interface IcebergTableRef {
  /** Namespace / schema inside the catalog; absent in table mode. */
  schema?: string;
  /** Table name, or the derived display name of a direct location. */
  name: string;
}

/** The Iceberg definition persisted on a layer and replayed on a manual reload. */
export interface IcebergLayerConfig {
  mode: IcebergMode;
  /**
   * Table mode: the table's metadata JSON URL (or table directory).
   * Catalog mode: the warehouse the REST catalog serves.
   */
  location: string;
  /** Catalog mode: the Iceberg REST catalog endpoint. */
  endpoint?: string;
  /** The table to scan. Required in catalog mode; the sole table otherwise. */
  table?: IcebergTableRef;
  /** Maximum rows read per load, already clamped. */
  rowLimit: number;
  /**
   * Which GEOMETRY column to read, when the source exposes more than one.
   * Unset means the first one, which is the only case for most tables.
   */
  geometryColumn?: string;
  /**
   * A SQL statement to read instead of the whole table — the Iceberg equivalent
   * of the DuckDB layer's query box. When set it replaces the generated
   * `SELECT * FROM ...` as the scan's source, so a `WHERE`, a join, or a
   * projection decides which geometries are rendered.
   *
   * No CRS is persisted alongside it: the coordinate system is read from the
   * geometry column's own type on every load (see {@link icebergTransformCrs}),
   * so a table re-projected upstream stays correct without the layer carrying a
   * stale copy.
   */
  sql?: string;
}

/** A column as reported by `DESCRIBE`, used to drive the geometry-column picker. */
export interface IcebergColumn {
  name: string;
  type: string;
}

/** What an inspected table reports before the user commits to loading it. */
export interface IcebergTableInfo {
  /**
   * Only the columns DuckDB reports as `GEOMETRY`. Iceberg v3 has a real
   * geometry type, so anything else is an attribute — offering a plain BLOB or
   * VARCHAR as a geometry candidate just invites a load that fails deep in
   * `ST_AsGeoJSON`.
   */
  geometryColumns: IcebergColumn[];
  /** Total rows the source returns (from manifest metadata for a whole table). */
  rowCount: number;
  /** The geometry column that will be read, or null when there is none. */
  geometryColumn: string | null;
  /**
   * The CRS that column declares, verbatim, for display — e.g. `OGC:CRS84`.
   * Null when the type carries no CRS parameter (Iceberg's default, CRS84).
   */
  crs: string | null;
}

/**
 * The CRS an Iceberg geometry column has when its type names none. Fixed by the
 * Iceberg specification, and mirrored by DuckDB's iceberg extension as
 * `IcebergConstants::DefaultGeometryCRS`. Shown in the dialog so a table without
 * an explicit CRS still reports what it is being read as.
 */
export const DEFAULT_ICEBERG_CRS = "OGC:CRS84";

// Iceberg's default geometry CRS is `OGC:CRS84` (DuckDB's iceberg extension
// hard-codes the same value in `IcebergConstants::DefaultGeometryCRS`), which is
// lon/lat WGS84 — exactly GeoJSON's own convention. These identifiers therefore
// need no reprojection at all. `EPSG:4326` is included because its authority
// axis order is lat/lon but every producer that names it here stores lon/lat,
// and a transform to WGS84 with `always_xy` would be a no-op anyway.
const GEOJSON_EQUIVALENT_CRS = new Set(["OGC:CRS84", "CRS84", "EPSG:4326", "WGS84"]);

/**
 * The CRS named by a DuckDB column type, or null when it carries none.
 *
 * DuckDB renders a CRS-annotated geometry as `GEOMETRY(<crs>)` (the literal
 * `GEOMETRY(%s)` format string in the engine), and a plain one as `GEOMETRY`.
 * Surrounding quotes are tolerated because the spatial extension's own
 * geometry type renders its CRS quoted.
 *
 * @param columnType The `column_type` a `DESCRIBE` reported.
 * @returns The CRS identifier as written, or null.
 */
export function icebergCrsFromColumnType(columnType: unknown): string | null {
  if (typeof columnType !== "string") return null;
  const match = /^GEOMETRY\s*\((.*)\)\s*$/is.exec(columnType.trim());
  if (!match) return null;
  const crs = match[1]
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .trim();
  return crs === "" ? null : crs;
}

/**
 * The CRS to reproject a geometry column from, or null when it is already in
 * GeoJSON's coordinate convention and must be passed through untouched.
 *
 * This is what removes the manual "Source CRS" field: Iceberg records the
 * coordinate system in the column type itself, so the layer reads it rather than
 * asking. A table with no CRS parameter is CRS84 by specification.
 *
 * @param columnType The `column_type` a `DESCRIBE` reported.
 * @returns A CRS for `ST_Transform`, or null to skip reprojection.
 */
export function icebergTransformCrs(columnType: unknown): string | null {
  const crs = icebergCrsFromColumnType(columnType);
  if (!crs) return null;
  return GEOJSON_EQUIVALENT_CRS.has(crs.toUpperCase()) ? null : crs;
}

/**
 * Clamp a user-entered row limit into `[1, MAX_ICEBERG_ROW_LIMIT]`, falling back
 * to the default for anything non-numeric. Also applied when reading a
 * hand-edited project file, so a stored `0` or `1e12` cannot uncap a load.
 */
export function clampIcebergRowLimit(value: unknown): number {
  const numeric = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric < 1) {
    return DEFAULT_ICEBERG_ROW_LIMIT;
  }
  return Math.min(MAX_ICEBERG_ROW_LIMIT, Math.floor(numeric));
}

/**
 * Normalize a location or endpoint as typed: trim, and drop a trailing slash so
 * the same table entered with and without one produces one config.
 *
 * Cloud schemes (`s3://`, `gs://`, `az://`) are deliberately **not** rewritten
 * to their HTTPS gateways the way `rewriteCloudUrls` does for the SQL Workspace.
 * An Iceberg table's manifests record absolute data-file paths, so rewriting the
 * root the user typed would leave every path inside the table untouched and the
 * scan would fail halfway with a far more confusing error. Such a location is
 * passed to DuckDB as-is and resolves only when httpfs has credentials for it.
 */
export function normalizeIcebergLocation(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length > 1 && trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

/**
 * The table a newly listed catalog should start on: the only one when the
 * catalog holds exactly one, otherwise null so the user must choose. This is
 * the whole of the "specify a table, or default to the only table" rule — the
 * dialog preselects what this returns and leaves the submit disabled otherwise.
 *
 * @param tables The tables the catalog reported.
 * @returns The sole table, or null when there is a choice to make (or nothing).
 */
export function selectDefaultIcebergTable(
  tables: readonly IcebergTableRef[],
): IcebergTableRef | null {
  return tables.length === 1 ? tables[0] : null;
}

/** Stable key for a table ref, used as the `<option>` value and for lookups. */
export function icebergTableKey(table: IcebergTableRef): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

/** Human label for a table ref (identical to its key; kept separate so the
 * displayed form can diverge from the lookup key without touching callers). */
export function icebergTableLabel(table: IcebergTableRef): string {
  return icebergTableKey(table);
}

/**
 * Derive a layer/table name from a direct table location: the table directory,
 * skipping Iceberg's `metadata` directory and the metadata JSON file itself so
 * `.../warehouse/taxis/metadata/v3.metadata.json` reads as `taxis`.
 *
 * @param location A metadata JSON URL or a table directory.
 * @returns The derived name, or "Iceberg table" when nothing usable remains.
 */
export function icebergNameFromLocation(location: string): string {
  const withoutQuery = location.split(/[?#]/)[0];
  const segments = withoutQuery.split("/").filter((segment) => segment.length > 0);
  // Drop a trailing metadata file and the `metadata` directory it sits in.
  while (segments.length > 0) {
    const last = segments[segments.length - 1];
    if (last.endsWith(".json") || last.endsWith(".avro") || last.toLowerCase() === "metadata") {
      segments.pop();
      continue;
    }
    break;
  }
  const name = segments[segments.length - 1];
  return name && !name.includes(":") ? name : "Iceberg table";
}

/**
 * The `ATTACH` statement for a catalog-mode connection. Always aliases to
 * {@link ICEBERG_CATALOG_ALIAS} so {@link buildIcebergSourceSql} can name the
 * catalog without the config carrying a runtime-chosen alias.
 */
export function buildIcebergAttachSql(config: IcebergLayerConfig): string {
  const options = ["TYPE ICEBERG"];
  if (config.endpoint) options.push(`ENDPOINT ${quoteSqlString(config.endpoint)}`);
  return (
    `ATTACH ${quoteSqlString(config.location)} AS ${quoteIdentifier(ICEBERG_CATALOG_ALIAS)} ` +
    `(${options.join(", ")})`
  );
}

/** The `DETACH` statement matching {@link buildIcebergAttachSql}. */
export function buildIcebergDetachSql(): string {
  return `DETACH ${quoteIdentifier(ICEBERG_CATALOG_ALIAS)}`;
}

/**
 * The generated `SELECT * FROM ...` for the configured table: a qualified name
 * inside the attached catalog, or an `iceberg_scan` over the table's own
 * metadata location.
 *
 * Also what the dialog pre-fills its SQL box with, so the user edits a working
 * statement rather than composing the `iceberg_scan` call by hand.
 *
 * @throws When catalog mode carries no selected table — the caller must resolve
 *   the selection (see {@link selectDefaultIcebergTable}) before scanning.
 */
export function buildIcebergDefaultSql(config: IcebergLayerConfig): string {
  if (config.mode === "catalog") {
    const table = config.table;
    if (!table) {
      throw new Error("Select an Iceberg table to read.");
    }
    const qualified = [ICEBERG_CATALOG_ALIAS, ...(table.schema ? [table.schema] : []), table.name]
      .map(quoteIdentifier)
      .join(".");
    return `SELECT * FROM ${qualified}`;
  }
  return `SELECT * FROM iceberg_scan(${quoteSqlString(config.location)})`;
}

/**
 * Trim a user-supplied statement into something that can be wrapped as a
 * sub-select: a trailing semicolon would break `FROM (<sql>) AS ...`.
 *
 * Only the terminator is handled here. Rejecting *multiple* statements needs
 * literal-aware masking, which lives in `sql-workspace.ts` alongside the DuckDB
 * engine, so the loader does that check.
 */
export function normalizeIcebergSql(sql: string): string {
  return sql
    .trim()
    .replace(/;+\s*$/, "")
    .trim();
}

/**
 * The FROM-able expression the scan actually reads: the user's own statement
 * when the SQL box is filled in, otherwise the generated whole-table select.
 *
 * @throws When catalog mode carries no selected table and no custom statement.
 */
export function buildIcebergSourceSql(config: IcebergLayerConfig): string {
  const custom = config.sql ? normalizeIcebergSql(config.sql) : "";
  return custom || buildIcebergDefaultSql(config);
}

/**
 * Wrap the source in the bounded read the loader materializes: the attribute
 * columns plus the GeoJSON rendering of the geometry, capped at the row limit.
 *
 * `excludeColumns` is how a table with several geometry columns stays sane. The
 * caller passes **every** GEOMETRY column, including the one being rendered: the
 * rendered column is already carried by the `ST_AsGeoJSON` alias, and the others
 * would otherwise ride the wildcard into feature properties and be embedded in
 * the saved project — as an unreadable binary blob at best, and as many
 * megabytes of it across a 50k-row load. Excluding them also trims what crosses
 * the Arrow boundary.
 *
 * @param sourceSql A FROM-able sub-select (see {@link buildIcebergSourceSql}).
 * @param geometryJsonSql The `ST_AsGeoJSON(...)` expression for the geometry.
 * @param geometryJsonColumn Alias the GeoJSON text is exposed under.
 * @param rowLimit Maximum rows to materialize.
 * @param excludeColumns Columns to drop from the wildcard; empty omits the
 *   clause entirely, since DuckDB rejects an empty `EXCLUDE`.
 */
export function buildIcebergSelectSql(
  sourceSql: string,
  geometryJsonSql: string,
  geometryJsonColumn: string,
  rowLimit: number,
  excludeColumns: readonly string[] = [],
): string {
  const exclude =
    excludeColumns.length > 0 ? ` EXCLUDE (${excludeColumns.map(quoteIdentifier).join(", ")})` : "";
  return (
    `SELECT *${exclude}, ${geometryJsonSql} AS ${quoteIdentifier(geometryJsonColumn)} ` +
    `FROM (${sourceSql}) AS iceberg_source LIMIT ${clampIcebergRowLimit(rowLimit)}`
  );
}

/**
 * The geometry column a picker should land on after the source is re-described:
 * the one already chosen when it is still there, otherwise the first available.
 *
 * Re-inspection happens whenever the SQL box is edited, and without this the
 * chosen column would be silently reset to the first every time — losing a
 * deliberate pick with no indication. Kept here, rather than inline in the
 * dialog, so the rule is unit-testable.
 *
 * @param current The currently selected column name (may be empty).
 * @param columns The GEOMETRY columns the source now exposes.
 * @returns The column to select, or `""` when the source has none.
 */
export function keepOrDefaultGeometryColumn(
  current: string,
  columns: readonly IcebergColumn[],
): string {
  if (current && columns.some((column) => column.name === current)) return current;
  return columns[0]?.name ?? "";
}

/** Build the metadata blob a loaded Iceberg layer carries. */
export function icebergLayerMetadata(config: IcebergLayerConfig): Record<string, unknown> {
  return { sourceKind: ICEBERG_SOURCE_KIND, iceberg: config };
}

/**
 * Read and validate the Iceberg definition from a layer's metadata.
 *
 * Tolerates hand-edited project files the way {@link getSqlQueryLayerConfig}
 * does: anything malformed yields null, so the layer behaves as a plain GeoJSON
 * snapshot instead of offering a reload that would fail confusingly later.
 *
 * @param layer The candidate layer (only `metadata` is inspected).
 * @returns The validated config, or null when the layer is not an Iceberg layer.
 */
export function getIcebergLayerConfig(
  layer: Pick<GeoLibreLayer, "metadata">,
): IcebergLayerConfig | null {
  if (layer.metadata.sourceKind !== ICEBERG_SOURCE_KIND) return null;
  const candidate = layer.metadata.iceberg;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const { mode, location, endpoint, table, rowLimit, geometryColumn, sql } = candidate as Record<
    string,
    unknown
  >;
  if (mode !== "table" && mode !== "catalog") return null;
  if (typeof location !== "string" || location.trim() === "") return null;

  const parsedTable = parseTableRef(table);
  // A catalog scan names a table inside the attached catalog, so without one
  // there is nothing to read; a direct location is the table.
  if (mode === "catalog" && !parsedTable) return null;

  return {
    mode,
    location,
    ...(typeof endpoint === "string" && endpoint.trim() !== "" ? { endpoint } : {}),
    ...(parsedTable ? { table: parsedTable } : {}),
    rowLimit: clampIcebergRowLimit(rowLimit),
    ...(typeof geometryColumn === "string" && geometryColumn.trim() !== ""
      ? { geometryColumn }
      : {}),
    ...(typeof sql === "string" && normalizeIcebergSql(sql) !== ""
      ? { sql: normalizeIcebergSql(sql) }
      : {}),
  };
}

function parseTableRef(value: unknown): IcebergTableRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { name, schema } = value as Record<string, unknown>;
  if (typeof name !== "string" || name.trim() === "") return null;
  return {
    name,
    ...(typeof schema === "string" && schema.trim() !== "" ? { schema } : {}),
  };
}

/**
 * True when the layer is a GeoJSON snapshot read from an Iceberg table, and so
 * can be reloaded on demand — but never on a timer.
 *
 * @param layer The candidate layer.
 * @returns Whether the layer replays an Iceberg scan on refresh.
 */
export function isIcebergLayer(layer: Pick<GeoLibreLayer, "metadata" | "type">): boolean {
  return layer.type === "geojson" && getIcebergLayerConfig(layer) !== null;
}

/**
 * Re-read an Iceberg layer's table using the definition stored on it.
 *
 * Only ever called from an explicit user action (the layer menu's Refresh) —
 * Iceberg layers are excluded from timer-driven refresh, because re-scanning a
 * table of this size on a schedule is never what the user meant.
 *
 * The DuckDB engine is pulled in with a dynamic import so this module stays
 * importable without the WASM bundle (mirroring `refreshSqlQueryLayer`).
 *
 * @param layer The Iceberg layer to reload.
 * @returns The refreshed features and the counts describing the row cap.
 * @throws When the layer carries no valid Iceberg definition, or the scan fails
 *   (DuckDB's message is surfaced as-is).
 */
export async function refreshIcebergLayer(layer: GeoLibreLayer): Promise<{
  geojson: FeatureCollection;
  featureCount: number;
  totalRows: number;
  truncated: boolean;
}> {
  const config = getIcebergLayerConfig(layer);
  if (!config) {
    throw new Error("This layer does not carry an Iceberg table definition.");
  }
  const { loadIcebergTable } = await import("./iceberg-loader");
  const result = await loadIcebergTable(config);
  return {
    geojson: result.geojson,
    featureCount: result.featureCount,
    totalRows: result.totalRows,
    truncated: result.truncated,
  };
}
