import {
  fetchPostgisStatus,
  listPostgisTables,
  readPostgisTable,
  type PostgisTableInfo,
} from "@geolibre/processing";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ensureMartinBinary,
  fetchMartinCatalog,
  fetchMartinTileJson,
  martinTileJsonUrl,
  startMartinServer,
  stopMartinServer,
} from "../../../../lib/martin";
import { postgisFeatureKeys, registerPostgisConnection } from "../../../../lib/postgis-connections";
import { startGeoLibreSidecar } from "../../../../lib/sidecar";
import { isTauri } from "../../../../lib/tauri-io";
import {
  createBaseLayer,
  errorMessage,
  readSavedPostgresConnections,
  rememberPostgresConnection,
  savedPostgresConnectionLabel,
} from "../helpers";
import { AddDataSourceForm, useAddDataSource } from "../shared";
import { martinSourceMatchesTable } from "../martin-source-match";
import type { OpenAddDataPostgres } from "../open-add-data";

type PostgresLoadMode = "tiles" | "editable";

function postgisTableKey(table: PostgisTableInfo): string {
  return `${table.schema}.${table.table}`;
}

interface PostgresSourceProps {
  /** Prefill from the Browser panel (saved connection / clicked table). */
  initialPostgres?: OpenAddDataPostgres;
}

