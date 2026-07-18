import { useAppStore } from "@geolibre/core";
import { Button, Input, ScrollArea, Select, cn } from "@geolibre/ui";
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Database,
  DatabaseZap,
  Download,
  Eraser,
  Loader2,
  MapPlus,
  Play,
  X,
} from "lucide-react";
import { type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ParseKeys } from "i18next";
import { exportBinaryVectorLayer, type BinaryVectorExportResult } from "../../lib/vector-exporter";
import {
  previewLayerColumns,
  resultToCsv,
  runSqlQuery,
  SAMPLE_DATASET_URL,
  type SqlQueryResult,
} from "../../lib/sql-workspace";
import { runPostgisQuery } from "../../lib/pglite-workspace";
import { runSedonaQuery } from "../../lib/sedona-workspace";
import { sqlQueryLayerMetadata } from "../../lib/sql-query-layer";
import {
  consumePendingSqlWorkspaceQuery,
  SQL_WORKSPACE_PREFILL_EVENT,
} from "../../lib/sql-workspace-prefill";
import { saveBinaryFileWithFallback } from "../../lib/tauri-io";
import { useSqlCompletion } from "../../lib/useSqlCompletion";
import { PANEL_RESIZE_END_EVENT, PANEL_RESIZE_START_EVENT } from "../../lib/panel-resize";

const CSV_MIME_TYPE = "text/csv";

const DEFAULT_PANEL_HEIGHT = 300;
const MIN_PANEL_HEIGHT = 160;
const MAX_PANEL_HEIGHT = 640;
// Share of the panel width given to the editor (the left pane), as a fraction.
// Default 0.42 keeps the editor a little narrower than the results grid.
const DEFAULT_EDITOR_FRACTION = 0.42;
const MIN_EDITOR_FRACTION = 0.2;
const MAX_EDITOR_FRACTION = 0.8;

/** SQL engine backing the workspace. */
type SqlEngine = "duckdb" | "postgis" | "sedona";

const ENGINE_STORAGE_KEY = "geolibre.sqlWorkspace.engine";

/** Load the last-used engine from localStorage, defaulting to DuckDB. */
function loadEngine(): SqlEngine {
  if (typeof window === "undefined") return "duckdb";
  const stored = window.localStorage.getItem(ENGINE_STORAGE_KEY);
  return stored === "postgis" || stored === "sedona" ? stored : "duckdb";
}

/** Persist the chosen engine; ignore storage failures (quota/privacy mode). */
function saveEngine(engine: SqlEngine): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ENGINE_STORAGE_KEY, engine);
  } catch {
    // Best-effort persistence only.
  }
}

// Cap how many result rows are rendered so a large result set cannot freeze the
// UI; the full result is still used for export and add-as-layer.
const MAX_DISPLAYED_ROWS = 500;

const SAMPLE_QUERY = "SELECT 1 AS hello;";

// Curated examples covering plain attribute tables, aggregates, and spatial
// queries that return a geometry column (so "Add as layer" / export work). All
// were validated against the dataset above.
// A curated example: its label is an i18n key (resolved with t() at render) and
// its SQL is inserted verbatim into the editor.
interface SampleQuery {
  labelKey: ParseKeys;
  sql: string;
}

const SAMPLE_QUERIES: ReadonlyArray<SampleQuery> = [
  {
    labelKey: "toolbar.sqlWorkspace.samples.countriesGeom",
    sql: `SELECT NAME, CONTINENT, POP_EST, geom\nFROM ${SAMPLE_DATASET_URL}\nLIMIT 100;`,
  },
  {
    labelKey: "toolbar.sqlWorkspace.samples.attributesOnly",
    sql: `SELECT NAME, CONTINENT, POP_EST, GDP_MD_EST\nFROM ${SAMPLE_DATASET_URL}\nORDER BY POP_EST DESC\nLIMIT 10;`,
  },
  {
    labelKey: "toolbar.sqlWorkspace.samples.populationByContinent",
    sql: `SELECT CONTINENT, COUNT(*) AS countries, SUM(POP_EST) AS population\nFROM ${SAMPLE_DATASET_URL}\nGROUP BY CONTINENT\nORDER BY population DESC;`,
  },
  {
    labelKey: "toolbar.sqlWorkspace.samples.mostPopulous",
    sql: `SELECT NAME, POP_EST, geom\nFROM ${SAMPLE_DATASET_URL}\nWHERE POP_EST > 50000000\nORDER BY POP_EST DESC;`,
  },
  {
    labelKey: "toolbar.sqlWorkspace.samples.countryCentroids",
    sql: `SELECT NAME, CONTINENT, ST_Centroid(geom) AS geom\nFROM ${SAMPLE_DATASET_URL}\nWHERE CONTINENT = 'Africa';`,
  },
  {
    labelKey: "toolbar.sqlWorkspace.samples.largestByArea",
    sql: `SELECT NAME, ST_Area(geom) AS area\nFROM ${SAMPLE_DATASET_URL}\nORDER BY area DESC\nLIMIT 10;`,
  },
];

