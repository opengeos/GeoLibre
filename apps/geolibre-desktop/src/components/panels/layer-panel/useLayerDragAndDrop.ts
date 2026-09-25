import { type DragEvent as ReactDragEvent, useState } from "react";
import { useAppStore } from "@geolibre/core";
import type { GeoLibreLayer } from "@geolibre/core";

interface UseLayerDragAndDropOptions {
  /** The project's layers, in store order. */
  layers: GeoLibreLayer[];
  /** The layers in panel (top-to-bottom) order. */
  visibleLayers: GeoLibreLayer[];
  /** The ids of the selected rows, which move together when one is dragged. */
  selectedLayerIds: Set<string>;
  /** The ids a move of `layerId` carries: the selection, or just that layer. */
  selectedMoveIds: (layerId: string) => string[];
  selectOnlyLayer: (layerId: string) => void;
}

/**
 * Drag-and-drop of layer rows: reordering within a group, moving across group
 * boundaries, and dropping onto a group header.
 *
 * @param options - The layers and the current row selection.
 * @returns The drag/drop-target state and the row and group-header handlers.
 */
export function useLayerDragAndDrop({
  layers,
  visibleLayers,
  selectedLayerIds,
  selectedMoveIds,
  selectOnlyLayer,
}: UseLayerDragAndDropOptions) {
  const moveLayer = useAppStore((s) => s.moveLayer);
  const moveLayersRelative = useAppStore((s) => s.moveLayersRelative);
  const moveLayersToGroup = useAppStore((s) => s.moveLayersToGroup);
  const [draggedLayerId, setDraggedLayerId] = useState<string | null>(null);
  const [dropTargetLayerId, setDropTargetLayerId] = useState<string | null>(null);
  const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null);

  const draggedDisplayIndex = draggedLayerId
    ? visibleLayers.findIndex((layer) => layer.id === draggedLayerId)
    : -1;

  const resetDragState = () => {
    setDraggedLayerId(null);
    setDropTargetLayerId(null);
    setDropTargetGroupId(null);
  };

  const handleLayerDragStart = (event: ReactDragEvent<HTMLElement>, layerId: string) => {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", layerId);
    if (!selectedLayerIds.has(layerId)) {
      selectOnlyLayer(layerId);
    }
    setDraggedLayerId(layerId);
  };

  const handleLayerDragOver = (event: ReactDragEvent<HTMLDivElement>, layerId: string) => {
    if (!draggedLayerId || draggedLayerId === layerId) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropTargetLayerId(layerId);
    setDropTargetGroupId(null);
  };

  const handleLayerDrop = (
    event: ReactDragEvent<HTMLDivElement>,
    layerId: string,
    displayIndex: number,
  ) => {
    if (!draggedLayerId || draggedLayerId === layerId) {
      resetDragState();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const dragged = layers.find((l) => l.id === draggedLayerId);
    const target = layers.find((l) => l.id === layerId);
    const draggedGroupId = dragged?.groupId ?? null;
    const targetGroupId = target?.groupId ?? null;
    if (draggedGroupId === targetGroupId) {
      const moveIds = selectedMoveIds(draggedLayerId);
      if (moveIds.length > 1) {
        moveLayersRelative(
          moveIds,
          layerId,
          draggedDisplayIndex > displayIndex ? "above" : "below",
        );
      } else {
        // Same group (or both top-level): a plain reorder keeps contiguity.
        moveLayer(draggedLayerId, layers.length - 1 - displayIndex);
      }
    } else {
      // Crossing a group boundary: adopt the target's group and land next to it.
      moveLayersToGroup(selectedMoveIds(draggedLayerId), targetGroupId, layerId);
    }
    resetDragState();
  };

  const handleGroupHeaderDragOver = (event: ReactDragEvent<HTMLDivElement>, groupId: string) => {
    if (!draggedLayerId) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropTargetGroupId(groupId);
    setDropTargetLayerId(null);
  };

  const handleGroupHeaderDrop = (event: ReactDragEvent<HTMLDivElement>, groupId: string) => {
    if (!draggedLayerId) {
      resetDragState();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    moveLayersToGroup(selectedMoveIds(draggedLayerId), groupId);
    resetDragState();
  };

  return {
    draggedLayerId,
    draggedDisplayIndex,
    dropTargetLayerId,
    dropTargetGroupId,
    resetDragState,
    handleLayerDragStart,
    handleLayerDragOver,
    handleLayerDrop,
    handleGroupHeaderDragOver,
    handleGroupHeaderDrop,
  };
}
