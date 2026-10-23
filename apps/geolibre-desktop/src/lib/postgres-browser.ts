import { fetchPostgisStatus, listPostgisTables } from "@geolibre/processing";
import type { TFunction } from "i18next";
import { errorMessage } from "../components/layout/add-data/helpers";
import { uniqueDatabaseTables } from "./database-tables";
import { isDesktopRuntime } from "./is-mobile";
import { ignoreSidecarStartError, startGeoLibreSidecar } from "./sidecar";
import type { BrowserNode, ConnectionLoad, SetConnectionLoads } from "./browser-tree";
import {
  forgetPostgresConnection,
  PostgresConnectionForgetError,
  type PostgresConnectionForgetResult,
} from "./saved-postgres-connections";
import { notify } from "./notify";

export interface PostgresBrowserLoaderDependencies {
  isDesktop: () => boolean;
  startSidecar: typeof startGeoLibreSidecar;
  fetchStatus: typeof fetchPostgisStatus;
  listTables: typeof listPostgisTables;
}

const defaultDependencies: PostgresBrowserLoaderDependencies = {
  isDesktop: isDesktopRuntime,
  startSidecar: startGeoLibreSidecar,
  fetchStatus: fetchPostgisStatus,
  listTables: listPostgisTables,
};

/**
 * Lazily introspect a desktop PostgreSQL connection once per successful load.
 * Publish loading/error/table state; failures clear the fetched marker for retry.
 * Completions from generations invalidated by forget or retry are ignored.
 */
export function fetchPostgresBrowserTables(
  connectionString: string,
  fetched: Set<string>,
  generations: Map<string, number>,
  setLoads: SetConnectionLoads,
  t: TFunction,
  dependencies: PostgresBrowserLoaderDependencies = defaultDependencies,
): void {
  if (fetched.has(connectionString)) return;
  const generation = (generations.get(connectionString) ?? 0) + 1;
  generations.set(connectionString, generation);
  fetched.add(connectionString);
  const update = (load: ConnectionLoad) =>
    setLoads((previous) =>
      generations.get(connectionString) === generation
        ? { ...previous, [connectionString]: load }
        : previous,
    );

  // PostGIS browsing needs the desktop sidecar/Martin, so outside the
  // desktop shell show the same localized "requires GeoLibre Desktop"
  // message the Add Data dialog gives rather than letting
  // startGeoLibreSidecar/fetch fail with a raw network error. The gate is
  // isDesktopRuntime(), not isTauri(): the packaged mobile apps are Tauri
  // too and have no sidecar to reach (GeoLibre#2091). Dropped from the
  // fetched set so it can retry on desktop.
  if (!dependencies.isDesktop()) {
    fetched.delete(connectionString);
    update({
      status: "error",
      message: t("addData.postgres.errorDesktopOnly"),
    });
    return;
  }
  update({ status: "loading" });
  // The desktop sidecar is spawned on demand and only authenticated after
  // startGeoLibreSidecar runs, so ensure it is up before hitting /postgis —
  // best-effort, mirroring PostgresSource.handleConnectEditable (a failed
  // start still lets the status/list calls surface the real error, except a
  // stale sidecar from an earlier session, which is surfaced directly).
  void dependencies
    .startSidecar()
    .catch(ignoreSidecarStartError)
    .then(() => dependencies.fetchStatus())
    .then((status) => {
      // Same runtime gate as the Add Data dialog, so a missing postgis
      // extra reads as the friendly "install the extra" message rather
      // than a raw connection error from /postgis/tables.
      if (!status.available) {
        throw new Error(t("addData.postgres.errorRuntimeMissing"));
      }
      return dependencies.listTables(connectionString);
    })
    .then((tables) => {
      if (generations.get(connectionString) !== generation) return;
      // geometry_columns returns one row per geometry column, so a table
      // with several geometry columns appears several times; keep the first
      // because the Browser tree represents tables, while the Add Data
      // dialog provides the geometry-column picker after a table is chosen.
      const unique = uniqueDatabaseTables(tables).map(({ schema, table }) => ({
        schema,
        table,
      }));
      update({ status: "loaded", tables: unique });
    })
    .catch((err: unknown) => {
      if (generations.get(connectionString) !== generation) return;
      // Allow a retry: drop the fetched marker so collapsing and
      // re-expanding the connection re-runs introspection rather than
      // sticking on the error. Reuse the Add Data errorMessage helper for a
      // translated fallback, matching the dialog's PostGIS entry point.
      fetched.delete(connectionString);
      update({
        status: "error",
        message: errorMessage(err, t("addData.postgres.errorConnect")),
      });
    });
}

export type SetBrowserExpanded = (update: (previous: Set<string>) => Set<string>) => void;

/**
 * Forgets a saved DSN, then drops its cached load, fetched marker and expansion
 * so a re-saved copy starts collapsed and loads on first expand. Throws before
 * touching Browser state when the saved connection cannot be removed.
 */
export function forgetPostgresBrowserConnection(
  connectionString: string,
  nodeId: string,
  fetched: Set<string>,
  generations: Map<string, number>,
  setLoads: SetConnectionLoads,
  setExpanded: SetBrowserExpanded,
  forget: (connectionString: string) => PostgresConnectionForgetResult = forgetPostgresConnection,
): Promise<boolean> {
  const { credentialDeleted } = forget(connectionString);
  const generation = (generations.get(connectionString) ?? 0) + 1;
  generations.set(connectionString, generation);
  fetched.delete(connectionString);
  setLoads((previous) => {
    if (generations.get(connectionString) !== generation) return previous;
    const next = { ...previous };
    delete next[connectionString];
    return next;
  });
  setExpanded((previous) => {
    if (!previous.has(nodeId)) return previous;
    const next = new Set(previous);
    next.delete(nodeId);
    return next;
  });
  return credentialDeleted;
}

/** Confirm removal and report each failure independently using the masked node label. */
export function confirmForgetPostgresBrowserConnection(
  node: BrowserNode,
  fetched: Set<string>,
  generations: Map<string, number>,
  setLoads: SetConnectionLoads,
  setExpanded: SetBrowserExpanded,
  t: TFunction,
  forget: (connectionString: string) => PostgresConnectionForgetResult = forgetPostgresConnection,
): boolean {
  const connectionString = node.connectionString;
  if (node.kind !== "connection" || !connectionString || node.mssqlConnectionId) return false;
  if (!window.confirm(t("addData.postgres.forgetConnectionConfirm", { name: node.label }))) {
    return false;
  }
  let credentialDeleted: Promise<boolean>;
  try {
    credentialDeleted = forgetPostgresBrowserConnection(
      connectionString,
      node.id,
      fetched,
      generations,
      setLoads,
      setExpanded,
      forget,
    );
  } catch (error) {
    if (!(error instanceof PostgresConnectionForgetError)) throw error;
    notify.error(t("browser.forgetPostgresConnectionFailed"), {
      description: node.label,
    });
    return false;
  }
  void credentialDeleted.then((deleted) => {
    if (!deleted) {
      notify.warning(t("browser.forgetPostgresCredentialFailed"), {
        description: node.label,
        durationMs: null,
      });
    }
  });
  return true;
}
