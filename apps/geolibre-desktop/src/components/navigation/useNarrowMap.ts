import type * as maplibregl from "maplibre-gl";
import { useEffect, useState } from "react";
import { NARROW_MAP_WIDTH } from "../../lib/navigation/session";

/**
 * Whether the map is phone-sized, following the container as it resizes
 * (a rotated phone, a side panel opening).
 *
 * @param getMap - Reads the live MapLibre map.
 * @param mapReadyGeneration - Bumped when the map is replaced.
 * @returns True below {@link NARROW_MAP_WIDTH}.
 */
export function useNarrowMap(
  getMap: () => maplibregl.Map | null,
  mapReadyGeneration: number,
): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const container = getMap()?.getContainer();
    if (!container) return;
    const update = () => setNarrow(container.clientWidth < NARROW_MAP_WIDTH);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [getMap, mapReadyGeneration]);
  return narrow;
}
