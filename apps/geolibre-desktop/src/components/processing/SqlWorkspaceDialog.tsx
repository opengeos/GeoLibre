import { useAppStore } from "@geolibre/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  ScrollArea,
  Select,
  cn,
} from "@geolibre/ui";
import {
  AlertCircle,
  Download,
  Eraser,
  Loader2,
  MapPlus,
  Play,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import {
  exportBinaryVectorLayer,
  type BinaryVectorExportResult,
} from "../../lib/vector-exporter";
import {
  previewLayerTables,
  resultToCsv,
  runSqlQuery,
  SAMPLE_DATASET_URL,
  type SqlQueryResult,
} from "../../lib/sql-workspace";
import { saveBinaryFileWithFallback } from "../../lib/tauri-io";

const CSV_MIME_TYPE = "text/csv";

// Cap how many result rows are rendered so a large result set cannot freeze the
// UI; the full result is still used for export and add-as-layer.
const MAX_DISPLAYED_ROWS = 500;

const SAMPLE_QUERY = "SELECT 1 AS hello;";

// Curated examples covering plain attribute tables, aggregates, and spatial
// queries that return a geometry column (so "Add as layer" / export work). All
// were validated against the dataset above.
const SAMPLE_QUERIES: ReadonlyArray<{ label: string; sql: string }> = [
  {
    label: "Countries with geometry",
    sql: `SELECT NAME, CONTINENT, POP_EST, geom\nFROM ${SAMPLE_DATASET_URL}\nLIMIT 100;`,
  },
  {
    label: "Attributes only (no geometry)",
    sql: `SELECT NAME, CONTINENT, POP_EST, GDP_MD_EST\nFROM ${SAMPLE_DATASET_URL}\nORDER BY POP_EST DESC\nLIMIT 10;`,
  },
  {
    label: "Population by continent (aggregate)",
    sql: `SELECT CONTINENT, COUNT(*) AS countries, SUM(POP_EST) AS population\nFROM ${SAMPLE_DATASET_URL}\nGROUP BY CONTINENT\nORDER BY population DESC;`,
  },
  {
    label: "Most populous countries (geometry)",
    sql: `SELECT NAME, POP_EST, geom\nFROM ${SAMPLE_DATASET_URL}\nWHERE POP_EST > 50000000\nORDER BY POP_EST DESC;`,
  },
  {
    label: "Country centroids (spatial)",
    sql: `SELECT NAME, CONTINENT, ST_Centroid(geom) AS geom\nFROM ${SAMPLE_DATASET_URL}\nWHERE CONTINENT = 'Africa';`,
  },
  {
    label: "Largest countries by area (spatial)",
    sql: `SELECT NAME, ST_Area(geom) AS area\nFROM ${SAMPLE_DATASET_URL}\nORDER BY area DESC\nLIMIT 10;`,
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
    const parsed = JSON.parse(
      window.localStorage.getItem(HISTORY_STORAGE_KEY) ?? "[]",
    );
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
  const next = [
    trimmed,
    ...history.filter((entry) => entry !== trimmed),
  ].slice(0, MAX_HISTORY_ENTRIES);
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

export function SqlWorkspaceDialog() {
  const open = useAppStore((s) => s.ui.sqlWorkspaceOpen);
  const setSqlWorkspaceOpen = useAppStore((s) => s.setSqlWorkspaceOpen);
  const layers = useAppStore((s) => s.layers);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);

  const [sql, setSql] = useState(SAMPLE_QUERY);
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SqlQueryResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>(loadQueryHistory);
  const [layerName, setLayerName] = useState("");

  const tables = useMemo(() => previewLayerTables(layers), [layers]);

  // `running` state lags a render behind, so a rapid second Ctrl+Enter could
  // read the stale `false` and fire a concurrent query. A ref is updated
  // synchronously and guards against that race; `running` only drives the UI.
  const runningRef = useRef(false);
  // Same race for exports: the disabled buttons lag a render, so a fast double
  // click could open two save dialogs. The ref guards synchronously.
  const exportingRef = useRef(false);
  // handleAddAsLayer is synchronous, so a rapid double-click could add the same
  // result as two layers before React re-renders. The ref guards synchronously.
  const addingLayerRef = useRef(false);

  const runQuery = async () => {
    const trimmed = sql.trim();
    if (!trimmed || runningRef.current) return;
    setHistory((current) => saveQueryToHistory(current, trimmed));
    runningRef.current = true;
    setRunning(true);
    setError(null);
    setNotice(null);
    try {
      const queryResult = await runSqlQuery(trimmed, layers);
      setResult(queryResult);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : String(err));
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
  };

  const handleAddAsLayer = () => {
    if (!result?.geojson || addingLayerRef.current) return;
    addingLayerRef.current = true;
    setError(null);
    const featureCount = result.geojson.features.length;
    const name =
      layerName.trim() || `SQL result ${new Date().toLocaleTimeString()}`;
    addGeoJsonLayer(name, result.geojson);
    setNotice(`Added ${featureCount} features to the map as "${name}".`);
    addingLayerRef.current = false;
  };

  const saveBinary = async (
    payload: BinaryVectorExportResult,
    label: string,
  ) => {
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
    if (savedName) setNotice(`Saved ${label} as ${savedName}.`);
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
      const exported = await exportBinaryVectorLayer(
        result.geojson,
        "geoparquet",
        "SQL result",
      );
      // exportBinaryVectorLayer already sets the GeoParquet mimeType.
      await saveBinary(exported, "GeoParquet");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  };

  const displayedRows = result?.rows.slice(0, MAX_DISPLAYED_ROWS) ?? [];
  const hiddenRowCount = result ? result.rowCount - displayedRows.length : 0;

  return (
    <Dialog open={open} onOpenChange={setSqlWorkspaceOpen}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>SQL Workspace</DialogTitle>
          <DialogDescription>
            Run DuckDB SQL against loaded layers, files, and URLs. The spatial
            extension is loaded, so {"ST_*"} functions are available.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2">
            {tables.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Queryable layers:{" "}
                {tables.map((table, index) => (
                  <span key={table.tableName}>
                    {index > 0 ? ", " : ""}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">
                      {table.tableName}
                    </code>
                  </span>
                ))}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                No vector layers are loaded as tables yet. You can still read
                files and URLs with {"read_parquet()"}, {"read_csv_auto()"}, or{" "}
                {"ST_Read()"}.
              </p>
            )}
            <div className="ml-auto flex items-center gap-2">
              {history.length > 0 ? (
                <Select
                  aria-label="Reuse a query from history"
                  className="h-8 w-auto max-w-[12rem] text-xs"
                  value=""
                  onChange={(event) => {
                    const entry = history[Number(event.target.value)];
                    if (entry) setSql(entry);
                  }}
                >
                  <option value="" disabled>
                    History…
                  </option>
                  {history.map((entry, index) => (
                    <option key={index} value={index}>
                      {historyLabel(entry)}
                    </option>
                  ))}
                </Select>
              ) : null}
              <Select
                aria-label="Insert a sample query"
                className="h-8 w-auto text-xs"
                value=""
                onChange={(event) => {
                  const index = Number(event.target.value);
                  const sample = SAMPLE_QUERIES[index];
                  if (sample) setSql(sample.sql);
                }}
              >
                <option value="" disabled>
                  Sample queries…
                </option>
                {SAMPLE_QUERIES.map((sample, index) => (
                  <option key={sample.label} value={index}>
                    {sample.label}
                  </option>
                ))}
              </Select>
              {tables.length > 0 ? (
                <Select
                  aria-label="Insert a sample query for a layer"
                  className="h-8 w-auto text-xs"
                  value=""
                  onChange={(event) => {
                    const tableName = event.target.value;
                    if (tableName) setSql(sampleQueryForTable(tableName));
                  }}
                >
                  <option value="" disabled>
                    Sample query for layer…
                  </option>
                  {tables.map((table) => (
                    <option key={table.tableName} value={table.tableName}>
                      {table.tableName}
                    </option>
                  ))}
                </Select>
              ) : null}
            </div>
          </div>

          <label htmlFor="sql-workspace-editor" className="sr-only">
            SQL query
          </label>
          <textarea
            id="sql-workspace-editor"
            value={sql}
            onChange={(event) => setSql(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                void runQuery();
              }
            }}
            spellCheck={false}
            rows={6}
            className={cn(
              "w-full rounded-md border border-input bg-transparent px-3 py-2",
              "font-mono text-sm shadow-sm transition-colors",
              "placeholder:text-muted-foreground focus-visible:border-2",
              "focus-visible:border-ring focus-visible:outline-none",
            )}
            placeholder="SELECT * FROM your_layer LIMIT 10;"
          />

          <div className="flex items-center gap-2">
            <Button onClick={runQuery} disabled={running || !sql.trim()}>
              {running ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              Run
            </Button>
            <Button
              variant="outline"
              onClick={clearWorkspace}
              disabled={running || (!sql && !result && !error && !notice)}
            >
              <Eraser className="h-4 w-4" />
              Clear
            </Button>
            {result ? (
              <span className="text-sm text-muted-foreground">
                {result.rowCount} row{result.rowCount === 1 ? "" : "s"} ·{" "}
                {result.columns.length} column
                {result.columns.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>

          {error ? (
            <div className="grid gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <p className="flex items-start gap-2 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="font-mono">{error}</span>
              </p>
            </div>
          ) : null}

          {notice ? (
            <p className="text-sm text-muted-foreground">{notice}</p>
          ) : null}

          {result ? (
            <div className="grid gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {result.geojson ? (
                  <Input
                    aria-label="Layer name"
                    className="h-8 w-48 text-sm"
                    value={layerName}
                    onChange={(event) => setLayerName(event.target.value)}
                    placeholder="Layer name (optional)"
                  />
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleAddAsLayer}
                  disabled={!result.geojson || exporting}
                >
                  <MapPlus className="h-4 w-4" />
                  Add as layer
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleExportCsv}
                  disabled={result.columns.length === 0 || exporting}
                >
                  <Download className="h-4 w-4" />
                  Export CSV
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleExportGeoParquet}
                  disabled={!result.geojson || exporting}
                >
                  <Download className="h-4 w-4" />
                  Export GeoParquet
                </Button>
              </div>

              {result.columns.length > 0 ? (
                <ScrollArea className="max-h-80 rounded-md border">
                  <table className="w-full border-collapse text-sm">
                    <thead className="sticky top-0 bg-muted">
                      <tr>
                        {result.columns.map((column) => (
                          <th
                            key={column}
                            className="border-b px-2 py-1.5 text-left font-medium"
                          >
                            {column}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {displayedRows.map((row, rowIndex) => (
                        <tr key={rowIndex} className="even:bg-muted/40">
                          {result.columns.map((column) => (
                            <td
                              key={column}
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
                <p className="text-sm text-muted-foreground">
                  Statement executed. No rows returned.
                </p>
              )}

              {hiddenRowCount > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Showing first {displayedRows.length} of {result.rowCount} rows.
                  Export to see them all.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
