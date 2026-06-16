import { isDuckDBQueryLayer, useAppStore } from "@geolibre/core";
import {
  getDuckDBLayerRows,
  getGeometryEditTargetLayerId,
  subscribeGeometryEdit,
  updateDuckDBLayerRows,
  type DuckDBAttributeRow,
} from "@geolibre/plugins";
import type { MapController } from "@geolibre/map";
import type { GeoJSONSource } from "maplibre-gl";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Label,
  ScrollArea,
  Select,
  Textarea,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@geolibre/ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Feature, FeatureCollection } from "geojson";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Calculator,
  ChartColumn,
  Columns3,
  Download,
  EyeOff,
  MoreHorizontal,
  Pencil,
  PanelBottomClose,
  Plus,
  RotateCcw,
  Save,
  Sigma,
  TableProperties,
  Telescope,
  Trash2,
  X,
} from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { isTauri } from "../../lib/tauri-io";
import {
  addColumn,
  calculateField,
  deleteColumn,
  getColumnSettings,
  hiddenColumns,
  moveColumn,
  showAllColumns,
  toggleColumnHidden,
  renameColumn,
  visibleColumns,
  type ColumnMoveDirection,
  type NewColumnType,
} from "../../lib/attribute-columns";
import {
  coerceComputedValue,
  compileExpression,
  EXPRESSION_HELPERS,
  fieldReference,
  type CalcOutputType,
} from "../../lib/attribute-expression";
import { AttributeChartDialog } from "./AttributeChartDialog";
import { AttributeStatsDialog } from "./AttributeStatsDialog";
import { ColumnExplorerDialog } from "./ColumnExplorerDialog";
import {
  exportVectorLayer,
  formatAttributeValue,
  geojsonVectorSourceId,
  sanitizeExportFileName,
  shapefileFieldWarnings,
  type VectorExportFormat,
} from "../../lib/vector-export";

type SortDirection = "asc" | "desc";
type SortKey = "__featureId" | string;
type ColumnWidths = Record<string, number>;
type AttributeDrafts = Record<string, Record<string, string>>;
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
// Estimated row height used to size the virtualizer before real rows are
// measured. View-mode rows are ~37px; edit-mode rows (with an Input) are taller
// and are corrected by measureElement once rendered.
const ESTIMATED_ROW_HEIGHT = 37;
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

interface AttributeTableProps {
  mapControllerRef: RefObject<MapController | null>;
}

