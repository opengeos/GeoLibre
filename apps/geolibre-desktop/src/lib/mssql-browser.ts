import { fetchMssqlStatus, listMssqlTables } from "@geolibre/processing";
import type { TFunction } from "i18next";
import { isDesktopRuntime } from "./is-mobile";
import { ignoreSidecarStartError, startGeoLibreSidecar } from "./sidecar";
import {
  MssqlReconnectRequiredError,
  forgetMssqlProfile,
  withMssqlSession,
} from "./mssql-sessions";
import { errorMessage } from "../components/layout/add-data/helpers";
import type { ConnectionLoad, SetConnectionLoads } from "./browser-tree";
import { uniqueDatabaseTables } from "./database-tables";

export interface MssqlBrowserLoaderDependencies {
  isDesktop: () => boolean;
  startSidecar: typeof startGeoLibreSidecar;
  fetchStatus: typeof fetchMssqlStatus;
  listTables: typeof listMssqlTables;
  withSession: typeof withMssqlSession;
}

const defaultDependencies: MssqlBrowserLoaderDependencies = {
  isDesktop: isDesktopRuntime,
  startSidecar: startGeoLibreSidecar,
  fetchStatus: fetchMssqlStatus,
  listTables: listMssqlTables,
  withSession: withMssqlSession,
};

export function fetchMssqlBrowserTables(
  connectionId: string,
  fetched: Set<string>,
  setLoads: SetConnectionLoads,
  t: TFunction,
  dependencies: MssqlBrowserLoaderDependencies = defaultDependencies,
): void {
  if (fetched.has(connectionId)) return;
  fetched.add(connectionId);
  const key = `mssql:${connectionId}`;
  const update = (load: ConnectionLoad) => setLoads((previous) => ({ ...previous, [key]: load }));

  if (!dependencies.isDesktop()) {
    fetched.delete(connectionId);
    update({ status: "error", message: t("addData.mssql.errorDesktopOnly") });
    return;
  }
  update({ status: "loading" });
  void dependencies
    .startSidecar()
    .catch(ignoreSidecarStartError)
    .then(() => dependencies.fetchStatus())
    .then((status) => {
      if (!status.available) {
        throw new Error(t("addData.mssql.errorRuntimeMissing", { detail: status.message }));
      }
      return dependencies.withSession(connectionId, (sessionId) =>
        dependencies.listTables(sessionId),
      );
    })
    .then((tables) => {
      update({ status: "loaded", tables: uniqueDatabaseTables(tables) });
    })
    .catch((error: unknown) => {
      fetched.delete(connectionId);
      update({
        status: "error",
        message:
          error instanceof MssqlReconnectRequiredError
            ? t(
                error.reason === "secret-missing"
                  ? "addData.mssql.errorBrowserMissingSecret"
                  : "addData.mssql.errorReconnectRequired",
              )
            : errorMessage(error, t("addData.mssql.errorConnect")),
      });
    });
}

/**
 * Forget a saved SQL Server profile from the Browser: drop its saved profile,
 * credential and session, and its cached table load so a profile saved again
 * later under the same id is fetched afresh.
 */
export function forgetMssqlBrowserConnection(
  connectionId: string,
  fetched: Set<string>,
  setLoads: SetConnectionLoads,
  forget: (profileId: string) => unknown = forgetMssqlProfile,
): void {
  forget(connectionId);
  fetched.delete(connectionId);
  setLoads((previous) => {
    const next = { ...previous };
    delete next[`mssql:${connectionId}`];
    return next;
  });
}
