import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { useEffect, useState } from "react";

/**
 * The layer shown in the floating Extract Subset panel, cleared when it is removed.
 *
 * @returns The layer (or null when the panel is closed) and its setter.
 */
export function useRasterSubsetLayer() {
  // The COG/WMS/XYZ layer whose bounding-box subset is being extracted in the
  // floating Extract Subset panel, or null when that panel is closed.
  const [rasterSubsetLayer, setRasterSubsetLayer] = useState<GeoLibreLayer | null>(null);
  // Whether that layer still exists in the store; subscribe to the derived
  // boolean (not the whole layers array) so this large component only re-renders
  // when it flips. Close the panel if its layer is removed, matching how
  // LayerPanel clears its own per-layer dialog state.
  const rasterSubsetLayerExists = useAppStore((s) =>
    rasterSubsetLayer ? s.layers.some((layer) => layer.id === rasterSubsetLayer.id) : true,
  );
  useEffect(() => {
    if (rasterSubsetLayer && !rasterSubsetLayerExists) {
      setRasterSubsetLayer(null);
    }
  }, [rasterSubsetLayer, rasterSubsetLayerExists]);
  return [rasterSubsetLayer, setRasterSubsetLayer] as const;
}
