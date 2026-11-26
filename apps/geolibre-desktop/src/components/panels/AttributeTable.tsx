import {
  canEditAttributeValues,
  isReadOnlyAttributeLayer,
  isVectorControlAttributeSource,
} from "../../lib/attribute-table-source";
import {
  filterAttributeRowsByColumns,
  hasActiveColumnFilter,
  matchesColumnFilter,
  sortAttributeRows,
  toggleMultiSort,
  type ColumnFilterSpec,
  type SortSpec,
} from "../../lib/attribute-table-ops";
import { AttributeBulkEditDialog, ColumnFilterBar } from "./AttributeBulkEditDialog";
import { useTranslation } from "react-i18next";
import {
  editorTrackingFieldNames,
  ensureEditorTrackingFields,
  isDuckDBQueryLayer,
  useAppStore,
  resolveLayerCapabilities,
  type AttributeTableDrafts as AttributeDrafts,
  type AttributeTableDraftTarget,
  type GeoLibreLayer,
  useLayer,
} from "@geolibre/core";
import {
  SKETCHES_SOURCE_KIND,
  getGeometryEditTargetLayerId,
  subscribeGeometryEdit,
} from "@geolibre/plugins/geo-editor-state";
import {
  stripEditorProperties,
  isInternalEditorProperty,
} from "@geolibre/plugins/geo-editor-view-import";
import {
  arcGISAttachmentObjectId,
  arcGISAttachmentSupport,
} from "@geolibre/plugins/arcgis-attachments";
import {
  arcGISAttributeConstraints,
  arcGISLayerHasPendingEdits,
} from "@geolibre/plugins/arcgis-layer";
import {
  arcGISRelatedParentObjectId,
  arcGISRelationships,
} from "@geolibre/plugins/arcgis-related-records";
import { getDuckDBLayerRows } from "@geolibre/plugins/maplibre-duckdb";
import { getVectorLayerGeoJSON } from "@geolibre/plugins/maplibre-vector";
import type { MapEngine } from "@geolibre/map";
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Input,
  Select,
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
  Filter,
  LayoutDashboard,
  LayoutList,
  MoreHorizontal,
  MousePointerSquareDashed,
  Network,
  Paperclip,
  Pencil,
  PanelBottomClose,
  PanelBottomOpen,
  Plus,
  Replace,
  RefreshCw,
  RotateCcw,
  Save,
  Sigma,
  SquareFunction,
  TableProperties,
  Telescope,
  Trash2,
  X,
  Ban,
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
import { isRefreshableLayer } from "../../lib/layer-refresh";
import { isLocalFileLayer } from "../../lib/local-file-watch";
import type { LayerRefreshStatus } from "./layer-panel/layer-panel-utils";
import {
  getColumnSettings,
  hiddenColumns,
  visibleColumns,
  type NewColumnType,
  attributeValuesMatchQuery,
  numericColumnSet,
} from "../../lib/attribute-columns";
import { type CalcOutputType } from "../../lib/attribute-expression";
import { useResolvedAttributeForm } from "../../hooks/useResolvedAttributeForm";
import { coerceNumericStringRows, pickAnalysisRows } from "../../lib/attribute-charts";
import { computeRowSelection } from "../../lib/attribute-selection";
import { RESERVED_PROPERTY_KEYS } from "../../lib/field-collection";
import { type GeometryMetric } from "../../lib/geometry-measure";
import { AttributeChartDialog } from "./AttributeChartDialog";
import { AttributeStatsDialog } from "./AttributeStatsDialog";
import { ColumnExplorerDialog } from "./ColumnExplorerDialog";
import { ArcGISAttachmentsDialog } from "./ArcGISAttachmentsDialog";
import { ArcGISRelatedRecordsDialog } from "./ArcGISRelatedRecordsDialog";
import { geojsonVectorSourceId, layerSupportsPolylineExport } from "../../lib/vector-export";
import {
  type AttributeTableRow,
  isInvalidObjectDraft,
  draftTargetJson,
  getAttributeDraftRow,
  hasDraftEdits,
  makeRowFormResolver,
  computeFormDraftErrors,
  type ContingencyContext,
  contingencyNotices,
  duckDBRowsToAttributeRows,
} from "./attribute-table/attribute-drafts";
import { FieldCalculatorDialog } from "./attribute-table/FieldCalculatorDialog";
import { AddFieldDialog } from "./attribute-table/AddFieldDialog";
import {
  type SortDirection,
  type SortKey,
  VERTICAL_SCROLLBAR_GUTTER,
} from "./attribute-table/table-layout";
import { AttributeTableGrid } from "./attribute-table/AttributeTableGrid";
import { useFieldCalculator } from "./attribute-table/useFieldCalculator";
import { useColumnManagement } from "./attribute-table/useColumnManagement";
import { useAttributeEditing } from "./attribute-table/useAttributeEditing";
import {
  type ColumnWidths,
  DEFAULT_FEATURE_ID_COLUMN_WIDTH,
  DEFAULT_ATTRIBUTE_COLUMN_WIDTH,
  ESTIMATED_ROW_HEIGHT,
  ATTRIBUTE_TABLE_CHROME_HEIGHT,
  DEFAULT_TABLE_HEIGHT,
} from "./attribute-table/table-sizes";
import { useTableResize } from "./attribute-table/useTableResize";

const EMPTY_DRAFTS: AttributeDrafts = {};

/** Reserved inline-image property keys (photo thumbnail + full-resolution) that
 * hold data URLs, so they are hidden from the attribute table's columns. */
const RESERVED_IMAGE_KEYS = new Set<string>(RESERVED_PROPERTY_KEYS);

interface AttributeTableProps {
  mapControllerRef: RefObject<MapEngine | null>;
  /**
   * The layer panel's refresh state (`useLayerRefresh`): its Refresh action and
   * transient status notes keyed by layer id, shared so both surfaces dedupe
   * the request and report one status. Omitted, the table offers no Refresh.
   */
  refresh?: {
    handleRefreshLayer: (layer: GeoLibreLayer) => Promise<void> | void;
    refreshStatuses: Record<string, LayerRefreshStatus>;
  };
  /** Whether the phone mobile shell is active (propagated from DesktopShell). */
  mobileShell?: boolean;
}

