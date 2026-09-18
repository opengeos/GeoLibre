export interface PostgisTableIdentity {
  schema: string;
  table: string;
}

export function postgisTableKey(table: PostgisTableIdentity): string {
  return JSON.stringify([table.schema, table.table]);
}

export function postgisTableLabel(table: PostgisTableIdentity): string {
  return `${table.schema}.${table.table}`;
}
