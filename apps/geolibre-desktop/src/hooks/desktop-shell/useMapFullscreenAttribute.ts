import { useEffect, type RefObject } from "react";

/**
 * Mirrors the map's fullscreen state onto the shell as `data-map-fullscreen`.
 *
 * @param shellRef - The shell's root element.
 */
export function useMapFullscreenAttribute(shellRef: RefObject<HTMLDivElement | null>): void {
  // The map's Fullscreen control maximizes the map *canvas* (it calls
  // requestFullscreen on the map container). Chromium promotes that element to
  // the browser top layer, so the toolbar and side panels are hidden for free.
  // WebKit (the Tauri desktop webview) does not: it grows the map container to
  // fill the window but leaves the surrounding chrome painted around and on top
  // of it (opengeos/GeoLibre#611). Mirror the fullscreen state onto the shell as
  // `data-map-fullscreen` so CSS can hide that chrome on every engine, leaving a
  // clean map-only view. document.fullscreenElement is set even on WebKit.
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const sync = () => {
      const fsEl =
        document.fullscreenElement ??
        (document as Document & { webkitFullscreenElement?: Element | null })
          .webkitFullscreenElement ??
        null;
      shell.toggleAttribute("data-map-fullscreen", !!fsEl && shell.contains(fsEl));
    };
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    sync();
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, [shellRef]);
}
