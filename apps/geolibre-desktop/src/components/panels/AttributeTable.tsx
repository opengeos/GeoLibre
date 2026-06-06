import { isDuckDBQueryLayer, useAppStore } from "@geolibre/core";
import {
  getDuckDBLayerRows,
  updateDuckDBLayerRows,
  type DuckDBAttributeRow,
} from "@geolibre/plugins";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  ScrollArea,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@geolibre/ui";
import type { Feature } from "geojson";
import {
  ArrowDown,
  ArrowUp,
  Download,
  Pencil,
  PanelBottomClose,
  PanelBottomOpen,
  RotateCcw,
  Save,
  TableProperties,
  X,
} from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  isTauri,
  saveBinaryFileWithFallback,
  saveTextFileWithFallback,
} from "../../lib/tauri-io";
import type { BinaryVectorExportFormat } from "../../lib/vector-exporter";

type SortDirection = "asc" | "desc";
type SortKey = "__featureId" | string;
type ColumnWidths = Record<string, number>;
type AttributeDrafts = Record<string, Record<string, string>>;
type ExportFormat = "geojson" | "csv" | BinaryVectorExportFormat;
type AttributeTableRow = {
  featureId: string;
  properties: Record<string, unknown>;
};

const DEFAULT_FEATURE_ID_COLUMN_WIDTH = 72;
const DEFAULT_ATTRIBUTE_COLUMN_WIDTH = 160;
const MIN_FEATURE_ID_COLUMN_WIDTH = 48;
const MAX_FEATURE_ID_COLUMN_WIDTH = 180;
const MIN_ATTRIBUTE_COLUMN_WIDTH = 72;
const MAX_ATTRIBUTE_COLUMN_WIDTH = 520;
const DEFAULT_TABLE_HEIGHT = 192;
const MIN_TABLE_HEIGHT = 96;
const MAX_TABLE_HEIGHT = 520;
const PANEL_RESIZE_START_EVENT = "geolibre:panel-resize-start";
const PANEL_RESIZE_END_EVENT = "geolibre:panel-resize-end";

function compareAttributeValues(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;

  if (typeof a === "number" && typeof b === "number") return a - b;

  const aNumber = Number(a);
  const bNumber = Number(b);
  if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) {
    return aNumber - bNumber;
  }

  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function formatAttributeValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function parseAttributeDraft(draft: string, previousValue: unknown): unknown {
  if (draft.trim() === "") return null;

  // A null/undefined cell carries no original type to infer from, so the raw
  // string is kept as-is: editing a previously-empty cell does not coerce to
  // number/boolean/object.
  if (previousValue == null) return draft;

  if (typeof previousValue === "number") {
    const nextValue = Number(draft);
    return Number.isFinite(nextValue) ? nextValue : draft;
  }

  if (typeof previousValue === "boolean") {
    const normalized = draft.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    return draft;
  }

  if (typeof previousValue === "object") {
    try {
      return JSON.parse(draft);
    } catch {
      return draft;
    }
  }

  return draft;
}

function isInvalidObjectDraft(draft: string, previousValue: unknown): boolean {
  if (typeof previousValue !== "object" || previousValue == null) return false;
  if (draft.trim() === "") return false;
  try {
    JSON.parse(draft);
    return false;
  } catch {
    return true;
  }
}

function hasDraftEdits(drafts: AttributeDrafts): boolean {
  return Object.values(drafts).some(
    (columns) => Object.keys(columns).length > 0,
  );
}

function applyDraftsToFeatures(
  features: Feature[],
  drafts: AttributeDrafts,
): Feature[] {
  return features.map((feature, index) => {
    const featureId = String(feature.id ?? index);
    const rowDrafts = drafts[featureId];
    if (!rowDrafts) return feature;

    const properties = { ...(feature.properties ?? {}) };
    for (const [column, draft] of Object.entries(rowDrafts)) {
      const previousValue = feature.properties?.[column];
      // Skip drafts that are invalid JSON for an object-typed cell so we never
      // persist or export a type-corrupted value; the existing value is kept.
      if (isInvalidObjectDraft(draft, previousValue)) continue;
      properties[column] = parseAttributeDraft(draft, previousValue);
    }

    return { ...feature, properties };
  });
}

