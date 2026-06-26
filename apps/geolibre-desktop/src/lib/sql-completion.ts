import type { SqlWorkspaceTableColumns } from "./sql-workspace";

// SQL keywords offered by the workspace autocomplete. Upper-cased so an accepted
// keyword reads conventionally; matching is case-insensitive.
export const SQL_KEYWORDS: readonly string[] = [
  "SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "LIMIT", "OFFSET",
  "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "FULL JOIN", "ON",
  "AS", "AND", "OR", "NOT", "IN", "IS", "NULL", "LIKE", "ILIKE", "BETWEEN",
  "DISTINCT", "COUNT", "SUM", "AVG", "MIN", "MAX", "CASE", "WHEN", "THEN",
  "ELSE", "END", "HAVING", "UNION", "UNION ALL", "WITH", "DESC", "ASC",
];

// DuckDB scalar/aggregate and spatial (ST_*) functions plus the file readers the
// workspace exposes. Offered as completion candidates after a prefix match.
export const SQL_FUNCTIONS: readonly string[] = [
  // File / URL readers the workspace supports directly.
  "read_parquet", "read_csv_auto", "read_json_auto", "parquet_scan",
  // Common DuckDB spatial functions.
  "ST_Read", "ST_AsGeoJSON", "ST_AsText", "ST_GeomFromText", "ST_Point",
  "ST_MakePoint", "ST_Centroid", "ST_Area", "ST_Length", "ST_Buffer",
  "ST_Intersection", "ST_Intersects", "ST_Contains", "ST_Within",
  "ST_Distance", "ST_Envelope", "ST_Collect", "ST_Union", "ST_X", "ST_Y",
  "ST_Transform", "ST_SetSRID", "ST_GeometryType", "ST_IsValid",
  // Frequently used scalar functions.
  "COALESCE", "CAST", "ROUND", "ABS", "LOWER", "UPPER", "LENGTH", "CONCAT",
];

// Identifier characters that make up a completable SQL word. A leading digit is
// allowed inside the run so prefixes like `read_csv2` still complete.
const WORD_CHAR = /[A-Za-z0-9_]/;

// Cap the dropdown so a bare-prefix trigger cannot render hundreds of rows.
const MAX_CANDIDATES = 40;

/**
 * Find the identifier word immediately before `cursor`.
 *
 * @param text The full editor text.
 * @param cursor The caret offset to scan back from.
 * @returns The word prefix and the offset where it starts.
 */
export function wordPrefixAt(
  text: string,
  cursor: number,
): { prefix: string; start: number } {
  let start = cursor;
  while (start > 0 && WORD_CHAR.test(text[start - 1])) start -= 1;
  return { prefix: text.slice(start, cursor), start };
}

/**
 * Build ranked, de-duplicated completion candidates for a prefix. Loaded layer
 * table names rank first, then their columns, then SQL functions, then keywords,
 * so the most query-specific names surface at the top. Matching is
 * case-insensitive; an empty prefix offers only table and column names (the
 * "what can I query here" hint) rather than every keyword.
 *
 * @param prefix The identifier text typed so far (may be empty).
 * @param tables The loaded layers exposed as tables, with their columns.
 * @returns Candidate completions, ranked and capped.
 */
export function sqlCompletionCandidates(
  prefix: string,
  tables: SqlWorkspaceTableColumns[],
): string[] {
  const tableNames = tables.map((table) => table.tableName);
  const columnNames: string[] = [];
  const seenColumns = new Set<string>();
  for (const table of tables) {
    for (const column of table.columns) {
      const key = column.toLowerCase();
      if (seenColumns.has(key)) continue;
      seenColumns.add(key);
      columnNames.push(column);
    }
  }

  const lowerPrefix = prefix.toLowerCase();
  // With no prefix, only the layer-specific names are useful; offering every
  // keyword would bury them.
  const groups =
    lowerPrefix.length === 0
      ? [tableNames, columnNames]
      : [tableNames, columnNames, SQL_FUNCTIONS, SQL_KEYWORDS];

  const results: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const candidate of group) {
      if (!candidate.toLowerCase().startsWith(lowerPrefix)) continue;
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(candidate);
      if (results.length >= MAX_CANDIDATES) return results;
    }
  }
  return results;
}
