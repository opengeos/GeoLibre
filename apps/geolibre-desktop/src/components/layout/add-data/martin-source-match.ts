/**
 * Pure matcher for pairing a clicked Browser-panel table with the Martin source
 * that publishes it. Extracted from PostgresSource so it unit-tests without the
 * React component and its sidecar/Martin dependencies.
 */

/**
 * Whether a Martin source (auto-published one-per-table) is the given schema +
 * table. Martin names public-schema sources by the bare table and others by
 * `schema.table`. The bare form is only matched for the public (or unknown)
 * schema, so a `public.roads` source can't be mis-selected for a clicked
 * `other_schema.roads` when two schemas reuse a table name.
 *
 * @param sourceId - The Martin catalog source id.
 * @param schema - The clicked table's schema, or undefined when unknown.
 * @param table - The clicked table's name.
 * @returns True when `sourceId` names that schema's table.
 */
export function martinSourceMatchesTable(
  sourceId: string,
  schema: string | undefined,
  table: string,
): boolean {
  if (schema && schema !== "public") {
    return sourceId === `${schema}.${table}`;
  }
  return sourceId === table || sourceId === `public.${table}`;
}
