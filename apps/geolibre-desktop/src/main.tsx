import "./lib/symbol-dispose-polyfill";
import React from "react";
import ReactDOM from "react-dom/client";
import "@geoman-io/maplibre-geoman-free/dist/maplibre-geoman.css";
import "@maplibre/maplibre-gl-directions/dist/style.css";
import "maplibre-gl-3d-tiles/style.css";
import "maplibre-gl-basemap-control/style.css";
import "maplibre-gl-components/style.css";
import "maplibre-gl-duckdb/style.css";
import "maplibre-gl-enviroatlas/style.css";
import "maplibre-gl-esri-wayback/style.css";
import "maplibre-gl-earth-engine/style.css";
import "maplibre-gl-fema-wms/style.css";
import "maplibre-gl-geo-editor/style.css";
import "maplibre-gl-geoagent/style.css";
import "maplibre-gl-nasa-earthdata/style.css";
import "maplibre-gl-national-map/style.css";
import "maplibre-gl-overture-maps/style.css";
import "maplibre-gl-planetary-computer/style.css";
import "maplibre-gl-raster/style.css";
import "maplibre-gl-streetview/style.css";
import "maplibre-gl-swipe/style.css";
import "maplibre-gl-time-slider/style.css";
import "maplibre-gl-vector/style.css";
import "mapillary-js/dist/mapillary.css";
import "./index.css";
import "./lib/basemap-style";
import "./lib/geoagent-style";
import "./lib/lidar-style";
import "./lib/swipe-style";
import { registerSW } from "virtual:pwa-register";
import { I18nextProvider } from "react-i18next";
// Initializes i18next (resolves the UI language from the `?locale`/`?lang` query
// param, stored settings, or the browser) before React renders, so the first
// paint is already in the right language.
import i18n from "./i18n";
import { installDiagnosticsCapture } from "./lib/diagnostics";
import { installStaleChunkReload } from "./lib/stale-chunk-reload";

installDiagnosticsCapture();
// Recover from chunks orphaned by a web redeploy (stale lazy import → 404). A
// no-op in the desktop build, whose chunks are bundled locally.
installStaleChunkReload();
// Register the offline/PWA service worker (web build only). `registerSW` is a
// no-op stub in the Tauri desktop and embedded Jupyter builds, where the plugin
// is disabled (see vite.config.ts pwaPlugin).
//
// `autoUpdate` would, by default, force a full `window.location.reload()` the
// moment a new service worker activates (workbox's `activated` event, when
// `isUpdate || isExternal`). On the GitHub Pages demo — built with a relative
// base and served from the `/demo/` subpath — that reload fires spuriously a few
// seconds after load: a returning visitor fetches a freshly-built `sw.js`, and
// workbox's external-worker heuristics (URL/scope resolution under the relative
// base, the time-based fallback, a second `updatefound`) flag the activation as
// an update, reloading the page and discarding in-progress map state. Right
// after a deploy, when edge nodes briefly serve inconsistent assets, this can
// repeat, so the page looks like it "refreshes itself."
//
// `onNeedReload` takes over that reload flow: the new worker still activates and
// claims the page (skipWaiting + clientsClaim), so its fresh precache serves
// every subsequent request, but we do NOT force a reload. Page recovery is
// delegated to installStaleChunkReload above, which reloads on-demand when a
// stale lazy chunk 404s (cooldown-guarded; if sessionStorage is blocked it
// skips the reload and lets the preload error surface instead). That keeps
// the user's session/map state intact and removes the self-refresh loop.
registerSW({
  immediate: true,
  onNeedReload() {
    // Intentionally a no-op: the updated SW is already in control, so let the
    // refreshed shell load on the user's next page load rather than yanking the
    // page out from under them. See installStaleChunkReload for the on-demand
    // recovery path when a now-deleted lazy chunk is actually requested.
  },
  onRegisterError(error) {
    // Registration can fail in production (non-secure origin, scope conflict).
    // The app still works without the SW, so surface it rather than fail.
    console.error("[GeoLibre] Service worker registration failed", error);
  },
});

// Fetch both chunks in parallel rather than waterfalling the boundary import
// after App resolves — a free win, and it matters over the network in the web
// build where these are separate fetches.
void Promise.all([import("./App"), import("./components/common/error-boundaries")])
  .then(([{ default: App }, { AppErrorBoundary }]) => {
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <I18nextProvider i18n={i18n}>
          <AppErrorBoundary>
            <App />
          </AppErrorBoundary>
        </I18nextProvider>
      </React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    console.error("Failed to start GeoLibre", error);
  });
