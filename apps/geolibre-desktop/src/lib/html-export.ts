// Standalone "Export as interactive HTML" builder; the in-app counterpart of the
// Python widget's `Map.to_html()`. See `docs/python.md` and `embedHost.ts`.

import type { GeoLibreProject } from "@geolibre/core";

// Hosted viewer used as the default embed target (matches Python's default).
export const DEFAULT_VIEWER_BASE_URL = "https://web.geolibre.app/";

// Excludes the structural CSS chars ("{};:") so a width/height can't close the
// <style> rule and inject CSS; "/" is allowed so calc() divisions pass (extends
// the Python _CSS_DIMENSION_RE, which does not allow "/").
const CSS_DIMENSION_RE = /^[\w%.+\-/\s()]+$/;

// Resolve the viewer URL from the env, accepting only HTTPS (or loopback HTTP)
// and matching the hostname exactly; mirrors resolveShareBaseUrl.
export function resolveViewerBaseUrl(
  configured: unknown = import.meta.env?.VITE_GEOLIBRE_VIEWER_URL,
): string {
  if (typeof configured === "string" && configured.trim()) {
    const trimmed = configured.trim();
    try {
      const url = new URL(trimmed);
      if (
        url.protocol === "https:" ||
        (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"))
      ) {
        return trimmed;
      }
    } catch {
      // Invalid URL; fall through to the production default.
    }
  }
  return DEFAULT_VIEWER_BASE_URL;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Append a flag to the query only when it is not already present, preserving an
// existing query (joins with "&") or starting one (joins with "?").
function appendFlag(base: string, flag: string, present: RegExp): string {
  if (present.test(base)) return base;
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}${flag}`;
}

// Insert the viewer query flags before any "#fragment" (a fragment would
// otherwise swallow a trailing "?..."); mirrors the Python export. `embed=1`
// puts the framed app in embed mode so it accepts the posted project, and
// `welcome=0` skips the first-launch experience-level wizard so the recipient
// lands straight on the map (issue #991). `welcome=0` is what the currently
// deployed viewer honors, so the export works without waiting for the
// embed-mode onboarding suppression to ship.
function withViewerFlags(baseUrl: string): string {
  const hashIndex = baseUrl.indexOf("#");
  let base = hashIndex === -1 ? baseUrl : baseUrl.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : baseUrl.slice(hashIndex);
  base = appendFlag(base, "embed=1", /[?&]embed=(1|true)(&|$)/);
  base = appendFlag(base, "welcome=0", /[?&]welcome=(0|false|off|no)(&|$)/);
  return `${base}${fragment}`;
}

export interface BuildProjectHtmlOptions {
  /** The serializable project to inline and replay into the embedded app. */
  project: GeoLibreProject;
  /** The exported page's `<title>`. */
  title: string;
  /** Base URL of the GeoLibre app to embed; validated and defaulted to the
   * env/hosted viewer via resolveViewerBaseUrl. */
  appUrl?: string;
  /** CSS width of the embedded map (default `"100%"`). */
  width?: string;
  /** CSS height of the embedded map (default `"100vh"`). */
  height?: string;
}

// Build a self-contained HTML page that frames the viewer (with ?embed=1) and
// posts the inlined project to it on "geolibre:ready"; throws on an unsafe
// width/height. Mirrors the Python widget's to_html().
export function buildProjectHtml(options: BuildProjectHtmlOptions): string {
  const { project, title } = options;
  // Resolve (and validate) here so an unsafe appUrl - e.g. a "javascript:" URI -
  // can never reach the iframe src; falls back to the env/default viewer.
  const appUrl = resolveViewerBaseUrl(options.appUrl);
  const width = options.width ?? "100%";
  const height = options.height ?? "100vh";
  // The regex below is the guard that keeps width/height from closing the
  // <style> rule; HTML-escaping them would be a no-op (the regex rejects & < > " ').
  if (!CSS_DIMENSION_RE.test(width)) {
    throw new Error(`Invalid CSS width value: ${width}`);
  }
  if (!CSS_DIMENSION_RE.test(height)) {
    throw new Error(`Invalid CSS height value: ${height}`);
  }
  const iframeSrc = withViewerFlags(appUrl);
  // Escape "<" so a property value can't break out of the JSON <script> block.
  const projectJson = JSON.stringify(project).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; }
  #geolibre-frame { border: 0; display: block; width: ${width}; height: ${height}; }
</style>
</head>
<body>
<iframe id="geolibre-frame" src="${escapeHtml(iframeSrc)}" allow="fullscreen" allowfullscreen></iframe>
<script type="application/json" id="geolibre-project">${projectJson}</script>
<script>
(function () {
  var frame = document.getElementById("geolibre-frame");
  var project = JSON.parse(
    document.getElementById("geolibre-project").textContent
  );
  // The src attribute is fixed, so this pins to the viewer origin: both the
  // inbound "ready" check and the outbound post are scoped to it.
  var viewerOrigin = new URL(frame.src).origin;
  var loaded = false;
  function load() {
    if (loaded || !frame.contentWindow) return;
    loaded = true;
    frame.contentWindow.postMessage(
      { type: "geolibre:load-project", project: project, seq: 1 },
      viewerOrigin
    );
  }
  window.addEventListener("message", function (event) {
    if (event.origin !== viewerOrigin) return;
    if (event.source !== frame.contentWindow) return;
    var data = event.data;
    if (data && data.type === "geolibre:ready") load();
  });
})();
</script>
</body>
</html>
`;
}
