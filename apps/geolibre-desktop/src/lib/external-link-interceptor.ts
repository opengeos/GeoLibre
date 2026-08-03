import { attributeLinkUrl } from "@geolibre/core";
import { isTauri } from "./is-tauri";
import { openExternalLink } from "./open-external";

/**
 * Route outbound http(s) anchor clicks to the system browser on the desktop
 * build.
 *
 * The Tauri webview ignores `target="_blank"`, so a plain anchor either does
 * nothing or, worse, navigates the single app webview away from GeoLibre with
 * no way back. Plenty of anchors are rendered outside React and outside this
 * repo — Identify popups, KML `<description>` markup, plugin panels — so
 * catching them one call site at a time is a losing game. One delegated
 * listener covers all of them.
 *
 * Left plain clicks only: a modified click (new tab/window, download) and the
 * middle button already mean "not here", and the webview handles those itself.
 */
export function installExternalLinkInterceptor(
  target: Pick<Document, "addEventListener"> = document,
): void {
  if (!isTauri()) return;
  target.addEventListener(
    "click",
    (event) => {
      const mouseEvent = event as MouseEvent;
      if (mouseEvent.defaultPrevented || mouseEvent.button !== 0) return;
      if (mouseEvent.metaKey || mouseEvent.ctrlKey || mouseEvent.shiftKey || mouseEvent.altKey)
        return;
      const anchor = (mouseEvent.target as Element | null)?.closest?.("a[href]");
      const url = attributeLinkUrl(anchor?.getAttribute("href"));
      if (!url) return;
      // Windows serves the app itself over http://tauri.localhost, so a
      // same-origin link is in-app navigation, not something to hand off.
      if (sameOrigin(url)) return;
      mouseEvent.preventDefault();
      void openExternalLink(url);
    },
    // Bubble, not capture: a component that handles its own link click and
    // calls preventDefault (the attribute table does) still wins.
    false,
  );
}

function sameOrigin(url: string): boolean {
  try {
    return new URL(url).origin === window.location.origin;
  } catch {
    return false;
  }
}
