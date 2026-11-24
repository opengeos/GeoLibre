import {
  isDuckDBQueryLayer,
  pluginOwnsPaint,
  rendererAppliesOpacity,
  resolveLayerCapabilities,
  supportsBridgedOpacity,
  useAppStore,
} from "@geolibre/core";
import type { GeoLibreLayer } from "@geolibre/core";
import { canEditLayerGeometry } from "@geolibre/plugins/maplibre-geo-editor";
import { isArcGISWritableLayer } from "@geolibre/plugins/arcgis-layer";
import {
  ArrowDown,
  ArrowUp,
  Download,
  Folder,
  Info,
  MousePointerClick,
  Palette,
  Pencil,
  PencilRuler,
  RefreshCw,
  Save,
  SquareDashed,
  Table2,
  Trash2,
  ZoomIn,
} from "lucide-react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { canOpenLayerAttributeTable } from "../../../lib/attribute-table-source";
import { isRefreshableLayer } from "../../../lib/layer-refresh";
import { notify } from "../../../lib/notify";
import {
  activateLayerPreservingSelection,
  openLayerAttributeTable,
} from "../../../lib/selection-actions";
import type { TouchMenuItem } from "../../../lib/touch-menu-nav";
import { TouchMenuSheet } from "../../layout/mobile/TouchMenuSheet";
import {
  canWriteEditsToSource,
  isMssqlEditableLayer,
  isPostgisEditableLayer,
} from "./layer-panel-utils";
import type { LayerActionsMenuShared } from "./LayerActionsMenu";
import { LayerOpacitySlider } from "./LayerOpacitySlider";
import { buildLayerTouchSubmenus } from "./layer-touch-submenus";

export interface LayerActionsTouchSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shared: LayerActionsMenuShared;
  layer: GeoLibreLayer;
  layerCaps: ReturnType<typeof resolveLayerCapabilities>;
  layerRendered: boolean;
  canIdentify: boolean;
  identifyActive: boolean;
  identifyOwnsClicks: boolean;
  identifyLabel: string;
  geometryEditActive: boolean;
  geometryEditElsewhere: boolean;
  isLayerLocked: boolean;
  isRefreshing: boolean;
  layerEditable: boolean;
  readOnlyHint?: string;
  onOpenMetadata: (layer: GeoLibreLayer) => void;
  onRequestRemove: (layer: GeoLibreLayer) => void;
}

/**
 * Touch drill-down action sheet replacing nested Radix dropdown submenus for a
 * layer row in Touch UI mode (GeoLibre#3537 Phase 2).
 */
