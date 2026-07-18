import type { AddDataKind } from "./types";

/** Window event letting any panel open the Add Data dialog at a given kind. */
export const OPEN_ADD_DATA_EVENT = "geolibre:open-add-data";

/**
 * Optional prefill payload for the PostgreSQL source, so the Browser panel can
 * open the dialog on a specific saved connection (and, when a table was clicked,
 * that table) rather than the default first-saved connection.
 */
export interface OpenAddDataPostgres {
  /** libpq connection string to preselect in the PostgreSQL source. */
  connection: string;
  /** Schema of the table to preselect (with {@link table}). */
  schema?: string;
  /** Table to preselect once connected. */
  table?: string;
}

/** The detail carried by {@link OPEN_ADD_DATA_EVENT}. */
export interface OpenAddDataDetail {
  kind: AddDataKind;
  /** Prefill for the PostgreSQL source (only meaningful when `kind` is "postgres"). */
  postgres?: OpenAddDataPostgres;
}

/**
 * Open the Add Data dialog preselected to `kind` from anywhere in the app,
 * without prop-drilling (mirrors {@link openSettingsSection}). TopToolbar owns
 * the dialog and its kind state and listens for this event. Used by the Browser
 * panel's per-source "New connection" action and its PostGIS table nodes.
 *
 * @param kind - The Add Data source to open (e.g. "wms", "wfs", "xyz").
 * @param options - Optional source-specific prefill (currently `postgres`).
 */
export function openAddData(kind: AddDataKind, options?: { postgres?: OpenAddDataPostgres }): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<OpenAddDataDetail>(OPEN_ADD_DATA_EVENT, {
      detail: { kind, postgres: options?.postgres },
    }),
  );
}
