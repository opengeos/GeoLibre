/**
 * Hand-off channel for opening the SQL Workspace with a prefilled query (the
 * "edit this layer's query" shortcut on SQL query layers). The panel is
 * lazy-mounted only while open, so the query is parked here and either consumed
 * by the panel's mount effect (panel was closed) or applied in response to the
 * event (panel already open). Kept out of the Zustand store because the value
 * is transient UI hand-off state, not app state worth persisting or observing.
 */

/** Window event fired when a prefill query is requested. */
export const SQL_WORKSPACE_PREFILL_EVENT = "geolibre:sql-workspace-prefill";

let pendingQuery: string | null = null;

/**
 * Park a query for the SQL Workspace and notify a mounted panel. The caller
 * should open the workspace (setSqlWorkspaceOpen) after calling this so a
 * closed panel consumes the query on mount.
 *
 * @param sql The SQL statement to load into the editor.
 */
export function requestSqlWorkspaceQuery(sql: string): void {
  pendingQuery = sql;
  window.dispatchEvent(new Event(SQL_WORKSPACE_PREFILL_EVENT));
}

/**
 * Take the parked query, clearing it so it is applied exactly once.
 *
 * @returns The pending SQL statement, or null when none is parked.
 */
export function consumePendingSqlWorkspaceQuery(): string | null {
  const value = pendingQuery;
  pendingQuery = null;
  return value;
}
