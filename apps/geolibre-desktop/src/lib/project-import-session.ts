import { useAppStore } from "@geolibre/core";

/**
 * One project import (ArcGIS Pro, QGIS) from the moment it starts until it
 * finishes, and whether another project has replaced the one it is building.
 *
 * An import reads its file, loads the converted project, and then keeps
 * adding layers (rasters, services) for a while. If the user opens another
 * project at any point, the import is superseded: it must not load over that
 * project, add layers to it, mark it changed or record undo steps in it.
 *
 * Replacement is judged by the store's `projectLoadCount`, which only
 * `loadProject` and `newProject` change. `projectGeneration` is not used: a
 * collaboration snapshot bumps it while refreshing the open project in place,
 * and the layers that snapshot keeps (an imported raster included) still
 * belong to this import.
 */
export interface ProjectImportSession {
  /**
   * Aborted, synchronously, as soon as another project replaces the open one.
   * Pass it to slow loaders (`addRasterToMap`, `addArcGISLayer`) so they check
   * it right before they add anything to the map or the store.
   */
  readonly signal: AbortSignal;
  /** Whether another project has replaced the one this import is building. */
  superseded(): boolean;
  /**
   * Load this import's own project (`load` calls `loadProject`), so that
   * replacement is not counted against the import. Does nothing and returns
   * false when the import has already been superseded.
   */
  replaceProject(load: () => void): boolean;
  /** Stop watching the store. Call once the import finishes; safe to repeat. */
  dispose(): void;
}

/**
 * Start watching for replacement. Call it before the project file is read, so
 * a project opened while the file is still loading supersedes the import too.
 *
 * @returns The session; dispose of it when the import ends.
 */
export function startProjectImportSession(): ProjectImportSession {
  const controller = new AbortController();
  let owned = useAppStore.getState().projectLoadCount;
  let loading = false;
  const unsubscribe = useAppStore.subscribe((state) => {
    if (loading || controller.signal.aborted || state.projectLoadCount === owned) return;
    controller.abort(new DOMException("Another project replaced the import.", "AbortError"));
    unsubscribe();
  });
  const superseded = () =>
    controller.signal.aborted || useAppStore.getState().projectLoadCount !== owned;
  return {
    signal: controller.signal,
    superseded,
    replaceProject(load) {
      if (superseded()) return false;
      loading = true;
      try {
        load();
      } finally {
        loading = false;
        owned = useAppStore.getState().projectLoadCount;
      }
      return true;
    },
    dispose: unsubscribe,
  };
}