// PostGIS examples. PGlite cannot read remote files, so these target registered
// layer tables (replace `your_layer` with a name from "Queryable layers") plus a
// couple of table-free spatial constructors. Every table query uses the `geom`
// column the workspace creates on each registered layer.
const POSTGIS_SAMPLE_QUERIES: ReadonlyArray<SampleQuery> = [
  {
    labelKey: "toolbar.sqlWorkspace.samples.postgisVersion",
    sql: "SELECT PostGIS_Full_Version() AS version;",
  },
  {
    labelKey: "toolbar.sqlWorkspace.samples.makePoint",
    sql: "SELECT ST_SetSRID(ST_MakePoint(-115.1398, 36.1699), 4326) AS geom;",
  },
  {
    labelKey: "toolbar.sqlWorkspace.samples.firstRows",
    sql: `SELECT *\nFROM your_layer\nLIMIT 10;`,
  },
  {
    labelKey: "toolbar.sqlWorkspace.samples.featureCount",
    sql: `SELECT COUNT(*) AS features\nFROM your_layer;`,
  },
  {
    labelKey: "toolbar.sqlWorkspace.samples.layerCentroids",
    sql: `SELECT ST_Centroid(geom) AS geom\nFROM your_layer;`,
  },
  {
    labelKey: "toolbar.sqlWorkspace.samples.bufferFeatures",
    sql: `SELECT ST_Buffer(geom, 0.01) AS geom\nFROM your_layer;`,
  },
  {
    labelKey: "toolbar.sqlWorkspace.samples.boundingBox",
    sql: `SELECT ST_Envelope(ST_Collect(geom)) AS geom\nFROM your_layer;`,
  },
];

// Apache Sedona examples. Both backends (the in-browser CereusDB WASM engine and
// the SedonaDB sidecar) register loaded layers as tables, so these target a
// layer table (replace `your_layer` with a name from "Queryable layers") plus a
// couple of table-free spatial constructors. Each table query uses the `geom`
// alias for the geometry column the workspace creates on each registered layer.
const SEDONA_SAMPLE_QUERIES: ReadonlyArray<SampleQuery> = [
  {
    labelKey: "toolbar.sqlWorkspace.samples.makePoint",
    sql: "SELECT ST_Point(-115.1398, 36.1699) AS geom;",
  },
  {
    labelKey: "toolbar.sqlWorkspace.samples.bufferPoint",
    sql: "SELECT ST_Buffer(ST_Point(-115.1398, 36.1699), 0.5) AS geom;",
  },
  {
    labelKey: "toolbar.sqlWorkspace.samples.firstRows",
    sql: `SELECT *\nFROM your_layer\nLIMIT 10;`,
  },
  {
    labelKey: "toolbar.sqlWorkspace.samples.featureCount",
    sql: `SELECT COUNT(*) AS features\nFROM your_layer;`,
  },
  {
    labelKey: "toolbar.sqlWorkspace.samples.layerCentroids",
    sql: `SELECT ST_Centroid(geometry) AS geom\nFROM your_layer;`,
  },
  {
    labelKey: "toolbar.sqlWorkspace.samples.areaPerFeature",
    sql: `SELECT ST_Area(geometry) AS area, geometry AS geom\nFROM your_layer\nORDER BY area DESC\nLIMIT 10;`,
  },
];

