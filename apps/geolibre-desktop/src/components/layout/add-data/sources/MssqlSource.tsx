import {
  fetchMssqlStatus,
  listMssqlTables,
  readMssqlTable,
  type MssqlAuthMethod,
  type MssqlTableInfo,
} from "@geolibre/processing";
import { useAppStore } from "@geolibre/core";
import type en from "../../../../i18n/locales/en.json";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  MSSQL_AUTH_METHODS,
  findMssqlConnectionId,
  mssqlConnectionLabel,
  readSavedMssqlConnections,
  rememberMssqlConnection,
  savedMssqlSecret,
  type MssqlConnectionProfile,
  type MssqlStoredSecret,
} from "../../../../lib/saved-mssql-connections";
import {
  disconnectMssqlProfileSession,
  openMssqlSession,
  releaseMssqlSession,
  forgetMssqlProfile,
  discardMssqlProfileSession,
  requiredMssqlSecret,
  resolveMssqlSecret,
  withMssqlSession,
} from "../../../../lib/mssql-sessions";
import { rememberMssqlLoadedRows } from "../../../../lib/mssql-writeback";
import {
  databaseFeatureKeys,
  databaseTableKey,
  databaseTableLabel,
  uniqueDatabaseTables,
} from "../../../../lib/database-tables";
import { isDesktopRuntime, isWindows } from "../../../../lib/is-mobile";
import { IS_MAS_BUILD } from "../../../../lib/build-flags";
import { ignoreSidecarStartError, startGeoLibreSidecar } from "../../../../lib/sidecar";
import { createBaseLayer, errorMessage } from "../helpers";
import { AddDataSourceForm, useAddDataSource } from "../shared";
import type { OpenAddDataMssql } from "../open-add-data";

interface MssqlSourceProps {
  initialMssql?: OpenAddDataMssql;
}

const AUTH_LABEL_KEY: Record<MssqlAuthMethod, `addData.mssql.auth.${MssqlAuthMethod}`> = {
  sql: "addData.mssql.auth.sql",
  windows: "addData.mssql.auth.windows",
  entra_password: "addData.mssql.auth.entra_password",
  entra_sp: "addData.mssql.auth.entra_sp",
  entra_interactive: "addData.mssql.auth.entra_interactive",
  msi: "addData.mssql.auth.msi",
  token: "addData.mssql.auth.token",
};

