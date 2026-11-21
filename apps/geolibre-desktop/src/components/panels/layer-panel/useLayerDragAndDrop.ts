import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { useAppStore } from "@geolibre/core";
import type { GeoLibreLayer } from "@geolibre/core";
import { evaluateLayerDragActivation, LAYER_TOUCH_DRAG_HOLD_MS } from "../../../lib/touch-menu-nav";

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

interface DragGesture {
  pointerId: number;
  pointerType: string;
  targetEl: HTMLElement;
  layerId: string;
  x: number;
  y: number;
  startTime: number;
  holdTimer: ReturnType<typeof setTimeout> | null;
  active: boolean;
}

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
  const gesture = useRef<DragGesture | null>(null);

  const draggedDisplayIndex = draggedLayerId
    ? visibleLayers.findIndex((layer) => layer.id === draggedLayerId)
    : -1;

  const clearHoldTimer = () => {
    if (gesture.current?.holdTimer) {
      clearTimeout(gesture.current.holdTimer);
      gesture.current.holdTimer = null;
    }
  };

  const resetDragState = () => {
    clearHoldTimer();
    gesture.current = null;
    setDraggedLayerId(null);
    setDropTarget(null);
  };

  useEffect(() => () => clearHoldTimer(), []);

  const targetAtPointer = (event: ReactPointerEvent<HTMLElement>): DropTarget | null => {
    const list = event.currentTarget.closest("[data-layer-list]");
    const hit = event.currentTarget.ownerDocument.elementFromPoint(event.clientX, event.clientY);
    if (!hit || !list?.contains(hit)) return null;
    const row = hit.closest<HTMLElement>("[data-layer-id]");
    if (row?.dataset.layerId) return { kind: "layer", id: row.dataset.layerId };
    const group = hit.closest<HTMLElement>("[data-group-id]");
    return group?.dataset.groupId ? { kind: "group", id: group.dataset.groupId } : null;
  };

  const activateGesture = (current: DragGesture) => {
    if (current.active) return;
    current.active = true;
    clearHoldTimer();
    if (!current.targetEl.hasPointerCapture(current.pointerId)) {
      try {
        current.targetEl.setPointerCapture(current.pointerId);
      } catch {
        // Pointer may have already ended before the hold timer fired.
      }
    }
    setDraggedLayerId(current.layerId);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>, layerId: string) => {
    if (!event.isPrimary || event.button !== 0 || gesture.current) return;
    const isTouch = event.pointerType === "touch";
    if (!isTouch) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    event.stopPropagation();
    if (!selectedLayerIds.has(layerId)) selectOnlyLayer(layerId);
    const entry: DragGesture = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      targetEl: event.currentTarget,
      layerId,
      x: event.clientX,
      y: event.clientY,
      startTime: Date.now(),
      holdTimer: null,
      active: false,
    };
    if (isTouch) {
      entry.holdTimer = setTimeout(() => {
        if (gesture.current === entry) {
          activateGesture(entry);
        }
      }, LAYER_TOUCH_DRAG_HOLD_MS);
    }
    gesture.current = entry;
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (!current.active) {
      const distancePx = Math.hypot(event.clientX - current.x, event.clientY - current.y);
      const decision = evaluateLayerDragActivation({
        pointerType: current.pointerType,
        distancePx,
        elapsedMs: Date.now() - current.startTime,
      });
      if (decision === "cancel") {
        resetDragState();
        return;
      }
      if (decision === "pending") return;
      activateGesture(current);
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
