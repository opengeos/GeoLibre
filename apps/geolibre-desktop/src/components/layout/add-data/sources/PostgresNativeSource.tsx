import { Button, Input, Label, Select } from "@geolibre/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  listPostgisTileSources,
  readPostgisTileSourceInfo,
  registerPostgisTilesProtocol,
  releasePostgisTilesConnectionIfUnused,
  rememberPostgisTilesConnection,
  type PostgisTileSource,
} from "../../../../lib/postgis-tiles";
import { POSTGIS_TILES_SOURCE_KIND, postgisTilesUrl } from "../../../../lib/postgis-tiles-url";
import {
  createBaseLayer,
  errorMessage,
  readSavedPostgresConnections,
  rememberPostgresConnection,
  savedPostgresConnectionLabel,
} from "../helpers";
import { AddDataSourceForm, useAddDataSource } from "../shared";
import { PostgresConnectionFields } from "./PostgresConnectionFields";
import type { OpenAddDataPostgres } from "../open-add-data";

/** Zoom range the in-process renderer advertises to MapLibre. */
const NATIVE_TILES_MAXZOOM = 22;

interface PostgresNativeSourceProps {
  /** Prefill from the Browser panel (saved connection / clicked table). */
  initialPostgres?: OpenAddDataPostgres;
}

function sourceKey(source: Pick<PostgisTileSource, "schema" | "table" | "geometryColumn">) {
  return JSON.stringify([source.schema, source.table, source.geometryColumn]);
}

function sourceLabel(source: PostgisTileSource, showGeometryColumn: boolean): string {
  const table = source.schema === "public" ? source.table : `${source.schema}.${source.table}`;
  return showGeometryColumn ? `${table} (${source.geometryColumn})` : table;
}

/**
 * PostgreSQL vector tiles for the mobile apps (Android/iOS), which cannot run
 * the Martin tile server the desktop source uses (GeoLibre#2091). Tiles are
 * rendered in the database with `ST_AsMVT` by the Tauri backend and reach
 * MapLibre through the `geolibre-pgtiles://` protocol (`lib/postgis-tiles.ts`).
 * Read-only: the editable mode still needs the desktop Python sidecar.
 */