function duckDBRowsToAttributeRows(
  rows: DuckDBAttributeRow[],
): AttributeTableRow[] {
  return rows.map((row) => ({
    featureId: row.featureId,
    properties: row.properties,
  }));
}

function applyDraftsToDuckDBRows(
  rows: AttributeTableRow[],
  drafts: AttributeDrafts,
): Record<string, Record<string, unknown>> {
  const rowById = new Map(rows.map((row) => [row.featureId, row]));
  const updates: Record<string, Record<string, unknown>> = {};

  for (const [featureId, rowDrafts] of Object.entries(drafts)) {
    const row = rowById.get(featureId);
    if (!row) continue;

    const properties: Record<string, unknown> = {};
    for (const [column, draft] of Object.entries(rowDrafts)) {
      const previousValue = row.properties[column];
      if (isInvalidObjectDraft(draft, previousValue)) continue;
      properties[column] = parseAttributeDraft(draft, previousValue);
    }

    if (Object.keys(properties).length > 0) updates[featureId] = properties;
  }

  return updates;
}

function sanitizeExportFileName(name: string): string {
  const sanitized = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return sanitized || "layer";
}

function csvCell(value: unknown): string {
  const text = formatAttributeValue(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportFormatLabel(format: BinaryVectorExportFormat): string {
  switch (format) {
    case "geoparquet":
      return "GeoParquet";
  }
}

function exportFileExtension(format: BinaryVectorExportFormat): string {
  switch (format) {
    case "geoparquet":
      return "parquet";
  }
}

function exportMimeType(format: BinaryVectorExportFormat): string {
  switch (format) {
    case "geoparquet":
      return "application/vnd.apache.parquet";
  }
}

export function AttributeTable() {
  const tableSectionRef = useRef<HTMLElement>(null);
  const tableResizeGuideRef = useRef<HTMLDivElement>(null);
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  const layers = useAppStore((s) => s.layers);
  const attributeFilter = useAppStore((s) => s.attributeFilter);
  const setAttributeFilter = useAppStore((s) => s.setAttributeFilter);
  const selectedFeatureId = useAppStore((s) => s.selectedFeatureId);
  const selectFeature = useAppStore((s) => s.selectFeature);
  const attributeTableOpen = useAppStore((s) => s.ui.attributeTableOpen);
  const setAttributeTableOpen = useAppStore((s) => s.setAttributeTableOpen);
  const updateLayer = useAppStore((s) => s.updateLayer);
  const zoomToSelectedFeature = useAppStore(
    (s) => s.ui.zoomToSelectedFeature,
  );
  const setZoomToSelectedFeature = useAppStore(
    (s) => s.setZoomToSelectedFeature,
  );
  const [sort, setSort] = useState<{
    key: SortKey;
    direction: SortDirection;
  }>({
    key: "__featureId",
    direction: "asc",
  });
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>({});
  const [tableHeight, setTableHeight] = useState(DEFAULT_TABLE_HEIGHT);
  const [isEditing, setIsEditing] = useState(false);
  const [drafts, setDrafts] = useState<AttributeDrafts>({});
  const [exportError, setExportError] = useState<string | null>(null);
  const deferTableResize = isTauri();

  const layer = layers.find((l) => l.id === selectedLayerId);
  const hasLayer = Boolean(layer);
  const features = layer?.geojson?.features ?? [];
  const isDuckDBLayer = isDuckDBQueryLayer(layer);
  const duckdbRows = layer && isDuckDBLayer ? getDuckDBLayerRows(layer.id) : [];
  const attributeRows: AttributeTableRow[] = isDuckDBLayer
    ? duckDBRowsToAttributeRows(duckdbRows)
    : features.map((feature, index) => ({
        featureId: String(feature.id ?? index),
        properties: (feature.properties ?? {}) as Record<string, unknown>,
      }));
  const hasAttributeSource = Boolean(layer?.geojson || isDuckDBLayer);
  const hasEdits = hasDraftEdits(drafts);
  const hasInvalidDrafts = attributeRows.some((row) => {
    const rowDrafts = drafts[row.featureId];
    if (!rowDrafts) return false;
    return Object.entries(rowDrafts).some(([column, draft]) =>
      isInvalidObjectDraft(draft, row.properties[column]),
    );
  });

  useEffect(() => {
    setIsEditing(false);
    setDrafts({});
  }, [selectedLayerId, hasLayer]);

  const filterLower = attributeFilter.toLowerCase();
  const filtered = attributeRows.filter(({ properties, featureId }) => {
    if (!filterLower) return true;
    const props = JSON.stringify(properties).toLowerCase();
    return featureId.includes(filterLower) || props.includes(filterLower);
  });
  const sorted = [...filtered].sort((a, b) => {
    const aValue =
      sort.key === "__featureId"
        ? a.featureId
        : a.properties[sort.key];
    const bValue =
      sort.key === "__featureId"
        ? b.featureId
        : b.properties[sort.key];
    const result = compareAttributeValues(aValue, bValue);
    return sort.direction === "asc" ? result : -result;
  });

  const propKeys = new Set<string>();
  for (const row of attributeRows) {
    for (const k of Object.keys(row.properties)) {
      propKeys.add(k);
    }
  }
  const columns = Array.from(propKeys);
  const tableColumns = ["__featureId", ...columns];

  const columnWidth = (key: SortKey) =>
    columnWidths[key] ??
    (key === "__featureId"
      ? DEFAULT_FEATURE_ID_COLUMN_WIDTH
      : DEFAULT_ATTRIBUTE_COLUMN_WIDTH);
  const tableWidth = tableColumns.reduce(
    (width, column) => width + columnWidth(column),
    0,
  );

  const columnWidthLimits = (key: SortKey) =>
    key === "__featureId"
      ? {
          max: MAX_FEATURE_ID_COLUMN_WIDTH,
          min: MIN_FEATURE_ID_COLUMN_WIDTH,
        }
      : {
          max: MAX_ATTRIBUTE_COLUMN_WIDTH,
          min: MIN_ATTRIBUTE_COLUMN_WIDTH,
        };

  const startColumnResize = (
    key: SortKey,
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = columnWidth(key);
    const { min, max } = columnWidthLimits(key);

    const onMouseMove = (moveEvent: MouseEvent) => {
      const nextWidth = Math.min(
        max,
        Math.max(min, startWidth + moveEvent.clientX - startX),
      );
      setColumnWidths((current) => ({ ...current, [key]: nextWidth }));
    };

    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const startTableResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const startY = event.clientY;
    const startHeight = tableHeight;
    let nextHeight = startHeight;
    let resizeFrame: number | null = null;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.dispatchEvent(new Event(PANEL_RESIZE_START_EVENT));

    const onMouseMove = (moveEvent: MouseEvent) => {
      const availableHeight = Math.max(
        MIN_TABLE_HEIGHT,
        window.innerHeight - 180,
      );
      const maxHeight = Math.min(MAX_TABLE_HEIGHT, availableHeight);
      nextHeight = Math.min(
        maxHeight,
        Math.max(MIN_TABLE_HEIGHT, startHeight + startY - moveEvent.clientY),
      );
      if (resizeFrame !== null) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        if (deferTableResize) {
          if (tableResizeGuideRef.current) {
            tableResizeGuideRef.current.style.top = `${
              startY + startHeight - nextHeight
            }px`;
            tableResizeGuideRef.current.classList.remove("hidden");
          }
          return;
        }
        if (tableSectionRef.current) {
          tableSectionRef.current.style.height = `${nextHeight}px`;
        }
      });
    };

    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
        resizeFrame = null;
      }
      if (tableSectionRef.current) {
        tableSectionRef.current.style.height = `${nextHeight}px`;
      }
      tableResizeGuideRef.current?.classList.add("hidden");
      setTableHeight(nextHeight);
      window.dispatchEvent(new Event(PANEL_RESIZE_END_EVENT));
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const toggleSort = (key: SortKey) => {
    setSort((current) => ({
      key,
      direction:
        current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  };

  const renderSortIcon = (key: SortKey) => {
    if (sort.key !== key) return null;
    return sort.direction === "asc" ? (
      <ArrowUp className="h-3.5 w-3.5" />
    ) : (
      <ArrowDown className="h-3.5 w-3.5" />
    );
  };

  const updateCellDraft = (
    featureId: string,
    column: string,
    value: string,
    previousValue: unknown,
  ) => {
    setDrafts((current) => {
      const next = { ...current };
      const row = { ...(next[featureId] ?? {}) };

      if (value === formatAttributeValue(previousValue)) {
        delete row[column];
      } else {
        row[column] = value;
      }

      if (Object.keys(row).length === 0) {
        delete next[featureId];
      } else {
        next[featureId] = row;
      }

      return next;
    });
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setDrafts({});
  };

  const toggleEditing = () => {
    if (isEditing && !hasEdits) {
      setIsEditing(false);
      return;
    }

    if (!isEditing) {
      setIsEditing(true);
    }
  };

  const saveDrafts = () => {
    if (!layer || !hasEdits || hasInvalidDrafts) return;

    if (isDuckDBLayer) {
      updateDuckDBLayerRows(
        layer.id,
        applyDraftsToDuckDBRows(attributeRows, drafts),
      );
      setIsEditing(false);
      setDrafts({});
      return;
    }

    if (!layer.geojson) return;

    const geojson = {
      ...layer.geojson,
      features: applyDraftsToFeatures(layer.geojson.features, drafts),
    };

    updateLayer(layer.id, { geojson });
    setIsEditing(false);
    setDrafts({});
  };

  const geojsonWithDrafts = () => {
    if (!layer?.geojson) return null;

    return {
      ...layer.geojson,
      features: applyDraftsToFeatures(layer.geojson.features, drafts),
    };
  };

  const geojsonToCsv = (
    geojson: NonNullable<ReturnType<typeof geojsonWithDrafts>>,
  ) => {
    const propertyKeys = new Set<string>();
    for (const feature of geojson.features) {
      for (const key of Object.keys(feature.properties ?? {})) {
        propertyKeys.add(key);
      }
    }

    const headers = ["feature_id", ...propertyKeys];
    const rows = geojson.features.map((feature, index) => {
      const featureId = String(feature.id ?? index);
      const properties = feature.properties ?? {};
      const values = [
        featureId,
        ...Array.from(propertyKeys).map((key) => properties[key]),
      ];
      return values
        .map(csvCell)
        .join(",");
    });

    return [headers.map(csvCell).join(","), ...rows].join("\n");
  };

  const exportTextLayer = async (
    format: Extract<ExportFormat, "geojson" | "csv">,
    exportGeojson: NonNullable<ReturnType<typeof geojsonWithDrafts>>,
    baseName: string,
  ) => {
    const isCsv = format === "csv";
    const content = isCsv
      ? geojsonToCsv(exportGeojson)
      : JSON.stringify(exportGeojson, null, 2);
    await saveTextFileWithFallback(content, {
      defaultName: `${baseName}.${isCsv ? "csv" : "geojson"}`,
      filters: [
        isCsv
          ? { name: "CSV", extensions: ["csv"] }
          : { name: "GeoJSON", extensions: ["geojson", "json"] },
      ],
      browserTypes: [
        {
          description: isCsv ? "CSV" : "GeoJSON",
          accept: isCsv
            ? { "text/csv": [".csv"] }
            : { "application/geo+json": [".geojson", ".json"] },
        },
      ],
      mimeType: isCsv ? "text/csv" : "application/geo+json",
    });
  };

  const exportBinaryLayer = async (
    format: BinaryVectorExportFormat,
    exportGeojson: NonNullable<ReturnType<typeof geojsonWithDrafts>>,
    baseName: string,
  ) => {
    const { exportBinaryVectorLayer } = await import("../../lib/vector-exporter");
    const result = await exportBinaryVectorLayer(
      exportGeojson,
      format,
      baseName,
    );
    const label = exportFormatLabel(format);
    const extension = exportFileExtension(format);
    await saveBinaryFileWithFallback(result.data, {
      defaultName: `${baseName}.${extension}`,
      filters: [{ name: label, extensions: [extension] }],
      browserTypes: [
        {
          description: label,
          accept: { [exportMimeType(format)]: [`.${extension}`] },
        },
      ],
      mimeType: result.mimeType,
    });
  };

  const exportLayer = async (format: ExportFormat) => {
    if (!layer?.geojson) return;

    try {
      setExportError(null);
      const exportGeojson = geojsonWithDrafts();
      if (!exportGeojson) return;

      const baseName = sanitizeExportFileName(layer.name);
      if (format === "geojson" || format === "csv") {
        await exportTextLayer(format, exportGeojson, baseName);
        return;
      }

      await exportBinaryLayer(format, exportGeojson, baseName);
    } catch (error) {
      console.error("Failed to export attribute table", error);
      setExportError(
        error instanceof Error
          ? error.message
          : "Could not export the selected layer.",
      );
    }
  };

  const sortableHeader = (key: SortKey, label: string) => (
    <div className="relative flex h-full min-h-10 items-center">
      <button
        type="button"
        className="flex h-full min-w-0 flex-1 items-center gap-1 pr-3 text-left font-medium"
        onClick={() => toggleSort(key)}
      >
        <span className="truncate">{label}</span>
        {renderSortIcon(key)}
      </button>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${label} column`}
        className="absolute -right-2 top-0 h-full w-3 cursor-col-resize select-none border-r border-transparent hover:border-primary"
        onMouseDown={(event) => startColumnResize(key, event)}
      />
    </div>
  );

  if (!attributeTableOpen) {
    return (
      <section className="flex h-11 shrink-0 items-center gap-2 border-t bg-card px-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          title="Expand attribute table"
          aria-label="Expand attribute table"
          onClick={() => setAttributeTableOpen(true)}
        >
          <PanelBottomOpen className="h-4 w-4" />
        </Button>
        <TableProperties className="h-4 w-4 text-muted-foreground" />
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Attribute table
        </span>
      </section>
    );
  }

  return (
    <section
      ref={tableSectionRef}
      className="relative flex shrink-0 flex-col border-t bg-card"
      style={{ height: tableHeight }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize attribute table"
        className="absolute -top-1 left-0 right-0 z-20 h-2 cursor-row-resize select-none border-t border-transparent hover:border-primary"
        onMouseDown={startTableResize}
      />
      <div
        ref={tableResizeGuideRef}
        className="pointer-events-none fixed left-0 right-0 z-50 hidden h-px bg-primary shadow-[0_0_0_1px_hsl(var(--primary)/0.25)]"
      />
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 md:flex-nowrap">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          title="Collapse attribute table"
          aria-label="Collapse attribute table"
          onClick={() => setAttributeTableOpen(false)}
        >
          <PanelBottomClose className="h-4 w-4" />
        </Button>
        <TableProperties className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">Attribute table</span>
        {layer ? (
          <span className="min-w-0 max-w-full truncate text-xs text-muted-foreground md:max-w-56">
            - {layer.name}
          </span>
        ) : (
          <span className="min-w-0 max-w-full truncate text-xs text-muted-foreground md:max-w-56">
            - select a layer with attributes
          </span>
        )}
        {exportError ? (
          <span className="max-w-48 truncate text-xs text-destructive">
            {exportError}
          </span>
        ) : null}
        <Button
          variant={isEditing ? "secondary" : "outline"}
          size="sm"
          className="ml-auto h-7 px-2"
          title={
            isEditing
              ? hasEdits
                ? "Use Save or Cancel to finish editing"
                : "Exit edit mode"
              : isDuckDBLayer
                ? "Edit displayed DuckDB query attributes in memory"
                : "Edit attribute values"
          }
          aria-label={
            isEditing && !hasEdits ? "Exit edit mode" : "Edit attribute values"
          }
          disabled={!hasAttributeSource || (isEditing && hasEdits)}
          onClick={toggleEditing}
        >
          <Pencil className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Edit</span>
        </Button>
        <Button
          variant="default"
          size="sm"
          className="h-7 px-2"
          title={
            hasInvalidDrafts
              ? "Fix invalid JSON before saving"
              : isDuckDBLayer
                ? "Save in-memory DuckDB attribute edits"
                : "Save attribute edits"
          }
          aria-label="Save attribute edits"
          disabled={!isEditing || !hasEdits || hasInvalidDrafts}
          onClick={saveDrafts}
        >
          <Save className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Save</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2"
              title={
                layer?.geojson
                  ? "Export selected layer"
                  : "Export requires a GeoJSON-backed layer"
              }
              aria-label="Export selected layer"
              disabled={!layer?.geojson}
            >
              <Download className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Export</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void exportLayer("geojson")}>
              GeoJSON
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void exportLayer("geoparquet")}>
              GeoParquet
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void exportLayer("csv")}>
              CSV (attributes only)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {isEditing ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Cancel attribute edits"
            aria-label="Cancel attribute edits"
            onClick={cancelEditing}
          >
            <RotateCcw className="h-4 w-4" />
          </Button>
        ) : null}
        <Input
          className="h-7 min-w-36 flex-1 text-xs md:max-w-xs"
          placeholder="Search attributes..."
          aria-label="Search attributes"
          value={attributeFilter}
          onChange={(e) => setAttributeFilter(e.target.value)}
        />
        <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={zoomToSelectedFeature}
            onChange={(event) =>
              setZoomToSelectedFeature(event.target.checked)
            }
          />
          Zoom to selection
        </label>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title="Clear selected feature"
          aria-label="Clear selected feature"
          disabled={!selectedFeatureId}
          onClick={() => selectFeature(null)}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      {/*
        Vertical scrollbar height reserves 3.625rem: 2.75rem for the sticky
        header (top-11) plus 0.875rem for the horizontal scrollbar (h-3.5),
        so the two scrollbars do not overlap.
      */}
      <ScrollArea
        type="always"
        className="flex-1 [&_[data-orientation=vertical]]:!top-11 [&_[data-orientation=vertical]]:!h-[calc(100%-3.625rem)]"
      >
        {!hasAttributeSource ? (
          <p className="p-4 text-xs text-muted-foreground">
            Attribute table requires a vector or DuckDB query layer.
          </p>
        ) : (
          <table
            className="table-fixed caption-bottom text-sm"
            style={{ minWidth: "100%", width: tableWidth }}
          >
            <colgroup>
              {tableColumns.map((col) => (
                <col key={col} style={{ width: columnWidth(col) }} />
              ))}
            </colgroup>
            <TableHeader className="sticky top-0 z-10 bg-card shadow-sm">
              <TableRow>
                <TableHead className="bg-card">
                  {sortableHeader("__featureId", "#")}
                </TableHead>
                {columns.map((col) => (
                  <TableHead key={col} className="bg-card">
                    {sortableHeader(col, col)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map(({ featureId, properties }) => {
                const selected = selectedFeatureId === featureId;
                return (
                  <TableRow
                    key={featureId}
                    data-state={selected ? "selected" : undefined}
                    className="cursor-pointer"
                    onClick={() => {
                      selectFeature(featureId);
                    }}
                  >
                    <TableCell>{featureId}</TableCell>
                    {columns.map((col) => {
                      const value = properties[col];
                      const draft = drafts[featureId]?.[col];
                      const changed = draft !== undefined;
                      const invalid =
                        draft !== undefined &&
                        isInvalidObjectDraft(draft, value);
                      const inputClassName = invalid
                        ? "h-7 min-w-0 border-destructive bg-destructive/10 px-2 text-xs"
                        : changed
                          ? "h-7 min-w-0 border-primary/60 bg-primary/10 px-2 text-xs"
                          : "h-7 min-w-0 px-2 text-xs";
                      return (
                        <TableCell
                          key={col}
                          data-state={changed ? "edited" : undefined}
                          className="data-[state=edited]:bg-primary/10 data-[state=edited]:shadow-[inset_3px_0_0_hsl(var(--primary))]"
                        >
                          {isEditing ? (
                            <Input
                              className={inputClassName}
                              aria-invalid={invalid || undefined}
                              title={
                                invalid ? "Invalid JSON" : undefined
                              }
                              aria-label={`Edit ${col} for feature ${featureId}`}
                              value={draft ?? formatAttributeValue(value)}
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) =>
                                updateCellDraft(
                                  featureId,
                                  col,
                                  event.target.value,
                                  value,
                                )
                              }
                            />
                          ) : (
                            formatAttributeValue(value)
                          )}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                );
              })}
            </TableBody>
          </table>
        )}
      </ScrollArea>
    </section>
  );
}