export function PostgresSource({ initialPostgres }: PostgresSourceProps) {
  const { t } = useTranslation();
  const source = useAddDataSource(t("addData.postgres.defaultName"));
  const { martin } = source.shell;
  const [postgresConnectionString, setPostgresConnectionString] = useState(
    () => initialPostgres?.connection ?? readSavedPostgresConnections()[0] ?? "",
  );
  // A table clicked in the Browser panel to auto-select once a Connect
  // populates the source/table list (the user still triggers the desktop-only
  // Connect; this just spares them re-picking the table they came in for).
  const desiredTableRef = useRef(
    initialPostgres?.table
      ? { schema: initialPostgres.schema, table: initialPostgres.table }
      : null,
  );
  const [savedPostgresConnections, setSavedPostgresConnections] = useState(() =>
    readSavedPostgresConnections(),
  );
  const [postgresDefaultSrid, setPostgresDefaultSrid] = useState("");
  const [loadMode, setLoadMode] = useState<PostgresLoadMode>("tiles");
  const [postgisTables, setPostgisTables] = useState<PostgisTableInfo[]>([]);
  const [selectedTableKey, setSelectedTableKey] = useState("");
  const [postgisStatus, setPostgisStatus] = useState<string | null>(null);
  // The connection string the table list was fetched with. The submit uses
  // this snapshot (not the live input) so editing the field after a Connect
  // cannot silently read a same-named table from a different database.
  const [postgisConnection, setPostgisConnection] = useState("");
  // Invalidation token for the async table listing: editing the connection
  // string bumps it, so an in-flight listing for the previous string cannot
  // repopulate the dropdown after its results stopped being relevant.
  const listRequestRef = useRef(0);
  // Latest started editable-connect call. Only its own `finally` may clear
  // isSubmitting: an older, superseded call settling late must not re-enable
  // the controls mid-flight of a newer one. Separate from listRequestRef
  // because input edits bump that token without starting a request (guarding
  // on it in `finally` would leave isSubmitting stuck true).
  const connectFlightRef = useRef(0);
  // Invalidation token for the tiles-mode Martin connect, mirroring
  // listRequestRef for the editable list: a connection-string change bumps it
  // so an in-flight connect can't revive a server/catalog for the previous
  // database after the user has moved on.
  const martinRequestRef = useRef(0);

  // Clear the (shell-owned) Martin connection state so a stale server/catalog
  // from a previous connection can't be submitted (and submit is disabled)
  // after the connection string changes.
  const clearMartinState = () => {
    martinRequestRef.current += 1;
    // A completed connect leaves a real Martin process running. stopTransient
    // (on dialog close) only stops it while martin.server is set, so stop it
    // here before clearing the state — otherwise it leaks, and since the Rust
    // side refuses a second concurrent server a later reconnect would fail.
    // An in-flight connect (server not yet set) is instead torn down by
    // handleConnectPostgres's own staleness checks.
    if (martin.server) {
      void stopMartinServer().catch(() => {});
    }
    martin.setServer(null);
    martin.setSources([]);
    martin.setSelectedSourceId("");
    martin.setStatus(null);
  };

  // Reset the (shell-owned) Martin connection when the source opens, matching
  // the original dialog: a running server is preserved across reopens only
  // after a layer was added. But when opened from a Browser-panel table click
  // (initialPostgres), that preserve behavior would leave the previous add's
  // server/source connected — and submittable — for a *different* clicked
  // table, so force a clean slate (stopping the old server) instead.
  useEffect(() => {
    if (initialPostgres) clearMartinState();
    else martin.resetOnOpen();
    // Mount-only: `martin`/`clearMartinState` are intentionally excluded from
    // the deps — re-running on every render would clear state mid-flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // List the database's spatial tables through the sidecar's /postgis
  // endpoints (psycopg) for the editable-layer mode. Martin is not involved:
  // the features are loaded as GeoJSON so edits can be written back.
  const handleConnectEditable = async () => {
    const requestToken = ++listRequestRef.current;
    const flightId = ++connectFlightRef.current;
    source.setError(null);
    setPostgisStatus(null);
    source.shell.setIsSubmitting(true);
    setPostgisTables([]);
    setSelectedTableKey("");

    try {
      if (!isTauri()) {
        throw new Error(t("addData.postgres.errorDesktopOnly"));
      }
      if (!postgresConnectionString.trim()) {
        throw new Error(t("addData.postgres.errorConnectionString"));
      }
      const connectionString = postgresConnectionString.trim();
      setPostgisStatus(t("addData.postgres.statusListingTables"));
      try {
        // Best-effort: the sidecar may already be running (or be started
        // externally in dev); a failed start still lets the list call try.
        await startGeoLibreSidecar();
      } catch {
        // Ignored: the status check below surfaces the real error.
      }
      // Check the runtime first so a missing psycopg reads as "install the
      // postgis extra", not as a generic connection failure (mirrors how the
      // other optional engines gate their dialogs on a *Status call).
      const status = await fetchPostgisStatus();
      if (!status.available) {
        throw new Error(t("addData.postgres.errorRuntimeMissing"));
      }
      const listed = await listPostgisTables(connectionString);
      if (listRequestRef.current !== requestToken) {
        // The connection string changed while the listing was in flight; do
        // not revive a table list that belongs to the previous string.
        return;
      }
      // geometry_columns lists one row per geometry column, so a table with
      // several geometry columns appears several times; keep the first entry
      // (the /postgis/read endpoint edits that table's first geometry column)
      // so the select has unique keys.
      const seen = new Set<string>();
      const tables = listed.filter((table) => {
        const key = postgisTableKey(table);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      setSavedPostgresConnections(rememberPostgresConnection(connectionString));
      setPostgisConnection(connectionString);
      setPostgisTables(tables);
      // Prefer the table the user clicked in the Browser panel (when writable),
      // else the first writable table (single-column primary key); read-only
      // tables are listed but disabled, so with no writable table nothing is
      // preselected and the submit stays disabled.
      const desired = desiredTableRef.current;
      const desiredTable = desired
        ? tables.find(
            (table) =>
              table.primary_key &&
              table.table === desired.table &&
              (!desired.schema || table.schema === desired.schema),
          )
        : undefined;
      const defaultTable = desiredTable ?? tables.find((table) => table.primary_key);
      setSelectedTableKey(defaultTable ? postgisTableKey(defaultTable) : "");
      // Consumed once: a later reconnect on the same connection must not undo a
      // manual table pick by re-applying the originally-clicked table.
      desiredTableRef.current = null;
      setPostgisStatus(
        tables.length > 0
          ? t("addData.postgres.statusTablesFound", { count: tables.length })
          : t("addData.postgres.statusNoTables"),
      );
    } catch (err) {
      if (listRequestRef.current === requestToken) {
        source.setError(errorMessage(err, t("addData.postgres.errorConnect")));
        setPostgisStatus(null);
      }
    } finally {
      if (connectFlightRef.current === flightId) {
        source.shell.setIsSubmitting(false);
      }
    }
  };

  const handleConnectPostgres = async () => {
    const requestToken = ++martinRequestRef.current;
    source.setError(null);
    martin.setStatus(null);
    source.shell.setIsSubmitting(true);
    martin.setSources([]);
    martin.setSelectedSourceId("");

    try {
      if (!isTauri()) {
        throw new Error(t("addData.postgres.errorDesktopOnly"));
      }
      if (!postgresConnectionString.trim()) {
        throw new Error(t("addData.postgres.errorConnectionString"));
      }
      const connectionString = postgresConnectionString.trim();

      martin.setStatus(t("addData.postgres.statusCheckingBinary"));
      const binary = await ensureMartinBinary();
      martin.setStatus(
        binary.downloaded
          ? t("addData.postgres.statusDownloaded")
          : t("addData.postgres.statusStarting"),
      );
      const server = await startMartinServer({
        connectionString,
        defaultSrid: postgresDefaultSrid,
      });
      if (martinRequestRef.current !== requestToken) {
        // The connection string changed while connecting; discard this server
        // for the now-stale database rather than showing it as connected.
        await stopMartinServer().catch(() => {});
        return;
      }
      setSavedPostgresConnections(rememberPostgresConnection(connectionString));
      martin.setServer(server);
      martin.setStatus(t("addData.postgres.statusReadingCatalog"));

      const sources = await fetchMartinCatalog(server);
      if (martinRequestRef.current !== requestToken) {
        // Mirror the earlier staleness check: a superseded request must stop
        // its server rather than leaving it running in the background.
        await stopMartinServer().catch(() => {});
        return;
      }
      martin.setSources(sources);
      // Preselect the table the user clicked in the Browser panel, if Martin
      // published it; otherwise fall back to the first source.
      const desired = desiredTableRef.current;
      const match = desired
        ? sources.find((s) => martinSourceMatchesTable(s.id, desired.schema, desired.table))
        : undefined;
      martin.setSelectedSourceId(match?.id ?? sources[0]?.id ?? "");
      // Consumed once: a later reconnect on the same connection must not undo a
      // manual source pick by re-applying the originally-clicked table.
      desiredTableRef.current = null;
      martin.setStatus(
        sources.length > 0
          ? t("addData.postgres.statusFound", { count: sources.length })
          : t("addData.postgres.statusNoSources"),
      );
    } catch (err) {
      // Ignore a superseded call's failure so it can't wipe a fresher, working
      // connection or show a misleading error for a connection the user has
      // already moved on from. (finally stays unguarded — clearMartinState also
      // bumps this token without starting a request, so guarding it would leave
      // the Connect button stuck disabled.)
      if (martinRequestRef.current === requestToken) {
        martin.setServer(null);
        source.setError(errorMessage(err, t("addData.postgres.errorConnect")));
        martin.setStatus(null);
      }
    } finally {
      source.shell.setIsSubmitting(false);
    }
  };

  const handleStopMartin = async () => {
    source.setError(null);
    source.shell.setIsSubmitting(true);
    try {
      await stopMartinServer();
      martin.setServer(null);
      martin.setSources([]);
      martin.setSelectedSourceId("");
      martin.setStatus(t("addData.postgres.statusStopped"));
    } catch (err) {
      source.setError(errorMessage(err, t("addData.postgres.errorStop")));
    } finally {
      source.shell.setIsSubmitting(false);
    }
  };

  const addMartinSource = async (sourceId: string) => {
    const server = martin.server;
    if (!server) throw new Error(t("addData.postgres.errorConnectFirst"));
    const tilejson = await fetchMartinTileJson(server, sourceId);
    const vectorLayers = tilejson.vector_layers ?? tilejson.vectorLayers ?? [];
    const sourceLayer = vectorLayers[0]?.id;
    if (!sourceLayer) {
      throw new Error(t("addData.postgres.errorNoVectorLayers"));
    }

    const summary = martin.sources.find((candidate) => candidate.id === sourceId);
    const tilejsonUrl = martinTileJsonUrl(server, sourceId);
    martin.markLayerAdded();
    source.addAndClose(
      createBaseLayer(
        source.layerName.trim() || tilejson.name || summary?.name || sourceId,
        "vector-tiles",
        {
          type: "vector",
          url: tilejsonUrl,
          sourceLayer,
          sourceLayers: vectorLayers.map((vectorLayer) => vectorLayer.id),
          bounds: tilejson.bounds,
          minzoom: tilejson.minzoom,
          maxzoom: tilejson.maxzoom,
        },
        {
          bounds: tilejson.bounds,
          center: tilejson.center,
          maxzoom: tilejson.maxzoom,
          minzoom: tilejson.minzoom,
          martinPort: server.port,
          martinSourceId: sourceId,
          sourceKind: "martin-postgis",
          sourceLayers: vectorLayers.map((vectorLayer) => vectorLayer.id),
          tilejsonUrl,
        },
      ),
      { fit: true },
    );
  };

  // Load the selected table's features as an editable GeoJSON layer. The
  // connection string is kept in an in-memory registry (plus a masked label on
  // the layer metadata) so "Save edits to PostGIS table" can commit changes
  // back without persisting credentials in the project file.
  const addEditableTable = async (tableKey: string) => {
    const table = postgisTables.find((candidate) => postgisTableKey(candidate) === tableKey);
    if (!table) {
      throw new Error(t("addData.postgres.errorSelectTable"));
    }
    // The snapshot taken when the table list was fetched, not the live input.
    const connectionString = postgisConnection;
    if (!connectionString) {
      throw new Error(t("addData.postgres.errorConnectFirst"));
    }
    const result = await readPostgisTable({
      connection: connectionString,
      schema_name: table.schema,
      table: table.table,
    });
    const layer = {
      ...createBaseLayer(
        source.layerName.trim() || table.table,
        "geojson",
        {
          type: "geojson",
          service: "postgis",
          schema: result.schema,
          table: result.table,
        },
        {
          featureCount: result.feature_count,
          sourceKind: "postgis-table",
          postgisSchema: result.schema,
          postgisTable: result.table,
          postgisPrimaryKey: result.primary_key,
          postgisGeometryColumn: result.geometry_column,
          postgisSrid: result.srid,
          postgisConnectionLabel: savedPostgresConnectionLabel(connectionString),
          // Persisted with the project so the deletion-scoping baseline
          // survives a reload (keys are not credentials).
          postgisBaselineKeys: postgisFeatureKeys(result.geojson),
        },
      ),
      geojson: result.geojson,
    };
    registerPostgisConnection(layer.id, connectionString);
    source.addAndClose(layer, { fit: true });
  };

  const handleSubmit = source.runSubmit(async () => {
    if (loadMode === "editable") {
      if (postgisTables.length === 0) {
        throw new Error(t("addData.postgres.errorConnectFirst"));
      }
      if (!selectedTableKey) {
        throw new Error(t("addData.postgres.errorSelectTable"));
      }
      await addEditableTable(selectedTableKey);
      return;
    }
    if (!martin.server) {
      throw new Error(t("addData.postgres.errorConnectFirst"));
    }
    if (!martin.selectedSourceId) {
      throw new Error(t("addData.postgres.errorSelectSource"));
    }
    await addMartinSource(martin.selectedSourceId);
  });

  return (
    <AddDataSourceForm
      layerName={source.layerName}
      onLayerNameChange={source.setLayerName}
      beforeLayerId={source.beforeLayerId}
      onBeforeLayerIdChange={source.setBeforeLayerId}
      onSubmit={handleSubmit}
      error={source.error}
      submitDisabled={
        source.isSubmitting ||
        (loadMode === "editable" ? !selectedTableKey : !martin.server || !martin.selectedSourceId)
      }
    >
      <div className="space-y-3">
        {!isTauri() ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {t("addData.postgres.desktopOnlyNotice")}
          </p>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor="postgres-load-mode">{t("addData.postgres.loadMode")}</Label>
          <Select
            id="postgres-load-mode"
            value={loadMode}
            onChange={(event) => setLoadMode(event.target.value as PostgresLoadMode)}
          >
            <option value="tiles">{t("addData.postgres.loadModeTiles")}</option>
            <option value="editable">{t("addData.postgres.loadModeEditable")}</option>
          </Select>
          {loadMode === "editable" ? (
            <p className="text-xs text-muted-foreground">{t("addData.postgres.editableNotice")}</p>
          ) : null}
        </div>
        {savedPostgresConnections.length > 0 ? (
          <div className="space-y-1.5">
            <Label htmlFor="postgres-saved-connection">
              {t("addData.postgres.savedConnection")}
            </Label>
            <Select
              id="postgres-saved-connection"
              value={
                savedPostgresConnections.includes(postgresConnectionString)
                  ? postgresConnectionString
                  : ""
              }
              onChange={(event) => {
                setPostgresConnectionString(event.target.value);
                if (event.target.value.trim() !== postgisConnection) {
                  listRequestRef.current += 1;
                  setPostgisTables([]);
                  setSelectedTableKey("");
                  setPostgisConnection("");
                  setPostgisStatus(null);
                  // A different database also invalidates the tiles-mode Martin
                  // connection, so a layer from the old server can't be added.
                  clearMartinState();
                  // The Browser-panel table preselect belongs to the connection
                  // it was opened for; once the user switches connections it no
                  // longer applies and must not preselect a same-named table in
                  // a different database.
                  desiredTableRef.current = null;
                }
              }}
            >
              <option value="">{t("addData.postgres.selectSavedConnection")}</option>
              {savedPostgresConnections.map((connection) => (
                <option key={connection} value={connection}>
                  {savedPostgresConnectionLabel(connection)}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor="postgres-connection">{t("addData.postgres.connectionString")}</Label>
          <Input
            id="postgres-connection"
            type="password"
            autoComplete="off"
            placeholder={t("addData.postgres.connectionStringPlaceholder")}
            value={postgresConnectionString}
            onChange={(event) => {
              setPostgresConnectionString(event.target.value);
              // The fetched table list belongs to the previous connection
              // string; invalidate it (and any in-flight listing) so a stale
              // selection cannot be submitted against a different database.
              if (event.target.value.trim() !== postgisConnection) {
                listRequestRef.current += 1;
                setPostgisTables([]);
                setSelectedTableKey("");
                setPostgisConnection("");
                setPostgisStatus(null);
                // See the saved-connection handler: a connection change voids
                // the tiles-mode Martin connection and the table preselect.
                clearMartinState();
                desiredTableRef.current = null;
              }
            }}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <div className="space-y-1.5">
            {loadMode === "tiles" ? (
              <>
                <Label htmlFor="postgres-default-srid">{t("addData.postgres.defaultSrid")}</Label>
                <Input
                  id="postgres-default-srid"
                  inputMode="numeric"
                  placeholder={t("addData.common.optional")}
                  value={postgresDefaultSrid}
                  onChange={(event) => setPostgresDefaultSrid(event.target.value)}
                />
              </>
            ) : null}
          </div>
          <div className="flex items-end">
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={loadMode === "editable" ? handleConnectEditable : handleConnectPostgres}
                disabled={source.isSubmitting || !isTauri()}
              >
                {t("addData.postgres.connect")}
              </Button>
              {loadMode === "tiles" && martin.server ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleStopMartin}
                  disabled={source.isSubmitting}
                >
                  {t("addData.postgres.stop")}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
        {loadMode === "tiles" && martin.status ? (
          <p className="text-xs text-muted-foreground">{martin.status}</p>
        ) : null}
        {loadMode === "editable" && postgisStatus ? (
          <p className="text-xs text-muted-foreground">{postgisStatus}</p>
        ) : null}
        {loadMode === "editable" && postgisTables.length > 0 ? (
          <div className="space-y-1.5">
            <Label htmlFor="postgis-table">{t("addData.postgres.editableTable")}</Label>
            <Select
              id="postgis-table"
              value={selectedTableKey}
              onChange={(event) => setSelectedTableKey(event.target.value)}
            >
              {postgisTables.map((table) => {
                const key = postgisTableKey(table);
                // Tables without a usable key stay visible (so the user sees
                // why they are missing) but cannot be picked: this mode exists
                // to save edits back, which needs a primary key.
                return (
                  <option key={key} value={key} disabled={!table.primary_key}>
                    {table.primary_key ? key : t("addData.postgres.tableReadOnly", { table: key })}
                  </option>
                );
              })}
            </Select>
          </div>
        ) : null}
        {loadMode === "tiles" && martin.sources.length > 0 ? (
          <div className="space-y-1.5">
            <Label htmlFor="martin-source">{t("addData.postgres.martinSource")}</Label>
            <Select
              id="martin-source"
              value={martin.selectedSourceId}
              onChange={(event) => martin.setSelectedSourceId(event.target.value)}
            >
              {martin.sources.map((martinSource) => (
                <option key={martinSource.id} value={martinSource.id}>
                  {martinSource.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        {loadMode === "tiles" && martin.server ? (
          <p className="text-xs text-muted-foreground">
            {t("addData.postgres.runningOnPort", { port: martin.server.port })}
          </p>
        ) : null}
      </div>
    </AddDataSourceForm>
  );
}
