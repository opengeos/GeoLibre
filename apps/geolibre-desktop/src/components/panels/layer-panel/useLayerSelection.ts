import { type MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from "react";
import type { GeoLibreLayer } from "@geolibre/core";

interface UseLayerSelectionOptions {
  /** The project's layers, in store order. */
  layers: GeoLibreLayer[];
  /** The layers in panel (top-to-bottom) order. */
  visibleLayers: GeoLibreLayer[];
  /** The store's active layer. */
  selectedLayerId: string | null;
  selectLayer: (layerId: string | null) => void;
}

/**
 * The panel's multi-selection of layer rows (click, Shift range, Ctrl/Cmd
 * toggle), kept in step with the store's single active layer.
 *
 * @param options - The layers and the store's active-layer state.
 * @returns The selected ids, the range anchor, and the selection handlers.
 */
export function useLayerSelection({
  layers,
  visibleLayers,
  selectedLayerId,
  selectLayer,
}: UseLayerSelectionOptions) {
  const [selectedLayerIds, setSelectedLayerIds] = useState<Set<string>>(
    () => new Set(selectedLayerId ? [selectedLayerId] : []),
  );
  const selectionAnchorRef = useRef<string | null>(selectedLayerId);
  useEffect(() => {
    const existingIds = new Set(layers.map((layer) => layer.id));
    setSelectedLayerIds((current) => {
      const next = new Set([...current].filter((id) => existingIds.has(id)));
      if (next.size === current.size) return current;
      return next;
    });
    if (selectionAnchorRef.current && !existingIds.has(selectionAnchorRef.current)) {
      selectionAnchorRef.current = null;
    }
  }, [layers]);
  useEffect(() => {
    if (!selectedLayerId) return;
    setSelectedLayerIds((current) =>
      current.has(selectedLayerId) ? current : new Set([selectedLayerId]),
    );
    selectionAnchorRef.current = selectedLayerId;
  }, [selectedLayerId]);

  const selectedMoveIds = (layerId: string) =>
    selectedLayerIds.has(layerId) && selectedLayerIds.size > 1
      ? layers.filter((layer) => selectedLayerIds.has(layer.id)).map((layer) => layer.id)
      : [layerId];

  const handleLayerSelection = (event: ReactMouseEvent<HTMLDivElement>, layerId: string) => {
    if (event.shiftKey && selectionAnchorRef.current) {
      const anchorIndex = visibleLayers.findIndex(
        (layer) => layer.id === selectionAnchorRef.current,
      );
      const layerIndex = visibleLayers.findIndex((layer) => layer.id === layerId);
      if (anchorIndex >= 0 && layerIndex >= 0) {
        const start = Math.min(anchorIndex, layerIndex);
        const end = Math.max(anchorIndex, layerIndex);
        setSelectedLayerIds(new Set(visibleLayers.slice(start, end + 1).map((layer) => layer.id)));
      }
    } else if (event.ctrlKey || event.metaKey) {
      const next = new Set(selectedLayerIds);
      if (next.has(layerId) && next.size > 1) next.delete(layerId);
      else next.add(layerId);
      setSelectedLayerIds(next);
      selectionAnchorRef.current = layerId;
      selectLayer(next.has(layerId) ? layerId : [...next][0]);
      return;
    } else {
      setSelectedLayerIds(new Set([layerId]));
      selectionAnchorRef.current = layerId;
    }
    selectLayer(layerId);
  };

  // Make one layer the whole selection and the range anchor.
  const selectOnlyLayer = (layerId: string) => {
    setSelectedLayerIds(new Set([layerId]));
    selectionAnchorRef.current = layerId;
    selectLayer(layerId);
  };

  return {
    selectedLayerIds,
    selectedMoveIds,
    handleLayerSelection,
    selectOnlyLayer,
  };
}