type MssqlLabelKey = Exclude<keyof (typeof en)["addData"]["mssql"], "auth">;
export function MssqlSource({ initialMssql }: MssqlSourceProps) {
  const { t } = useTranslation();
  const source = useAddDataSource(t("addData.mssql.defaultName"));
  const desktopRuntime = useMemo(() => isDesktopRuntime(), []);
  const windowsHost = useMemo(() => isWindows(), []);
  const [savedProfiles, setSavedProfiles] = useState(readSavedMssqlConnections);
  const [selectedSavedId, setSelectedSavedId] = useState(() => {
    const requestedId = initialMssql?.connectionId;
    if (requestedId) {
      return savedProfiles.some((profile) => profile.id === requestedId) ? requestedId : "";
    }
    return savedProfiles[0]?.id ?? "";
  });
  const selectedSaved = savedProfiles.find((item) => item.id === selectedSavedId);
  const [server, setServer] = useState(() => selectedSaved?.server ?? "");
  const [port, setPort] = useState(() => String(selectedSaved?.port ?? 1433));
  const [database, setDatabase] = useState(() => selectedSaved?.database ?? "");
  const [encrypt, setEncrypt] = useState(() => selectedSaved?.encrypt ?? true);
  const [trustServerCertificate, setTrustServerCertificate] = useState(
    () => selectedSaved?.trustServerCertificate ?? false,
  );
  const [authMethod, setAuthMethod] = useState<MssqlAuthMethod>(
    () => selectedSaved?.authMethod ?? "sql",
  );
  const [username, setUsername] = useState(() => selectedSaved?.username ?? "");
  const [tenantId, setTenantId] = useState(() => selectedSaved?.tenantId ?? "");
  const [clientId, setClientId] = useState(() => selectedSaved?.clientId ?? "");
  const [password, setPassword] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [tables, setTables] = useState<MssqlTableInfo[]>([]);
  const [selectedTableKey, setSelectedTableKey] = useState("");
  const [selectedGeometryColumn, setSelectedGeometryColumn] = useState("");
  const [profileEvictionNotice, setProfileEvictionNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [activeProfileId, setActiveProfileId] = useState("");
  const listRequestRef = useRef(0);
  const connectFlightRef = useRef(0);
  const desiredTableRef = useRef(
    initialMssql?.table ? { schema: initialMssql.schema, table: initialMssql.table } : null,
  );

  const invalidateConnection = () => {
    if (activeProfileId && !source.isSubmitting) {
      disconnectMssqlProfileSession(activeProfileId);
    }
    listRequestRef.current += 1;
    setTables([]);
    setSelectedTableKey("");
    setSelectedGeometryColumn("");
    setActiveProfileId("");
    setStatus(null);
    desiredTableRef.current = null;
  };

  const changeSavedProfile = (id: string) => {
    const next = savedProfiles.find((item) => item.id === id);
    setSelectedSavedId(id);
    if (next) {
      setServer(next.server);
      setPort(String(next.port));
      setDatabase(next.database);
      setEncrypt(next.encrypt);
      setTrustServerCertificate(next.trustServerCertificate);
      setAuthMethod(next.authMethod);
      setUsername(next.username ?? "");
      setTenantId(next.tenantId ?? "");
      setClientId(next.clientId ?? "");
    } else {
      setServer("");
      setPort("1433");
      setDatabase("");
      setEncrypt(true);
      setTrustServerCertificate(false);
      setAuthMethod("sql");
      setUsername("");
      setTenantId("");
      setClientId("");
    }
    setPassword("");
    setClientSecret("");
    setAccessToken("");
    invalidateConnection();
  };

  const changeField = (change: () => void) => {
    change();
    setSelectedSavedId("");
    invalidateConnection();
  };
  const changeAuthMethod = (next: MssqlAuthMethod) => {
    changeField(() => {
      setAuthMethod(next);
      setUsername("");
      setTenantId("");
      setClientId("");
      setPassword("");
      setClientSecret("");
      setAccessToken("");
    });
  };
  const forgetSelectedProfile = () => {
    if (!selectedSaved) return;
    const name = mssqlConnectionLabel(selectedSaved, t);
    if (!window.confirm(t("addData.mssql.forgetConnectionConfirm", { name }))) return;
    setSavedProfiles(forgetMssqlProfile(selectedSaved.id));
    setProfileEvictionNotice(null);
    changeSavedProfile("");
  };

  const handleConnect = async () => {
    const requestToken = ++listRequestRef.current;
    const flightId = ++connectFlightRef.current;
    if (activeProfileId && !source.isSubmitting) {
      disconnectMssqlProfileSession(activeProfileId);
    }
    source.setError(null);
    setStatus(null);
    setProfileEvictionNotice(null);
    setTables([]);
    setSelectedTableKey("");
    setSelectedGeometryColumn("");
    setActiveProfileId("");
    source.shell.setIsSubmitting(true);
    let id = "";
    let openedSessionId: string | undefined;
    try {
      if (!desktopRuntime) throw new Error(t("addData.mssql.errorDesktopOnly"));
      if (IS_MAS_BUILD) throw new Error(t("masBuild.unavailable"));
      if (!server.trim()) throw new Error(t("addData.mssql.errorServer"));
      if (!database.trim()) throw new Error(t("addData.mssql.errorDatabase"));
      const portNumber = Number(port);
      if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
        throw new Error(t("addData.mssql.errorPort"));
      }
      const requiredField =
        authMethod === "sql" || authMethod === "entra_password"
          ? !username.trim()
            ? "username"
            : ""
          : authMethod === "entra_sp"
            ? !tenantId.trim()
              ? "tenantId"
              : !clientId.trim()
                ? "clientId"
                : ""
            : "";
      if (requiredField) {
        const fieldLabel = t(`addData.mssql.${requiredField}`);
        throw new Error(t("addData.mssql.errorMissingField", { field: fieldLabel }));
      }
      const draft: Omit<MssqlConnectionProfile, "id"> = {
        server: server.trim(),
        port: portNumber,
        database: database.trim(),
        encrypt,
        trustServerCertificate,
        authMethod,
        ...(username.trim() ? { username: username.trim() } : {}),
        ...(tenantId.trim() ? { tenantId: tenantId.trim() } : {}),
        ...(clientId.trim() ? { clientId: clientId.trim() } : {}),
      };
      id = findMssqlConnectionId(draft) ?? crypto.randomUUID();
      const profile: MssqlConnectionProfile = { ...draft, id };
      const secret: MssqlStoredSecret & { accessToken?: string } = {
        ...(password ? { password } : {}),
        ...(clientSecret ? { clientSecret } : {}),
        ...(accessToken ? { accessToken } : {}),
      };
      const resolved = resolveMssqlSecret(id, secret);
      const required = requiredMssqlSecret(authMethod);
      if (required && !resolved[required]) {
        throw new Error(
          t("addData.mssql.errorMissingField", { field: t(`addData.mssql.${required}`) }),
        );
      }
      // Best-effort: the status request below reports a missing runtime; only
      // a stale sidecar from an earlier session is surfaced from here.
      await startGeoLibreSidecar().catch(ignoreSidecarStartError);
      const runtime = await fetchMssqlStatus();
      if (!runtime.available)
        throw new Error(t("addData.mssql.errorRuntimeMissing", { detail: runtime.message }));
      if (!runtime.auth_methods.includes(authMethod))
        throw new Error(t("addData.mssql.errorAuthMethodUnavailable"));
      setStatus(
        t(
          authMethod === "entra_interactive"
            ? "addData.mssql.statusSigningIn"
            : "addData.mssql.statusConnecting",
        ),
      );
      openedSessionId = await openMssqlSession(profile, resolved);
      if (listRequestRef.current !== requestToken) {
        releaseMssqlSession(id, openedSessionId);
        return;
      }
      const listed = await listMssqlTables(openedSessionId);
      if (listRequestRef.current !== requestToken) {
        releaseMssqlSession(id, openedSessionId);
        return;
      }
      const remembered = rememberMssqlConnection(
        profile,
        resolved.password || resolved.clientSecret
          ? { password: resolved.password, clientSecret: resolved.clientSecret }
          : null,
      );
      for (const evicted of remembered.evictedProfiles) {
        discardMssqlProfileSession(evicted.id);
      }
      setSavedProfiles(remembered.profiles);
      if (remembered.evictedProfiles.length > 0) {
        setProfileEvictionNotice(
          t("addData.mssql.profileEvicted", {
            count: remembered.evictedProfiles.length,
            names: remembered.evictedProfiles
              .map((item) => mssqlConnectionLabel(item, t))
              .join(", "),
          }),
        );
      }
      setSelectedSavedId(id);
      setActiveProfileId(id);
      setTables(listed);
      const desired = desiredTableRef.current;
      const preferred =
        desired &&
        listed.find(
          (table) =>
            table.primary_key &&
            table.table === desired.table &&
            (!desired.schema || table.schema === desired.schema),
        );
      const chosen = preferred ?? listed.find((table) => table.primary_key);
      setSelectedTableKey(chosen ? databaseTableKey(chosen) : "");
      setSelectedGeometryColumn(chosen?.geometry_column ?? "");
      desiredTableRef.current = null;
      setStatus(
        listed.length
          ? t("addData.mssql.statusTablesFound", {
              count: new Set(listed.map(databaseTableKey)).size,
            })
          : t("addData.mssql.statusNoTables"),
      );
    } catch (error) {
      // A failed table-list request still owns an open session; this attempt
      // never reached the active-profile state, so release it on every failure.
      if (openedSessionId) releaseMssqlSession(id, openedSessionId);
      if (listRequestRef.current === requestToken) {
        source.setError(errorMessage(error, t("addData.mssql.errorConnect")));
        setStatus(null);
      }
    } finally {
      if (connectFlightRef.current === flightId) source.shell.setIsSubmitting(false);
    }
  };

  const uniqueTables = useMemo(() => uniqueDatabaseTables(tables), [tables]);
  const selectedGeometries = tables.filter((table) => databaseTableKey(table) === selectedTableKey);

  const handleSubmit = source.runSubmit(async () => {
    const table = tables.find(
      (item) =>
        databaseTableKey(item) === selectedTableKey &&
        item.geometry_column === selectedGeometryColumn,
    );
    if (!activeProfileId || !table) throw new Error(t("addData.mssql.errorConnectFirst"));
    if (!table.primary_key) throw new Error(t("addData.mssql.errorSelectTable"));
    const profileId = activeProfileId;
    const requestToken = listRequestRef.current;
    const result = await withMssqlSession(profileId, (sessionId) =>
      readMssqlTable({
        session_id: sessionId,
        schema_name: table.schema,
        table: table.table,
        geometry_column: table.geometry_column,
      }),
    );
    // The connection was changed or cleared while the read ran. Its cleanup was
    // deferred because a submit was in flight, so finish it here and do not
    // publish a layer the form no longer refers to.
    if (listRequestRef.current !== requestToken) {
      disconnectMssqlProfileSession(profileId);
      return;
    }
    const baselineKeys = databaseFeatureKeys(result.geojson);
    const savedProfile = readSavedMssqlConnections().find((item) => item.id === activeProfileId);
    if (!savedProfile) throw new Error(t("addData.mssql.errorReconnectRequired"));
    // `createBaseLayer` uses the features only to pick the initial style; the
    // layer itself must carry them, as the PostGIS source does.
    const layer = {
      ...createBaseLayer(
        source.layerName.trim() || table.table,
        "geojson",
        {
          type: "geojson",
          service: "mssql",
          schema: result.schema,
          table: result.table,
        },
        {
          featureCount: result.feature_count,
          sourceKind: "mssql-table",
          mssqlConnectionId: activeProfileId,
          mssqlConnectionLabel: mssqlConnectionLabel(savedProfile, t),
          mssqlSchema: result.schema,
          mssqlTable: result.table,
          mssqlPrimaryKey: result.primary_key,
          mssqlGeometryColumn: result.geometry_column,
          mssqlColumnType: result.column_type,
          mssqlSrid: result.srid,
          mssqlPrimaryKeyColumns: result.primary_key_columns,
          mssqlMixedGeometry: result.mixed_geometry,
          mssqlMixedSrid: result.mixed_srid,
          mssqlBaselineKeys: baselineKeys,
        },
        { geojson: result.geojson },
      ),
      geojson: result.geojson,
    };
    if (result.primary_key) {
      rememberMssqlLoadedRows(
        layer.id,
        useAppStore.getState().projectGeneration,
        result.primary_key,
        result.geojson,
      );
    }
    source.addAndClose(layer, { fit: true });
  });

  const savedSecret = selectedSavedId ? savedMssqlSecret(selectedSavedId) : undefined;
  const label = (key: MssqlLabelKey): string => t(`addData.mssql.${key}`);
  const geometryLabel = (table: MssqlTableInfo): string => {
    const geometryType =
      table.geometry_types.length > 1 ? table.geometry_types.join(" / ") : table.geometry_type;
    const srid = table.mixed_srid
      ? label("mixedSrids")
      : table.srid === 0
        ? label("sridUnknown")
        : `EPSG:${table.srid}`;
    return `${table.geometry_column} (${geometryType}, ${table.column_type}, ${srid})`;
  };
  return (
    <AddDataSourceForm
      layerName={source.layerName}
      onLayerNameChange={source.setLayerName}
      beforeLayerId={source.beforeLayerId}
      onBeforeLayerIdChange={source.setBeforeLayerId}
      onSubmit={handleSubmit}
      error={source.error}
      submitDisabled={source.isSubmitting || !selectedTableKey || !activeProfileId}
    >
      <div className="space-y-3">
        {!desktopRuntime ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {t("addData.mssql.desktopOnlyNotice")}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">{t("addData.mssql.editableNotice")}</p>
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor="mssql-saved">{label("savedConnection")}</Label>
            <Select
              id="mssql-saved"
              value={selectedSavedId}
              onChange={(event) => changeSavedProfile(event.target.value)}
            >
              <option value="">{label("selectSavedConnection")}</option>
              {savedProfiles.map((item) => (
                <option key={item.id} value={item.id}>
                  {mssqlConnectionLabel(item, t)}
                </option>
              ))}
            </Select>
          </div>
          {selectedSaved ? (
            <Button
              type="button"
              variant="outline"
              size="icon"
              title={label("forgetConnection")}
              aria-label={label("forgetConnection")}
              disabled={source.isSubmitting}
              onClick={forgetSelectedProfile}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="mssql-server">{label("server")}</Label>
            <Input
              id="mssql-server"
              placeholder={t("addData.mssql.serverPlaceholder")}
              value={server}
              onChange={(event) => changeField(() => setServer(event.target.value))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mssql-port">{label("port")}</Label>
            <Input
              id="mssql-port"
              inputMode="numeric"
              value={port}
              onChange={(event) => changeField(() => setPort(event.target.value))}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="mssql-database">{label("database")}</Label>
            <Input
              id="mssql-database"
              value={database}
              onChange={(event) => changeField(() => setDatabase(event.target.value))}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="mssql-auth">{label("authMethod")}</Label>
            <Select
              id="mssql-auth"
              value={authMethod}
              onChange={(event) => changeAuthMethod(event.target.value as MssqlAuthMethod)}
            >
              {MSSQL_AUTH_METHODS.map((method) => (
                <option key={method} value={method} disabled={method === "windows" && !windowsHost}>
                  {t(AUTH_LABEL_KEY[method])}
                </option>
              ))}
            </Select>
          </div>
        </div>
        {authMethod === "windows" && !windowsHost ? (
          <p className="text-xs text-muted-foreground">{label("authWindowsOnly")}</p>
        ) : null}
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={encrypt}
              onChange={(event) => changeField(() => setEncrypt(event.target.checked))}
            />
            {label("encrypt")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={trustServerCertificate}
              onChange={(event) =>
                changeField(() => setTrustServerCertificate(event.target.checked))
              }
            />
            {label("trustServerCertificate")}
          </label>
        </div>
        {authMethod === "sql" || authMethod === "entra_password" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="mssql-username">{label("username")}</Label>
              <Input
                id="mssql-username"
                value={username}
                onChange={(event) => changeField(() => setUsername(event.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mssql-password">{label("password")}</Label>
              <Input
                id="mssql-password"
                type="password"
                autoComplete="off"
                placeholder={
                  !password && savedSecret?.password
                    ? t("addData.mssql.passwordSavedPlaceholder")
                    : undefined
                }
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          </div>
        ) : null}
        {authMethod === "entra_sp" ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="mssql-tenant">{label("tenantId")}</Label>
              <Input
                id="mssql-tenant"
                value={tenantId}
                onChange={(event) => changeField(() => setTenantId(event.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mssql-client">{label("clientId")}</Label>
              <Input
                id="mssql-client"
                value={clientId}
                onChange={(event) => changeField(() => setClientId(event.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mssql-client-secret">{label("clientSecret")}</Label>
              <Input
                id="mssql-client-secret"
                type="password"
                autoComplete="off"
                placeholder={
                  !clientSecret && savedSecret?.clientSecret
                    ? t("addData.mssql.passwordSavedPlaceholder")
                    : undefined
                }
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
              />
            </div>
          </div>
        ) : null}
        {authMethod === "entra_interactive" ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="mssql-tenant">{label("tenantId")}</Label>
                <Input
                  id="mssql-tenant"
                  value={tenantId}
                  onChange={(event) => changeField(() => setTenantId(event.target.value))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mssql-client">{label("clientId")}</Label>
                <Input
                  id="mssql-client"
                  value={clientId}
                  onChange={(event) => changeField(() => setClientId(event.target.value))}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{label("interactiveNotice")}</p>
          </>
        ) : null}
        {authMethod === "msi" ? (
          <div className="space-y-1.5">
            <Label htmlFor="mssql-client">{label("clientId")}</Label>
            <Input
              id="mssql-client"
              value={clientId}
              onChange={(event) => changeField(() => setClientId(event.target.value))}
            />
          </div>
        ) : null}
        {authMethod === "token" ? (
          <div className="space-y-1.5">
            <Label htmlFor="mssql-token">{label("accessToken")}</Label>
            <Input
              id="mssql-token"
              type="password"
              autoComplete="off"
              value={accessToken}
              onChange={(event) => setAccessToken(event.target.value)}
            />
          </div>
        ) : null}
        <Button
          type="button"
          variant="outline"
          onClick={() => void handleConnect()}
          disabled={source.isSubmitting || !desktopRuntime}
        >
          {label("connect")}
        </Button>
        {status ? <p className="text-xs text-muted-foreground">{status}</p> : null}
        {profileEvictionNotice ? (
          <p role="status" className="text-xs text-amber-700 dark:text-amber-300">
            {profileEvictionNotice}
          </p>
        ) : null}
        {tables.length > 0 ? (
          <div className="space-y-1.5">
            <Label htmlFor="mssql-table">{label("editableTable")}</Label>
            <Select
              id="mssql-table"
              value={selectedTableKey}
              onChange={(event) => {
                setSelectedTableKey(event.target.value);
                const chosen = tables.find(
                  (table) => databaseTableKey(table) === event.target.value,
                );
                setSelectedGeometryColumn(chosen?.geometry_column ?? "");
              }}
            >
              <option value="">{label("errorSelectTable")}</option>
              {uniqueTables.map((table) => {
                const key = databaseTableKey(table);
                const title = databaseTableLabel(table);
                const optionLabel = `${title} — ${geometryLabel(table)}`;
                const readOnlyLabel =
                  table.primary_key_columns.length > 1
                    ? t("addData.mssql.tableReadOnlyComposite", {
                        table: title,
                        columns: table.primary_key_columns.join(", "),
                      })
                    : t("addData.mssql.tableReadOnly", { table: title });
                return (
                  <option key={key} value={key} disabled={!table.primary_key}>
                    {table.primary_key ? optionLabel : `${readOnlyLabel} — ${geometryLabel(table)}`}
                  </option>
                );
              })}
            </Select>
          </div>
        ) : null}
        {selectedGeometries.length > 1 ? (
          <div className="space-y-1.5">
            <Label htmlFor="mssql-geometry">{label("geometryColumn")}</Label>
            <Select
              id="mssql-geometry"
              value={selectedGeometryColumn}
              onChange={(event) => setSelectedGeometryColumn(event.target.value)}
            >
              {selectedGeometries.map((table) => (
                <option key={table.geometry_column} value={table.geometry_column}>
                  {geometryLabel(table)}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
      </div>
    </AddDataSourceForm>
  );
}