/** Build a starter query that selects the first rows of a layer table. */
function sampleQueryForTable(tableName: string): string {
  // Quote the identifier so the generated query stays valid even if the table
  // name ever contains characters the sanitizer does not currently produce.
  return `SELECT *\nFROM "${tableName.replaceAll('"', '""')}"\nLIMIT 10;`;
}

const HISTORY_STORAGE_KEY = "geolibre.sqlWorkspace.history";
const MAX_HISTORY_ENTRIES = 25;

/** Load saved query history from localStorage, newest first. */
function loadQueryHistory(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(HISTORY_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed
          .filter((entry): entry is string => typeof entry === "string")
          .slice(0, MAX_HISTORY_ENTRIES)
      : [];
  } catch {
    return [];
  }
}

/** Prepend a query to history (deduped, newest first, capped) and persist it. */
function saveQueryToHistory(history: string[], query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return history;
  const next = [trimmed, ...history.filter((entry) => entry !== trimmed)].slice(
    0,
    MAX_HISTORY_ENTRIES,
  );
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Best-effort: ignore quota or privacy-mode storage failures.
    }
  }
  return next;
}

/** One-line, length-capped label for a history entry. */
function historyLabel(query: string): string {
  const oneLine = query.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}

/** Format a result cell for display, keeping the grid compact and readable. */
function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[object]";
    }
  }
  return String(value);
}

/**
 * The in-app SQL Workspace: a bottom-docked, resizable panel (à la the Python
 * Console) that runs DuckDB / PostGIS / Apache Sedona SQL against loaded layers,
 * local files, and URLs. Results render beside the editor so a query gives
 * immediate feedback, and the editor autocompletes layer tables, columns, SQL
 * keywords, and spatial functions. Rendered only while open.
 */