export function AttributeTable({
  mapControllerRef,
  refresh,
  mobileShell = false,
}: AttributeTableProps) {
  const { t, i18n } = useTranslation();
  // Column order is visual: in a right-to-left layout the first column renders
  // rightmost, so the move-left/right actions and their guards swap.
  const isRtl = document.documentElement.dir === "rtl";
  const tableSectionRef = useRef<HTMLElement>(null);
  const tableResizeGuideRef = useRef<HTMLDivElement>(null);
  // The Radix ScrollArea viewport, used as the virtualizer's scroll container.
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  const attributeFilter = useAppStore((s) => s.attributeFilter);
  const setAttributeFilter = useAppStore((s) => s.setAttributeFilter);
  const selectedFeatureId = useAppStore((s) => s.selectedFeatureId);
  const selectedFeatureIds = useAppStore((s) => s.selectedFeatureIds);
  const selectFeature = useAppStore((s) => s.selectFeature);
  const selectFeatures = useAppStore((s) => s.selectFeatures);
  const [cardViewOverride, setCardViewOverride] = useState<boolean | null>(null);
  const useCardView = mobileShell && (cardViewOverride ?? true);
  const attributeTableOpen = useAppStore((s) => s.ui.attributeTableOpen);
  const setAttributeTableOpen = useAppStore((s) => s.setAttributeTableOpen);
  const setDashboardOpen = useAppStore((s) => s.setDashboardOpen);
  const updateLayer = useAppStore((s) => s.updateLayer);
  const zoomToSelectedFeature = useAppStore((s) => s.ui.zoomToSelectedFeature);
  const setZoomToSelectedFeature = useAppStore((s) => s.setZoomToSelectedFeature);
  const [sortSpecs, setSortSpecs] = useState<SortSpec[]>([
    { key: "__featureId", direction: "asc" },
  ]);
  const sort = sortSpecs[0] ?? {
    key: "__featureId" as SortKey,
    direction: "asc" as SortDirection,
  };
  const [columnFilters, setColumnFilters] = useState<Record<string, ColumnFilterSpec>>({});
  const [columnFilterBarOpen, setColumnFilterBarOpen] = useState(false);
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>({});
  // "all" shows every feature; "selected" restricts the table to the current
  // multi-selection (the Show All / Show Selected dropdown).
  const [featureView, setFeatureView] = useState<"all" | "selected">("all");
  const [tableHeight, setTableHeight] = useState(DEFAULT_TABLE_HEIGHT);
  // Collapsed shows only the toolbar header, hiding the table body, while the
  // panel stays open. Distinct from closing the panel entirely (the X button).
  const [collapsed, setCollapsed] = useState(false);
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const draftSession = useAppStore((s) =>
    selectedLayerId ? s.ui.attributeTableDrafts[selectedLayerId] : undefined,
  );
  const drafts = draftSession?.values ?? EMPTY_DRAFTS;
  const setAttributeTableDrafts = useAppStore((s) => s.setAttributeTableDrafts);
  // A layer with drafts reopens in edit mode, even after the panel remounts.
  const isEditing =
    (editingLayerId !== null && editingLayerId === selectedLayerId) || hasDraftEdits(drafts);
  const setIsEditing = (editing: boolean) => setEditingLayerId(editing ? selectedLayerId : null);
  const setDrafts = (next: AttributeDrafts | ((current: AttributeDrafts) => AttributeDrafts)) => {
    if (!selectedLayerId) return;
    const current =
      useAppStore.getState().ui.attributeTableDrafts[selectedLayerId]?.values ?? EMPTY_DRAFTS;
    setAttributeTableDrafts(
      selectedLayerId,
      typeof next === "function" ? next(current) : next,
      // The table's own row map, so the store need not rebuild it (and DuckDB
      // rows, which have no geojson, are snapshotted too).
      currentFeatures,
    );
  };
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

  const layer = useLayer(selectedLayerId);
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
  // Editor tracking columns are maintained by the app on every create/update,
  // so a hand-typed value would be overwritten by the next edit and a rename
  // would detach the column from the configuration that names it. They are
  // shown, but not edited here — the Editor Tracking section owns them.
  const trackingColumns = useMemo(
    () => new Set(editorTrackingFieldNames(layer?.editorTracking) ?? []),
    [layer?.editorTracking],
  );
  // Every column the user may not type into or restructure from this table.
  const readOnlyColumns = useMemo(
    () => new Set([...derivedColumns, ...trackingColumns]),
    [derivedColumns, trackingColumns],
  );
  const features = useMemo(() => layer?.geojson?.features ?? [], [layer?.geojson]);
  const isDuckDBLayer = isDuckDBQueryLayer(layer);
  const duckdbRows = layer && isDuckDBLayer ? getDuckDBLayerRows(layer.id) : [];
  // Memoized so the analysis adapters below (and everything else keyed on these
  // rows) only rebuild when the layer's features actually change, not on every
  // render caused by scrolling, filtering or selection. The DuckDB branch stays
  // unmemoized because `getDuckDBLayerRows` reads a mutable store and returns a
  // fresh array each call; delimited-text layers — the ones that pay for the
  // numeric-string adapter below — are geojson-backed and take this path.
  const geojsonRows: AttributeTableRow[] = useMemo(
    () =>
      features.map((feature, index) => ({
        featureId: String(feature.id ?? index),
        properties:
          layer?.metadata.sourceKind === SKETCHES_SOURCE_KIND
            ? stripEditorProperties(feature.properties)
            : ((feature.properties ?? {}) as Record<string, unknown>),
      })),
    [features, layer?.metadata.sourceKind],
  );
  const attributeRows: AttributeTableRow[] = useMemo(
    () => (isDuckDBLayer ? duckDBRowsToAttributeRows(duckdbRows) : geojsonRows),
    [duckdbRows, geojsonRows, isDuckDBLayer],
  );
  const layerCaps = resolveLayerCapabilities(layer);
  // ArcGIS service attachments of the one selected record, keyed by its object
  // ID; a feature not yet saved to the service has none to show.
  const attachmentSupport = useMemo(() => arcGISAttachmentSupport(layer), [layer]);
  const attachmentObjectId = useMemo(() => {
    if (!attachmentSupport?.list || !layer || selectedFeatureIds.length !== 1) return undefined;
    const feature = features.find((f, index) => String(f.id ?? index) === selectedFeatureIds[0]);
    return arcGISAttachmentObjectId(layer, feature);
  }, [attachmentSupport, layer, features, selectedFeatureIds]);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  useEffect(() => {
    if (attachmentObjectId === undefined) setAttachmentsOpen(false);
  }, [attachmentObjectId]);
  // Rows a published ArcGIS relationship links to the one selected record.
  const relationships = useMemo(() => arcGISRelationships(layer), [layer]);
  const relatedParent = useMemo(() => {
    if (!relationships.length || !layer || selectedFeatureIds.length !== 1) return undefined;
    const feature = features.find((f, index) => String(f.id ?? index) === selectedFeatureIds[0]);
    const objectId = arcGISRelatedParentObjectId(layer, feature);
    return feature && objectId !== undefined ? { feature, objectId } : undefined;
  }, [relationships, layer, features, selectedFeatureIds]);
  const [relatedOpen, setRelatedOpen] = useState(false);
  useEffect(() => {
    if (relatedParent === undefined) setRelatedOpen(false);
  }, [relatedParent]);
  const hasAttributeSource = Boolean((layer?.geojson || isDuckDBLayer) && layerCaps.query);
  // Add Vector Layer layers are read-only here (see isReadOnlyAttributeLayer).
  const isReadOnlyVectorLayer = isReadOnlyAttributeLayer(layer);
  // While this layer's geometry is being edited in place, attribute edits would
  // race the editor's geometry write-back, so the inline editor is disabled.
  // Drafts stay in the session when geometry editing finishes. Stable-ID rows
  // can resume saving; changed positional targets still need reconciliation.
  const geometryEditLayerId = useSyncExternalStore(
    subscribeGeometryEdit,
    getGeometryEditTargetLayerId,
  );
  const isGeometryEditing = layer != null && geometryEditLayerId === layer.id;

  // Read full source features on demand. Tiled imports use the control's local
  // table, not rendered tiles, so off-screen rows and original geometry remain
  // available. GeoJSON-mode imports keep their existing map-source fallback.
  useEffect(() => {
    if (!attributeTableOpen || !layer || layer.geojson || !layerCaps.query) {
      setLoadingVectorGeojson(false);
      return;
    }
    const sourceId = geojsonVectorSourceId(layer);
    const source = sourceId
      ? (mapControllerRef.current?.getMap()?.getSource(sourceId) as GeoJSONSource | undefined)
      : undefined;
    const readData =
      isVectorControlAttributeSource(layer) && layer.type === "vector-tiles"
        ? () => getVectorLayerGeoJSON(layer.id)
        : source && typeof source.getData === "function"
          ? () => source.getData()
          : null;
    if (!readData) {
      setLoadingVectorGeojson(false);
      return;
    }

    let cancelled = false;
    const layerId = layer.id;
    setLoadingVectorGeojson(true);
    readData()
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
  }, [attributeTableOpen, layer, layerCaps.query, mapControllerRef, updateLayer]);
  const hasEdits = hasDraftEdits(drafts);
  // Never partially save missing targets or apply a positional draft to a
  // different feature after refresh/undo/sync. Keep the drafts for recovery.
  const rowIds = useMemo(() => new Set(attributeRows.map((row) => row.featureId)), [attributeRows]);
  // DuckDB rows are keyed by rendered row index, so a re-query can put another
  // source row at a drafted index. Compare id-less snapshots of their
  // properties, which the positional check below treats like GeoJSON rows.
  const currentFeatures: ReadonlyMap<string, AttributeTableDraftTarget> = useMemo(
    () =>
      isDuckDBLayer
        ? new Map(
            attributeRows.map((row) => [
              row.featureId,
              { type: "Feature", geometry: null, properties: row.properties },
            ]),
          )
        : new Map(features.map((feature, index) => [String(feature.id ?? index), feature])),
    [attributeRows, features, isDuckDBLayer],
  );
  const draftTargets = draftSession?.targets;
  const unsafeTargetIds = useMemo(
    () =>
      new Set(
        Object.entries(draftTargets ?? {})
          .filter(([featureId, original]) => {
            const current = currentFeatures.get(featureId);
            if (!current) return true;
            // IDs follow reorders. Without IDs, even a geometry-only change cannot
            // be distinguished from a different row occupying the same position.
            return (
              (original.id == null || current.id == null) &&
              original !== current &&
              draftTargetJson(original) !== draftTargetJson(current)
            );
          })
          .map(([featureId]) => featureId),
      ),
    [currentFeatures, draftTargets],
  );
  const hasUnsafeDraftTargets = Object.entries(drafts).some(
    ([featureId, row]) =>
      Object.keys(row).length > 0 &&
      (!rowIds.has(featureId) ||
        !draftTargets ||
        !Object.hasOwn(draftTargets, featureId) ||
        unsafeTargetIds.has(featureId)),
  );
  const hasInvalidDrafts = attributeRows.some((row) => {
    const rowDrafts = getAttributeDraftRow(drafts, row.featureId);
    if (!rowDrafts) return false;
    return Object.entries(rowDrafts).some(([column, draft]) =>
      isInvalidObjectDraft(draft, row.properties[column]),
    );
  });
  // Attribute Form designer config: per-column edit widgets plus constraint
  // validation of drafted rows. DuckDB layers keep the plain text editor —
  // the designer is only offered for store-backed geojson layers.
  // Relation dropdowns are filled live from the layers they reference.
  const attributeForm = useResolvedAttributeForm(isDuckDBLayer ? undefined : layer?.attributeForm);
  // Constraints the layer's data service publishes (ArcGIS coded-value and
  // range domains, per type/subtype), merged per record with the designer
  // config. Derived from metadata the layer already holds.
  const serviceConstraints = useMemo(
    () => (isDuckDBLayer ? undefined : arcGISAttributeConstraints(layer)),
    [isDuckDBLayer, layer],
  );
  const formForRow = useMemo(
    () => makeRowFormResolver(attributeForm, serviceConstraints),
    [attributeForm, serviceConstraints],
  );
  // Metadata the ArcGIS adapter could not resolve: those checks fall to the
  // server, so say so rather than imply the form validated them.
  const domainNotice = serviceConstraints?.diagnostics
    .map((diagnostic) =>
      diagnostic.code === "unresolvedDomain"
        ? t("attributeTable.serviceDomains.unresolvedDomain", {
            field: diagnostic.field,
          })
        : diagnostic.code === "subtypeFieldMissing"
          ? t("attributeTable.serviceDomains.subtypeFieldMissing", {
              field: diagnostic.field,
            })
          : t("attributeTable.serviceDomains.subtypeConflict", {
              field: diagnostic.field,
            }),
    )
    .join(" ");
  const hasRowForms = Boolean(attributeForm?.fields.length || serviceConstraints);
  // Feature index for validation, rebuilt only when the layer data (not a
  // draft keystroke) changes; null when no form config is active.
  const formFeatureIndex = useMemo(() => {
    if (!hasRowForms) return null;
    const geojsonFeatures = layer?.geojson?.features ?? [];
    return new Map(
      geojsonFeatures.map((feature, index): [string, Feature] => [
        String(feature.id ?? index),
        feature,
      ]),
    );
  }, [hasRowForms, layer?.geojson]);
  const contingencyContext = useMemo((): ContingencyContext | undefined => {
    if (!serviceConstraints) return undefined;
    return {
      checks: serviceConstraints.contingencyChecks,
      message: (check) =>
        t(check.status === "retired" ? "contingentValues.retired" : "contingentValues.violation", {
          fields: check.fields.join(", "),
          group: check.group,
        }),
    };
  }, [serviceConstraints, t]);
  const formDraftErrors = useMemo(
    () => computeFormDraftErrors(formForRow, drafts, formFeatureIndex, contingencyContext),
    [formForRow, drafts, formFeatureIndex, contingencyContext],
  );
  // Advisory field groups and untouched existing combinations: reported, not blocking.
  const contingencyNotice = useMemo(() => {
    const problem = serviceConstraints?.contingentValuesProblem;
    const lines = problem
      ? [
          problem.status === "unavailable"
            ? t("contingentValues.unavailable", { reason: problem.reason })
            : t("contingentValues.unsupported"),
        ]
      : [];
    if (contingencyContext)
      for (const { featureId, check } of contingencyNotices(
        drafts,
        formFeatureIndex,
        formForRow,
        contingencyContext.checks,
      ))
        lines.push(
          t(
            check.affected
              ? "contingentValues.advisory"
              : check.status === "retired"
                ? "contingentValues.existingRetired"
                : "contingentValues.existing",
            {
              row: featureId,
              fields: check.fields.join(", "),
              group: check.group,
            },
          ),
        );
    return lines.join(" ");
  }, [serviceConstraints, contingencyContext, drafts, formFeatureIndex, formForRow, t]);
  const hasFormErrors = Object.keys(formDraftErrors).length > 0;

  useEffect(() => {
    setEditingLayerId(null);
    // Drafts belong to the layer in the store, so selection and geometry-edit
    // changes must not discard them. Only reset the transient column UI here.
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
    setColumnFilters({});
    setBulkEditOpen(false);
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

  const filtered = useMemo(() => {
    const filterLower = attributeFilter.toLowerCase();
    const base = attributeRows.filter(({ properties, featureId }) => {
      // "Show Selected Features" restricts the table to the current selection.
      if (featureView === "selected" && !selectedIdSet.has(featureId)) return false;
      if (!filterLower) return true;
      if (featureId.toLowerCase().includes(filterLower)) return true;
      return attributeValuesMatchQuery(properties, filterLower);
    });
    return filterAttributeRowsByColumns(base, columnFilters);
  }, [attributeFilter, attributeRows, columnFilters, featureView, selectedIdSet]);

  // Identify's Edit attributes action asks for edit mode on its layer (#2932).
  // Declared after the layer-change reset above so, when the request arrives
  // together with the layer selection, the reset runs first and this one wins.
  const attributeTableEditLayerId = useAppStore((s) => s.ui.attributeTableEditLayerId);
  const requestAttributeTableEdit = useAppStore((s) => s.requestAttributeTableEdit);
  // The same gate as the Edit button below, shared with Identify's action.
  const canEnterEditMode = canEditAttributeValues(layer, geometryEditLayerId);
  // Refresh re-reads the source so edits made by other clients show up (issue
  // #2948). It mirrors the layer menu: desktop local-file layers reload from
  // disk, everything else needs a refreshable source.
  const isLocalFileRefresh = layer != null && isTauri() && isLocalFileLayer(layer);
  const canRefreshLayer =
    Boolean(refresh) && layer != null && (isLocalFileRefresh || isRefreshableLayer(layer));
  const refreshStatus = layer ? refresh?.refreshStatuses[layer.id] : undefined;
  const isRefreshingLayer = refreshStatus?.type === "refreshing";
  // An ArcGIS refresh with unsaved edits keeps the local copy rather than
  // overwrite it, so a click would report success without fetching anything.
  const refreshBlockedByEdits =
    canRefreshLayer && layer != null && arcGISLayerHasPendingEdits(layer.id);

  /**
   * Refresh a layer, then drop the row copy this table cached for a tiled
   * vector-control layer. Its reload keeps the source unchanged, so the store
   * sync leaves that copy in place and the table would keep showing the old
   * rows; clearing it makes the loading effect above re-read the control.
   *
   * @param target - The layer to refresh.
   */
  const refreshLayerRows = async (target: GeoLibreLayer) => {
    // Re-checked here because an in-flight ArcGIS save is module state the
    // render-time check above is not subscribed to.
    if (!refresh || arcGISLayerHasPendingEdits(target.id)) return;
    const syncedBefore = target.connection?.lastSyncedAt;
    await refresh.handleRefreshLayer(target);
    if (!isVectorControlAttributeSource(target)) return;
    const current = useAppStore.getState().layers.find((l) => l.id === target.id);
    // The handler reports failure through the layer, not by throwing: only a
    // new sync stamp with no error means the control actually reloaded. A
    // failed, deduped, or skipped refresh keeps the rows the table has.
    const synced =
      current?.connection?.lastSyncedAt !== syncedBefore && !current?.connection?.lastError;
    if (synced && current?.type === "vector-tiles" && current.geojson) {
      updateLayer(target.id, { geojson: undefined });
    }
  };
  useEffect(() => {
    if (attributeTableEditLayerId === null) return;
    if (layer?.id === attributeTableEditLayerId && canEnterEditMode) {
      // Clear only filters that hide the requested row; filters that already
      // admit it are the user's to keep.
      if (
        selectedFeatureId !== null &&
        !filtered.some((row) => row.featureId === selectedFeatureId)
      ) {
        const targetRow = attributeRows.find((row) => row.featureId === selectedFeatureId);
        if (attributeFilter) {
          const filterLower = attributeFilter.toLowerCase();
          const admittedBySearch =
            targetRow !== undefined &&
            (targetRow.featureId.toLowerCase().includes(filterLower) ||
              attributeValuesMatchQuery(targetRow.properties, filterLower));
          if (!admittedBySearch) setAttributeFilter("");
        }
        if (targetRow && Object.keys(columnFilters).length > 0) {
          setColumnFilters((prev) => {
            const next: Record<string, ColumnFilterSpec> = {};
            for (const [col, spec] of Object.entries(prev)) {
              const val = col === "__featureId" ? targetRow.featureId : targetRow.properties[col];
              if (matchesColumnFilter(val, spec)) next[col] = spec;
            }
            return next;
          });
        }
      }
      // A collapsed table would enter edit mode with the row out of sight.
      setCollapsed(false);
      setIsEditing(true);
    }
    requestAttributeTableEdit(null);
    // Runs once per request; the rows and filter are read as they stand then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attributeTableEditLayerId, canEnterEditMode, layer?.id, requestAttributeTableEdit]);
  // String-oriented sources can encode measurements as text. Adapt only the
  // rows sent to analysis dialogs, leaving the table and source data intact.
  const adaptAnalysisRows = chartOpen || statsOpen || explorerOpen;
  const analysisRows = useMemo(
    () => (adaptAnalysisRows ? coerceNumericStringRows(attributeRows) : attributeRows),
    [adaptAnalysisRows, attributeRows],
  );
  // Both subsets are picked out of the already-adapted full-layer rows so a field
  // keeps the same numeric/text inference whichever statistics scope is showing.
  const analysisFilteredRows = useMemo(() => {
    if (!adaptAnalysisRows) return filtered;
    if (filtered.length === attributeRows.length) return analysisRows;
    const filteredIds = new Set(filtered.map(({ featureId }) => featureId));
    return pickAnalysisRows(analysisRows, attributeRows, filteredIds);
  }, [adaptAnalysisRows, analysisRows, attributeRows, filtered]);
  const analysisSelectedRows = useMemo(() => {
    if (!adaptAnalysisRows || selectedIdSet.size === 0) return [];
    return pickAnalysisRows(analysisRows, attributeRows, selectedIdSet);
  }, [adaptAnalysisRows, analysisRows, attributeRows, selectedIdSet]);
  const sorted = useMemo(() => sortAttributeRows(filtered, sortSpecs), [filtered, sortSpecs]);

  // Row selection with keyboard modifiers (plain / Ctrl-toggle / Shift-range /
  // Shift+Ctrl merge). The branching lives in the pure `computeRowSelection`
  // helper so it can be unit-tested; here we just feed it the current state.
  const handleRowClick = (featureId: string, event: ReactMouseEvent<HTMLElement>) => {
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
    // Row offsets are measured from the top of the scroll area, but the sticky
    // header (1.875rem) sits above the first row and the horizontal scrollbar
    // (0.875rem) overlays the bottom; the vertical scrollbar's 2.75rem inset
    // below is the same sum. Without this, scrolling the selected row into view
    // from below parked it under the horizontal scrollbar.
    scrollPaddingEnd: ATTRIBUTE_TABLE_CHROME_HEIGHT,
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
  // different position for the selected row). Also when edit mode toggles or the
  // table expands: edit-mode inputs make every row taller (and a collapsed table
  // has no viewport), so a row placed before that change slides out of view.
  const isCardViewActive = useCardView && !isEditing;

  useEffect(() => {
    // `""` is a valid feature id; only `null` means no selection.
    if (!attributeTableOpen || selectedFeatureId === null || isCardViewActive) return;
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
    sortSpecs,
    sorted.length,
    attributeFilter,
    columnFilters,
    isEditing,
    collapsed,
    isCardViewActive,
  ]);

  const discoveredColumns = useMemo(() => {
    const propKeys = new Set<string>();
    for (const row of attributeRows) {
      for (const k of Object.keys(row.properties)) {
        // The inline photo/full-resolution image keys are multi-KB-to-MB data
        // URLs (the map popup and Identify render them as thumbnails instead); a
        // table cell would dump the raw base64 as text and jank on large photos.
        if (!RESERVED_IMAGE_KEYS.has(k)) propKeys.add(k);
      }
    }
    // Tracking columns are listed even before any feature carries one, so a layer
    // that just turned tracking on shows what it is about to maintain (and the
    // Field Calculator's "new field" name check sees them as taken).
    return ensureEditorTrackingFields(Array.from(propKeys), layer?.editorTracking);
  }, [attributeRows, layer?.editorTracking]);
  // Displayed columns omit engine metadata and large inline photos; mutation
  // validation still needs every stored key to avoid overwriting hidden data.
  const mutationColumns = useMemo(
    () =>
      ensureEditorTrackingFields(
        Array.from(new Set(features.flatMap((feature) => Object.keys(feature.properties ?? {})))),
        layer?.editorTracking,
      ),
    [features, layer?.editorTracking],
  );
  const isReservedFieldName = (name: string) =>
    layer?.metadata.sourceKind === SKETCHES_SOURCE_KIND && isInternalEditorProperty(name);
  const columnSettings = getColumnSettings(layer);
  // Columns rendered in the table, honoring saved order and hidden state.
  const columns = visibleColumns(discoveredColumns, columnSettings);
  // Number columns read like QGIS: right-aligned, with display-only rounding.
  // A column's type comes from its first non-null value, as for editing. Keyed
  // on the column names, not the array, which is rebuilt every render.
  const columnsKey = columns.join("\u0000");
  const numericColumns = useMemo(
    () => numericColumnSet(attributeRows, columnsKey ? columnsKey.split("\u0000") : []),
    [attributeRows, columnsKey],
  );
  const hiddenCols = hiddenColumns(discoveredColumns, columnSettings);
  const hiddenColSet = new Set(hiddenCols);
  const tableColumns = ["__featureId", ...columns];
  // Column management mutates layer.geojson/style/metadata, so it is offered
  // only for in-store, editable GeoJSON layers — not DuckDB query results or
  // Add Vector Layer layers (whose geojson is not persisted).
  const canManageColumns =
    Boolean(layer?.geojson) && !isDuckDBLayer && !isReadOnlyVectorLayer && layerCaps.update;

  const columnWidth = (key: SortKey) =>
    columnWidths[key] ??
    (key === "__featureId" ? DEFAULT_FEATURE_ID_COLUMN_WIDTH : DEFAULT_ATTRIBUTE_COLUMN_WIDTH);
  const columnsWidth = tableColumns.reduce((width, column) => width + columnWidth(column), 0);
  const tableWidth = `calc(${columnsWidth}px + ${VERTICAL_SCROLLBAR_GUTTER})`;
  const { startColumnResize, startTableResize } = useTableResize({
    columnWidth,
    setColumnWidths,
    tableHeight,
    deferTableResize,
    tableResizeGuideRef,
    tableSectionRef,
    setTableHeight,
  });

  const toggleSort = (key: SortKey, additive = false) => {
    setSortSpecs((current) => toggleMultiSort(current, key, additive));
  };

  const renderSortIcon = (key: SortKey) => {
    const idx = sortSpecs.findIndex((spec) => spec.key === key);
    if (idx === -1) return null;
    const spec = sortSpecs[idx];
    return (
      <span className="inline-flex items-center gap-0.5">
        {spec.direction === "asc" ? (
          <ArrowUp className="h-3.5 w-3.5" />
        ) : (
          <ArrowDown className="h-3.5 w-3.5" />
        )}
        {sortSpecs.length > 1 ? (
          <span className="text-[10px] font-semibold tabular-nums text-primary">{idx + 1}</span>
        ) : null}
      </span>
    );
  };

  const handleColumnFilterChange = (column: string, spec: ColumnFilterSpec | null) => {
    setColumnFilters((current) => {
      const next = { ...current };
      if (!spec || !hasActiveColumnFilter(spec)) {
        delete next[column];
      } else {
        next[column] = spec;
      }
      return next;
    });
  };

  const activeColumnFilterCount = Object.keys(columnFilters).length;
  const editableBulkColumns = useMemo(
    () => columns.filter((col) => !readOnlyColumns.has(col)),
    [columns, readOnlyColumns],
  );
  const {
    handleBulkFill,
    handleFindReplace,
    formErrorText,
    updateCellDraft,
    cancelEditing,
    toggleEditing,
    saveDrafts,
    exportLayer,
  } = useAttributeEditing({
    canEnterEditMode,
    readOnlyColumns,
    selectedIdSet,
    filtered,
    attributeRows,
    drafts,
    setIsEditing,
    setDrafts,
    t,
    isEditing,
    hasEdits,
    layer,
    hasUnsafeDraftTargets,
    hasInvalidDrafts,
    hasFormErrors,
    isDuckDBLayer,
    formForRow,
    updateLayer,
    setExportError,
    setExportWarning,
  });
  const {
    beginColumnRename,
    cancelColumnRename,
    commitColumnRename,
    handleToggleHidden,
    handleToggleExcluded,
    handleShowAllColumns,
    handleMoveColumn,
    confirmDeleteColumn,
    newColumnNameTrimmed,
    newColumnCollides,
    newColumnReserved,
    canAddColumn,
    canSubmitNewColumn,
    openAddColumn,
    changeNewColumnType,
    confirmAddColumn,
  } = useColumnManagement({
    suppressColumnBlurRef,
    setEditingColumn,
    setEditingColumnName,
    editingColumn,
    layer,
    canManageColumns,
    editingColumnName,
    isReservedFieldName,
    mutationColumns,
    updateLayer,
    setColumnWidths,
    setSortSpecs,
    setColumnFilters,
    discoveredColumns,
    layerCaps,
    columnPendingDelete,
    setColumnPendingDelete,
    newColumnName,
    features,
    setNewColumnName,
    setNewColumnType,
    setNewColumnDefault,
    setAddingColumn,
    newColumnType,
    newColumnDefault,
  });
  const {
    calculatorTargetColumns,
    openCalculator,
    insertExpressionSnippet,
    calcAvailableMetrics,
    calcEffectiveMetric,
    calcGeomUnitOptions,
    calcEffectiveUnit,
    insertGeometrySnippet,
    calcNewNameTrimmed,
    calcNameCollides,
    calcNameReserved,
    calcHasSelection,
    calcPreview,
    calcCanSubmit,
    confirmCalculate,
  } = useFieldCalculator({
    discoveredColumns,
    readOnlyColumns,
    setCalcMode,
    setCalcTargetField,
    setCalcNewName,
    setCalcOutputType,
    setCalcExpression,
    setCalcSelectedOnly,
    setCalcError,
    features,
    setCalcGeomMetric,
    setCalcGeomUnit,
    setCalcOpen,
    calcExpressionRef,
    layer,
    calcOpen,
    calcGeomMetric,
    calcGeomUnit,
    calcNewName,
    calcMode,
    mutationColumns,
    isReservedFieldName,
    calcTargetField,
    selectedFeatureIds,
    calcSelectedOnly,
    attributeRows,
    selectedFeatureId,
    calcExpression,
    calcOutputType,
    t,
    canManageColumns,
    updateLayer,
  });

  const sortableHeader = (key: SortKey, label: string, numeric = false) => (
    <div className="relative flex h-full min-h-7 items-center">
      <button
        type="button"
        className={`flex h-full min-w-0 flex-1 items-center gap-1 pe-3 font-medium ${
          numeric ? "justify-end text-end" : "text-start"
        }`}
        title={t("attributeTable.multiSortHint")}
        onClick={(event) => toggleSort(key, event.shiftKey)}
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
        <div className="relative flex h-full min-h-7 items-center">
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
    const numeric = numericColumns.has(col);
    if (!canManageColumns || isEditing) return sortableHeader(col, col, numeric);

    return (
      <div className="relative flex h-full min-h-7 items-center">
        <button
          type="button"
          className={`flex h-full min-w-0 flex-1 items-center gap-1 pe-1 font-medium ${
            numeric ? "justify-end text-end" : "text-start"
          }`}
          onClick={(event) => toggleSort(col, event.shiftKey)}
          title={
            virtualFieldColumns.has(col)
              ? t("attributeTable.virtualColumnTitle")
              : t("attributeTable.multiSortHint")
          }
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
              disabled={readOnlyColumns.has(col)}
              onSelect={() => beginColumnRename(col)}
            >
              <Pencil className="me-2 h-3.5 w-3.5" />
              {t("attributeTable.renameField")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => handleToggleHidden(col)}>
              <EyeOff className="me-2 h-3.5 w-3.5" />
              {t("attributeTable.hideField")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => handleToggleExcluded(col)}>
              <Ban className="me-2 h-3.5 w-3.5" />
              {layer?.fieldVisibility?.[col] === "excluded"
                ? t("attributeTable.includeField", "Include field on export")
                : t("attributeTable.excludeField", "Exclude field on export")}
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
              disabled={readOnlyColumns.has(col) || !layerCaps.delete}
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
      data-collapsed={collapsed || undefined}
      className="geolibre-attribute-table-panel geolibre-bottom-panel @container relative flex shrink-0 flex-col border-t bg-card"
      style={{ height: collapsed ? undefined : tableHeight }}
    >
      {!collapsed ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("attributeTable.resize")}
          className="geolibre-attribute-table-resize-handle absolute -top-1 start-0 end-0 z-20 h-2 cursor-row-resize select-none border-t border-transparent hover:border-primary"
          onMouseDown={startTableResize}
        />
      ) : null}
      <div
        ref={tableResizeGuideRef}
        className="pointer-events-none fixed left-0 right-0 z-50 hidden h-px bg-primary shadow-[0_0_0_1px_hsl(var(--primary)/0.25)]"
      />
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5">
        <TableProperties className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">{t("attributeTable.title")}</span>
        {layer ? (
          <span className="min-w-0 max-w-56 flex-[1_1_6rem] truncate text-xs text-muted-foreground">
            {t("attributeTable.selectedLayerName", { name: layer.name })}
          </span>
        ) : (
          <span className="min-w-0 max-w-56 flex-[1_1_6rem] truncate text-xs text-muted-foreground">
            {t("attributeTable.noLayerSelected")}
          </span>
        )}
        {exportError ? (
          <span className="max-w-48 truncate text-xs text-destructive">{exportError}</span>
        ) : exportWarning ? (
          <span className="max-w-48 truncate text-xs text-amber-600" title={exportWarning}>
            {exportWarning}
          </span>
        ) : refreshStatus && refreshStatus.type !== "refreshing" ? (
          <span
            className={`max-w-48 truncate text-xs ${
              refreshStatus.type === "error"
                ? "text-destructive"
                : refreshStatus.type === "warning"
                  ? "text-amber-600"
                  : "text-muted-foreground"
            }`}
            title={refreshStatus.message}
            role="status"
          >
            {refreshStatus.message}
          </span>
        ) : null}
        {isEditing && domainNotice ? (
          <span
            className="max-w-48 truncate text-xs text-amber-600"
            title={domainNotice}
            role="status"
          >
            {domainNotice}
          </span>
        ) : null}
        {isEditing && contingencyNotice ? (
          <span
            className="max-w-64 truncate text-xs text-amber-600"
            title={contingencyNotice}
            role="status"
          >
            {contingencyNotice}
          </span>
        ) : null}
        {/* One line at laptop widths: the table's own actions (edit, save,
            the feature view, selection, search and, in the phone shell, the
            card-view toggle) stay in the bar, and the field tools, analysis
            dialogs, refresh, export and the zoom toggle sit in the overflow
            menu, so the toolbar no longer wraps over the rows. Narrower
            panels still wrap rather than clip Close. */}
        <Button
          variant={isEditing ? "secondary" : "outline"}
          size="sm"
          className="h-7 px-2"
          title={
            !layerCaps.update
              ? t("attributeTable.editTitleCapabilityDisabled")
              : isGeometryEditing
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
          disabled={!canEnterEditMode || (isEditing && hasEdits)}
          onClick={toggleEditing}
        >
          <Pencil className="h-3.5 w-3.5" />
          <span className="hidden @[112rem]:inline">{t("attributeTable.buttons.edit")}</span>
        </Button>
        <Button
          variant="default"
          size="sm"
          className="h-7 px-2"
          title={
            hasUnsafeDraftTargets
              ? t("layers.pendingTableDraftsBlocked")
              : hasInvalidDrafts
                ? t("attributeTable.saveTitleInvalid")
                : hasFormErrors
                  ? t("attributeTable.saveTitleFormErrors")
                  : isDuckDBLayer
                    ? t("attributeTable.saveTitleDuckdb")
                    : t("attributeTable.saveEdits")
          }
          aria-label={t("attributeTable.saveEdits")}
          disabled={
            !isEditing ||
            !canEnterEditMode ||
            !hasEdits ||
            hasUnsafeDraftTargets ||
            hasInvalidDrafts ||
            hasFormErrors
          }
          onClick={saveDrafts}
        >
          <Save className="h-3.5 w-3.5" />
          <span className="hidden @[112rem]:inline">{t("common.save")}</span>
        </Button>
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
        {/* Compact so it matches the h-7 toolbar. As a flex item the wrapper
            sizes to the longest label rather than clipping it. */}
        <Select
          compact
          className="shrink-0"
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
        </Select>
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
        {attachmentSupport?.list ? (
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            title={
              attachmentObjectId !== undefined
                ? t("attachments.openTitle")
                : t("attachments.openTitleNoRecord")
            }
            aria-label={t("attachments.title")}
            disabled={attachmentObjectId === undefined}
            onClick={() => setAttachmentsOpen(true)}
          >
            <Paperclip className="h-3.5 w-3.5" />
          </Button>
        ) : null}
        {relationships.length ? (
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            title={
              relatedParent !== undefined
                ? t("relatedRecords.openTitle")
                : t("relatedRecords.openTitleNoRecord")
            }
            aria-label={t("relatedRecords.title")}
            disabled={relatedParent === undefined}
            onClick={() => setRelatedOpen(true)}
          >
            <Network className="h-3.5 w-3.5" />
          </Button>
        ) : null}
        {mobileShell && hasAttributeSource && !isEditing ? (
          <Button
            variant={useCardView ? "secondary" : "ghost"}
            size="icon"
            data-testid="attribute-table-view-toggle"
            className="h-7 w-7"
            title={
              useCardView
                ? t("mobileShell.attributeCards.switchToTable")
                : t("mobileShell.attributeCards.switchToCards")
            }
            aria-label={
              useCardView
                ? t("mobileShell.attributeCards.switchToTable")
                : t("mobileShell.attributeCards.switchToCards")
            }
            aria-pressed={useCardView}
            onClick={() => setCardViewOverride(!useCardView)}
          >
            {useCardView ? (
              <TableProperties className="h-4 w-4" />
            ) : (
              <LayoutList className="h-4 w-4" />
            )}
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              title={t("attributeTable.moreActions")}
              aria-label={t("attributeTable.moreActions")}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            {canManageColumns && !isEditing ? (
              <>
                <DropdownMenuItem
                  className="gap-2"
                  title={t("attributeTable.addFieldTitle")}
                  onSelect={openAddColumn}
                >
                  <Plus className="h-4 w-4" />
                  {t("attributeTable.addField")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="gap-2"
                  title={t("attributeTable.fieldCalculatorTitle")}
                  onSelect={openCalculator}
                >
                  <Calculator className="h-4 w-4" />
                  {t("attributeTable.fieldCalculator")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="gap-2"
                  disabled={!canEnterEditMode || editableBulkColumns.length === 0}
                  onSelect={() => setBulkEditOpen(true)}
                >
                  <Replace className="h-4 w-4" />
                  {t("attributeTable.bulkEdit.title")}
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger title={t("attributeTable.manageFieldsTitle")}>
                    <Columns3 className="h-4 w-4" />
                    {t("attributeTable.manageFields")}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
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
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
              </>
            ) : null}
            {!isEditing ? (
              <>
                <DropdownMenuItem
                  className="gap-2"
                  title={
                    hasAttributeSource
                      ? t("attributeTable.columnExplorerTitle")
                      : t("attributeTable.columnExplorerTitleDisabled")
                  }
                  disabled={!hasAttributeSource}
                  onSelect={() => setExplorerOpen(true)}
                >
                  <Telescope className="h-4 w-4" />
                  {t("attributeTable.columnExplorer")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="gap-2"
                  title={
                    hasAttributeSource
                      ? t("attributeTable.statisticsTitle")
                      : t("attributeTable.statisticsTitleDisabled")
                  }
                  disabled={!hasAttributeSource}
                  onSelect={() => setStatsOpen(true)}
                >
                  <Sigma className="h-4 w-4" />
                  {t("attributeTable.statistics")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="gap-2"
                  title={
                    hasAttributeSource
                      ? t("attributeTable.chartsTitle")
                      : t("attributeTable.chartsTitleDisabled")
                  }
                  disabled={!hasAttributeSource}
                  onSelect={() => setChartOpen(true)}
                >
                  <ChartColumn className="h-4 w-4" />
                  {t("attributeTable.charts")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="gap-2"
                  title={t("attributeTable.dashboardTitle")}
                  onSelect={() => setDashboardOpen(true)}
                >
                  <LayoutDashboard className="h-4 w-4" />
                  {t("attributeTable.dashboard")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            ) : null}
            {!isEditing && canRefreshLayer && layer ? (
              <DropdownMenuItem
                className="gap-2"
                title={
                  refreshBlockedByEdits
                    ? t("attributeTable.refreshTitlePendingEdits")
                    : isLocalFileRefresh
                      ? t("attributeTable.refreshTitleLocalFile")
                      : t("attributeTable.refreshTitle")
                }
                aria-busy={isRefreshingLayer}
                disabled={isRefreshingLayer || refreshBlockedByEdits}
                onSelect={() => void refreshLayerRows(layer)}
              >
                <RefreshCw className={`h-4 w-4 ${isRefreshingLayer ? "animate-spin" : ""}`} />
                {t("attributeTable.refresh")}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger
                title={
                  !layerCaps.export
                    ? t("attributeTable.exportTitleCapabilityDisabled")
                    : layer?.geojson
                      ? t("attributeTable.exportSelectedLayer")
                      : t("attributeTable.exportTitleDisabled")
                }
                disabled={!layer?.geojson || !layerCaps.export}
              >
                <Download className="h-4 w-4" />
                {t("attributeTable.buttons.export")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem onSelect={() => void exportLayer("geojson")}>
                  GeoJSON
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void exportLayer("geoparquet")}>
                  GeoParquet
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void exportLayer("geopackage")}>
                  GeoPackage
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void exportLayer("kml")}>KML</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void exportLayer("kmz")}>KMZ</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void exportLayer("shapefile")}>
                  Shapefile (zipped)
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void exportLayer("csv")}>CSV</DropdownMenuItem>
                {layer && layerSupportsPolylineExport(layer) && (
                  <>
                    <DropdownMenuItem onSelect={() => void exportLayer("polyline", 5)}>
                      {t("layers.exportPolyline", { precision: 5 })}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void exportLayer("polyline", 6)}>
                      {t("layers.exportPolyline", { precision: 6 })}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={zoomToSelectedFeature}
              onCheckedChange={(checked) => setZoomToSelectedFeature(checked === true)}
            >
              {t("attributeTable.zoomToSelection")}
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant={columnFilterBarOpen || activeColumnFilterCount > 0 ? "secondary" : "outline"}
          size="sm"
          className="ms-auto h-7 gap-1 px-2"
          title={t("attributeTable.columnFilter.toggle")}
          aria-label={t("attributeTable.columnFilter.toggle")}
          aria-pressed={columnFilterBarOpen}
          disabled={!hasAttributeSource || columns.length === 0}
          onClick={() => setColumnFilterBarOpen((open) => !open)}
        >
          <Filter className="h-3.5 w-3.5" />
          {activeColumnFilterCount > 0 ? (
            <span className="text-[11px] font-semibold tabular-nums">
              {activeColumnFilterCount}
            </span>
          ) : null}
        </Button>
        {canEnterEditMode && editableBulkColumns.length > 0 ? (
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            title={t("attributeTable.bulkEdit.title")}
            aria-label={t("attributeTable.bulkEdit.title")}
            onClick={() => setBulkEditOpen(true)}
          >
            <Replace className="h-3.5 w-3.5" />
          </Button>
        ) : null}
        <Input
          className="h-7 w-[180px] min-w-28 shrink text-xs"
          placeholder={t("attributeTable.searchPlaceholder")}
          aria-label={t("attributeTable.searchAria")}
          value={attributeFilter}
          onChange={(e) => setAttributeFilter(e.target.value)}
        />
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
        Vertical scrollbar height reserves 2.75rem: 1.875rem for the sticky
        header row (30px) plus 0.875rem for the
        horizontal scrollbar (h-3.5), so the two scrollbars do not overlap.
      */}
      {!collapsed && columnFilterBarOpen && hasAttributeSource ? (
        <ColumnFilterBar
          columns={columns}
          numericColumns={numericColumns}
          filters={columnFilters}
          onChangeFilter={handleColumnFilterChange}
          onClearAll={() => setColumnFilters({})}
        />
      ) : null}
      {!collapsed ? (
        <AttributeTableGrid
          scrollViewportRef={scrollViewportRef}
          hasAttributeSource={hasAttributeSource}
          loadingVectorGeojson={loadingVectorGeojson}
          t={t}
          isCardViewActive={isCardViewActive}
          sorted={sorted}
          columns={columns}
          selectedIdSet={selectedIdSet}
          selectedFeatureId={selectedFeatureId}
          sort={sort}
          setSortSpecs={setSortSpecs}
          handleRowClick={handleRowClick}
          selectFeature={selectFeature}
          layer={layer}
          mapControllerRef={mapControllerRef}
          tableWidth={tableWidth}
          tableColumns={tableColumns}
          columnWidth={columnWidth}
          sortableHeader={sortableHeader}
          attributeColumnHeader={attributeColumnHeader}
          paddingTop={paddingTop}
          virtualRows={virtualRows}
          drafts={drafts}
          formForRow={formForRow}
          rowVirtualizer={rowVirtualizer}
          formDraftErrors={formDraftErrors}
          i18n={i18n}
          numericColumns={numericColumns}
          isEditing={isEditing}
          canEnterEditMode={canEnterEditMode}
          readOnlyColumns={readOnlyColumns}
          formErrorText={formErrorText}
          updateCellDraft={updateCellDraft}
          virtualFieldColumns={virtualFieldColumns}
          joinDerivedColumns={joinDerivedColumns}
          trackingColumns={trackingColumns}
          serviceConstraints={serviceConstraints}
          paddingBottom={paddingBottom}
        />
      ) : null}
      {/*
        Status bar: how many features the layer has, how many the table is
        currently showing, and how many are selected. The "shown" count only
        appears when a search or the Selected view is narrowing the table, so
        the common case reads as one unambiguous total rather than two equal
        numbers. Sits outside the ScrollArea so it stays put while scrolling.
      */}
      {!collapsed && hasAttributeSource ? (
        <div
          data-testid="attribute-table-status"
          className="flex shrink-0 items-center gap-3 border-t bg-card px-3 py-1 text-[11px] text-muted-foreground"
        >
          <span>
            {t("attributeTable.statusFeatures", {
              count: attributeRows.length,
            })}
          </span>
          {filtered.length !== attributeRows.length ? (
            <span>{t("attributeTable.statusShown", { count: filtered.length })}</span>
          ) : null}
          <span>
            {t("attributeTable.statusSelected", {
              count: selectedFeatureIds.length,
            })}
          </span>
        </div>
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
            <Button
              variant="destructive"
              disabled={!canManageColumns || !layerCaps.delete}
              onClick={confirmDeleteColumn}
            >
              {t("attributeTable.deleteField")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <AddFieldDialog
        addingColumn={addingColumn}
        setAddingColumn={setAddingColumn}
        t={t}
        layer={layer}
        newColumnName={newColumnName}
        newColumnCollides={newColumnCollides}
        newColumnReserved={newColumnReserved}
        setNewColumnName={setNewColumnName}
        canSubmitNewColumn={canSubmitNewColumn}
        confirmAddColumn={confirmAddColumn}
        newColumnNameTrimmed={newColumnNameTrimmed}
        newColumnType={newColumnType}
        changeNewColumnType={changeNewColumnType}
        newColumnDefault={newColumnDefault}
        setNewColumnDefault={setNewColumnDefault}
        canAddColumn={canAddColumn}
        canManageColumns={canManageColumns}
      />
      <FieldCalculatorDialog
        calcOpen={calcOpen}
        setCalcOpen={setCalcOpen}
        setCalcError={setCalcError}
        t={t}
        layer={layer}
        calcMode={calcMode}
        setCalcMode={setCalcMode}
        discoveredColumns={discoveredColumns}
        calcNewName={calcNewName}
        calcNameCollides={calcNameCollides}
        calcNameReserved={calcNameReserved}
        setCalcNewName={setCalcNewName}
        calcTargetField={calcTargetField}
        setCalcTargetField={setCalcTargetField}
        calculatorTargetColumns={calculatorTargetColumns}
        calcNewNameTrimmed={calcNewNameTrimmed}
        calcOutputType={calcOutputType}
        setCalcOutputType={setCalcOutputType}
        calcExpressionRef={calcExpressionRef}
        calcExpression={calcExpression}
        setCalcExpression={setCalcExpression}
        insertExpressionSnippet={insertExpressionSnippet}
        calcAvailableMetrics={calcAvailableMetrics}
        calcEffectiveMetric={calcEffectiveMetric}
        setCalcGeomMetric={setCalcGeomMetric}
        calcEffectiveUnit={calcEffectiveUnit}
        setCalcGeomUnit={setCalcGeomUnit}
        calcGeomUnitOptions={calcGeomUnitOptions}
        insertGeometrySnippet={insertGeometrySnippet}
        calcPreview={calcPreview}
        calcSelectedOnly={calcSelectedOnly}
        calcHasSelection={calcHasSelection}
        setCalcSelectedOnly={setCalcSelectedOnly}
        calcError={calcError}
        canManageColumns={canManageColumns}
        calcCanSubmit={calcCanSubmit}
        confirmCalculate={confirmCalculate}
      />
      {layer && attachmentSupport && attachmentObjectId !== undefined ? (
        <ArcGISAttachmentsDialog
          open={attachmentsOpen}
          onOpenChange={setAttachmentsOpen}
          source={layer.id}
          layerName={layer.name}
          objectId={attachmentObjectId}
          support={attachmentSupport}
        />
      ) : null}
      {layer && relatedParent !== undefined ? (
        <ArcGISRelatedRecordsDialog
          open={relatedOpen}
          onOpenChange={setRelatedOpen}
          layer={layer}
          parent={relatedParent.feature}
          objectId={relatedParent.objectId}
          relationships={relationships}
        />
      ) : null}
      <AttributeChartDialog
        open={chartOpen}
        onOpenChange={setChartOpen}
        rows={analysisRows}
        columns={discoveredColumns}
        layerName={layer?.name ?? ""}
      />
      <AttributeStatsDialog
        open={statsOpen}
        onOpenChange={setStatsOpen}
        rows={analysisRows}
        filteredRows={analysisFilteredRows}
        selectedRows={analysisSelectedRows}
        columns={discoveredColumns}
        layerName={layer?.name ?? ""}
      />
      <ColumnExplorerDialog
        open={explorerOpen}
        onOpenChange={setExplorerOpen}
        rows={analysisRows}
        filteredRows={analysisFilteredRows}
        columns={discoveredColumns}
        layerName={layer?.name ?? ""}
      />
      <AttributeBulkEditDialog
        open={bulkEditOpen && canEnterEditMode}
        onOpenChange={setBulkEditOpen}
        canEdit={canEnterEditMode}
        editableColumns={editableBulkColumns}
        selectedCount={selectedIdSet.size}
        filteredCount={filtered.length}
        onBulkFill={handleBulkFill}
        onFindReplace={handleFindReplace}
      />
    </section>
  );
}
