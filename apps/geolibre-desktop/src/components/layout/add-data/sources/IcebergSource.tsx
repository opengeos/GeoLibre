import { Button, Input, Label, Select, Textarea } from "@geolibre/ui";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  buildIcebergDefaultSql,
  clampIcebergRowLimit,
  DEFAULT_ICEBERG_CRS,
  DEFAULT_ICEBERG_ROW_LIMIT,
  icebergLayerMetadata,
  icebergCrsFromColumnType,
  icebergTableKey,
  icebergTableLabel,
  keepOrDefaultGeometryColumn,
  MAX_ICEBERG_ROW_LIMIT,
  normalizeIcebergLocation,
  normalizeIcebergSql,
  selectDefaultIcebergTable,
  type IcebergLayerConfig,
  type IcebergMode,
  type IcebergTableInfo,
  type IcebergTableRef,
} from "../../../../lib/iceberg";
import { createBaseLayer, errorMessage } from "../helpers";
import { AddDataSourceForm, useAddDataSource } from "../shared";

/**
 * A connection the table list was fetched with. Held as a snapshot so the submit
 * reads what was actually connected to, not whatever the inputs say now.
 */
interface IcebergConnection {
  mode: IcebergMode;
  location: string;
  /** Empty in table mode. */
  endpoint: string;
}

/**
 * Add Data source for Apache Iceberg tables, read through DuckDB's `iceberg`
 * extension with `spatial` turning the geometry column into features.
 *
 * The flow is deliberately three-step — Connect, pick a table, add — because an
 * Iceberg table is usually far too large to load speculatively. Connect lists
 * what the source exposes (a REST catalog's tables, or the single table of a
 * direct metadata location); picking one reports its true row count before any
 * data is read; the row limit then caps what is materialized. The layer that
 * results is a snapshot and is never re-scanned on a timer — see
 * `supportsAutoRefresh` in lib/layer-refresh.ts.
 */
