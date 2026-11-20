import {
  pluginOwnsPaint,
  rendererAppliesOpacity,
  resolveLayerCapabilities,
  supportsBridgedOpacity,
  useAppStore,
} from "@geolibre/core";
import type { GeoLibreLayer } from "@geolibre/core";
import { startFeatureSelection } from "@geolibre/map";
import {
  ArrowDown,
  ArrowUp,
  CircleDashed,
  Download,
  FilePlus2,
  Folder,
  FolderMinus,
  Info,
  LassoSelect,
  MousePointerClick,
  Palette,
  Pencil,
  Pentagon,
  RefreshCw,
  Shuffle,
  SquareDashed,
  Table2,
  Trash2,
  X,
  ZoomIn,
} from "lucide-react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { canOpenLayerAttributeTable } from "../../../lib/attribute-table-source";
import { canExportLidarLayer, type LidarExportFormat } from "../../../lib/lidar-export";
import { isRefreshableLayer } from "../../../lib/layer-refresh";
import { notify } from "../../../lib/notify";
import { canExportRasterLayer } from "../../../lib/raster-export";
import {
  activateLayerPreservingSelection,
  clearFeatureSelection,
  exportSelectionAsLayer,
  invertLayerSelection,
  openLayerAttributeTable,
  zoomToSelection,
} from "../../../lib/selection-actions";
import type { TouchMenuItem } from "../../../lib/touch-menu-nav";
import { TouchMenuSheet } from "../../layout/mobile/TouchMenuSheet";
import type { LayerActionsMenuShared } from "./LayerActionsMenu";
import { LayerOpacitySlider } from "./LayerOpacitySlider";

const LIDAR_EXPORT_ITEMS = [
  { format: "las", labelKey: "layers.exportLas" },
  { format: "laz", labelKey: "layers.exportLaz" },
  { format: "copc", labelKey: "layers.exportCopc" },
] as const satisfies ReadonlyArray<{ format: LidarExportFormat; labelKey: string }>;

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
    onOpenStylePanel,
  } = shared;

  const showOpacity =
    !pluginOwnsPaint(layer) ||
    supportsBridgedOpacity(layer.id) ||
    rendererAppliesOpacity(layer, primaryRenderer);
  const canOpenAttrTable = canOpenLayerAttributeTable(layer) && layerCaps.query;
  const canSelect = layer.type === "geojson" && layerCaps.query;
  const holdsSelection = selectedLayerId === layer.id && selectedFeatureCount > 0;
  const canExportVector = layer.type === "geojson" && layerCaps.export;
  const canExportRaster = canExportRasterLayer(layer) && layerCaps.export;
  const canExportLidar = canExportLidarLayer(layer) && layerCaps.export;
  const moveIds = selectedMoveIds(layer.id);

  const exportItems: TouchMenuItem[] = [];
  if (canExportVector) {
    for (const [format, label] of [
      ["geojson", "GeoJSON"],
      ["geoparquet", "GeoParquet"],
      ["geopackage", "GeoPackage"],
      ["shapefile", "Shapefile (zipped)"],
      ["kml", "KML"],
      ["kmz", "KMZ"],
      ["csv", "CSV"],
    ] as const) {
      exportItems.push({
        kind: "action",
        id: `export-${format}`,
        label,
        icon: <Download className="h-4 w-4" />,
        onSelect: () => void actions.handleExportLayer(layer, format),
      });
    }
  }
  if (canExportRaster) {
    exportItems.push({
      kind: "action",
      id: "export-raster",
      label: t("layers.exportGeoTiff"),
      icon: <Download className="h-4 w-4" />,
      onSelect: () => void actions.handleExportRasterLayer(layer),
    });
  }
  if (canExportLidar) {
    for (const { format, labelKey } of LIDAR_EXPORT_ITEMS) {
      exportItems.push({
        kind: "action",
        id: `export-${format}`,
        label: t(labelKey),
        icon: <Download className="h-4 w-4" />,
        onSelect: () => void actions.handleExportLidarLayer(layer, format),
      });
    }
  }

  const selectionItems: TouchMenuItem[] = [];
  if (canSelect) {
    for (const [shape, Icon, labelKey] of [
      ["single", MousePointerClick, "layers.selectFeaturesSingle"],
      ["rectangle", SquareDashed, "layers.selectFeaturesRectangle"],
      ["polygon", Pentagon, "layers.selectFeaturesPolygon"],
      ["freehand", LassoSelect, "layers.selectFeaturesFreehand"],
      ["radius", CircleDashed, "layers.selectFeaturesRadius"],
    ] as const) {
      selectionItems.push({
        kind: "action",
        id: `select-${shape}`,
        label: t(labelKey),
        disabled: !layerRendered,
        icon: <Icon className="h-4 w-4" />,
        onSelect: () => {
          if (identifyOwnsClicks) setIdentifyLayer(null);
          startFeatureSelection({ layerId: layer.id, shape });
        },
      });
    }
    if (holdsSelection) {
      selectionItems.push(
        {
          kind: "action",
          id: "selection-zoom",
          label: t("toolbar.item.zoomToSelection"),
          icon: <SquareDashed className="h-4 w-4" />,
          onSelect: () => zoomToSelection(mapControllerRef.current),
        },
        {
          kind: "action",
          id: "selection-invert",
          label: t("toolbar.item.invertSelection"),
          icon: <Shuffle className="h-4 w-4" />,
          onSelect: invertLayerSelection,
        },
        {
          kind: "action",
          id: "selection-clear",
          label: t("toolbar.item.clearSelection"),
          icon: <X className="h-4 w-4" />,
          onSelect: clearFeatureSelection,
        },
      );
      if (layerCaps.export) {
        selectionItems.push({
          kind: "action",
          id: "selection-export",
          label: t("toolbar.item.exportSelection"),
          icon: <FilePlus2 className="h-4 w-4" />,
          onSelect: () =>
            exportSelectionAsLayer(t("selection.exportedLayerName", { name: layer.name })),
        });
      }
    }
  }

  const groupItems: TouchMenuItem[] = layerGroups.map((g) => ({
    kind: "action",
    id: `group-${g.id}`,
    label: g.name,
    active: layer.groupId === g.id,
    disabled: !layerEditable,
    icon: <Folder className="h-4 w-4" />,
    onSelect: () => moveLayersToGroup(moveIds, g.id),
  }));
  if (layer.groupId) {
    groupItems.push({
      kind: "action",
      id: "group-ungroup",
      label: t("layers.removeFromGroup"),
      disabled: !layerEditable,
      icon: <FolderMinus className="h-4 w-4" />,
      onSelect: () => moveLayersToGroup(moveIds, null),
    });
  }

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
  if (canIdentify) {
    primaryActions.push({
      kind: "action",
      id: "identify",
      label: identifyLabel,
      active: identifyActive,
      disabled: geometryEditActive,
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
      icon: <RefreshCw className="h-4 w-4" />,
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
      onSelect: () => beginRename(layer),
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
