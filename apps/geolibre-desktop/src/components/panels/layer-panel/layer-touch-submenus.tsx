import type { GeoLibreLayer, LayerGroup, resolveLayerCapabilities } from "@geolibre/core";
import { startFeatureSelection, type MapEngine } from "@geolibre/map";
import type { TFunction } from "i18next";
import {
  CircleDashed,
  Download,
  FilePlus2,
  Folder,
  FolderMinus,
  LassoSelect,
  MousePointerClick,
  Pentagon,
  Shuffle,
  SquareDashed,
  X,
} from "lucide-react";
import type { RefObject } from "react";
import { canExportLidarLayer, type LidarExportFormat } from "../../../lib/lidar-export";
import { canExportRasterLayer } from "../../../lib/raster-export";
import {
  clearFeatureSelection,
  exportSelectionAsLayer,
  invertLayerSelection,
  zoomToSelection,
} from "../../../lib/selection-actions";
import type { TouchMenuItem } from "../../../lib/touch-menu-nav";
import type { LayerActions } from "./useLayerActions";

const LIDAR_EXPORT_ITEMS = [
  { format: "las", labelKey: "layers.exportLas" },
  { format: "laz", labelKey: "layers.exportLaz" },
  { format: "copc", labelKey: "layers.exportCopc" },
] as const satisfies ReadonlyArray<{ format: LidarExportFormat; labelKey: string }>;

const SELECTION_SHAPES = [
  ["single", MousePointerClick, "layers.selectFeaturesSingle"],
  ["rectangle", SquareDashed, "layers.selectFeaturesRectangle"],
  ["polygon", Pentagon, "layers.selectFeaturesPolygon"],
  ["freehand", LassoSelect, "layers.selectFeaturesFreehand"],
  ["radius", CircleDashed, "layers.selectFeaturesRadius"],
] as const;

export function buildLayerTouchSubmenus(opts: {
  t: TFunction;
  layer: GeoLibreLayer;
  layerCaps: ReturnType<typeof resolveLayerCapabilities>;
  layerRendered: boolean;
  layerEditable: boolean;
  layerGroups: LayerGroup[];
  holdsSelection: boolean;
  identifyOwnsClicks: boolean;
  geometryEditActive: boolean;
  geometryEditElsewhere: boolean;
  isLayerLocked: boolean;
  moveIds: string[];
  actions: LayerActions;
  mapControllerRef: RefObject<MapEngine | null>;
  setIdentifyLayer: (layerId: string | null) => void;
  moveLayersToGroup: (layerIds: string[], groupId: string | null) => void;
}): {
  exportItems: TouchMenuItem[];
  selectionItems: TouchMenuItem[];
  groupItems: TouchMenuItem[];
} {
  const {
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
    moveIds,
    actions,
    mapControllerRef,
    setIdentifyLayer,
    moveLayersToGroup,
  } = opts;

  const canExportVector = layer.type === "geojson" && layerCaps.export;
  const canExportRaster = canExportRasterLayer(layer) && layerCaps.export;
  const canExportLidar = canExportLidarLayer(layer) && layerCaps.export;
  const canSelect = layer.type === "geojson" && layerCaps.query;

  const exportItems: TouchMenuItem[] = [
    ...(canExportVector
      ? (
          [
            ["geojson", "GeoJSON"],
            ["geoparquet", "GeoParquet"],
            ["geopackage", "GeoPackage"],
            ["shapefile", t("layers.exportShapefileZipped")],
            ["kml", "KML"],
            ["kmz", "KMZ"],
            ["csv", "CSV"],
          ] as const
        ).map(([format, label]) => ({
          kind: "action" as const,
          id: `export-${format}`,
          label,
          icon: <Download className="h-4 w-4" />,
          onSelect: () => void actions.handleExportLayer(layer, format),
        }))
      : []),
    ...(canExportRaster
      ? [
          {
            kind: "action" as const,
            id: "export-raster",
            label: t("layers.exportGeoTiff"),
            icon: <Download className="h-4 w-4" />,
            onSelect: () => void actions.handleExportRasterLayer(layer),
          },
        ]
      : []),
    ...(canExportLidar
      ? LIDAR_EXPORT_ITEMS.map(({ format, labelKey }) => ({
          kind: "action" as const,
          id: `export-${format}`,
          label: t(labelKey),
          icon: <Download className="h-4 w-4" />,
          onSelect: () => void actions.handleExportLidarLayer(layer, format),
        }))
      : []),
  ];

  const selectionDisabled =
    !layerRendered || geometryEditActive || geometryEditElsewhere || isLayerLocked;
  const selectionItems: TouchMenuItem[] = canSelect
    ? [
        ...SELECTION_SHAPES.map(([shape, Icon, labelKey]) => ({
          kind: "action" as const,
          id: `select-${shape}`,
          label: t(labelKey),
          disabled: selectionDisabled,
          icon: <Icon className="h-4 w-4" />,
          onSelect: () => {
            if (identifyOwnsClicks) setIdentifyLayer(null);
            startFeatureSelection({ layerId: layer.id, shape });
          },
        })),
        ...(holdsSelection
          ? [
              {
                kind: "action" as const,
                id: "selection-zoom",
                label: t("toolbar.item.zoomToSelection"),
                icon: <SquareDashed className="h-4 w-4" />,
                onSelect: () => zoomToSelection(mapControllerRef.current),
              },
              {
                kind: "action" as const,
                id: "selection-invert",
                label: t("toolbar.item.invertSelection"),
                icon: <Shuffle className="h-4 w-4" />,
                onSelect: invertLayerSelection,
              },
              {
                kind: "action" as const,
                id: "selection-clear",
                label: t("toolbar.item.clearSelection"),
                icon: <X className="h-4 w-4" />,
                onSelect: clearFeatureSelection,
              },
              ...(layerCaps.export
                ? [
                    {
                      kind: "action" as const,
                      id: "selection-export",
                      label: t("toolbar.item.exportSelection"),
                      icon: <FilePlus2 className="h-4 w-4" />,
                      onSelect: () =>
                        exportSelectionAsLayer(
                          t("selection.exportedLayerName", { name: layer.name }),
                        ),
                    },
                  ]
                : []),
            ]
          : []),
      ]
    : [];

  const groupItems: TouchMenuItem[] = layerGroups.map((g) => ({
    kind: "action",
    id: `group-${g.id}`,
    label: g.name,
    active: layer.groupId === g.id,
    disabled: geometryEditElsewhere || !layerEditable,
    icon: <Folder className="h-4 w-4" />,
    onSelect: () => moveLayersToGroup(moveIds, g.id),
  }));
  if (layer.groupId) {
    groupItems.push({
      kind: "action",
      id: "group-ungroup",
      label: t("layers.removeFromGroup"),
      disabled: geometryEditElsewhere || !layerEditable,
      icon: <FolderMinus className="h-4 w-4" />,
      onSelect: () => moveLayersToGroup(moveIds, null),
    });
  }

  return { exportItems, selectionItems, groupItems };
}
