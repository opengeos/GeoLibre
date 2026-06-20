import { useEffect, useMemo } from "react";
import { useAppStore } from "@geolibre/core";
import { setRasterPixelInspect } from "@geolibre/plugins";

/**
 * Bridges the store's `identifyLayerId` to the raster control's pixel inspector.
 *
 * When the active identify target is a COG layer, the Layers-panel Identify icon
 * reads its source pixel/band values on map click — the same behavior as the
 * raster panel's Inspect button. Vector/WMS/DuckDB identify is handled in
 * MapCanvas; this hook drives only the raster path, and MapCanvas bails for
 * raster/COG layers, so the two never both register a map-click handler.
 *
 * Mounted once at the app shell so it stays active regardless of which panels
 * are open.
 */
export function useRasterIdentify(): void {
  const identifyLayerId = useAppStore((s) => s.identifyLayerId);
  const layers = useAppStore((s) => s.layers);

  const activeCogId = useMemo(() => {
    if (!identifyLayerId) return null;
    const layer = layers.find((item) => item.id === identifyLayerId);
    return layer?.type === "cog" ? layer.id : null;
  }, [identifyLayerId, layers]);

  useEffect(() => {
    if (!activeCogId) return;
    setRasterPixelInspect(activeCogId, true);
    return () => setRasterPixelInspect(activeCogId, false);
  }, [activeCogId]);
}