export function LayerActionsTouchSheet({
  open,
  onOpenChange,
  shared,
  layer,
  layerCaps,
  layerRendered,
  canIdentify,
  identifyActive,
  identifyOwnsClicks,
  identifyLabel,
  geometryEditActive,
  geometryEditElsewhere,
  isLayerLocked,
  isRefreshing,
  layerEditable,
  readOnlyHint,
  onOpenMetadata,
  onRequestRemove,
}: LayerActionsTouchSheetProps) {
  const { t } = useTranslation();
  const primaryRenderer = useAppStore((s) => s.primaryRenderer);
  const setLayerOpacity = useAppStore((s) => s.setLayerOpacity);
  const reorderLayer = useAppStore((s) => s.reorderLayer);
  const setIdentifyLayer = useAppStore((s) => s.setIdentifyLayer);
  const moveLayersToGroup = useAppStore((s) => s.moveLayersToGroup);

  if (!open || typeof document === "undefined") return null;

  const {
    mapControllerRef,
    layerGroups,
    selectedLayerId,
    selectedFeatureCount,
    selectedMoveIds,
    actions,
    handleRefreshLayer,
    beginRename,
    onToggleGeometryEdit,
    onMaterializeDuckDBLayer,
    onOpenStylePanel,
  } = shared;

  const showOpacity =
    !pluginOwnsPaint(layer) ||
    supportsBridgedOpacity(layer.id) ||
    rendererAppliesOpacity(layer, primaryRenderer);
  const canOpenAttrTable = canOpenLayerAttributeTable(layer) && layerCaps.query;
  const holdsSelection = selectedLayerId === layer.id && selectedFeatureCount > 0;
  const canEditGeometry =
    canEditLayerGeometry(layer) && (layerCaps.update || layerCaps.create || layerCaps.delete);
  const canMaterializeDuckDB = isDuckDBQueryLayer(layer);
  const canWriteBack =
    canWriteEditsToSource(layer) && (layerCaps.update || layerCaps.create || layerCaps.delete);

  const { exportItems, selectionItems, groupItems } = buildLayerTouchSubmenus({
    t,
    layer,
    layerCaps,
    layerRendered,
    layerEditable,
    layerGroups,
    holdsSelection,
    identifyOwnsClicks,
    geometryEditActive,
    geometryEditElsewhere,
    isLayerLocked,
    moveIds: selectedMoveIds(layer.id),
    actions,
    mapControllerRef,
    setIdentifyLayer,
    moveLayersToGroup,
  });

  const primaryActions: TouchMenuItem[] = [
    {
      kind: "action",
      id: "zoom-to-layer",
      label: t("layers.zoomToLayer"),
      icon: <ZoomIn className="h-4 w-4" />,
      onSelect: () => {
        const controller = mapControllerRef.current;
        if (controller && !controller.fitLayer(layer)) {
          notify.info(
            controller.isLayerOutsideMapCrs?.(layer)
              ? t("layers.zoomToLayerOutsideMapCrs", { name: layer.name })
              : t("layers.zoomToLayerUnknownExtent", { name: layer.name }),
          );
        }
      },
    },
  ];
  if (onOpenStylePanel) {
    primaryActions.push({
      kind: "action",
      id: "open-style",
      label: t("layers.openStylePanel"),
      icon: <Palette className="h-4 w-4" />,
      onSelect: () => {
        activateLayerPreservingSelection(layer.id);
        onOpenStylePanel();
      },
    });
  }
  if (canOpenAttrTable) {
    primaryActions.push({
      kind: "action",
      id: "attribute-table",
      label: t("layers.openAttributeTable"),
      icon: <Table2 className="h-4 w-4" />,
      onSelect: () => openLayerAttributeTable(layer.id),
    });
  }
  if (canMaterializeDuckDB) {
    primaryActions.push({
      kind: "action",
      id: "materialize-duckdb",
      label: t("layers.materializeToEditable"),
      disabled: !layerEditable,
      icon: <Table2 className="h-4 w-4" />,
      onSelect: () => {
        if (!layerEditable) return;
        onMaterializeDuckDBLayer(layer);
      },
    });
  }
  if (canEditGeometry || geometryEditActive) {
    primaryActions.push({
      kind: "action",
      id: "edit-geometry",
      label: geometryEditActive ? t("layers.finishEditingGeometry") : t("layers.editGeometry"),
      active: geometryEditActive,
      disabled: geometryEditElsewhere || !layerEditable,
      icon: <PencilRuler className="h-4 w-4" />,
      onSelect: () => {
        if (!layerEditable) return;
        activateLayerPreservingSelection(layer.id);
        if (identifyOwnsClicks) setIdentifyLayer(null);
        onToggleGeometryEdit(layer.id);
      },
    });
  }
  if (canWriteBack) {
    const mssqlPending = isMssqlEditableLayer(layer) && layer.mssqlWritebackPending === true;
    primaryActions.push({
      kind: "action",
      id: "save-edits-to-source",
      label: isArcGISWritableLayer(layer)
        ? t("layers.saveEditsToArcgis")
        : isMssqlEditableLayer(layer)
          ? t("layers.saveEditsToMssql")
          : isPostgisEditableLayer(layer)
            ? t("layers.saveEditsToPostgis")
            : t("layers.saveEditsToSource"),
      description: mssqlPending ? t("layers.saveEditsMssqlRefreshRequired") : undefined,
      disabled: geometryEditActive || !layerEditable || mssqlPending,
      icon: <Save className="h-4 w-4" />,
      onSelect: () => void actions.handleSaveEditsToSource(layer),
    });
  }
  if (canIdentify) {
    primaryActions.push({
      kind: "action",
      id: "identify",
      label: identifyLabel,
      active: identifyActive,
      disabled: geometryEditActive || geometryEditElsewhere || isLayerLocked,
      icon: <MousePointerClick className="h-4 w-4" />,
      onSelect: () => {
        activateLayerPreservingSelection(layer.id);
        setIdentifyLayer(identifyActive ? null : layer.id);
      },
    });
  }
  if (isRefreshableLayer(layer)) {
    primaryActions.push({
      kind: "action",
      id: "refresh-layer",
      label: t("layers.refresh"),
      disabled: isRefreshing,
      icon: <RefreshCw className={`h-4 w-4${isRefreshing ? " animate-spin" : ""}`} />,
      onSelect: () => void handleRefreshLayer(layer),
    });
  }

  const organizeActions: TouchMenuItem[] = [
    {
      kind: "action",
      id: "rename",
      label: t("layers.rename"),
      disabled: !layerEditable,
      icon: <Pencil className="h-4 w-4" />,
      // Defer past the synchronous sheet unmount so BottomSheet's cleanup focus
      // restoration does not immediately blur the inline rename input.
      onSelect: () => {
        window.setTimeout(() => beginRename(layer), 0);
      },
    },
    {
      kind: "action",
      id: "move-up",
      label: t("layers.moveUp"),
      icon: <ArrowUp className="h-4 w-4" />,
      onSelect: () => reorderLayer(layer.id, "up"),
    },
    {
      kind: "action",
      id: "move-down",
      label: t("layers.moveDown"),
      icon: <ArrowDown className="h-4 w-4" />,
      onSelect: () => reorderLayer(layer.id, "down"),
    },
  ];
  if (groupItems.length > 0) {
    organizeActions.push({
      kind: "submenu",
      id: "move-to-group",
      label: t("layers.moveToGroup"),
      icon: <Folder className="h-4 w-4" />,
      items: groupItems,
    });
  }

  const submenus: TouchMenuItem[] = [];
  if (selectionItems.length > 0) {
    submenus.push({
      kind: "submenu",
      id: "selection",
      label: t("layers.selectFeaturesMenu"),
      icon: <SquareDashed className="h-4 w-4" />,
      items: selectionItems,
    });
  }
  if (exportItems.length > 0) {
    submenus.push({
      kind: "submenu",
      id: "export",
      label: t("layers.export"),
      icon: <Download className="h-4 w-4" />,
      items: exportItems,
    });
  }

  const items: TouchMenuItem[] = [
    {
      kind: "section",
      id: "primary",
      label: t("mobileShell.layerActions.quickActions"),
      items: primaryActions,
    },
    {
      kind: "section",
      id: "organize",
      label: t("mobileShell.layerActions.organize"),
      items: [...organizeActions, ...submenus],
    },
    {
      kind: "section",
      id: "info",
      label: t("mobileShell.layerActions.manage"),
      items: [
        {
          kind: "action",
          id: "metadata",
          label: t("layers.metadata"),
          icon: <Info className="h-4 w-4" />,
          onSelect: () => onOpenMetadata(layer),
        },
        {
          kind: "action",
          id: "remove",
          label: t("layers.removeLayer"),
          disabled: !layerEditable,
          destructive: true,
          icon: <Trash2 className="h-4 w-4" />,
          onSelect: () => onRequestRemove(layer),
        },
      ],
    },
  ];

  const opacityHeader = showOpacity ? (
    <div className="rounded-lg border bg-muted/30 p-3">
      <LayerOpacitySlider
        label={t("layers.opacity")}
        ariaLabel={t("layers.opacityFor", { name: layer.name })}
        value={layer.opacity}
        disabled={!layerEditable}
        disabledHint={readOnlyHint}
        onChange={(value) => setLayerOpacity(layer.id, value)}
      />
    </div>
  ) : undefined;

  return createPortal(
    <div
      role="presentation"
      className="fixed inset-0 z-50"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <TouchMenuSheet
        open={open}
        onOpenChange={onOpenChange}
        title={layer.name}
        items={items}
        defaultDetent="half"
        searchable={false}
        headerContent={opacityHeader}
        data-testid="mobile-layer-actions-sheet"
      />
    </div>,
    document.body,
  );
}
