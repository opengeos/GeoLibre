import { useTranslation } from "react-i18next";
import {
  coerceAttributeFormValue,
  isDuckDBQueryLayer,
  useAppStore,
  validateAttributeFormValues,
  type AttributeFormConfig,
  type AttributeFormFieldConfig,
  type AttributeFormFieldError,
} from "@geolibre/core";
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
  LayoutDashboard,
  MoreHorizontal,
  MousePointerSquareDashed,
  Pencil,
  PanelBottomClose,
  PanelBottomOpen,
  Plus,
  RotateCcw,
  Save,
  Sigma,
  SquareFunction,
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
import { attributeFormErrorMessage } from "../../lib/attribute-form-messages";
import { computeRowSelection } from "../../lib/attribute-selection";
import { RESERVED_PROPERTY_KEYS } from "../../lib/field-collection";
import {
  AREA_UNITS,
  detectGeometryFamilies,
  DISTANCE_UNITS,
  UNIT_SYMBOLS,
  type GeometryMetric,
} from "../../lib/geometry-measure";
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
import { PANEL_RESIZE_END_EVENT, PANEL_RESIZE_START_EVENT } from "../../lib/panel-resize";

type SortDirection = "asc" | "desc";
type SortKey = "__featureId" | string;
type ColumnWidths = Record<string, number>;
type AttributeDrafts = Record<string, Record<string, string>>;
type AttributeTableRow = {
  featureId: string;
  properties: Record<string, unknown>;
};

/** Reserved inline-image property keys (photo thumbnail + full-resolution) that
 * hold data URLs, so they are hidden from the attribute table's columns. */
const RESERVED_IMAGE_KEYS = new Set<string>(RESERVED_PROPERTY_KEYS);

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
  return Object.values(drafts).some((columns) => Object.keys(columns).length > 0);
}

function applyDraftsToFeatures(
  features: Feature[],
  drafts: AttributeDrafts,
  formFields?: Map<string, AttributeFormFieldConfig>,
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
      // A column with an Attribute Form widget coerces by widget type (a
      // number widget stores a number even into a previously-null cell);
      // unconfigured columns keep the previous-value type inference.
      const config = formFields?.get(column);
      properties[column] = config
        ? coerceAttributeFormValue(config, draft)
        : parseAttributeDraft(draft, previousValue);
    }

    return { ...feature, properties };
  });
}

/**
 * Validate drafted rows against the layer's Attribute Form config. Only edits
 * that introduce (or keep, on an edited field) a violation are reported —
 * pre-existing violations on untouched fields never block an unrelated edit.
 * Iterates the drafts (few rows), not the whole table; `featureById` is the
 * memoized feature index so no per-keystroke full scan happens here. Returns
 * featureId → field → error for every blocking violation.
 */
function computeFormDraftErrors(
  form: AttributeFormConfig | undefined,
  drafts: AttributeDrafts,
  featureById: Map<string, Feature> | null,
): Record<string, Record<string, AttributeFormFieldError>> {
  const result: Record<string, Record<string, AttributeFormFieldError>> = {};
  if (!form?.fields.length || !featureById || !hasDraftEdits(drafts)) {
    return result;
  }

  const formFields = new Map(form.fields.map((entry) => [entry.field, entry]));

  for (const [featureId, rowDrafts] of Object.entries(drafts)) {
    if (Object.keys(rowDrafts).length === 0) continue;
    const feature = featureById.get(featureId);
    if (!feature) continue;
    const properties = (feature.properties ?? {}) as Record<string, unknown>;

    const candidate = { ...properties };
    for (const [column, draft] of Object.entries(rowDrafts)) {
      const previousValue = properties[column];
      if (isInvalidObjectDraft(draft, previousValue)) continue;
      const config = formFields.get(column);
      candidate[column] = config
        ? coerceAttributeFormValue(config, draft)
        : parseAttributeDraft(draft, previousValue);
    }

    const validation = validateAttributeFormValues(form, candidate, {
      feature,
    });
    if (validation.ok) continue;

    const baseline = validateAttributeFormValues(form, properties, {
      feature,
    });
    const rowErrors: Record<string, AttributeFormFieldError> = {};
    for (const [field, error] of Object.entries(validation.errors)) {
      if (rowDrafts[field] !== undefined || !baseline.errors[field]) {
        rowErrors[field] = error;
      }
    }
    if (Object.keys(rowErrors).length > 0) result[featureId] = rowErrors;
  }
  return result;
}