export function AttributeTable({ mapControllerRef }: AttributeTableProps) {
  const tableSectionRef = useRef<HTMLElement>(null);
  const tableResizeGuideRef = useRef<HTMLDivElement>(null);
  // The Radix ScrollArea viewport, used as the virtualizer's scroll container.
  const scrollViewportRef = useRef<HTMLDivElement>(null);
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
  const [exportWarning, setExportWarning] = useState<string | null>(null);
  const deferTableResize = isTauri();

  const [loadingVectorGeojson, setLoadingVectorGeojson] = useState(false);
  // Inline field-rename editing in a column header.
  const [editingColumn, setEditingColumn] = useState<string | null>(null);
  const [editingColumnName, setEditingColumnName] = useState("");
  // Set true by Escape/commit so the input's blur does not re-commit a rename
  // from a stale closure (mirrors LayerPanel's rename guard).
  const suppressColumnBlurRef = useRef(false);
  const [columnPendingDelete, setColumnPendingDelete] = useState<string | null>(
    null,
  );
  // New-field creation dialog state.
  const [addingColumn, setAddingColumn] = useState(false);
  const [newColumnName, setNewColumnName] = useState("");
  const [newColumnType, setNewColumnType] = useState<NewColumnType>("text");
  const [newColumnDefault, setNewColumnDefault] = useState("");
  // Charts dialog state.
  const [chartOpen, setChartOpen] = useState(false);
  // Field-statistics dialog state.
  const [statsOpen, setStatsOpen] = useState(false);
  // Column-explorer dialog state.
  const [explorerOpen, setExplorerOpen] = useState(false);
  // Field-calculator dialog state.
  const [calcOpen, setCalcOpen] = useState(false);
  const [calcMode, setCalcMode] = useState<"update" | "create">("update");
  const [calcTargetField, setCalcTargetField] = useState("");
  const [calcNewName, setCalcNewName] = useState("");
  const [calcOutputType, setCalcOutputType] = useState<CalcOutputType>("auto");
  const [calcExpression, setCalcExpression] = useState("");
  const [calcSelectedOnly, setCalcSelectedOnly] = useState(false);
  const [calcError, setCalcError] = useState<string | null>(null);
  const calcExpressionRef = useRef<HTMLTextAreaElement>(null);

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
  // Add Vector Layer (geojson-mode) layers render from a MapLibre source the
  // control owns, and their `layer.geojson` is dropped when a project is saved.
  // Edits made here would neither redraw on the map nor survive a save, so the
  // attribute table is read-only for them.
  const isReadOnlyVectorLayer = geojsonVectorSourceId(layer) !== null;
  // While this layer's geometry is being edited in place, attribute edits would
  // race the editor's geometry write-back, so the inline editor is disabled.
  const geometryEditLayerId = useSyncExternalStore(
    subscribeGeometryEdit,
    getGeometryEditTargetLayerId,
  );
  const isGeometryEditing =
    layer != null && geometryEditLayerId === layer.id;

  // Vector layers added via the Add Vector Layer control keep their features in
  // a MapLibre GeoJSON source rather than in `layer.geojson`. Read the data back
  // from the map once so the table (and export) can use it like any other
  // vector layer. Tiles-mode vector layers are not handled here.
  useEffect(() => {
    if (!layer || layer.geojson) {
      setLoadingVectorGeojson(false);
      return;
    }
    const sourceId = geojsonVectorSourceId(layer);
    if (!sourceId) {
      setLoadingVectorGeojson(false);
      return;
    }
    const source = mapControllerRef.current?.getMap()?.getSource(sourceId) as
      | GeoJSONSource
      | undefined;
    if (!source || typeof source.getData !== "function") {
      // Reset here too: a prior run may have left the indicator true, and this
      // early return would otherwise leave it stuck after a layer switch.
      setLoadingVectorGeojson(false);
      return;
    }

    let cancelled = false;
    const layerId = layer.id;
    setLoadingVectorGeojson(true);
    source
      .getData()
      .then((data) => {
        if (cancelled) return;
        if (
          data &&
          typeof data === "object" &&
          (data as { type?: string }).type === "FeatureCollection"
        ) {
          updateLayer(layerId, { geojson: data as FeatureCollection });
        }
      })
      .catch(() => {
        // Best-effort: a source that cannot return data leaves the table in its
        // existing "requires a vector layer" empty state.
      })
      .finally(() => {
        if (!cancelled) setLoadingVectorGeojson(false);
      });

    return () => {
      cancelled = true;
    };
  }, [layer, mapControllerRef, updateLayer]);
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
    // Clear column-management state too, so a rename input or pending delete
    // started on the previous layer cannot apply to a same-named column on the
    // newly selected layer. Suppress the rename Input's onBlur first: clearing
    // editingColumn unmounts it, which fires onBlur -> commitColumnRename with
    // the old column but the new layer, so the guard must already be set.
    suppressColumnBlurRef.current = true;
    setEditingColumn(null);
    setEditingColumnName("");
    setColumnPendingDelete(null);
    setAddingColumn(false);
    setNewColumnName("");
    setNewColumnType("text");
    setNewColumnDefault("");
    setCalcOpen(false);
    setCalcExpression("");
    setCalcError(null);
    setCalcSelectedOnly(false);
  }, [selectedLayerId, hasLayer, isGeometryEditing]);

  // If the selected feature is cleared while the calculator is open, drop the
  // "selected only" flag too: leaving it checked-but-disabled would mislead the
  // user, and the submit guard would silently widen the scope to all features.
  useEffect(() => {
    if (!selectedFeatureId) setCalcSelectedOnly(false);
  }, [selectedFeatureId]);

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

  // Row virtualization: only the rows in (and just around) the viewport are
  // mounted, so opening the table on a layer with tens of thousands of features
  // no longer builds that many DOM nodes at once. Sorting/filtering above still
  // operate over the full data model; the virtualizer only governs rendering.
  const rowVirtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scrollViewportRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    // Key by feature id so measured heights stay attached to the right row when
    // the sort/filter reorders the list. getItemKey is only called with indices
    // in [0, count), so sorted[index] is always defined.
    getItemKey: (index) => sorted[index].featureId,
    // A small cushion of off-screen rows: enough to cover the sticky header's
    // ~1-row offset (the virtualizer measures from the scroll container top) and
    // to avoid blank gaps during fast scrolling, without keeping many extra rows
    // mounted.
    overscan: 8,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualTotalSize = rowVirtualizer.getTotalSize();
  // Spacer rows above/below the rendered window reserve the scroll height of the
  // off-screen rows while keeping the native <table> column layout intact.
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const paddingBottom =
    virtualRows.length > 0
      ? virtualTotalSize - virtualRows[virtualRows.length - 1].end
      : 0;

  // Bring the selected feature's row into view. With virtualization the row may
  // be unmounted (e.g. when a feature is picked on the map), so a plain CSS
  // highlight would be invisible; scroll the virtualizer to it instead. "auto"
  // alignment leaves an already-visible row untouched, so this stays unobtrusive
  // even when it re-runs on every filter keystroke. Re-runs when the table opens
  // (the viewport is null while closed, so scrollToIndex is a no-op then), when
  // the sort changes, when the row count changes (so the scroll fires once rows
  // materialize asynchronously for Add Vector Layer layers), and when the filter
  // text changes (two different filters can yield the same row count yet a
  // different position for the selected row).
  useEffect(() => {
    if (!attributeTableOpen || !selectedFeatureId) return;
    const index = sorted.findIndex(
      (row) => row.featureId === selectedFeatureId,
    );
    if (index >= 0) rowVirtualizer.scrollToIndex(index, { align: "auto" });
    // `sorted`/`rowVirtualizer` are rebuilt every render and so are intentionally
    // excluded; the dependencies below are the inputs that actually change which
    // row (if any) the selected feature occupies and warrant a re-scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedFeatureId,
    selectedLayerId,
    attributeTableOpen,
    sort,
    sorted.length,
    attributeFilter,
  ]);

  const propKeys = new Set<string>();
  for (const row of attributeRows) {
    for (const k of Object.keys(row.properties)) {
      propKeys.add(k);
    }
  }
  const discoveredColumns = Array.from(propKeys);
  const columnSettings = getColumnSettings(layer);
  // Columns rendered in the table, honoring saved order and hidden state.
  const columns = visibleColumns(discoveredColumns, columnSettings);
  const hiddenCols = hiddenColumns(discoveredColumns, columnSettings);
  const hiddenColSet = new Set(hiddenCols);
  const tableColumns = ["__featureId", ...columns];
  // Column management mutates layer.geojson/style/metadata, so it is offered
  // only for in-store, editable GeoJSON layers — not DuckDB query results or
  // Add Vector Layer layers (whose geojson is not persisted).
  const canManageColumns =
    Boolean(layer?.geojson) && !isDuckDBLayer && !isReadOnlyVectorLayer;

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

  const exportLayer = async (format: VectorExportFormat) => {
    if (!layer?.geojson) return;

    try {
      setExportError(null);
      setExportWarning(null);
      const exportGeojson = geojsonWithDrafts();
      if (!exportGeojson) return;

      const baseName = sanitizeExportFileName(layer.name);
      const savedPath = await exportVectorLayer(exportGeojson, format, baseName);
      // Surface Shapefile field-name limitations (10-char truncation and any
      // resulting collisions) only when a file was actually written; a null
      // path means the user cancelled the save dialog.
      if (savedPath !== null && format === "shapefile") {
        const warnings = shapefileFieldWarnings(exportGeojson);
        setExportWarning(warnings.length > 0 ? warnings.join(" ") : null);
      }
    } catch (error) {
      console.error("Failed to export attribute table", error);
      setExportError(
        error instanceof Error
          ? error.message
          : "Could not export the selected layer.",
      );
    }
  };

  const beginColumnRename = (col: string) => {
    suppressColumnBlurRef.current = false;
    setEditingColumn(col);
    setEditingColumnName(col);
  };

  const cancelColumnRename = () => {
    suppressColumnBlurRef.current = true;
    setEditingColumn(null);
    setEditingColumnName("");
  };

  const commitColumnRename = () => {
    if (suppressColumnBlurRef.current || !editingColumn || !layer) {
      suppressColumnBlurRef.current = false;
      return;
    }
    suppressColumnBlurRef.current = true;
    const oldKey = editingColumn;
    // Normalize the key here so the view-state updates below use exactly what
    // renameColumn writes. (renameColumn also trims defensively for other
    // callers; passing the already-trimmed value keeps the two in agreement.)
    const newKey = editingColumnName.trim();
    const patch = renameColumn(layer, discoveredColumns, oldKey, newKey);
    if (patch) {
      updateLayer(layer.id, patch);
      // Keep view state pointing at the renamed column.
      setColumnWidths((current) => {
        if (!(oldKey in current)) return current;
        const { [oldKey]: width, ...rest } = current;
        return { ...rest, [newKey]: width };
      });
      setSort((current) =>
        current.key === oldKey ? { ...current, key: newKey } : current,
      );
    }
    // Always close the editor when committing, even on a no-op (empty,
    // unchanged, or a name that collides with an existing — possibly hidden —
    // column); the original name is kept. This matches the layer-rename UX in
    // LayerPanel. Use Escape to cancel.
    setEditingColumn(null);
    setEditingColumnName("");
  };

  const handleToggleHidden = (col: string) => {
    if (!layer) return;
    updateLayer(layer.id, toggleColumnHidden(layer, col));
  };

  const handleShowAllColumns = () => {
    if (!layer) return;
    updateLayer(layer.id, showAllColumns(layer));
  };

  const handleMoveColumn = (col: string, direction: ColumnMoveDirection) => {
    if (!layer) return;
    const patch = moveColumn(layer, discoveredColumns, col, direction);
    if (patch) updateLayer(layer.id, patch);
  };

  const confirmDeleteColumn = () => {
    if (!layer || !columnPendingDelete) return;
    const patch = deleteColumn(layer, columnPendingDelete);
    if (patch) updateLayer(layer.id, patch);
    // Drop a sort that pointed at the deleted column, which would otherwise
    // leave sort.key referencing an absent field (every row compares equal).
    setSort((current) =>
      current.key === columnPendingDelete
        ? { key: "__featureId", direction: "asc" }
        : current,
    );
    // Drop the deleted column's width so columnWidths doesn't accumulate stale
    // entries across a session (mirrors the migration in commitColumnRename).
    setColumnWidths((current) => {
      if (!(columnPendingDelete in current)) return current;
      const { [columnPendingDelete]: _removed, ...rest } = current;
      return rest;
    });
    setColumnPendingDelete(null);
  };

  const newColumnNameTrimmed = newColumnName.trim();
  const newColumnCollides =
    newColumnNameTrimmed !== "" &&
    discoveredColumns.includes(newColumnNameTrimmed);
  // A field is only discoverable through feature property keys, so a new column
  // cannot be added to a layer with no features (see addColumn).
  const canAddColumn = features.length > 0;
  const canSubmitNewColumn =
    newColumnNameTrimmed !== "" && !newColumnCollides && canAddColumn;

  const openAddColumn = () => {
    setNewColumnName("");
    setNewColumnType("text");
    setNewColumnDefault("");
    setAddingColumn(true);
  };

  const changeNewColumnType = (type: NewColumnType) => {
    setNewColumnType(type);
    // Reset the default to blank ("no default" → null) for every type so a value
    // typed for one type does not carry over to an incompatible one, and so the
    // user must explicitly choose a value rather than silently persisting one.
    setNewColumnDefault("");
  };

  const confirmAddColumn = () => {
    if (!layer || !canSubmitNewColumn) return;
    const patch = addColumn(
      layer,
      discoveredColumns,
      newColumnName,
      newColumnType,
      newColumnDefault,
    );
    if (patch) updateLayer(layer.id, patch);
    setAddingColumn(false);
  };

  const openCalculator = () => {
    const hasColumns = discoveredColumns.length > 0;
    setCalcMode(hasColumns ? "update" : "create");
    setCalcTargetField(hasColumns ? discoveredColumns[0] : "");
    setCalcNewName("");
    setCalcOutputType("auto");
    setCalcExpression("");
    setCalcSelectedOnly(false);
    setCalcError(null);
    setCalcOpen(true);
  };

  // Insert a field reference (or function call) into the expression at the
  // caret, then restore focus so chips can be clicked without losing position.
  // `caretOffset` overrides where the caret lands relative to the inserted text
  // (default: at its end) — function chips use it to land inside the parens.
  const insertExpressionSnippet = (snippet: string, caretOffset?: number) => {
    const el = calcExpressionRef.current;
    if (!el) {
      setCalcExpression((current) => current + snippet);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + snippet + el.value.slice(end);
    // Write the DOM value and caret synchronously, then sync React state. Doing
    // this in a deferred rAF let a rapid second chip click read a stale caret
    // (still 0) and splice at the wrong offset.
    el.value = next;
    const caret = start + (caretOffset ?? snippet.length);
    el.focus();
    el.setSelectionRange(caret, caret);
    setCalcExpression(next);
  };

  const calcNewNameTrimmed = calcNewName.trim();
  const calcNameCollides =
    calcMode === "create" &&
    calcNewNameTrimmed !== "" &&
    discoveredColumns.includes(calcNewNameTrimmed);
  const calcHasTarget =
    calcMode === "create"
      ? calcNewNameTrimmed !== "" && !calcNameCollides
      : calcTargetField !== "";
  const calcHasSelection = Boolean(selectedFeatureId);

  // Live preview of the expression against a sample feature: the selected row
  // when present (and a single feature is targeted), else the first row. A
  // syntax error blocks submission; a runtime error on the sample does not,
  // since other features may still evaluate cleanly.
  const calcSampleRow =
    (calcSelectedOnly && calcHasSelection
      ? attributeRows.find((row) => row.featureId === selectedFeatureId)
      : undefined) ?? attributeRows[0];
  const calcSampleIndex = calcSampleRow
    ? attributeRows.indexOf(calcSampleRow)
    : -1;
  // Stable string keys so the memo skips recompiling the expression on renders
  // that don't change the inputs (discoveredColumns / the sample row are rebuilt
  // with fresh identities every render, so they can't be deps directly).
  // Only serialize while the dialog is open — these exist solely as stable memo
  // deps, and the memo short-circuits to "empty" when closed anyway.
  const calcColumnsKey = calcOpen ? JSON.stringify(discoveredColumns) : "";
  const calcSampleKey =
    calcOpen && calcSampleRow ? JSON.stringify(calcSampleRow.properties) : "";
  const calcPreview = useMemo<
    | { kind: "empty" }
    | { kind: "ok"; value: unknown }
    | { kind: "syntax"; message: string }
    | { kind: "runtime"; message: string }
  >(() => {
    if (!calcOpen || calcExpression.trim() === "") return { kind: "empty" };
    try {
      const compiled = compileExpression(calcExpression, discoveredColumns);
      if (!calcSampleRow) return { kind: "ok", value: null };
      try {
        const raw = compiled.evaluate(calcSampleRow.properties, calcSampleIndex);
        return { kind: "ok", value: coerceComputedValue(raw, calcOutputType) };
      } catch (error) {
        return {
          kind: "runtime",
          message:
            error instanceof Error ? error.message : "Evaluation failed.",
        };
      }
    } catch (error) {
      return {
        kind: "syntax",
        message: error instanceof Error ? error.message : "Invalid expression.",
      };
    }
    // Keyed on the stable strings above rather than the rebuilt arrays/objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    calcOpen,
    calcExpression,
    calcOutputType,
    calcColumnsKey,
    calcSampleKey,
    calcSampleIndex,
  ]);
  const calcCanSubmit =
    features.length > 0 &&
    calcHasTarget &&
    calcExpression.trim() !== "" &&
    calcPreview.kind !== "syntax";

  const confirmCalculate = () => {
    if (!layer || !calcCanSubmit) return;
    const targetName =
      calcMode === "create" ? calcNewNameTrimmed : calcTargetField;
    const scope =
      calcSelectedOnly && selectedFeatureId
        ? new Set([selectedFeatureId])
        : undefined;
    const result = calculateField(
      layer,
      discoveredColumns,
      targetName,
      calcMode === "create",
      calcExpression,
      calcOutputType,
      scope,
    );
    if (!result) {
      setCalcError("Could not apply the calculation to this layer.");
      return;
    }
    if ("error" in result) {
      setCalcError(result.error);
      return;
    }
    updateLayer(layer.id, result.patch);
    if (result.errors > 0) {
      // The calculation was applied, but some rows threw and were written as
      // null. Keep the dialog open and report it rather than showing a silent
      // success over a column of nulls.
      setCalcError(
        `Applied, but ${result.errors} of ${result.evaluated} feature(s) errored and were written as null.`,
      );
      return;
    }
    setCalcError(null);
    setCalcOpen(false);
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

  const attributeColumnHeader = (col: string, index: number) => {
    if (editingColumn === col) {
      return (
        <div className="relative flex h-full min-h-10 items-center">
          <Input
            autoFocus
            className="h-7 min-w-0 flex-1 px-2 text-xs"
            aria-label={`Rename field ${col}`}
            value={editingColumnName}
            onClick={(event) => event.stopPropagation()}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setEditingColumnName(event.target.value)}
            onBlur={commitColumnRename}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                commitColumnRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancelColumnRename();
              }
            }}
          />
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={`Resize ${col} column`}
            className="absolute -right-2 top-0 h-full w-3 cursor-col-resize select-none border-r border-transparent hover:border-primary"
            onMouseDown={(event) => startColumnResize(col, event)}
          />
        </div>
      );
    }

    // Read-only / non-manageable layers (DuckDB, Add Vector Layer) keep the
    // plain sortable header with no management affordances.
    if (!canManageColumns || isEditing) return sortableHeader(col, col);

    return (
      <div className="relative flex h-full min-h-10 items-center">
        <button
          type="button"
          className="flex h-full min-w-0 flex-1 items-center gap-1 pr-1 text-left font-medium"
          onClick={() => toggleSort(col)}
        >
          <span className="truncate">{col}</span>
          {renderSortIcon(col)}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 shrink-0 text-muted-foreground"
              title={`Manage field "${col}"`}
              aria-label={`Manage field ${col}`}
              onClick={(event) => event.stopPropagation()}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => beginColumnRename(col)}>
              <Pencil className="mr-2 h-3.5 w-3.5" />
              Rename field
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => handleToggleHidden(col)}>
              <EyeOff className="mr-2 h-3.5 w-3.5" />
              Hide field
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={index === 0}
              onSelect={() => handleMoveColumn(col, "left")}
            >
              <ArrowLeft className="mr-2 h-3.5 w-3.5" />
              Move left
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={index === columns.length - 1}
              onSelect={() => handleMoveColumn(col, "right")}
            >
              <ArrowRight className="mr-2 h-3.5 w-3.5" />
              Move right
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() => setColumnPendingDelete(col)}
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Delete field
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${col} column`}
          className="absolute -right-2 top-0 h-full w-3 cursor-col-resize select-none border-r border-transparent hover:border-primary"
          onMouseDown={(event) => startColumnResize(col, event)}
        />
      </div>
    );
  };

  // Hidden by default: render nothing when closed. The panel is opened on
  // demand from a vector layer's context menu, which sets attributeTableOpen
  // to true.
  if (!attributeTableOpen) {
    return null;
  }

  return (
    <section
      ref={tableSectionRef}
      aria-label="Attribute table"
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
        ) : exportWarning ? (
          <span
            className="max-w-48 truncate text-xs text-amber-600"
            title={exportWarning}
          >
            {exportWarning}
          </span>
        ) : null}
        <Button
          variant={isEditing ? "secondary" : "outline"}
          size="sm"
          className="ml-auto h-7 px-2"
          title={
            isGeometryEditing
              ? "Finish geometry editing to edit attributes"
              : isReadOnlyVectorLayer
                ? "Editing is not available for Add Vector Layer layers"
                : isEditing
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
          disabled={
            !hasAttributeSource ||
            isReadOnlyVectorLayer ||
            isGeometryEditing ||
            (isEditing && hasEdits)
          }
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
        {canManageColumns && !isEditing ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2"
            title="Add a new field"
            aria-label="Add field"
            onClick={openAddColumn}
          >
            <Plus className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Add field</span>
          </Button>
        ) : null}
        {canManageColumns && !isEditing ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2"
            title="Calculate field values from an expression"
            aria-label="Field calculator"
            onClick={openCalculator}
          >
            <Calculator className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Calculate</span>
          </Button>
        ) : null}
        {canManageColumns && !isEditing ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2"
                title="Show or hide fields"
                aria-label="Manage fields"
              >
                <Columns3 className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Fields</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
              <DropdownMenuLabel>Show fields</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {discoveredColumns.length === 0 ? (
                <DropdownMenuItem disabled>No fields</DropdownMenuItem>
              ) : (
                discoveredColumns.map((col) => (
                  <DropdownMenuCheckboxItem
                    key={col}
                    checked={!hiddenColSet.has(col)}
                    // Keep the menu open so several fields can be toggled at once.
                    onSelect={(event: Event) => event.preventDefault()}
                    onCheckedChange={() => handleToggleHidden(col)}
                  >
                    <span className="truncate">{col}</span>
                  </DropdownMenuCheckboxItem>
                ))
              )}
              {hiddenCols.length > 0 ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={handleShowAllColumns}>
                    Show all fields
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {!isEditing ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2"
            title={
              hasAttributeSource
                ? "Explore all fields at a glance"
                : "Column explorer requires a vector or DuckDB query layer"
            }
            aria-label="Column explorer"
            disabled={!hasAttributeSource}
            onClick={() => setExplorerOpen(true)}
          >
            <Telescope className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Explore</span>
          </Button>
        ) : null}
        {!isEditing ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2"
            title={
              hasAttributeSource
                ? "Field statistics summary"
                : "Statistics require a vector or DuckDB query layer"
            }
            aria-label="Field statistics"
            disabled={!hasAttributeSource}
            onClick={() => setStatsOpen(true)}
          >
            <Sigma className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Statistics</span>
          </Button>
        ) : null}
        {!isEditing ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2"
            title={
              hasAttributeSource
                ? "Chart numeric fields"
                : "Charts require a vector or DuckDB query layer"
            }
            aria-label="Charts"
            disabled={!hasAttributeSource}
            onClick={() => setChartOpen(true)}
          >
            <ChartColumn className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Charts</span>
          </Button>
        ) : null}
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
            <DropdownMenuItem onSelect={() => void exportLayer("geopackage")}>
              GeoPackage
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void exportLayer("shapefile")}>
              Shapefile (zipped)
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
        viewportRef={scrollViewportRef}
        className="flex-1 [&_[data-orientation=vertical]]:!top-11 [&_[data-orientation=vertical]]:!h-[calc(100%-3.625rem)]"
      >
        {!hasAttributeSource ? (
          <p className="p-4 text-xs text-muted-foreground">
            {loadingVectorGeojson
              ? "Loading layer attributes…"
              : "Attribute table requires a vector or DuckDB query layer."}
          </p>
        ) : (
          <table
            data-testid="attribute-table"
            className="table-fixed caption-bottom text-sm"
            style={{ minWidth: "100%", width: tableWidth }}
          >
            <colgroup>
              {tableColumns.map((col) => (
                <col key={col} style={{ width: columnWidth(col) }} />
              ))}
            </colgroup>
            <TableHeader className="sticky top-0 z-10 bg-card shadow-xs">
              <TableRow>
                <TableHead className="bg-card">
                  {sortableHeader("__featureId", "#")}
                </TableHead>
                {columns.map((col, index) => (
                  <TableHead key={col} className="bg-card">
                    {attributeColumnHeader(col, index)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {paddingTop > 0 ? (
                <tr aria-hidden="true">
                  <td colSpan={tableColumns.length} style={{ height: paddingTop }} />
                </tr>
              ) : null}
              {virtualRows.map((virtualRow) => {
                const { featureId, properties } = sorted[virtualRow.index];
                const selected = selectedFeatureId === featureId;
                return (
                  <TableRow
                    key={featureId}
                    data-index={virtualRow.index}
                    ref={rowVirtualizer.measureElement}
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
              {paddingBottom > 0 ? (
                <tr aria-hidden="true">
                  <td
                    colSpan={tableColumns.length}
                    style={{ height: paddingBottom }}
                  />
                </tr>
              ) : null}
            </TableBody>
          </table>
        )}
      </ScrollArea>
      <Dialog
        open={columnPendingDelete !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setColumnPendingDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete field</DialogTitle>
            <DialogDescription>
              {`This permanently removes the field "${columnPendingDelete ?? ""}" from every feature in "${layer?.name ?? ""}". Styling or labels that reference it will be cleared. This cannot be undone.`}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setColumnPendingDelete(null)}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDeleteColumn}>
              Delete field
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={addingColumn}
        onOpenChange={(open: boolean) => setAddingColumn(open)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add field</DialogTitle>
            <DialogDescription>
              {`Add a new field to every feature in "${layer?.name ?? ""}".`}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-1">
            <div className="grid gap-1.5">
              <Label htmlFor="new-field-name">Field name</Label>
              <Input
                id="new-field-name"
                autoFocus
                value={newColumnName}
                placeholder="e.g. category"
                aria-invalid={newColumnCollides || undefined}
                onChange={(event) => setNewColumnName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && canSubmitNewColumn) {
                    event.preventDefault();
                    confirmAddColumn();
                  }
                }}
              />
              {newColumnCollides ? (
                <span className="text-xs text-destructive">
                  A field named "{newColumnNameTrimmed}" already exists.
                </span>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-field-type">Type</Label>
              <Select
                id="new-field-type"
                value={newColumnType}
                onChange={(event) =>
                  changeNewColumnType(event.target.value as NewColumnType)
                }
              >
                <option value="text">Text</option>
                <option value="number">Number</option>
                <option value="boolean">Boolean</option>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-field-default">Default value</Label>
              {newColumnType === "boolean" ? (
                <Select
                  id="new-field-default"
                  value={newColumnDefault}
                  onChange={(event) => setNewColumnDefault(event.target.value)}
                >
                  <option value="">(no default)</option>
                  <option value="false">false</option>
                  <option value="true">true</option>
                </Select>
              ) : (
                <Input
                  id="new-field-default"
                  type={newColumnType === "number" ? "number" : "text"}
                  value={newColumnDefault}
                  placeholder="Leave blank for empty"
                  onChange={(event) => setNewColumnDefault(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && canSubmitNewColumn) {
                      event.preventDefault();
                      confirmAddColumn();
                    }
                  }}
                />
              )}
            </div>
            {!canAddColumn ? (
              <span className="text-xs text-destructive">
                This layer has no features to add a field to.
              </span>
            ) : null}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setAddingColumn(false)}>
              Cancel
            </Button>
            <Button disabled={!canSubmitNewColumn} onClick={confirmAddColumn}>
              Add field
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={calcOpen}
        onOpenChange={(open: boolean) => {
          setCalcOpen(open);
          if (!open) setCalcError(null);
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Field calculator</DialogTitle>
            <DialogDescription>
              {`Compute values from a JavaScript expression and write them to a field in "${layer?.name ?? ""}".`}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-1">
            <div className="grid gap-1.5">
              <Label htmlFor="calc-target">Target field</Label>
              <div className="flex gap-2">
                <Select
                  id="calc-target-mode"
                  className="w-40 shrink-0"
                  value={calcMode}
                  onChange={(event) =>
                    setCalcMode(event.target.value as "update" | "create")
                  }
                >
                  <option
                    value="update"
                    disabled={discoveredColumns.length === 0}
                  >
                    Update field
                  </option>
                  <option value="create">Create field</option>
                </Select>
                {calcMode === "create" ? (
                  <Input
                    id="calc-target"
                    className="flex-1"
                    value={calcNewName}
                    placeholder="New field name"
                    aria-invalid={calcNameCollides || undefined}
                    onChange={(event) => setCalcNewName(event.target.value)}
                  />
                ) : (
                  <Select
                    id="calc-target"
                    className="flex-1"
                    value={calcTargetField}
                    onChange={(event) => setCalcTargetField(event.target.value)}
                  >
                    {discoveredColumns.map((col) => (
                      <option key={col} value={col}>
                        {col}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
              {calcNameCollides ? (
                <span className="text-xs text-destructive">
                  A field named "{calcNewNameTrimmed}" already exists.
                </span>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="calc-output-type">Output type</Label>
              <Select
                id="calc-output-type"
                value={calcOutputType}
                onChange={(event) =>
                  setCalcOutputType(event.target.value as CalcOutputType)
                }
              >
                <option value="auto">Auto (keep computed type)</option>
                <option value="text">Text</option>
                <option value="number">Number</option>
                <option value="boolean">Boolean</option>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="calc-expression">Expression</Label>
              <Textarea
                id="calc-expression"
                ref={calcExpressionRef}
                className="min-h-20 font-mono text-xs"
                value={calcExpression}
                placeholder='e.g. pop / area, or upper(name), or pop > 100 ? "big" : "small"'
                onChange={(event) => setCalcExpression(event.target.value)}
              />
              {discoveredColumns.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-xs text-muted-foreground">Fields:</span>
                  {discoveredColumns.map((col) => (
                    <button
                      key={col}
                      type="button"
                      className="rounded border border-input bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted"
                      title={`Insert ${col}`}
                      onClick={() => insertExpressionSnippet(fieldReference(col))}
                    >
                      {col}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-xs text-muted-foreground">
                  Functions:
                </span>
                {Object.keys(EXPRESSION_HELPERS).map((fn) => (
                  <button
                    key={fn}
                    type="button"
                    className="rounded border border-input bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted"
                    title={`Insert ${fn}()`}
                    onClick={() =>
                      // Land the caret between the parens so the user can type
                      // the argument straight away.
                      insertExpressionSnippet(`${fn}()`, fn.length + 1)
                    }
                  >
                    {fn}
                  </button>
                ))}
              </div>
            </div>
            {calcPreview.kind === "syntax" ? (
              <span className="text-xs text-destructive">
                {calcPreview.message}
              </span>
            ) : calcPreview.kind === "runtime" ? (
              <span className="text-xs text-amber-600 dark:text-amber-500">
                {`Sample row errored (other rows may still compute): ${calcPreview.message}`}
              </span>
            ) : calcPreview.kind === "ok" ? (
              <span className="truncate text-xs text-muted-foreground">
                Preview:{" "}
                <span className="font-mono text-foreground">
                  {formatAttributeValue(calcPreview.value)}
                </span>
              </span>
            ) : null}
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={calcSelectedOnly}
                disabled={!calcHasSelection}
                onChange={(event) => setCalcSelectedOnly(event.target.checked)}
              />
              Only update the selected feature
            </label>
            {calcError ? (
              <span className="text-xs text-destructive">{calcError}</span>
            ) : null}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCalcOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!calcCanSubmit} onClick={confirmCalculate}>
              Calculate
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <AttributeChartDialog
        open={chartOpen}
        onOpenChange={setChartOpen}
        rows={attributeRows}
        columns={discoveredColumns}
        layerName={layer?.name ?? ""}
      />
      <AttributeStatsDialog
        open={statsOpen}
        onOpenChange={setStatsOpen}
        rows={attributeRows}
        filteredRows={filtered}
        columns={discoveredColumns}
        layerName={layer?.name ?? ""}
      />
      <ColumnExplorerDialog
        open={explorerOpen}
        onOpenChange={setExplorerOpen}
        rows={attributeRows}
        filteredRows={filtered}
        columns={discoveredColumns}
        layerName={layer?.name ?? ""}
      />
    </section>
  );
}