export function PostgresNativeSource({ initialPostgres }: PostgresNativeSourceProps) {
  const { t } = useTranslation();
  const source = useAddDataSource(t("addData.postgres.defaultName"));
  const [connectionString, setConnectionString] = useState(
    () => initialPostgres?.connection ?? readSavedPostgresConnections()[0] ?? "",
  );
  const [savedConnections, setSavedConnections] = useState(() => readSavedPostgresConnections());
  const [defaultSrid, setDefaultSrid] = useState("");
  const [sources, setSources] = useState<PostgisTileSource[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  // The connection string and SRID the source list was fetched with. Submit
  // uses this snapshot, not the live inputs, so editing a field after Connect
  // cannot add a same-named table from a different database.
  const [connected, setConnected] = useState<{
    connection: string;
    defaultSrid: string;
  } | null>(null);
  // Invalidation token: an in-flight listing for a superseded connection
  // string must not repopulate the picker.
  const requestRef = useRef(0);
  const desiredTableRef = useRef(
    initialPostgres?.table
      ? { schema: initialPostgres.schema, table: initialPostgres.table }
      : null,
  );

  // Every connection string this form opened a backend pool for. Moving to
  // another database, or closing the form, releases the ones no layer on the
  // map uses rather than leaving them for eviction.
  const openedRef = useRef(new Set<string>());
  useEffect(() => {
    const opened = openedRef.current;
    return () => {
      for (const connection of opened) releasePostgisTilesConnectionIfUnused(connection);
    };
  }, []);

  const resetConnection = () => {
    requestRef.current += 1;
    setSources([]);
    setSelectedKey("");
    setConnected(null);
    setStatus(null);
    desiredTableRef.current = null;
  };

  const handleConnectionChange = (value: string) => {
    setConnectionString(value);
    if (value.trim() !== connected?.connection) resetConnection();
  };

  const handleConnect = async () => {
    const requestToken = ++requestRef.current;
    source.setError(null);
    setStatus(t("addData.postgres.statusListingTables"));
    source.shell.setIsSubmitting(true);
    setSources([]);
    setSelectedKey("");
    try {
      const connection = connectionString.trim();
      if (!connection) throw new Error(t("addData.postgres.errorConnectionString"));
      const listed = await listPostgisTileSources(connection, defaultSrid);
      // Recorded even when superseded, so that pool is still released later.
      openedRef.current.add(connection);
      if (requestRef.current !== requestToken) return;
      for (const previous of openedRef.current) {
        if (previous === connection) continue;
        releasePostgisTilesConnectionIfUnused(previous);
        openedRef.current.delete(previous);
      }
      setSavedConnections(rememberPostgresConnection(connection));
      setConnected({ connection, defaultSrid: defaultSrid.trim() });
      setSources(listed);
      const desired = desiredTableRef.current;
      const match = desired
        ? listed.find(
            (candidate) =>
              candidate.table === desired.table &&
              (!desired.schema || candidate.schema === desired.schema),
          )
        : undefined;
      const initial = match ?? listed[0];
      setSelectedKey(initial ? sourceKey(initial) : "");
      // Consumed once, so a later reconnect does not undo a manual pick.
      desiredTableRef.current = null;
      setStatus(
        listed.length > 0
          ? t("addData.postgres.statusTablesFound", { count: listed.length })
          : t("addData.postgres.statusNoTables"),
      );
    } catch (err) {
      if (requestRef.current === requestToken) {
        source.setError(errorMessage(err, t("addData.postgres.errorConnect")));
        setStatus(null);
      }
    } finally {
      source.shell.setIsSubmitting(false);
    }
  };

  const handleSubmit = source.runSubmit(async () => {
    if (!connected) throw new Error(t("addData.postgres.errorConnectFirst"));
    const selected = sources.find((candidate) => sourceKey(candidate) === selectedKey);
    if (!selected) throw new Error(t("addData.postgres.errorSelectTable"));

    const ref = {
      schema: selected.schema,
      table: selected.table,
      geometryColumn: selected.geometryColumn,
      defaultSrid: connected.defaultSrid || undefined,
    };
    const info = await readPostgisTileSourceInfo(connected.connection, ref);
    // The tile URL names the connection by its masked label only; the
    // protocol resolves it back through this session's map or the saved list.
    const connectionLabel = rememberPostgisTilesConnection(connected.connection);
    registerPostgisTilesProtocol();
    const tiles = [postgisTilesUrl({ ...ref, connectionLabel })];
    const bounds = info.bounds ?? undefined;
    source.addAndClose(
      createBaseLayer(
        source.layerName.trim() || selected.table,
        "vector-tiles",
        {
          type: "vector",
          tiles,
          sourceLayer: info.layer,
          sourceLayers: [info.layer],
          bounds,
          minzoom: 0,
          maxzoom: NATIVE_TILES_MAXZOOM,
        },
        {
          bounds,
          minzoom: 0,
          maxzoom: NATIVE_TILES_MAXZOOM,
          sourceKind: POSTGIS_TILES_SOURCE_KIND,
          sourceLayers: [info.layer],
          fields: info.fields,
          postgisSchema: selected.schema,
          postgisTable: selected.table,
          postgisGeometryColumn: selected.geometryColumn,
          postgisSrid: selected.srid,
          postgisConnectionLabel: savedPostgresConnectionLabel(connected.connection),
        },
      ),
      { fit: true },
    );
  });

  // A table with two geometry columns is listed twice; only then does the
  // label need the column to tell the entries apart.
  const tableCounts = new Map<string, number>();
  for (const candidate of sources) {
    const key = `${candidate.schema}.${candidate.table}`;
    tableCounts.set(key, (tableCounts.get(key) ?? 0) + 1);
  }

  return (
    <AddDataSourceForm
      layerName={source.layerName}
      onLayerNameChange={source.setLayerName}
      beforeLayerId={source.beforeLayerId}
      onBeforeLayerIdChange={source.setBeforeLayerId}
      onSubmit={handleSubmit}
      error={source.error}
      submitDisabled={source.isSubmitting || !connected || !selectedKey}
    >
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">{t("addData.postgres.nativeTilesNotice")}</p>
        <PostgresConnectionFields
          savedConnections={savedConnections}
          connectionString={connectionString}
          onConnectionChange={handleConnectionChange}
        />
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <div className="space-y-1.5">
            <Label htmlFor="postgres-default-srid">{t("addData.postgres.defaultSrid")}</Label>
            <Input
              id="postgres-default-srid"
              inputMode="numeric"
              placeholder={t("addData.common.optional")}
              value={defaultSrid}
              onChange={(event) => {
                setDefaultSrid(event.target.value);
                // The SRID is part of the tile URL, so a change needs a reconnect.
                if (connected && event.target.value.trim() !== connected.defaultSrid) {
                  resetConnection();
                }
              }}
            />
          </div>
          <div className="flex items-end">
            <Button
              type="button"
              variant="outline"
              onClick={handleConnect}
              disabled={source.isSubmitting}
            >
              {t("addData.postgres.connect")}
            </Button>
          </div>
        </div>
        {status ? <p className="text-xs text-muted-foreground">{status}</p> : null}
        {sources.length > 0 ? (
          <div className="space-y-1.5">
            <Label htmlFor="postgis-tile-source">{t("addData.postgres.tileSourceTable")}</Label>
            <Select
              id="postgis-tile-source"
              value={selectedKey}
              onChange={(event) => setSelectedKey(event.target.value)}
            >
              {sources.map((candidate) => (
                <option key={sourceKey(candidate)} value={sourceKey(candidate)}>
                  {sourceLabel(
                    candidate,
                    (tableCounts.get(`${candidate.schema}.${candidate.table}`) ?? 0) > 1,
                  )}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
      </div>
    </AddDataSourceForm>
  );
}
