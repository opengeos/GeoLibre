/**
 * Table functions that generate rows instead of reading data, so a query whose
 * only FROM is one of these is still built from literals.
 */
const ROW_GENERATOR_TABLE_FUNCTIONS: ReadonlySet<string> = new Set([
  "range",
  "generate_series",
  "unnest",
]);

/**
 * List the data a query reads, from DuckDB's parsed form of it
 * (`json_serialize_sql`): every base table that is not one of the query's own
 * CTEs, and every table function that is not a row generator (`read_parquet`,
 * `ST_Read`, ...). Subqueries and CTE bodies are part of the tree, so a table
 * read anywhere in the statement counts. An empty list means nothing in the
 * query reads data: `SELECT ST_Point(100, 13) AS geom` or a `VALUES` list.
 *
 * This proves only that *some* data is read, not that the geometry column is
 * derived from it; `SELECT ST_Point(0, 0) FROM cities` still lists `cities`.
 *
 * @param ast The parsed `json_serialize_sql` output.
 * @returns Distinct source names, in first-seen order.
 */
export function collectQueryDataSources(ast: unknown): string[] {
  const cteNames = new Set<string>();
  const tables: string[] = [];
  const functions: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const cteMap = (record.cte_map as { map?: unknown } | undefined)?.map;
    if (Array.isArray(cteMap)) {
      for (const entry of cteMap) {
        const key = (entry as { key?: unknown } | null)?.key;
        if (typeof key === "string") cteNames.add(key.toLowerCase());
      }
    }
    if (record.type === "BASE_TABLE" && typeof record.table_name === "string") {
      tables.push(record.table_name);
    } else if (record.type === "TABLE_FUNCTION") {
      const name = (record.function as { function_name?: unknown } | undefined)?.function_name;
      if (typeof name === "string" && !ROW_GENERATOR_TABLE_FUNCTIONS.has(name.toLowerCase())) {
        functions.push(name);
      }
    }
    Object.values(record).forEach(visit);
  };
  visit(ast);
  const sources = [...tables.filter((name) => !cteNames.has(name.toLowerCase())), ...functions];
  return [...new Set(sources)];
}
