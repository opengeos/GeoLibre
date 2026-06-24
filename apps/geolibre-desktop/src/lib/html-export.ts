// Standalone "Export as interactive HTML" builder.
//
// This is the in-app counterpart of the Python widget's `Map.to_html()`
// (`python/src/geolibre/geolibre.py`): it produces a single, self-contained
// HTML page that frames the hosted GeoLibre app and replays the current
// `.geolibre.json` project into it over the same `postMessage` bridge the
// embed/Jupyter host speaks (`geolibre:ready` -> `geolibre:load-project`, see
// `useEmbedBridge`/`embedHost`). The page needs no Python kernel and no
// share.geolibre.app upload; it loads the app over the network and renders the
// project interactively (pan/zoom, layer toggles) once opened.

import type { GeoLibreProject } from "@geolibre/core";

// Hosted GeoLibre viewer used as the default embed target, matching the Python
// widget's `_DEFAULT_HTML_APP_URL`. A hosted URL keeps the exported file small
// and portable (it loads the app over the network rather than inlining a build).
export const DEFAULT_VIEWER_BASE_URL = "https://viewer.geolibre.app/";

// A CSS length/percentage value (e.g. "100%", "800px", "calc(100% / 2)"). The
// allowed set deliberately excludes the structural CSS characters ("{};:") so a
// width/height cannot close the <style> rule and inject CSS; "/" is allowed so
// `calc()` divisions pass, since it cannot close a rule on its own.
const CSS_DIMENSION_RE = /^[\w%.+\-/\s()]+$/;

/**
 * Resolve the hosted-viewer base URL from the Vite env, falling back to the
 * production default. Only HTTPS (or HTTP on loopback for local dev) is
 * accepted, and the hostname is matched exactly so a value like
 * `http://localhost.evil.com` cannot slip through. Mirrors
 * {@link resolveShareBaseUrl} in `share-geolibre.ts`.
 *
 * @param configured - The raw env value; read from `VITE_GEOLIBRE_VIEWER_URL`
 *   by default but injectable for tests.
 * @returns A trusted viewer base URL.
 */
export function resolveViewerBaseUrl(
  configured: unknown = import.meta.env?.VITE_GEOLIBRE_VIEWER_URL,
): string {
  if (typeof configured === "string" && configured.trim()) {
    const trimmed = configured.trim();
    try {
      const url = new URL(trimmed);
      if (
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          (url.hostname === "localhost" || url.hostname === "127.0.0.1"))
      ) {
        return trimmed;
      }
    } catch {
      // Invalid URL; fall through to the production default.
    }
  }
  return DEFAULT_VIEWER_BASE_URL;
}

/** Escape a string for safe interpolation into HTML text/attribute context. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Append `embed=1` to the viewer URL's query string, before any `#fragment`.
 *
 * A trailing `#...` fragment would otherwise swallow a `?embed=1` suffix
 * (browsers read it as part of the fragment), so the flag is inserted into the
 * query and the fragment is reattached. Mirrors the Python export's fragment
 * handling.
 */
function withEmbedFlag(baseUrl: string): string {
  const hashIndex = baseUrl.indexOf("#");
  const base = hashIndex === -1 ? baseUrl : baseUrl.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : baseUrl.slice(hashIndex);
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}embed=1${fragment}`;
}

export interface BuildProjectHtmlOptions {
  /** The serializable project to inline and replay into the embedded app. */
  project: GeoLibreProject;
  /** The exported page's `<title>`. */
  title: string;
  /** Base URL of the GeoLibre app to embed (defaults to the hosted viewer). */
  appUrl?: string;
  /** CSS width of the embedded map (default `"100%"`). */
  width?: string;
  /** CSS height of the embedded map (default `"100vh"`). */
  height?: string;
}

/**
 * Build a standalone interactive HTML page for a GeoLibre project.
 *
 * The page embeds the GeoLibre app in an `<iframe>` (with `?embed=1` to force
 * the bridge on) and posts the inlined project to it once the app announces
 * `geolibre:ready`, exactly mirroring the Python widget's `to_html()` so the two
 * exports stay byte-compatible in approach.
 *
 * @param options - See {@link BuildProjectHtmlOptions}.
 * @returns The complete HTML document as a string.
 * @throws If `width` or `height` is not a safe CSS dimension.
 */
export function buildProjectHtml(options: BuildProjectHtmlOptions): string {
  const { project, title } = options;
  const appUrl = options.appUrl ?? DEFAULT_VIEWER_BASE_URL;
  const width = options.width ?? "100%";
  const height = options.height ?? "100vh";
  // width/height land inside a <style> rule; escapeHtml does not neutralise CSS
  // metacharacters like "}" or ";", so validate them as plain CSS dimensions to
  // keep a stray value from closing the rule and injecting CSS.
  if (!CSS_DIMENSION_RE.test(width)) {
    throw new Error(`Invalid CSS width value: ${width}`);
  }
  if (!CSS_DIMENSION_RE.test(height)) {
    throw new Error(`Invalid CSS height value: ${height}`);
  }
  const iframeSrc = withEmbedFlag(appUrl);
  // Inline the project inside a JSON <script> block and escape "<" so a property
  // value can never break out of the script element; "<" is valid JSON that
  // JSON.parse restores to "<".
  const projectJson = JSON.stringify(project).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; }
  #geolibre-frame { border: 0; display: block; width: ${escapeHtml(width)}; height: ${escapeHtml(height)}; }
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
  var loaded = false;
  function load() {
    if (loaded || !frame.contentWindow) return;
    loaded = true;
    // Scope the post to the iframe's own origin (not "*") so the project is
    // only ever delivered to the viewer it was meant for, even if the frame
    // navigated elsewhere before this ran.
    frame.contentWindow.postMessage(
      { type: "geolibre:load-project", project: project, seq: 1 },
      new URL(frame.src).origin
    );
  }
  // The app posts "geolibre:ready" once mounted; reply with the project. Guard
  // on the frame as the source so an unrelated message cannot trigger the load.
  window.addEventListener("message", function (event) {
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
