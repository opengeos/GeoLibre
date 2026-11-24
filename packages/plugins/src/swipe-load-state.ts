type ReadLoadState = typeof import("./plugins/maplibre-swipe").getSwipeRasterLoadState;
let read: ReadLoadState = () => null;

/** A provider imported through either the catalog or SDK publishes its probe. */
export function provideSwipeLoadState(probe: ReadLoadState): void {
  read = probe;
}

/** An unloaded swipe has no private raster mirror for the inspector to probe. */
export const getSwipeRasterLoadState: ReadLoadState = (layerId) => read(layerId);