export function IcebergSource() {
  const { t } = useTranslation();
  const source = useAddDataSource(t("addData.iceberg.defaultName"));
  const [mode, setMode] = useState<IcebergMode>("table");
  const [location, setLocation] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [tables, setTables] = useState<IcebergTableRef[]>([]);
  const [selectedTableKey, setSelectedTableKey] = useState("");
  const [tableInfo, setTableInfo] = useState<IcebergTableInfo | null>(null);
  const [geometryColumn, setGeometryColumn] = useState("");
  const [rowLimit, setRowLimit] = useState(String(DEFAULT_ICEBERG_ROW_LIMIT));
  // Optional SQL over the table, pre-filled with the generated whole-table
  // select once a table is chosen. `inspectedSql` is what the reported row
  // count and geometry columns belong to, so an edited box can re-inspect on
  // blur without re-running for every keystroke.
  const [sql, setSql] = useState("");
  const [inspectedSql, setInspectedSql] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The connection the table list was fetched with. The submit reads this
  // snapshot rather than the live inputs, so editing the location after a
  // Connect cannot scan a same-named table in a different warehouse.
  const [connected, setConnected] = useState<IcebergConnection | null>(null);
  // Invalidation token for the async listing/inspection: editing any connection
  // input bumps it, so an in-flight request for the previous source cannot
  // repopulate the dropdown after its results stopped being relevant.
  const requestRef = useRef(0);
  // Which request currently owns `busy`. Separate from `requestRef` because
  // invalidation bumps that token *without* starting a request: gating the
  // `busy` reset on `requestRef` alone would leave the form stuck disabled when
  // the user edits an input while a connect is still in flight.
  const busyRequestRef = useRef(0);

  /** Take ownership of `busy` for `requestToken` and raise it. */
  const beginBusy = (requestToken: number) => {
    busyRequestRef.current = requestToken;
    setBusy(true);
  };

  /** Drop `busy`, unless a newer request has taken it over in the meantime. */
  const endBusy = (requestToken: number) => {
    if (busyRequestRef.current === requestToken) setBusy(false);
  };

  /** Drop everything derived from a connection, so a stale table (or its row
   * count) can never be submitted after the inputs change. */
  const invalidateConnection = () => {
    requestRef.current += 1;
    setConnected(null);
    setTables([]);
    setSelectedTableKey("");
    setTableInfo(null);
    setGeometryColumn("");
    setSql("");
    setInspectedSql("");
    setStatus(null);
  };

  const selectedTable = tables.find((table) => icebergTableKey(table) === selectedTableKey) ?? null;

  /**
   * The config for a given table under the connection the list came from.
   * Returns null before a successful Connect, or when the chosen mode still has
   * no table, so callers can't build a scan out of half-entered inputs.
   */
  const configFor = (table: IcebergTableRef | null): IcebergLayerConfig | null => {
    if (!connected) return null;
    if (connected.mode === "catalog" && !table) return null;
    return {
      mode: connected.mode,
      location: connected.location,
      ...(connected.endpoint ? { endpoint: connected.endpoint } : {}),
      ...(table ? { table } : {}),
      rowLimit: clampIcebergRowLimit(rowLimit),
      ...(geometryColumn ? { geometryColumn } : {}),
      // Only carried when the user actually changed it: an untouched box holds
      // the generated select, and persisting that would freeze today's default
      // onto the layer instead of regenerating it on reload.
      ...(sqlOverride() ? { sql: sqlOverride() } : {}),
    };
  };

  /**
   * The SQL box's contents when they differ from the generated statement, else
   * empty. Compared after normalization so whitespace or a trailing semicolon
   * does not read as an edit.
   */
  const sqlOverride = (): string => {
    const typed = normalizeIcebergSql(sql);
    if (!typed) return "";
    const generated = generatedSqlFor(connected, selectedTable);
    return typed === normalizeIcebergSql(generated) ? "" : typed;
  };

  /**
   * The generated whole-table select the SQL box is pre-filled with. Takes the
   * connection explicitly rather than reading state: it runs from the Connect
   * handler, where `connected` has not committed yet.
   */
  const generatedSqlFor = (
    connection: IcebergConnection | null,
    table: IcebergTableRef | null,
  ): string => {
    if (!connection) return "";
    if (connection.mode === "catalog" && !table) return "";
    return buildIcebergDefaultSql({
      mode: connection.mode,
      location: connection.location,
      ...(connection.endpoint ? { endpoint: connection.endpoint } : {}),
      ...(table ? { table } : {}),
      rowLimit: clampIcebergRowLimit(rowLimit),
    });
  };

  /**
   * Read the source's GEOMETRY columns and row count. Runs after Connect, on
   * every table change, and when the SQL box is edited — so the user always
   * sees how much data is behind what they are about to load, and which
   * geometry column (in which CRS) it will render.
   *
   * @param customSql A statement to inspect instead of the whole table.
   */
  const inspectTable = async (
    connection: IcebergConnection,
    table: IcebergTableRef | null,
    requestToken: number,
    customSql = "",
  ) => {
    if (connection.mode === "catalog" && !table) return;
    setStatus(t("addData.iceberg.statusInspecting"));
    const { inspectIcebergTable } = await import("../../../../lib/iceberg-loader");
    const info = await inspectIcebergTable({
      mode: connection.mode,
      location: connection.location,
      ...(connection.endpoint ? { endpoint: connection.endpoint } : {}),
      ...(table ? { table } : {}),
      rowLimit: clampIcebergRowLimit(rowLimit),
      ...(customSql ? { sql: customSql } : {}),
    });
    if (requestRef.current !== requestToken) return;
    setTableInfo(info);
    // Keep a deliberate pick across re-inspection (the SQL box re-inspects on
    // every edit); only fall back to the first column when the previous choice
    // is no longer part of the source.
    setGeometryColumn((current) => keepOrDefaultGeometryColumn(current, info.geometryColumns));
    // Pre-fill the query box with the statement this inspection ran, so the
    // user edits something that already works rather than composing an
    // `iceberg_scan` call by hand. Only when they have not typed their own.
    const ran = customSql || generatedSqlFor(connection, table);
    if (!customSql) setSql(ran);
    setInspectedSql(normalizeIcebergSql(ran));
    // The row/geometry summary is rendered from state (see `summary` below) so
    // it follows the column picker; only the "nothing to render" case is a
    // status, since it has no column to describe.
    setStatus(
      info.geometryColumns.length > 0
        ? null
        : t("addData.iceberg.statusNoGeometry", {
            rows: info.rowCount.toLocaleString(),
          }),
    );
  };

  /**
   * Re-inspect when the query box has actually changed, on blur rather than per
   * keystroke — each inspection is a real round trip to the table.
   */
  const handleSqlBlur = async () => {
    if (!connected) return;
    const typed = normalizeIcebergSql(sql);
    if (!typed || typed === inspectedSql) return;
    const requestToken = ++requestRef.current;
    source.setError(null);
    beginBusy(requestToken);
    try {
      await inspectTable(connected, selectedTable, requestToken, typed);
    } catch (err) {
      if (requestRef.current === requestToken) {
        source.setError(errorMessage(err, t("addData.iceberg.errorInspect")));
        setStatus(null);
      }
    } finally {
      // Only the request that owns `busy` may clear it. A superseded one
      // settling first would otherwise re-enable Connect and Add while its
      // replacement is still in flight, letting a submit run against a
      // half-cleared inspection.
      endBusy(requestToken);
    }
  };

  const handleConnect = async () => {
    const requestToken = ++requestRef.current;
    source.setError(null);
    setConnected(null);
    setTables([]);
    setSelectedTableKey("");
    setTableInfo(null);
    setGeometryColumn("");
    setSql("");
    setInspectedSql("");
    beginBusy(requestToken);
    try {
      const normalizedLocation = normalizeIcebergLocation(location);
      if (!normalizedLocation) {
        throw new Error(
          mode === "catalog"
            ? t("addData.iceberg.errorWarehouse")
            : t("addData.iceberg.errorLocation"),
        );
      }
      const normalizedEndpoint = normalizeIcebergLocation(endpoint);
      if (mode === "catalog" && !normalizedEndpoint) {
        throw new Error(t("addData.iceberg.errorEndpoint"));
      }
      const connection = {
        mode,
        location: normalizedLocation,
        endpoint: mode === "catalog" ? normalizedEndpoint : "",
      };
      setStatus(t("addData.iceberg.statusConnecting"));
      const { listIcebergTables } = await import("../../../../lib/iceberg-loader");
      const listed = await listIcebergTables({
        mode: connection.mode,
        location: connection.location,
        ...(connection.endpoint ? { endpoint: connection.endpoint } : {}),
        rowLimit: clampIcebergRowLimit(rowLimit),
      });
      if (requestRef.current !== requestToken) {
        // The inputs changed while the listing was in flight; do not revive a
        // table list that belongs to the previous source.
        return;
      }
      setConnected(connection);
      setTables(listed);
      // "Specify a table, or default to the only one": a source exposing a
      // single table is selected (and inspected) outright; anything else waits
      // for the user, and the submit stays disabled until they choose.
      const only = selectDefaultIcebergTable(listed);
      setSelectedTableKey(only ? icebergTableKey(only) : "");
      if (listed.length === 0) {
        setStatus(t("addData.iceberg.statusNoTables"));
        return;
      }
      if (!only) {
        setStatus(t("addData.iceberg.statusTablesFound", { count: listed.length }));
        return;
      }
      await inspectTable(connection, only, requestToken);
    } catch (err) {
      if (requestRef.current === requestToken) {
        source.setError(errorMessage(err, t("addData.iceberg.errorConnect")));
        setStatus(null);
      }
    } finally {
      endBusy(requestToken);
    }
  };

  const handleSelectTable = async (key: string) => {
    setSelectedTableKey(key);
    setTableInfo(null);
    setGeometryColumn("");
    // A different table means a different generated statement; drop the old one
    // so the pre-fill is regenerated rather than pointing at the previous table.
    setSql("");
    setInspectedSql("");
    const table = tables.find((candidate) => icebergTableKey(candidate) === key) ?? null;
    if (!connected || !table) return;
    const requestToken = ++requestRef.current;
    source.setError(null);
    beginBusy(requestToken);
    try {
      await inspectTable(connected, table, requestToken);
    } catch (err) {
      if (requestRef.current === requestToken) {
        source.setError(errorMessage(err, t("addData.iceberg.errorInspect")));
        setStatus(null);
      }
    } finally {
      endBusy(requestToken);
    }
  };

  const handleSubmit = source.runSubmit(async () => {
    const config = configFor(selectedTable);
    if (!config) {
      throw new Error(t("addData.iceberg.errorConnectFirst"));
    }
    const { loadIcebergTable } = await import("../../../../lib/iceberg-loader");
    const result = await loadIcebergTable(config);
    const name = source.layerName.trim() || selectedTable?.name || t("addData.iceberg.defaultName");
    const layer = {
      ...createBaseLayer(
        name,
        "geojson",
        { type: "geojson", service: "iceberg" },
        {
          ...icebergLayerMetadata(config),
          featureCount: result.featureCount,
          icebergTotalRows: result.totalRows,
          icebergTruncated: result.truncated,
        },
        { geojson: result.geojson },
      ),
      geojson: result.geojson,
    };
    source.addAndClose(layer, { fit: true });
  });

  const rowLimitValue = clampIcebergRowLimit(rowLimit);
  const truncates = tableInfo !== null && tableInfo.rowCount > rowLimitValue;
  // Derived, not stored: the summary has to follow the geometry picker, which
  // changes the CRS being reported without any need to re-read the table. A
  // formatted string set once at inspection time would go stale on switch.
  const selectedGeometry =
    tableInfo?.geometryColumns.find((column) => column.name === geometryColumn) ?? null;
  const summary =
    tableInfo && selectedGeometry
      ? t("addData.iceberg.statusInspected", {
          rows: tableInfo.rowCount.toLocaleString(),
          column: selectedGeometry.name,
          // A column with no CRS parameter is CRS84 by the Iceberg spec, so name
          // it rather than leaving the reader to guess what "no CRS" means.
          crs: icebergCrsFromColumnType(selectedGeometry.type) ?? DEFAULT_ICEBERG_CRS,
        })
      : null;

  return (
    <AddDataSourceForm
      layerName={source.layerName}
      onLayerNameChange={source.setLayerName}
      beforeLayerId={source.beforeLayerId}
      onBeforeLayerIdChange={source.setBeforeLayerId}
      onSubmit={handleSubmit}
      error={source.error}
      submitDisabled={source.isSubmitting || busy || !connected || !selectedTable}
      useServiceIcon
    >
      <div className="space-y-3">
        <p className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {t("addData.iceberg.notice")}
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="iceberg-mode">{t("addData.iceberg.mode")}</Label>
          <Select
            id="iceberg-mode"
            value={mode}
            onChange={(event) => {
              setMode(event.target.value as IcebergMode);
              invalidateConnection();
            }}
          >
            <option value="table">{t("addData.iceberg.modeTable")}</option>
            <option value="catalog">{t("addData.iceberg.modeCatalog")}</option>
          </Select>
        </div>
        {mode === "catalog" ? (
          <div className="space-y-1.5">
            <Label htmlFor="iceberg-endpoint">{t("addData.iceberg.endpoint")}</Label>
            <Input
              id="iceberg-endpoint"
              placeholder={t("addData.iceberg.endpointPlaceholder")}
              value={endpoint}
              onChange={(event) => {
                setEndpoint(event.target.value);
                invalidateConnection();
              }}
            />
          </div>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <div className="space-y-1.5">
            <Label htmlFor="iceberg-location">
              {mode === "catalog" ? t("addData.iceberg.warehouse") : t("addData.iceberg.location")}
            </Label>
            <Input
              id="iceberg-location"
              placeholder={
                mode === "catalog"
                  ? t("addData.iceberg.warehousePlaceholder")
                  : t("addData.iceberg.locationPlaceholder")
              }
              value={location}
              onChange={(event) => {
                setLocation(event.target.value);
                invalidateConnection();
              }}
            />
          </div>
          <div className="flex items-end">
            <Button
              type="button"
              variant="outline"
              onClick={handleConnect}
              disabled={busy || source.isSubmitting}
            >
              {t("addData.iceberg.connect")}
            </Button>
          </div>
        </div>
        {status ? <p className="text-xs text-muted-foreground">{status}</p> : null}
        {summary ? <p className="text-xs text-muted-foreground">{summary}</p> : null}
        {tables.length > 0 ? (
          <div className="space-y-1.5">
            <Label htmlFor="iceberg-table">{t("addData.iceberg.table")}</Label>
            <Select
              id="iceberg-table"
              value={selectedTableKey}
              // Held while an inspection runs so a second one cannot be started
              // over the first; the token gate above then has a single request
              // to own `busy`.
              disabled={busy || source.isSubmitting}
              onChange={(event) => {
                void handleSelectTable(event.target.value);
              }}
            >
              {/* Only offered when the source exposes more than one table: a
                  single table is preselected, so a blank option would just be
                  a way to un-choose the only valid answer. */}
              {tables.length > 1 ? (
                <option value="">{t("addData.iceberg.selectTable")}</option>
              ) : null}
              {tables.map((table) => (
                <option key={icebergTableKey(table)} value={icebergTableKey(table)}>
                  {icebergTableLabel(table)}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        {connected && selectedTable ? (
          <div className="space-y-1.5">
            <Label htmlFor="iceberg-sql">{t("addData.iceberg.sql")}</Label>
            <Textarea
              id="iceberg-sql"
              rows={4}
              spellCheck={false}
              className="font-mono text-xs"
              value={sql}
              onChange={(event) => setSql(event.target.value)}
              onBlur={() => {
                void handleSqlBlur();
              }}
            />
            <p className="text-xs text-muted-foreground">{t("addData.iceberg.sqlHint")}</p>
          </div>
        ) : null}
        {/* Only GEOMETRY-typed columns are offered: Iceberg v3 has a real
            geometry type, so a BLOB or VARCHAR here is an attribute and picking
            one could only fail inside ST_AsGeoJSON. The picker appears solely
            when there is a genuine choice to make. */}
        {tableInfo && tableInfo.geometryColumns.length > 1 ? (
          <div className="space-y-1.5">
            <Label htmlFor="iceberg-geometry-column">{t("addData.iceberg.geometryColumn")}</Label>
            <Select
              id="iceberg-geometry-column"
              value={geometryColumn}
              onChange={(event) => setGeometryColumn(event.target.value)}
            >
              {tableInfo.geometryColumns.map((column) => (
                <option key={column.name} value={column.name}>
                  {column.name} ({column.type})
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor="iceberg-row-limit">{t("addData.iceberg.rowLimit")}</Label>
          <Input
            id="iceberg-row-limit"
            inputMode="numeric"
            value={rowLimit}
            onChange={(event) => setRowLimit(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {truncates
              ? t("addData.iceberg.rowLimitTruncates", {
                  limit: rowLimitValue.toLocaleString(),
                  total: tableInfo.rowCount.toLocaleString(),
                })
              : t("addData.iceberg.rowLimitHint", {
                  max: MAX_ICEBERG_ROW_LIMIT.toLocaleString(),
                })}
          </p>
        </div>
      </div>
    </AddDataSourceForm>
  );
}