export function SqlWorkspacePanel() {
  const setSqlWorkspaceOpen = useAppStore((s) => s.setSqlWorkspaceOpen);
  const layers = useAppStore((s) => s.layers);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const updateLayer = useAppStore((s) => s.updateLayer);

  const { t } = useTranslation();

  const sectionRef = useRef<HTMLElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  // The horizontal flex container holding the editor (left) and results (right);
  // its width drives the drag-to-resize fraction. The editor pane's width is
  // written straight to the DOM during a drag and committed to state on release.
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const editorPaneRef = useRef<HTMLDivElement>(null);
  // Tear down an in-flight drag's window listeners if the panel unmounts
  // mid-drag (e.g. the user closes it while dragging). One per drag axis so a
  // second drag cannot overwrite the other's cleanup.
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const horizontalResizeCleanupRef = useRef<(() => void) | null>(null);

  const [height, setHeight] = useState(DEFAULT_PANEL_HEIGHT);
  const [editorFraction, setEditorFraction] = useState(DEFAULT_EDITOR_FRACTION);
  const [collapsed, setCollapsed] = useState(false);
  const [engine, setEngine] = useState<SqlEngine>(loadEngine);
  const [sql, setSql] = useState(SAMPLE_QUERY);
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SqlQueryResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>(loadQueryHistory);
  const [layerName, setLayerName] = useState("");
  // The statement (and engine) that produced the current `result`, captured at
  // run time so "Add as query layer" stores the SQL that was actually executed
  // even if the editor has been modified since. Set together with setResult.
  const [lastRun, setLastRun] = useState<{
    sql: string;
    engine: SqlEngine;
  } | null>(null);

  // A single pass over the layers supplies both the columns (for autocomplete)
  // and the table names; deriving `tables` from it avoids walking the layers a
  // second time via previewLayerTables. The Sedona engine registers the geometry
  // column as `geometry`; DuckDB and PGlite use `geom`.
  const tableColumns = useMemo(
    () => previewLayerColumns(layers, engine === "sedona" ? "geometry" : "geom"),
    [layers, engine],
  );
  const tables = useMemo(() => tableColumns.map((table) => table.tableName), [tableColumns]);
  const sampleQueries =
    engine === "postgis"
      ? POSTGIS_SAMPLE_QUERIES
      : engine === "sedona"
        ? SEDONA_SAMPLE_QUERIES
        : SAMPLE_QUERIES;
  // DuckDB can read files/URLs directly; PostGIS and Sedona query loaded layers.
  const queriesLayersOnly = engine === "postgis" || engine === "sedona";

  const completion = useSqlCompletion({
    textareaRef: editorRef,
    sql,
    setSql,
    tables: tableColumns,
    label: t("toolbar.sqlWorkspace.completions"),
  });

  // `running` state lags a render behind, so a rapid second Ctrl+Enter could
  // read the stale `false` and fire a concurrent query. A ref is updated
  // synchronously and guards against that race; `running` only drives the UI.
  const runningRef = useRef(false);
  // Same race for exports: the disabled buttons lag a render, so a fast double
  // click could open two save dialogs. The ref guards synchronously.
  const exportingRef = useRef(false);

  // Focus the editor when the panel first opens so the user can type at once.
  useEffect(() => {
    editorRef.current?.focus();
  }, []);

  // Mirror of `sql` for the mount-once prefill listener below, so it can read
  // the in-progress editor text without re-registering on every keystroke.
  const sqlRef = useRef(sql);
  useEffect(() => {
    sqlRef.current = sql;
  }, [sql]);

  // Load a query handed off by a SQL query layer's "Edit query in SQL
  // Workspace" action: consume a parked query on mount (the panel was closed
  // when it was requested) and apply later requests while mounted via the
  // prefill event. Query layers are DuckDB-backed, so the engine follows.
  useEffect(() => {
    const applyPending = () => {
      const pending = consumePendingSqlWorkspaceQuery();
      if (pending === null) return;
      // Loading the layer's query replaces the editor content, so park any
      // in-progress statement in History first — the user can recover it from
      // the History dropdown instead of losing it silently.
      const inProgress = sqlRef.current.trim();
      if (inProgress && inProgress !== pending.trim() && inProgress !== SAMPLE_QUERY) {
        setHistory((current) => saveQueryToHistory(current, inProgress));
      }
      setEngine("duckdb");
      setSql(pending);
      setResult(null);
      setError(null);
      setNotice(null);
      editorRef.current?.focus();
    };
    applyPending();
    window.addEventListener(SQL_WORKSPACE_PREFILL_EVENT, applyPending);
    return () => window.removeEventListener(SQL_WORKSPACE_PREFILL_EVENT, applyPending);
  }, []);

  // Surface the engine error, and when it is a missing-table error append the
  // names the workspace actually exposes so the user can pick a real one (the
  // common cause of issue #906: querying a table name that was never loaded).
  // Declared before runQuery so the dependency order is explicit.
  const describeQueryError = (err: unknown): string => {
    const message = err instanceof Error ? err.message : String(err);
    // Match only the missing-table messages from DuckDB ("... does not exist"),
    // PGlite/PostGIS ("relation ... does not exist"), and SQLite ("no such
    // table"). The broader "Catalog Error" class also covers "already exists"
    // and other cases where listing queryable layers would mislead.
    const missingTable = /does not exist|no such table/i.test(message);
    if (missingTable && tables.length > 0) {
      const names = tables.join(", ");
      return `${message}\n\n${t("toolbar.sqlWorkspace.queryableHint", { names })}`;
    }
    return message;
  };

  const runQuery = async () => {
    const trimmed = sql.trim();
    if (!trimmed || runningRef.current) return;
    completion.close();
    setHistory((current) => saveQueryToHistory(current, trimmed));
    runningRef.current = true;
    setRunning(true);
    setError(null);
    setNotice(null);
    // Clear the previous result so a long-running query does not leave stale
    // rows on screen while the spinner runs.
    setResult(null);
    try {
      const queryResult =
        engine === "postgis"
          ? await runPostgisQuery(trimmed, layers)
          : engine === "sedona"
            ? await runSedonaQuery(trimmed, layers)
            : await runSqlQuery(trimmed, layers);
      setResult(queryResult);
      setLastRun({ sql: trimmed, engine });
    } catch (err) {
      setResult(null);
      setError(describeQueryError(err));
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };

  const clearWorkspace = () => {
    setSql("");
    setResult(null);
    setError(null);
    setNotice(null);
    setLayerName("");
    completion.close();
    editorRef.current?.focus();
  };

  // Each click adds the current result to the map as a new layer. Re-adds are
  // intentional (e.g. to add the same result again under a different name), so
  // the action is not one-shot; the notice updates on every add for feedback.
  const handleAddAsLayer = () => {
    if (!result?.geojson) return;
    setError(null);
    const featureCount = result.geojson.features.length;
    const name = layerName.trim() || `SQL result ${new Date().toLocaleTimeString()}`;
    addGeoJsonLayer(name, result.geojson);
    setNotice(t("toolbar.sqlWorkspace.addedAsLayer", { count: featureCount, name }));
  };

  // A live query layer only makes sense for a DuckDB result: refresh re-runs
  // the stored SQL through the DuckDB engine (refreshSqlQueryLayer).
  const canAddAsQueryLayer = !!result?.geojson && lastRun?.engine === "duckdb";

  // Like handleAddAsLayer, but the executed SQL is stored on the layer so it
  // can be re-run later (Refresh / auto-refresh in the Layers panel).
  const handleAddAsQueryLayer = () => {
    if (!result?.geojson || lastRun?.engine !== "duckdb") return;
    setError(null);
    const featureCount = result.geojson.features.length;
    const name = layerName.trim() || `SQL query ${new Date().toLocaleTimeString()}`;
    const id = addGeoJsonLayer(name, result.geojson);
    // updateLayer replaces `metadata` wholesale, so merge onto whatever base
    // metadata addGeoJsonLayer initialised (read synchronously from the store)
    // rather than overwriting it.
    const created = useAppStore.getState().layers.find((layer) => layer.id === id);
    updateLayer(id, {
      metadata: {
        ...created?.metadata,
        ...sqlQueryLayerMetadata(lastRun.sql),
      },
    });
    setNotice(
      t("toolbar.sqlWorkspace.addedAsQueryLayer", {
        count: featureCount,
        name,
      }),
    );
  };

  const saveBinary = async (payload: BinaryVectorExportResult, label: string) => {
    const savedName = await saveBinaryFileWithFallback(payload.data, {
      defaultName: `sql-result.${payload.extension}`,
      filters: [{ name: label, extensions: [payload.extension] }],
      browserTypes: [
        {
          description: label,
          accept: { [payload.mimeType]: [`.${payload.extension}`] },
        },
      ],
      mimeType: payload.mimeType,
    });
    if (savedName) setNotice(t("toolbar.sqlWorkspace.savedAs", { label, name: savedName }));
  };

  const handleExportCsv = async () => {
    if (!result || exportingRef.current) return;
    exportingRef.current = true;
    setError(null);
    setNotice(null);
    setExporting(true);
    try {
      const csv = resultToCsv(result.columns, result.rows);
      await saveBinary(
        {
          data: new TextEncoder().encode(csv),
          extension: "csv",
          mimeType: CSV_MIME_TYPE,
        },
        "CSV",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  };

  const handleExportGeoParquet = async () => {
    if (!result?.geojson || exportingRef.current) return;
    exportingRef.current = true;
    setError(null);
    setNotice(null);
    setExporting(true);
    try {
      const exported = await exportBinaryVectorLayer(result.geojson, "geoparquet", "SQL result");
      // exportBinaryVectorLayer already sets the GeoParquet mimeType.
      await saveBinary(exported, "GeoParquet");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  };

  // Drag the top edge to resize the panel height, mirroring the Python Console.
  // The live size is written straight to the DOM during the drag and committed
  // to state on release so React re-renders only once.
  const startResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    const startHeight = height;
    let nextHeight = startHeight;
    let frame: number | null = null;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.dispatchEvent(new Event(PANEL_RESIZE_START_EVENT));

    const onMove = (moveEvent: MouseEvent) => {
      const available = Math.max(MIN_PANEL_HEIGHT, window.innerHeight - 180);
      const maxHeight = Math.min(MAX_PANEL_HEIGHT, available);
      nextHeight = Math.min(
        maxHeight,
        Math.max(MIN_PANEL_HEIGHT, startHeight + startY - moveEvent.clientY),
      );
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (sectionRef.current) {
          sectionRef.current.style.height = `${nextHeight}px`;
        }
      });
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      resizeCleanupRef.current = null;
      if (frame !== null) window.cancelAnimationFrame(frame);
      setHeight(nextHeight);
      window.dispatchEvent(new Event(PANEL_RESIZE_END_EVENT));
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    resizeCleanupRef.current = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (frame !== null) window.cancelAnimationFrame(frame);
      // Pair the START dispatched on mousedown so MapCanvas clears its
      // resize-active flag even when unmounted mid-drag.
      window.dispatchEvent(new Event(PANEL_RESIZE_END_EVENT));
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  };

  // Drag the vertical splitter to resize the editor (left) vs results (right).
  // The editor's width is tracked as a fraction of the panel so the split stays
  // proportional as the window resizes, mirroring the Python Console's split.
  const startEditorResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const container = splitContainerRef.current;
    if (!container) return;
    // The container does not resize during a horizontal drag, so capture its
    // geometry once instead of forcing a layout read on every mousemove.
    const rect = container.getBoundingClientRect();
    if (rect.width === 0) return;
    let nextFraction = editorFraction;
    let frame: number | null = null;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const isRtl = getComputedStyle(container).direction === "rtl";

    const onMove = (moveEvent: MouseEvent) => {
      // The editor pane hugs the container's inline-start: its width is the gap
      // between that edge and the cursor.
      const raw = isRtl
        ? (rect.right - moveEvent.clientX) / rect.width
        : (moveEvent.clientX - rect.left) / rect.width;
      nextFraction = Math.min(MAX_EDITOR_FRACTION, Math.max(MIN_EDITOR_FRACTION, raw));
      // Throttle to one DOM write per frame; commit to state only on mouseup.
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (editorPaneRef.current) {
          editorPaneRef.current.style.flexBasis = `${nextFraction * 100}%`;
        }
      });
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      horizontalResizeCleanupRef.current = null;
      if (frame !== null) window.cancelAnimationFrame(frame);
      setEditorFraction(nextFraction);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    horizontalResizeCleanupRef.current = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (frame !== null) window.cancelAnimationFrame(frame);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  };

  // On unmount, tear down any in-flight drag listeners (either axis).
  useEffect(
    () => () => {
      resizeCleanupRef.current?.();
      horizontalResizeCleanupRef.current?.();
    },
    [],
  );

  const displayedRows = result?.rows.slice(0, MAX_DISPLAYED_ROWS) ?? [];
  const hiddenRowCount = result ? result.rowCount - displayedRows.length : 0;

  return (
    <section
      ref={sectionRef}
      aria-label={t("toolbar.sqlWorkspace.title")}
      className="relative flex shrink-0 flex-col border-t bg-card"
      // Collapsed: drop the fixed height so the panel hugs its header.
      style={collapsed ? undefined : { height }}
    >
      {collapsed ? null : (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("toolbar.sqlWorkspace.resize")}
          className="absolute -top-1 left-0 right-0 z-20 h-2 cursor-row-resize select-none border-t border-transparent hover:border-primary"
          onMouseDown={startResize}
        />
      )}

      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <Database className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">{t("toolbar.sqlWorkspace.title")}</span>
        <Select
          aria-label={t("toolbar.sqlWorkspace.engine")}
          className="ms-2 h-7 w-auto text-xs"
          value={engine}
          onChange={(event) => {
            const value = event.target.value;
            const next: SqlEngine =
              value === "postgis" ? "postgis" : value === "sedona" ? "sedona" : "duckdb";
            setEngine(next);
            saveEngine(next);
          }}
        >
          <option value="duckdb">
            {t("toolbar.sqlWorkspace.engineOption", { name: "DuckDB" })}
          </option>
          <option value="postgis">
            {t("toolbar.sqlWorkspace.engineOption", { name: "PostGIS" })}
          </option>
          <option value="sedona">
            {t("toolbar.sqlWorkspace.engineOption", { name: "Apache Sedona" })}
          </option>
        </Select>
        <div className="ms-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title={
              collapsed ? t("toolbar.sqlWorkspace.expand") : t("toolbar.sqlWorkspace.collapse")
            }
            aria-expanded={!collapsed}
            aria-controls="sql-workspace-body"
            onClick={() => setCollapsed((v) => !v)}
          >
            {collapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title={t("toolbar.sqlWorkspace.close")}
            onClick={() => setSqlWorkspaceOpen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div
        id="sql-workspace-body"
        ref={splitContainerRef}
        className={`flex min-h-0 flex-1 ${collapsed ? "hidden" : ""}`}
      >
        {/* Editor pane (left) */}
        <div
          ref={editorPaneRef}
          className="flex min-w-0 shrink-0 grow-0 flex-col gap-2 p-3"
          style={{ flexBasis: `${editorFraction * 100}%` }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label={t("toolbar.sqlWorkspace.sampleQueriesLabel")}
              className="h-7 w-auto max-w-[11rem] text-xs"
              value=""
              onChange={(event) => {
                const index = Number(event.target.value);
                const sample = sampleQueries[index];
                if (sample) setSql(sample.sql);
              }}
            >
              <option value="" disabled>
                {t("toolbar.sqlWorkspace.sampleQueries")}
              </option>
              {sampleQueries.map((sample, index) => (
                <option key={sample.labelKey} value={index}>
                  {t(sample.labelKey)}
                </option>
              ))}
            </Select>
            {history.length > 0 ? (
              <Select
                aria-label={t("toolbar.sqlWorkspace.historyLabel")}
                className="h-7 w-auto max-w-[11rem] text-xs"
                value=""
                onChange={(event) => {
                  const entry = history[Number(event.target.value)];
                  if (entry) setSql(entry);
                }}
              >
                <option value="" disabled>
                  {t("toolbar.sqlWorkspace.history")}
                </option>
                {history.map((entry, index) => (
                  <option key={index} value={index}>
                    {historyLabel(entry)}
                  </option>
                ))}
              </Select>
            ) : null}
            {tables.length > 0 ? (
              <Select
                aria-label={t("toolbar.sqlWorkspace.sampleForLayerLabel")}
                className="h-7 w-auto max-w-[11rem] text-xs"
                value=""
                onChange={(event) => {
                  const tableName = event.target.value;
                  if (tableName) setSql(sampleQueryForTable(tableName));
                }}
              >
                <option value="" disabled>
                  {t("toolbar.sqlWorkspace.sampleForLayer")}
                </option>
                {tables.map((tableName) => (
                  <option key={tableName} value={tableName}>
                    {tableName}
                  </option>
                ))}
              </Select>
            ) : null}
          </div>

          {tables.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("toolbar.sqlWorkspace.queryableLayers")}{" "}
              {tables.map((tableName, index) => (
                <span key={tableName}>
                  {index > 0 ? ", " : ""}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono">{tableName}</code>
                </span>
              ))}
            </p>
          ) : queriesLayersOnly ? (
            <p className="text-xs text-muted-foreground">
              {t("toolbar.sqlWorkspace.noLayersEngine", {
                engine: engine === "sedona" ? "Apache Sedona" : "PostGIS",
              })}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("toolbar.sqlWorkspace.noLayersReaders")}
            </p>
          )}

          <label htmlFor="sql-workspace-editor" className="sr-only">
            {t("toolbar.sqlWorkspace.queryLabel")}
          </label>
          <div className="relative flex min-h-0 flex-1 flex-col">
            {completion.dropdown}
            <textarea
              id="sql-workspace-editor"
              ref={editorRef}
              {...completion.inputProps}
              value={sql}
              onChange={(event) => {
                setSql(event.target.value);
                completion.close();
              }}
              onKeyDown={(event) => {
                if (completion.tryKey(event)) return;
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                  event.preventDefault();
                  void runQuery();
                }
              }}
              spellCheck={false}
              className={cn(
                "min-h-[4rem] w-full flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2",
                "font-mono text-sm shadow-xs transition-colors",
                "placeholder:text-muted-foreground focus-visible:border-2",
                "focus-visible:border-ring focus-visible:outline-none",
              )}
              placeholder={t("toolbar.sqlWorkspace.placeholder")}
            />
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => void runQuery()}
              disabled={running || !sql.trim()}
              title={t("toolbar.sqlWorkspace.runHint")}
            >
              {running ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {t("toolbar.sqlWorkspace.run")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={clearWorkspace}
              disabled={running || (!sql && !result && !error && !notice)}
            >
              <Eraser className="h-4 w-4" />
              {t("toolbar.sqlWorkspace.clear")}
            </Button>
            {result ? (
              <span className="text-xs text-muted-foreground">
                {t("toolbar.sqlWorkspace.rowsCount", { count: result.rowCount })} ·{" "}
                {t("toolbar.sqlWorkspace.columnsCount", {
                  count: result.columns.length,
                })}
              </span>
            ) : null}
          </div>
        </div>

        {/* Draggable splitter between the editor and results panes */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("toolbar.sqlWorkspace.resizeEditor")}
          className="w-1 shrink-0 cursor-col-resize select-none bg-border hover:bg-primary"
          onMouseDown={startEditorResize}
        />

        {/* Results pane (right) */}
        <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
          <div className="flex flex-wrap items-center gap-2">
            {result?.geojson ? (
              <Input
                aria-label={t("toolbar.sqlWorkspace.layerName")}
                className="h-8 w-44 text-sm"
                value={layerName}
                onChange={(event) => setLayerName(event.target.value)}
                placeholder={t("toolbar.sqlWorkspace.layerNamePlaceholder")}
              />
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={handleAddAsLayer}
              disabled={!result?.geojson || exporting}
            >
              <MapPlus className="h-4 w-4" />
              {t("toolbar.sqlWorkspace.addAsLayer")}
            </Button>
            {canAddAsQueryLayer ? (
              <Button
                variant="outline"
                size="sm"
                onClick={handleAddAsQueryLayer}
                disabled={exporting}
                title={t("toolbar.sqlWorkspace.addAsQueryLayerHint")}
              >
                <DatabaseZap className="h-4 w-4" />
                {t("toolbar.sqlWorkspace.addAsQueryLayer")}
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportCsv}
              disabled={!result || result.columns.length === 0 || exporting}
            >
              <Download className="h-4 w-4" />
              {t("toolbar.sqlWorkspace.exportCsv")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportGeoParquet}
              disabled={!result?.geojson || exporting}
            >
              <Download className="h-4 w-4" />
              {t("toolbar.sqlWorkspace.exportGeoParquet")}
            </Button>
          </div>

          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <p className="flex items-start gap-2 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="whitespace-pre-wrap font-mono">{error}</span>
              </p>
            </div>
          ) : null}

          {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}

          {result ? (
            result.columns.length > 0 ? (
              <ScrollArea className="min-h-0 flex-1 rounded-md border">
                <table className="w-full border-collapse text-sm">
                  <thead className="sticky top-0 bg-muted">
                    <tr>
                      {/* Key by index: a SELECT * over a join can repeat a
                          column name, and names would not be unique keys. */}
                      {result.columns.map((column, colIndex) => (
                        <th key={colIndex} className="border-b px-2 py-1.5 text-start font-medium">
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {displayedRows.map((row, rowIndex) => (
                      <tr key={rowIndex} className="even:bg-muted/40">
                        {result.columns.map((column, colIndex) => (
                          <td
                            key={colIndex}
                            className="max-w-xs truncate border-b px-2 py-1 font-mono"
                            title={formatCell(row[column])}
                          >
                            {formatCell(row[column])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollArea>
            ) : (
              <p className="text-sm text-muted-foreground">{t("toolbar.sqlWorkspace.noRows")}</p>
            )
          ) : error ? null : (
            <div className="flex min-h-0 flex-1 items-center justify-center rounded-md border border-dashed">
              <p className="px-4 text-center text-sm text-muted-foreground">
                {t("toolbar.sqlWorkspace.resultsPlaceholder")}
              </p>
            </div>
          )}

          {hiddenRowCount > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("toolbar.sqlWorkspace.showingRows", {
                shown: displayedRows.length,
                total: result?.rowCount ?? 0,
              })}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