function duckDBRowsToAttributeRows(rows: DuckDBAttributeRow[]): AttributeTableRow[] {
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
  const { t } = useTranslation();
  // Column order is visual: in a right-to-left layout the first column renders
  // rightmost, so the move-left/right actions and their guards swap.
  const isRtl = document.documentElement.dir === "rtl";
  const tableSectionRef = useRef<HTMLElement>(null);
  const tableResizeGuideRef = useRef<HTMLDivElement>(null);
  // The Radix ScrollArea viewport, used as the virtualizer's scroll container.
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  const layers = useAppStore((s) => s.layers);
  const attributeFilter = useAppStore((s) => s.attributeFilter);
  const setAttributeFilter = useAppStore((s) => s.setAttributeFilter);
  const selectedFeatureId = useAppStore((s) => s.selectedFeatureId);
  const selectedFeatureIds = useAppStore((s) => s.selectedFeatureIds);
  const selectFeature = useAppStore((s) => s.selectFeature);
  const selectFeatures = useAppStore((s) => s.selectFeatures);
  const attributeTableOpen = useAppStore((s) => s.ui.attributeTableOpen);
  const setAttributeTableOpen = useAppStore((s) => s.setAttributeTableOpen);
  const setDashboardOpen = useAppStore((s) => s.setDashboardOpen);
  const updateLayer = useAppStore((s) => s.updateLayer);
  const zoomToSelectedFeature = useAppStore((s) => s.ui.zoomToSelectedFeature);
  const setZoomToSelectedFeature = useAppStore((s) => s.setZoomToSelectedFeature);
  const [sort, setSort] = useState<{
    key: SortKey;
    direction: SortDirection;
  }>({
    key: "__featureId",
    direction: "asc",
  });
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>({});
  // "all" shows every feature; "selected" restricts the table to the current
  // multi-selection (the Show All / Show Selected dropdown).
  const [featureView, setFeatureView] = useState<"all" | "selected">("all");
  const [tableHeight, setTableHeight] = useState(DEFAULT_TABLE_HEIGHT);
  // Collapsed shows only the toolbar header, hiding the table body, while the
  // panel stays open. Distinct from closing the panel entirely (the X button).
  const [collapsed, setCollapsed] = useState(false);
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
  const [columnPendingDelete, setColumnPendingDelete] = useState<string | null>(null);
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
  // Geometry-measurement helper inside the calculator: which metric and unit the
  // "Insert" button builds a `$length/$perimeter/$area(...)` snippet from.
  const [calcGeomMetric, setCalcGeomMetric] = useState<GeometryMetric>("length");
  const [calcGeomUnit, setCalcGeomUnit] = useState<string>("meters");
  const calcExpressionRef = useRef<HTMLTextAreaElement>(null);

  const layer = layers.find((l) => l.id === selectedLayerId);
  const hasLayer = Boolean(layer);
  // Columns materialized by persistent joins are derived data: every save
  // re-derives them from the join table, so an edit, rename, or delete here
  // would be silently undone. Render them read-only instead.
  const joinDerivedColumns = useMemo(
    () => new Set((layer?.joins ?? []).flatMap((join) => join.addedFields ?? [])),
    [layer?.joins],
  );
  // Same for columns computed by virtual fields (expression-backed, re-derived
  // on every data change): read-only here, managed in Layer properties.
  const virtualFieldColumns = useMemo(
    () =>
      new Set(
        (layer?.virtualFields ?? []).flatMap((field) =>
          field.addedField ? [field.addedField] : [],
        ),
      ),
    [layer?.virtualFields],
  );
  const derivedColumns = useMemo(
    () => new Set([...joinDerivedColumns, ...virtualFieldColumns]),
    [joinDerivedColumns, virtualFieldColumns],
  );
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
  const isGeometryEditing = layer != null && geometryEditLayerId === layer.id;

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
  // Attribute Form designer config: per-column edit widgets plus constraint
  // validation of drafted rows. DuckDB layers keep the plain text editor —
  // the designer is only offered for store-backed geojson layers.
  const attributeForm = isDuckDBLayer ? undefined : layer?.attributeForm;
  const formFields = useMemo(
    () => new Map((attributeForm?.fields ?? []).map((entry) => [entry.field, entry])),
    [attributeForm],
  );
  // Feature index for validation, rebuilt only when the layer data (not a
  // draft keystroke) changes; null when no form config is active.
  const formFeatureIndex = useMemo(() => {
    if (!attributeForm?.fields.length) return null;
    const geojsonFeatures = layer?.geojson?.features ?? [];
    return new Map(
      geojsonFeatures.map((feature, index): [string, Feature] => [
        String(feature.id ?? index),
        feature,
      ]),
    );
  }, [attributeForm, layer?.geojson]);
  const formDraftErrors = useMemo(
    () => computeFormDraftErrors(attributeForm, drafts, formFeatureIndex),
    [attributeForm, drafts, formFeatureIndex],
  );
  const hasFormErrors = Object.keys(formDraftErrors).length > 0;

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

  // Always reopen the table expanded: a panel left collapsed before it was
  // closed should not reappear collapsed the next time it is opened.
  useEffect(() => {
    if (!attributeTableOpen) setCollapsed(false);
  }, [attributeTableOpen]);

  // "Show Selected Features" over an empty selection is a blank table; fall back
  // to showing everything once nothing is selected (e.g. after clearing or
  // switching layers).
  useEffect(() => {
    if (selectedFeatureIds.length === 0) setFeatureView("all");
  }, [selectedFeatureIds.length]);

  // O(1) lookups for the multi-selection while rendering thousands of rows.
  const selectedIdSet = useMemo(() => new Set(selectedFeatureIds), [selectedFeatureIds]);

  const filterLower = attributeFilter.toLowerCase();
  const filtered = attributeRows.filter(({ properties, featureId }) => {
    // "Show Selected Features" restricts the table to the current selection.
    if (featureView === "selected" && !selectedIdSet.has(featureId)) return false;
    if (!filterLower) return true;
    const props = JSON.stringify(properties).toLowerCase();
    return featureId.includes(filterLower) || props.includes(filterLower);
  });
  const sorted = [...filtered].sort((a, b) => {
    const aValue = sort.key === "__featureId" ? a.featureId : a.properties[sort.key];
    const bValue = sort.key === "__featureId" ? b.featureId : b.properties[sort.key];
    const result = compareAttributeValues(aValue, bValue);
    return sort.direction === "asc" ? result : -result;
  });

  // Row selection with keyboard modifiers (plain / Ctrl-toggle / Shift-range /
  // Shift+Ctrl merge). The branching lives in the pure `computeRowSelection`
  // helper so it can be unit-tested; here we just feed it the current state.
  const handleRowClick = (featureId: string, event: ReactMouseEvent<HTMLTableRowElement>) => {
    const additive = event.ctrlKey || event.metaKey;
    const range = event.shiftKey;
    const { ids, anchor } = computeRowSelection({
      featureId,
      sortedIds: sorted.map((row) => row.featureId),
      selectedIds: selectedFeatureIds,
      anchorId: selectedFeatureId,
      additive,
      range,
    });
    // A plain click ("make this the sole selection") while reviewing the
    // "Show Selected" subset would otherwise shrink the table to that one row.
    // Drop back to "Show All" so the pick lands in the full table instead of
    // stranding the user on a single-row view. Modifier clicks are deliberate
    // refinements of the shown set, so they stay in the selected view.
    if (!additive && !range && featureView === "selected") {
      setFeatureView("all");
    }
    selectFeatures(ids, anchor);
  };

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
    virtualRows.length > 0 ? virtualTotalSize - virtualRows[virtualRows.length - 1].end : 0;

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
    const index = sorted.findIndex((row) => row.featureId === selectedFeatureId);
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
      // The inline photo/full-resolution image keys are multi-KB-to-MB data
      // URLs (the map popup and Identify render them as thumbnails instead); a
      // table cell would dump the raw base64 as text and jank on large photos.
      if (!RESERVED_IMAGE_KEYS.has(k)) propKeys.add(k);
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
  const canManageColumns = Boolean(layer?.geojson) && !isDuckDBLayer && !isReadOnlyVectorLayer;

  const columnWidth = (key: SortKey) =>
    columnWidths[key] ??
    (key === "__featureId" ? DEFAULT_FEATURE_ID_COLUMN_WIDTH : DEFAULT_ATTRIBUTE_COLUMN_WIDTH);
  const tableWidth = tableColumns.reduce((width, column) => width + columnWidth(column), 0);

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

  const startColumnResize = (key: SortKey, event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = columnWidth(key);
    const { min, max } = columnWidthLimits(key);
    // The handle sits at the column's logical inline-end (`-end-2`) — the right
    // edge in LTR, the left edge in RTL. clientX still increases to the right in
    // both, so invert the delta under RTL: dragging the (left-side) RTL handle
    // outward lowers clientX but should widen the column.
    const directionSign = getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const nextWidth = Math.min(
        max,
        Math.max(min, startWidth + directionSign * (moveEvent.clientX - startX)),
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
      const availableHeight = Math.max(MIN_TABLE_HEIGHT, window.innerHeight - 180);
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
            tableResizeGuideRef.current.style.top = `${startY + startHeight - nextHeight}px`;
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
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
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

  // Localize an Attribute Form validation error for a cell tooltip.
  const formErrorText = (error: AttributeFormFieldError): string =>
    attributeFormErrorMessage(t, error);

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
    if (!layer || !hasEdits || hasInvalidDrafts || hasFormErrors) return;

    if (isDuckDBLayer) {
      updateDuckDBLayerRows(layer.id, applyDraftsToDuckDBRows(attributeRows, drafts));
      setIsEditing(false);
      setDrafts({});
      return;
    }

    if (!layer.geojson) return;

    const geojson = {
      ...layer.geojson,
      features: applyDraftsToFeatures(layer.geojson.features, drafts, formFields),
    };

    updateLayer(layer.id, { geojson });
    setIsEditing(false);
    setDrafts({});
  };

  const geojsonWithDrafts = () => {
    if (!layer?.geojson) return null;

    return {
      ...layer.geojson,
      features: applyDraftsToFeatures(layer.geojson.features, drafts, formFields),
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
      setExportError(error instanceof Error ? error.message : t("attributeTable.exportFailed"));
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
      setSort((current) => (current.key === oldKey ? { ...current, key: newKey } : current));
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
      current.key === columnPendingDelete ? { key: "__featureId", direction: "asc" } : current,
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
    newColumnNameTrimmed !== "" && discoveredColumns.includes(newColumnNameTrimmed);
  // A field is only discoverable through feature property keys, so a new column
  // cannot be added to a layer with no features (see addColumn).
  const canAddColumn = features.length > 0;
  const canSubmitNewColumn = newColumnNameTrimmed !== "" && !newColumnCollides && canAddColumn;

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

  // The Field Calculator must not target a derived column (joined or virtual)
  // either: the calculated value would be overwritten by the re-derivation in
  // the same store update.
  const calculatorTargetColumns = discoveredColumns.filter((col) => !derivedColumns.has(col));

  const openCalculator = () => {
    const hasColumns = calculatorTargetColumns.length > 0;
    setCalcMode(hasColumns ? "update" : "create");
    setCalcTargetField(hasColumns ? calculatorTargetColumns[0] : "");
    setCalcNewName("");
    setCalcOutputType("auto");
    setCalcExpression("");
    setCalcSelectedOnly(false);
    setCalcError(null);
    // Seed the geometry measurement to a metric that suits the layer; the
    // effective-metric fallback still corrects any mismatch on render.
    const families = detectGeometryFamilies(features);
    const lineOnly = families.has("line") && !families.has("polygon");
    setCalcGeomMetric(lineOnly ? "length" : "area");
    setCalcGeomUnit(lineOnly ? "meters" : "square-meters");
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

  // Geometry family drives which measurements the calculator offers: a polygon
  // layer gets Area/Perimeter, a line layer gets Length, a mixed layer gets all
  // three, and point/geometry-less layers get none (the row is hidden).
  const calcGeometryFamilies = useMemo(
    () => detectGeometryFamilies(features),
    // Recompute when the layer or its feature count changes, and each time the
    // dialog opens, so a geometry-type edit made while it was closed is picked
    // up. The families are otherwise stable across renders (and the calc dialog
    // is modal, so geometry cannot be edited while it is open). eslint can't see
    // that the array identity of `features` alone is not a meaningful dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layer?.id, features.length, calcOpen],
  );
  const calcAvailableMetrics = useMemo<GeometryMetric[]>(() => {
    // Offer only metrics the layer's geometry actually supports, so a mixed
    // point+line layer gets Length but not a no-op Area.
    const metrics: GeometryMetric[] = [];
    if (calcGeometryFamilies.has("polygon")) metrics.push("area", "perimeter");
    if (calcGeometryFamilies.has("line")) metrics.push("length");
    return metrics;
  }, [calcGeometryFamilies]);
  // Fall back to the first available metric/unit when the current selection is
  // not valid for this layer (e.g. an "area" choice carried over to a line layer).
  const calcEffectiveMetric = calcAvailableMetrics.includes(calcGeomMetric)
    ? calcGeomMetric
    : (calcAvailableMetrics[0] ?? "length");
  const calcGeomUnitOptions = calcEffectiveMetric === "area" ? AREA_UNITS : DISTANCE_UNITS;
  const calcEffectiveUnit = (calcGeomUnitOptions as readonly string[]).includes(calcGeomUnit)
    ? calcGeomUnit
    : calcGeomUnitOptions[0];

  const insertGeometrySnippet = () => {
    const snippet = `$${calcEffectiveMetric}(${JSON.stringify(calcEffectiveUnit)})`;
    insertExpressionSnippet(snippet);
  };

  const calcNewNameTrimmed = calcNewName.trim();
  const calcNameCollides =
    calcMode === "create" &&
    calcNewNameTrimmed !== "" &&
    discoveredColumns.includes(calcNewNameTrimmed);
  const calcHasTarget =
    calcMode === "create" ? calcNewNameTrimmed !== "" && !calcNameCollides : calcTargetField !== "";
  const calcHasSelection = selectedFeatureIds.length > 0;

  // Live preview of the expression against a sample feature: the selected row
  // when present (and a single feature is targeted), else the first row. A
  // syntax error blocks submission; a runtime error on the sample does not,
  // since other features may still evaluate cleanly.
  const calcSampleRow =
    (calcSelectedOnly && calcHasSelection
      ? attributeRows.find((row) => row.featureId === selectedFeatureId)
      : undefined) ?? attributeRows[0];
  const calcSampleIndex = calcSampleRow ? attributeRows.indexOf(calcSampleRow) : -1;
  // Stable string keys so the memo skips recompiling the expression on renders
  // that don't change the inputs (discoveredColumns / the sample row are rebuilt
  // with fresh identities every render, so they can't be deps directly).
  // Only serialize while the dialog is open — these exist solely as stable memo
  // deps, and the memo short-circuits to "empty" when closed anyway.
  const calcColumnsKey = calcOpen ? JSON.stringify(discoveredColumns) : "";
  const calcSampleKey = calcOpen && calcSampleRow ? JSON.stringify(calcSampleRow.properties) : "";
  // The preview feeds the sample feature's geometry to $length/$perimeter/$area,
  // so key on the geometry too — a geometry change (not just a property change)
  // must recompute the preview. Only one feature is serialized, and only while
  // the dialog is open.
  const calcSampleGeomKey =
    calcOpen && calcSampleRow ? JSON.stringify(features[calcSampleIndex]?.geometry ?? null) : "";
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
        // attributeRows map 1:1 to geojson features by index, so the sample
        // row's geometry drives the $length/$perimeter/$area helpers in the
        // preview (undefined for DuckDB layers, which the helpers treat as 0).
        const raw = compiled.evaluate(
          calcSampleRow.properties,
          calcSampleIndex,
          features[calcSampleIndex]?.geometry,
        );
        return { kind: "ok", value: coerceComputedValue(raw, calcOutputType) };
      } catch (error) {
        return {
          kind: "runtime",
          message: error instanceof Error ? error.message : t("attributeTable.evaluationFailed"),
        };
      }
    } catch (error) {
      return {
        kind: "syntax",
        message: error instanceof Error ? error.message : t("attributeTable.invalidExpression"),
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
    calcSampleGeomKey,
    calcSampleIndex,
  ]);
  const calcCanSubmit =
    features.length > 0 &&
    calcHasTarget &&
    calcExpression.trim() !== "" &&
    calcPreview.kind !== "syntax";

  const confirmCalculate = () => {
    if (!layer || !calcCanSubmit) return;
    const targetName = calcMode === "create" ? calcNewNameTrimmed : calcTargetField;
    const scope =
      calcSelectedOnly && selectedFeatureIds.length > 0 ? new Set(selectedFeatureIds) : undefined;
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
      setCalcError(t("attributeTable.calcCouldNotApply"));
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
        t("attributeTable.calcAppliedWithErrors", {
          errors: result.errors,
          evaluated: result.evaluated,
        }),
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
        className="flex h-full min-w-0 flex-1 items-center gap-1 pe-3 text-start font-medium"
        onClick={() => toggleSort(key)}
      >
        <span className="truncate">{label}</span>
        {renderSortIcon(key)}
      </button>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("attributeTable.resizeColumn", { name: label })}
        className="absolute -end-2 top-0 h-full w-3 cursor-col-resize select-none border-e border-transparent hover:border-primary"
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
            aria-label={t("attributeTable.renameFieldAria", { name: col })}
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
            aria-label={t("attributeTable.resizeColumn", { name: col })}
            className="absolute -end-2 top-0 h-full w-3 cursor-col-resize select-none border-e border-transparent hover:border-primary"
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
          className="flex h-full min-w-0 flex-1 items-center gap-1 pe-1 text-start font-medium"
          onClick={() => toggleSort(col)}
          title={virtualFieldColumns.has(col) ? t("attributeTable.virtualColumnTitle") : undefined}
        >
          {/* Virtual (expression-computed) columns get a function glyph and
              italics so their read-only, derived nature is visible at a
              glance, as in QGIS. */}
          {virtualFieldColumns.has(col) && (
            <SquareFunction
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          )}
          <span className={virtualFieldColumns.has(col) ? "truncate italic" : "truncate"}>
            {col}
          </span>
          {renderSortIcon(col)}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 shrink-0 text-muted-foreground"
              title={t("attributeTable.manageFieldTitle", { name: col })}
              aria-label={t("attributeTable.manageFieldAria", { name: col })}
              onClick={(event) => event.stopPropagation()}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={derivedColumns.has(col)}
              onSelect={() => beginColumnRename(col)}
            >
              <Pencil className="me-2 h-3.5 w-3.5" />
              {t("attributeTable.renameField")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => handleToggleHidden(col)}>
              <EyeOff className="me-2 h-3.5 w-3.5" />
              {t("attributeTable.hideField")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={isRtl ? index === columns.length - 1 : index === 0}
              onSelect={() => handleMoveColumn(col, isRtl ? "right" : "left")}
            >
              <ArrowLeft className="me-2 h-3.5 w-3.5" />
              {t("attributeTable.moveLeft")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={isRtl ? index === 0 : index === columns.length - 1}
              onSelect={() => handleMoveColumn(col, isRtl ? "left" : "right")}
            >
              <ArrowRight className="me-2 h-3.5 w-3.5" />
              {t("attributeTable.moveRight")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              disabled={derivedColumns.has(col)}
              onSelect={() => setColumnPendingDelete(col)}
            >
              <Trash2 className="me-2 h-3.5 w-3.5" />
              {t("attributeTable.deleteField")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("attributeTable.resizeColumn", { name: col })}
          className="absolute -end-2 top-0 h-full w-3 cursor-col-resize select-none border-e border-transparent hover:border-primary"
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
      aria-label={t("attributeTable.title")}
      className="relative flex shrink-0 flex-col border-t bg-card"
      style={{ height: collapsed ? undefined : tableHeight }}
    >
      {!collapsed ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("attributeTable.resize")}
          className="absolute -top-1 left-0 right-0 z-20 h-2 cursor-row-resize select-none border-t border-transparent hover:border-primary"
          onMouseDown={startTableResize}
        />
      ) : null}
      <div
        ref={tableResizeGuideRef}
        className="pointer-events-none fixed left-0 right-0 z-50 hidden h-px bg-primary shadow-[0_0_0_1px_hsl(var(--primary)/0.25)]"
      />
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 md:flex-nowrap">
        <TableProperties className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">{t("attributeTable.title")}</span>
        {layer ? (
          <span className="min-w-0 max-w-full truncate text-xs text-muted-foreground md:max-w-56">
            {t("attributeTable.selectedLayerName", { name: layer.name })}
          </span>
        ) : (
          <span className="min-w-0 max-w-full truncate text-xs text-muted-foreground md:max-w-56">
            {t("attributeTable.noLayerSelected")}
          </span>
        )}
        {exportError ? (
          <span className="max-w-48 truncate text-xs text-destructive">{exportError}</span>
        ) : exportWarning ? (
          <span className="max-w-48 truncate text-xs text-amber-600" title={exportWarning}>
            {exportWarning}
          </span>
        ) : null}
        <Button
          variant={isEditing ? "secondary" : "outline"}
          size="sm"
          className="ms-auto h-7 px-2"
          title={
            isGeometryEditing
              ? t("attributeTable.editTitleFinishGeometry")
              : isReadOnlyVectorLayer
                ? t("attributeTable.editTitleReadOnly")
                : isEditing
                  ? hasEdits
                    ? t("attributeTable.editTitleUseSaveCancel")
                    : t("attributeTable.exitEditMode")
                  : isDuckDBLayer
                    ? t("attributeTable.editTitleDuckdb")
                    : t("attributeTable.editValues")
          }
          aria-label={
            isEditing && !hasEdits
              ? t("attributeTable.exitEditMode")
              : t("attributeTable.editValues")
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
          <span className="hidden sm:inline">{t("attributeTable.buttons.edit")}</span>
        </Button>
        <Button
          variant="default"
          size="sm"
          className="h-7 px-2"
          title={
            hasInvalidDrafts
              ? t("attributeTable.saveTitleInvalid")
              : hasFormErrors
                ? t("attributeTable.saveTitleFormErrors")
                : isDuckDBLayer
                  ? t("attributeTable.saveTitleDuckdb")
                  : t("attributeTable.saveEdits")
          }
          aria-label={t("attributeTable.saveEdits")}
          disabled={!isEditing || !hasEdits || hasInvalidDrafts || hasFormErrors}
          onClick={saveDrafts}
        >
          <Save className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">{t("common.save")}</span>
        </Button>
        {canManageColumns && !isEditing ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2"
            title={t("attributeTable.addFieldTitle")}
            aria-label={t("attributeTable.addField")}
            onClick={openAddColumn}
          >
            <Plus className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t("attributeTable.addField")}</span>
          </Button>
        ) : null}
        {canManageColumns && !isEditing ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2"
            title={t("attributeTable.fieldCalculatorTitle")}
            aria-label={t("attributeTable.fieldCalculator")}
            onClick={openCalculator}
          >
            <Calculator className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t("attributeTable.buttons.calculate")}</span>
          </Button>
        ) : null}
        {canManageColumns && !isEditing ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2"
                title={t("attributeTable.manageFieldsTitle")}
                aria-label={t("attributeTable.manageFields")}
              >
                <Columns3 className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{t("attributeTable.buttons.fields")}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
              <DropdownMenuLabel>{t("attributeTable.showFields")}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {discoveredColumns.length === 0 ? (
                <DropdownMenuItem disabled>{t("attributeTable.noFields")}</DropdownMenuItem>
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
                    {t("attributeTable.showAllFields")}
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
                ? t("attributeTable.columnExplorerTitle")
                : t("attributeTable.columnExplorerTitleDisabled")
            }
            aria-label={t("attributeTable.columnExplorer")}
            disabled={!hasAttributeSource}
            onClick={() => setExplorerOpen(true)}
          >
            <Telescope className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t("attributeTable.buttons.explore")}</span>
          </Button>
        ) : null}
        {!isEditing ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2"
            title={
              hasAttributeSource
                ? t("attributeTable.statisticsTitle")
                : t("attributeTable.statisticsTitleDisabled")
            }
            aria-label={t("attributeTable.statistics")}
            disabled={!hasAttributeSource}
            onClick={() => setStatsOpen(true)}
          >
            <Sigma className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t("attributeTable.buttons.statistics")}</span>
          </Button>
        ) : null}
        {!isEditing ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2"
            title={
              hasAttributeSource
                ? t("attributeTable.chartsTitle")
                : t("attributeTable.chartsTitleDisabled")
            }
            aria-label={t("attributeTable.charts")}
            disabled={!hasAttributeSource}
            onClick={() => setChartOpen(true)}
          >
            <ChartColumn className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t("attributeTable.charts")}</span>
          </Button>
        ) : null}
        {!isEditing ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2"
            title={t("attributeTable.dashboardTitle")}
            aria-label={t("attributeTable.dashboard")}
            onClick={() => setDashboardOpen(true)}
          >
            <LayoutDashboard className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t("attributeTable.dashboard")}</span>
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
                  ? t("attributeTable.exportSelectedLayer")
                  : t("attributeTable.exportTitleDisabled")
              }
              aria-label={t("attributeTable.exportSelectedLayer")}
              disabled={!layer?.geojson}
            >
              <Download className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t("attributeTable.buttons.export")}</span>
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
            title={t("attributeTable.cancelEdits")}
            aria-label={t("attributeTable.cancelEdits")}
            onClick={cancelEditing}
          >
            <RotateCcw className="h-4 w-4" />
          </Button>
        ) : null}
        <Input
          className="h-7 min-w-36 flex-1 text-xs md:max-w-xs"
          placeholder={t("attributeTable.searchPlaceholder")}
          aria-label={t("attributeTable.searchAria")}
          value={attributeFilter}
          onChange={(e) => setAttributeFilter(e.target.value)}
        />
        <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={zoomToSelectedFeature}
            onChange={(event) => setZoomToSelectedFeature(event.target.checked)}
          />
          {t("attributeTable.zoomToSelection")}
        </label>
        {/* A native <select> (not the @geolibre/ui Select, which hardcodes h-9
            and w-full) so it matches the h-7 toolbar and self-sizes to its
            content instead of clipping the longest label. */}
        <select
          className="h-7 shrink-0 rounded-md border border-input bg-background px-2 text-xs shadow-xs transition-colors focus-visible:border-ring focus-visible:outline-none"
          aria-label={t("attributeTable.featureViewAria")}
          value={featureView}
          onChange={(event) => setFeatureView(event.target.value as "all" | "selected")}
        >
          <option value="all">{t("attributeTable.showAllFeatures")}</option>
          {/* Disabled when nothing is selected so the table can't be switched
              to an empty "selected" view it wouldn't auto-recover from. */}
          <option value="selected" disabled={selectedFeatureIds.length === 0}>
            {t("attributeTable.showSelectedFeatures", {
              count: selectedFeatureIds.length,
            })}
          </option>
        </select>
        <Button
          variant="outline"
          size="icon"
          className="h-7 w-7"
          title={t("attributeTable.clearSelectedFeature")}
          aria-label={t("attributeTable.clearSelectedFeature")}
          disabled={selectedFeatureIds.length === 0}
          onClick={() => selectFeature(null)}
        >
          <MousePointerSquareDashed className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title={collapsed ? t("attributeTable.expand") : t("attributeTable.collapse")}
          aria-label={collapsed ? t("attributeTable.expand") : t("attributeTable.collapse")}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? (
            <PanelBottomOpen className="h-4 w-4" />
          ) : (
            <PanelBottomClose className="h-4 w-4" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title={t("attributeTable.close")}
          aria-label={t("attributeTable.close")}
          onClick={() => setAttributeTableOpen(false)}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      {/*
        Vertical scrollbar height reserves 3.625rem: 2.75rem for the sticky
        header (top-11) plus 0.875rem for the horizontal scrollbar (h-3.5),
        so the two scrollbars do not overlap.
      */}
      {!collapsed ? (
        <ScrollArea
          type="always"
          viewportRef={scrollViewportRef}
          className="flex-1 [&_[data-orientation=vertical]]:!top-11 [&_[data-orientation=vertical]]:!h-[calc(100%-3.625rem)]"
        >
          {!hasAttributeSource ? (
            <p className="p-4 text-xs text-muted-foreground">
              {loadingVectorGeojson
                ? t("attributeTable.loadingAttributes")
                : t("attributeTable.requiresVectorLayer")}
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
                  <TableHead className="bg-card">{sortableHeader("__featureId", "#")}</TableHead>
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
                  const selected = selectedIdSet.has(featureId);
                  return (
                    <TableRow
                      key={featureId}
                      data-index={virtualRow.index}
                      ref={rowVirtualizer.measureElement}
                      data-state={selected ? "selected" : undefined}
                      className="cursor-pointer select-none"
                      // Shift-click would otherwise select the page text between
                      // rows; suppress that so range picks stay clean.
                      onMouseDown={(event) => {
                        if (event.shiftKey) event.preventDefault();
                      }}
                      onClick={(event) => {
                        handleRowClick(featureId, event);
                      }}
                    >
                      <TableCell>{featureId}</TableCell>
                      {columns.map((col) => {
                        const value = properties[col];
                        const draft = drafts[featureId]?.[col];
                        const changed = draft !== undefined;
                        const formError = formDraftErrors[featureId]?.[col];
                        const invalid =
                          (draft !== undefined && isInvalidObjectDraft(draft, value)) ||
                          formError !== undefined;
                        const inputClassName = invalid
                          ? "h-7 min-w-0 border-destructive bg-destructive/10 px-2 text-xs"
                          : changed
                            ? "h-7 min-w-0 border-primary/60 bg-primary/10 px-2 text-xs"
                            : "h-7 min-w-0 px-2 text-xs";
                        const config = formFields.get(col);
                        const current = draft ?? formatAttributeValue(value);
                        const invalidTitle = invalid
                          ? formError
                            ? formErrorText(formError)
                            : t("attributeTable.invalidJson")
                          : undefined;
                        const cellAria = t("attributeTable.editCellAria", {
                          col,
                          featureId,
                        });
                        const commitDraft = (next: string) =>
                          updateCellDraft(featureId, col, next, value);
                        return (
                          <TableCell
                            key={col}
                            data-state={changed ? "edited" : undefined}
                            className="data-[state=edited]:bg-primary/10 data-[state=edited]:shadow-[inset_3px_0_0_hsl(var(--primary))]"
                            title={
                              virtualFieldColumns.has(col)
                                ? t("attributeTable.virtualColumnTitle")
                                : joinDerivedColumns.has(col)
                                  ? t("attributeTable.joinedColumnTitle")
                                  : undefined
                            }
                          >
                            {isEditing && !derivedColumns.has(col) ? (
                              config?.widget === "valueMap" && config.valueMap?.length ? (
                                <Select
                                  className={inputClassName}
                                  aria-invalid={invalid || undefined}
                                  title={invalidTitle}
                                  aria-label={cellAria}
                                  value={current}
                                  onClick={(event) => event.stopPropagation()}
                                  onChange={(event) => commitDraft(event.target.value)}
                                >
                                  <option value="">—</option>
                                  {/* Keep an out-of-map current value listed so
                                      the select shows it instead of silently
                                      snapping to the first entry. */}
                                  {current !== "" &&
                                    !config.valueMap.some((entry) => entry.value === current) && (
                                      <option value={current}>{current}</option>
                                    )}
                                  {config.valueMap.map((entry) => (
                                    <option key={entry.value} value={entry.value}>
                                      {entry.label ?? entry.value}
                                    </option>
                                  ))}
                                </Select>
                              ) : config?.widget === "checkbox" ? (
                                <input
                                  type="checkbox"
                                  className="h-4 w-4"
                                  aria-invalid={invalid || undefined}
                                  title={invalidTitle}
                                  aria-label={cellAria}
                                  checked={current === "true"}
                                  onClick={(event) => event.stopPropagation()}
                                  onChange={(event) =>
                                    commitDraft(event.target.checked ? "true" : "false")
                                  }
                                />
                              ) : (
                                <Input
                                  className={inputClassName}
                                  type={
                                    config?.widget === "number" || config?.widget === "range"
                                      ? "number"
                                      : config?.widget === "date"
                                        ? "date"
                                        : "text"
                                  }
                                  min={config?.min}
                                  max={config?.max}
                                  step={config?.step}
                                  aria-invalid={invalid || undefined}
                                  title={invalidTitle}
                                  aria-label={cellAria}
                                  value={current}
                                  onClick={(event) => event.stopPropagation()}
                                  onChange={(event) => commitDraft(event.target.value)}
                                />
                              )
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
                    <td colSpan={tableColumns.length} style={{ height: paddingBottom }} />
                  </tr>
                ) : null}
              </TableBody>
            </table>
          )}
        </ScrollArea>
      ) : null}
      <Dialog
        open={columnPendingDelete !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setColumnPendingDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("attributeTable.deleteField")}</DialogTitle>
            <DialogDescription>
              {t("attributeTable.deleteFieldConfirm", {
                field: columnPendingDelete ?? "",
                layer: layer?.name ?? "",
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setColumnPendingDelete(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" onClick={confirmDeleteColumn}>
              {t("attributeTable.deleteField")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={addingColumn} onOpenChange={(open: boolean) => setAddingColumn(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("attributeTable.addField")}</DialogTitle>
            <DialogDescription>
              {t("attributeTable.addFieldDescription", {
                layer: layer?.name ?? "",
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-1">
            <div className="grid gap-1.5">
              <Label htmlFor="new-field-name">{t("attributeTable.fieldName")}</Label>
              <Input
                id="new-field-name"
                autoFocus
                value={newColumnName}
                placeholder={t("attributeTable.newFieldPlaceholder")}
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
                  {t("attributeTable.fieldExists", {
                    name: newColumnNameTrimmed,
                  })}
                </span>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-field-type">{t("attributeTable.fieldType")}</Label>
              <Select
                id="new-field-type"
                value={newColumnType}
                onChange={(event) => changeNewColumnType(event.target.value as NewColumnType)}
              >
                <option value="text">{t("attributeTable.typeText")}</option>
                <option value="number">{t("attributeTable.typeNumber")}</option>
                <option value="boolean">{t("attributeTable.typeBoolean")}</option>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-field-default">{t("attributeTable.defaultValue")}</Label>
              {newColumnType === "boolean" ? (
                <Select
                  id="new-field-default"
                  value={newColumnDefault}
                  onChange={(event) => setNewColumnDefault(event.target.value)}
                >
                  <option value="">{t("attributeTable.noDefault")}</option>
                  <option value="false">false</option>
                  <option value="true">true</option>
                </Select>
              ) : (
                <Input
                  id="new-field-default"
                  type={newColumnType === "number" ? "number" : "text"}
                  value={newColumnDefault}
                  placeholder={t("attributeTable.defaultValuePlaceholder")}
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
                {t("attributeTable.noFeaturesForField")}
              </span>
            ) : null}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setAddingColumn(false)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={!canSubmitNewColumn} onClick={confirmAddColumn}>
              {t("attributeTable.addField")}
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
            <DialogTitle>{t("attributeTable.fieldCalculator")}</DialogTitle>
            <DialogDescription>
              {t("attributeTable.calcDescription", {
                layer: layer?.name ?? "",
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-1">
            <div className="grid gap-1.5">
              <Label htmlFor="calc-target">{t("attributeTable.targetField")}</Label>
              <div className="flex gap-2">
                <Select
                  id="calc-target-mode"
                  className="w-40 shrink-0"
                  value={calcMode}
                  onChange={(event) => setCalcMode(event.target.value as "update" | "create")}
                >
                  <option value="update" disabled={discoveredColumns.length === 0}>
                    {t("attributeTable.updateField")}
                  </option>
                  <option value="create">{t("attributeTable.createField")}</option>
                </Select>
                {calcMode === "create" ? (
                  <Input
                    id="calc-target"
                    className="flex-1"
                    value={calcNewName}
                    placeholder={t("attributeTable.newFieldNamePlaceholder")}
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
                    {calculatorTargetColumns.map((col) => (
                      <option key={col} value={col}>
                        {col}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
              {calcNameCollides ? (
                <span className="text-xs text-destructive">
                  {t("attributeTable.fieldExists", {
                    name: calcNewNameTrimmed,
                  })}
                </span>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="calc-output-type">{t("attributeTable.outputType")}</Label>
              <Select
                id="calc-output-type"
                value={calcOutputType}
                onChange={(event) => setCalcOutputType(event.target.value as CalcOutputType)}
              >
                <option value="auto">{t("attributeTable.outputAuto")}</option>
                <option value="text">{t("attributeTable.typeText")}</option>
                <option value="number">{t("attributeTable.typeNumber")}</option>
                <option value="boolean">{t("attributeTable.typeBoolean")}</option>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="calc-expression">{t("attributeTable.expression")}</Label>
              <Textarea
                id="calc-expression"
                ref={calcExpressionRef}
                className="min-h-20 font-mono text-xs"
                value={calcExpression}
                placeholder={t("attributeTable.calcExpressionPlaceholder")}
                onChange={(event) => setCalcExpression(event.target.value)}
              />
              {discoveredColumns.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-xs text-muted-foreground">
                    {t("attributeTable.fieldsLabel")}
                  </span>
                  {discoveredColumns.map((col) => (
                    <button
                      key={col}
                      type="button"
                      className="rounded border border-input bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted"
                      title={t("attributeTable.insertField", { name: col })}
                      onClick={() => insertExpressionSnippet(fieldReference(col))}
                    >
                      {col}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-xs text-muted-foreground">
                  {t("attributeTable.functionsLabel")}
                </span>
                {Object.keys(EXPRESSION_HELPERS).map((fn) => (
                  <button
                    key={fn}
                    type="button"
                    className="rounded border border-input bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted"
                    title={t("attributeTable.insertFunction", { name: fn })}
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
              {calcAvailableMetrics.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">
                    {t("attributeTable.geomMeasureLabel")}
                  </span>
                  <Select
                    id="calc-geom-metric"
                    className="h-7 w-28 py-0 text-xs"
                    value={calcEffectiveMetric}
                    onChange={(event) => setCalcGeomMetric(event.target.value as GeometryMetric)}
                  >
                    {calcAvailableMetrics.map((metric) => (
                      <option key={metric} value={metric}>
                        {t(`attributeTable.geomMetric.${metric}`)}
                      </option>
                    ))}
                  </Select>
                  <Select
                    id="calc-geom-unit"
                    className="h-7 w-20 py-0 text-xs"
                    value={calcEffectiveUnit}
                    onChange={(event) => setCalcGeomUnit(event.target.value)}
                  >
                    {calcGeomUnitOptions.map((unit) => (
                      <option key={unit} value={unit}>
                        {UNIT_SYMBOLS[unit]}
                      </option>
                    ))}
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    onClick={insertGeometrySnippet}
                  >
                    {t("attributeTable.geomInsert")}
                  </Button>
                </div>
              ) : null}
            </div>
            {calcPreview.kind === "syntax" ? (
              <span className="text-xs text-destructive">{calcPreview.message}</span>
            ) : calcPreview.kind === "runtime" ? (
              <span className="text-xs text-amber-600 dark:text-amber-500">
                {t("attributeTable.sampleRowErrored", {
                  message: calcPreview.message,
                })}
              </span>
            ) : calcPreview.kind === "ok" ? (
              <span className="truncate text-xs text-muted-foreground">
                {t("attributeTable.preview")}{" "}
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
              {t("attributeTable.onlySelectedFeature")}
            </label>
            {calcError ? <span className="text-xs text-destructive">{calcError}</span> : null}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCalcOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={!calcCanSubmit} onClick={confirmCalculate}>
              {t("attributeTable.buttons.calculate")}
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
