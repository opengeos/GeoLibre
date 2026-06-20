import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "./tauri-io";

// Open a link in the system browser. The Tauri webview ignores
// target="_blank"/window.open, so route through the opener plugin there and
// fall back to window.open on the web build.
export async function openExternalLink(url: string): Promise<void> {
  // Only ever hand http(s) URLs to the opener so a call site can't open
  // arbitrary schemes (javascript:, file:, ...) in the system browser.
  try {
    const { protocol } = new URL(url);
    if (protocol !== "https:" && protocol !== "http:") return;
  } catch {
    return;
  }
  if (isTauri()) {
    // openUrl is async and can reject (e.g. the OS has no registered browser).
    // Call sites fire-and-forget with `void`, so log here rather than let the
    // rejection surface as an unhandled promise.
    try {
      await openUrl(url);
    } catch (error) {
      console.warn("[GeoLibre] failed to open external link", url, error);
    }
    return;
  }
  // window.open from this click (a user gesture) is normally allowed, but a
  // strict popup blocker can still return null; log it so the dead click is
  // debuggable rather than silent.
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) {
    console.warn("[GeoLibre] failed to open external link (popup blocked?)", url);
  }
}
