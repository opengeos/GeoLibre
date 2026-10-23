import type { GeoLibreLayer } from "@geolibre/core";

// The table-name half of the SQL workspace, split from sql-workspace.ts so the
// assistant (and its node tests) can compute a layer's queryable table name
// without importing DuckDB-WASM. sql-workspace.ts re-exports everything here.

// DuckDB reserved keywords cannot be used as unquoted identifiers, so a layer
// named e.g. "Group" would sanitize to `group` and break `SELECT * FROM group`.
// Such names are prefixed with `t_` to stay valid in the SQL the user types.
const RESERVED_TABLE_NAMES = new Set([
  "all",
  "analyse",
  "analyze",
  "and",
  "any",
  "array",
  "as",
  "asc",
  "asymmetric",
  "both",
  "case",
  "cast",
  "check",
  "collate",
  "column",
  "constraint",
  "create",
  "default",
  "deferrable",
  "desc",
  "describe",
  "distinct",
  "do",
  "else",
  "end",
  "except",
  "false",
  "fetch",
  "for",
  "foreign",
  "from",
  "grant",
  "group",
  "having",
  "in",
  "initially",
  "intersect",
  "into",
  "lateral",
  "leading",
  "limit",
  "not",
  "null",
  "offset",
  "on",
  "only",
  "or",
  "order",
  "pivot",
  "placing",
  "primary",
  "qualify",
  "references",
  "returning",
  "select",
  "show",
  "some",
  "symmetric",
  "table",
  "then",
  "to",
  "trailing",
  "true",
  "union",
  "unique",
  "using",
  "variadic",
  "when",
  "where",
  "window",
  "with",
  // DuckDB-specific keywords beyond the ANSI set above.
  "anti",
  "asof",
  "by",
  "glob",
  "ilike",
  "like",
  "macro",
  "map",
  "positional",
  "semi",
  "struct",
  "summarize",
  "try_cast",
  "unpivot",
  "values",
  "virtual",
]);

/** A loaded layer exposed to the workspace as a DuckDB table. */
export interface SqlWorkspaceTable {
  /** SQL identifier the user references in queries. */
  tableName: string;
  /** Human-readable layer name the table was derived from. */
  layerName: string;
}

/**
 * Turn a layer name into a valid, lower-case SQL identifier. Non-alphanumeric
 * runs collapse to underscores and a leading digit is prefixed so the result is
 * always a usable bare identifier; an empty result falls back to `layer_<id>`.
 */
function sanitizeTableName(layerName: string, layerId: string): string {
  const base = layerName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_/, "")
    .replace(/_$/, "");

  if (!base) {
    return `layer_${layerId.replace(/[^a-z0-9]+/gi, "_")}`;
  }

  // A leading digit or a reserved keyword is prefixed with `t_` so the name is
  // a usable bare identifier in the SQL the user writes.
  if (!/^[a-z_]/.test(base) || RESERVED_TABLE_NAMES.has(base)) {
    return `t_${base}`;
  }

  return base;
}

/**
 * Assign a unique table name to each layer that carries an in-memory GeoJSON
 * FeatureCollection. Names are derived from layer names and de-duplicated with a
 * numeric suffix on collision. Shared by registration and the UI preview so the
 * names cannot drift.
 */
export function assignTableNames(
  layers: GeoLibreLayer[],
): Array<{ layer: GeoLibreLayer; tableName: string }> {
  const assigned: Array<{ layer: GeoLibreLayer; tableName: string }> = [];
  const usedNames = new Set<string>();
  for (const layer of layers) {
    if (!layer.geojson) continue;
    const baseName = sanitizeTableName(layer.name, layer.id);
    let tableName = baseName;
    let suffix = 2;
    while (usedNames.has(tableName)) {
      tableName = `${baseName}_${suffix}`;
      suffix += 1;
    }
    usedNames.add(tableName);
    assigned.push({ layer, tableName });
  }
  return assigned;
}

/**
 * Compute the table names the workspace will expose for the given layers,
 * without touching DuckDB, so the UI can show queryable table names before a
 * query runs.
 *
 * @param layers Current app layers; those without `geojson` are skipped.
 * @returns The tables, in the same order and naming as registration.
 */
export function previewLayerTables(layers: GeoLibreLayer[]): SqlWorkspaceTable[] {
  return assignTableNames(layers).map(({ layer, tableName }) => ({
    tableName,
    layerName: layer.name,
  }));
}
