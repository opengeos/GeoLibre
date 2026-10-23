import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";
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

type DropTarget = { kind: "layer" | "group"; id: string };

/**
 * Pointer-captured layer dragging keeps reordering inside the webview. HTML
 * drag-and-drop starts a native drag on macOS, where Tauri's file-drop handler
 * intercepts it. Keep that handler enabled for actual files from Finder.
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
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const gesture = useRef<{
    pointerId: number;
    layerId: string;
    x: number;
    y: number;
    active: boolean;
  } | null>(null);

  const draggedDisplayIndex = draggedLayerId
    ? visibleLayers.findIndex((layer) => layer.id === draggedLayerId)
    : -1;

  const resetDragState = () => {
    gesture.current = null;
    setDraggedLayerId(null);
    setDropTarget(null);
  };

  const targetAtPointer = (event: ReactPointerEvent<HTMLElement>): DropTarget | null => {
    const list = event.currentTarget.closest("[data-layer-list]");
    const hit = event.currentTarget.ownerDocument.elementFromPoint(event.clientX, event.clientY);
    if (!hit || !list?.contains(hit)) return null;
    const row = hit.closest<HTMLElement>("[data-layer-id]");
    if (row?.dataset.layerId) return { kind: "layer", id: row.dataset.layerId };
    const group = hit.closest<HTMLElement>("[data-group-id]");
    return group?.dataset.groupId ? { kind: "group", id: group.dataset.groupId } : null;
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>, layerId: string) => {
    if (!event.isPrimary || event.button !== 0 || gesture.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (!selectedLayerIds.has(layerId)) selectOnlyLayer(layerId);
    gesture.current = {
      pointerId: event.pointerId,
      layerId,
      x: event.clientX,
      y: event.clientY,
      active: false,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (!current.active) {
      if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < 4) return;
      current.active = true;
      setDraggedLayerId(current.layerId);
    }
    event.preventDefault();
    const target = targetAtPointer(event);
    setDropTarget(target?.kind === "layer" && target.id === current.layerId ? null : target);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const target = current.active ? targetAtPointer(event) : null;
    if (target?.kind === "group") {
      moveLayersToGroup(selectedMoveIds(current.layerId), target.id);
    } else if (target && target.id !== current.layerId) {
      const dragged = layers.find((layer) => layer.id === current.layerId);
      const destination = layers.find((layer) => layer.id === target.id);
      const displayIndex = visibleLayers.findIndex((layer) => layer.id === target.id);
      if (dragged && destination && displayIndex >= 0) {
        const targetGroupId = destination.groupId ?? null;
        const moveIds = selectedMoveIds(current.layerId);
        if ((dragged.groupId ?? null) !== targetGroupId) {
          moveLayersToGroup(moveIds, targetGroupId, target.id);
        } else if (moveIds.length > 1) {
          const sourceIndex = visibleLayers.findIndex((layer) => layer.id === current.layerId);
          moveLayersRelative(moveIds, target.id, sourceIndex > displayIndex ? "above" : "below");
        } else {
          moveLayer(current.layerId, layers.length - 1 - displayIndex);
        }
      }
    }
    resetDragState();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return {
    draggedLayerId,
    draggedDisplayIndex,
    dropTargetLayerId: dropTarget?.kind === "layer" ? dropTarget.id : null,
    dropTargetGroupId: dropTarget?.kind === "group" ? dropTarget.id : null,
    resetDragState,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
  };
}
