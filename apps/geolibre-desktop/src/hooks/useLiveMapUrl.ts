import { useEffect } from "react";
import { useAppStore } from "@geolibre/core";
import { isTauri } from "../lib/is-tauri";
import { setMapViewUrl } from "../lib/live-url";

/** Subscribe without rendering the shell on camera movement. Do not write the
 * default view on mount, before startup links/projects have restored theirs. */
export function useLiveMapUrl(): void {
  useEffect(() => {
    if (isTauri()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      setMapViewUrl(useAppStore.getState().mapView);
    };
    window.addEventListener("pagehide", flush);
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      const view = state.mapView;
      const old = previous.mapView;
      if (
        view.center[0] === old.center[0] &&
        view.center[1] === old.center[1] &&
        view.zoom === old.zoom
      )
        return;
      clearTimeout(timer);
      timer = setTimeout(flush, 300);
    });
    return () => {
      unsubscribe();
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);
}
