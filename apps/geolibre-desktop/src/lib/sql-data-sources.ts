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
 * CTEs in scope where it is read, and every table function other than the row
 * generators (`range`, `generate_series`, `unnest`), so readers such as
 * `read_parquet` and `ST_Read` count. Subqueries and CTE bodies are part of the tree, so a table
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
  const tables: string[] = [];
  const functions: string[] = [];
  // `visible` holds the lower-cased CTE names in scope at `node`. A CTE only
  // shadows table references inside the query that defines it, so a table read
  // elsewhere in the statement under the same name still counts as data.
  const visit = (node: unknown, visible: ReadonlySet<string>): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, visible);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const cteEntries = (record.cte_map as { map?: unknown } | undefined)?.map;
    let scope = visible;
    if (Array.isArray(cteEntries) && cteEntries.length > 0) {
      // Each CTE body sees the outer scope plus the CTEs defined before it; a
      // non-recursive CTE naming itself (`WITH t AS (SELECT * FROM t)`) reads
      // the real table `t`. Only a recursive CTE body sees its own name.
      const names = new Set(visible);
      for (const entry of cteEntries) {
        const { key, value } = (entry ?? {}) as { key?: unknown; value?: unknown };
        const name = typeof key === "string" ? key.toLowerCase() : null;
        const body = (value as { query?: { node?: { type?: unknown } } } | undefined)?.query;
        const recursive = body?.node?.type === "RECURSIVE_CTE_NODE";
        visit(value, recursive && name ? new Set([...names, name]) : new Set(names));
        if (name) names.add(name);
      }
      scope = names;
    }
    if (record.type === "BASE_TABLE" && typeof record.table_name === "string") {
      // DuckDB resolves a CTE only for an unqualified name, so `main.cities`
      // reads the real table even when a `cities` CTE is in scope.
      const qualified =
        (typeof record.schema_name === "string" && record.schema_name !== "") ||
        (typeof record.catalog_name === "string" && record.catalog_name !== "");
      if (qualified || !scope.has(record.table_name.toLowerCase())) tables.push(record.table_name);
    } else if (record.type === "TABLE_FUNCTION") {
      const name = (record.function as { function_name?: unknown } | undefined)?.function_name;
      if (typeof name === "string" && !ROW_GENERATOR_TABLE_FUNCTIONS.has(name.toLowerCase())) {
        functions.push(name);
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (key !== "cte_map") visit(value, scope);
    }
  };
  visit(ast, new Set());
  // DuckDB identifiers are case-insensitive, so `Cities` and `cities` are one
  // source; keep the first spelling seen.
  const seen = new Set<string>();
  return [...tables, ...functions].filter((name) => {
    const folded = name.toLowerCase();
    if (seen.has(folded)) return false;
    seen.add(folded);
    return true;
  });
}
