import "./lib/symbol-dispose-polyfill";
// Must precede any Map construction (see the module docs).
import "./lib/maplibre-worker";
import React from "react";
import ReactDOM from "react-dom/client";
/* App typeface — see the --font-sans/--font-mono note in index.css.
   These must be imported from JS, not via `@import` in index.css: Tailwind v4
   resolves CSS @imports itself and inlines them before Vite sees them, so the
   relative `url(./files/*.woff2)` in fontsource's CSS is never rewritten into
   an asset reference and no font file is emitted into dist/. The result builds
   clean and 404s at runtime, silently falling back to system fonts. Importing
   from JS routes the CSS through Vite's asset pipeline instead. */
import "@fontsource-variable/ibm-plex-sans/wght.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/700.css";
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
import "maplibre-gl-usgs-lidar/style.css";
import "maplibre-gl-vector/style.css";
import "mapillary-js/dist/mapillary.css";
import "./index.css";
import "./lib/basemap-style";
import "./lib/geoagent-style";
import "./lib/lidar-style";
// Register the MapLibre RTL text plugin so Arabic/Hebrew/Persian basemap labels
// are shaped correctly instead of rendering reversed. Must run before any map is
// created. See https://github.com/hyperknot/openfreemap/issues/118.
import "./lib/rtl-text";
import "./lib/swipe-style";
import { registerSW } from "virtual:pwa-register";
import { TooltipProvider } from "@geolibre/ui";
import { I18nextProvider } from "react-i18next";
import type { ReactNode } from "react";
// Puts a deep link's query back after a sign-in redirect dropped it. This import
// MUST stay above `./i18n` below: it does its work while loading, and `./i18n`
// resolves the UI language from the query string while *it* loads, so a later
// position would restore the parameters after they had already been read. Same
// for the theme, resolved further down this file. A no-op when no sign-in
// redirect is in flight, so every other build just pays for an empty module.
import "./lib/auth-return-url-boot";
// Initializes i18next (resolves the UI language from the `?locale`/`?lang` query
// param, stored settings, or the browser) before React renders, so the first
// paint is already in the right language. English is bundled; other locales are
// lazily imported, so `i18nReady` resolves once the initial locale's catalog has
// loaded and init has run — the render below awaits it.
import i18n, { AVAILABLE_LANGUAGES, i18nReady, setActiveLanguage } from "./i18n";
import { startAnalytics } from "./lib/analytics";
import { installDiagnosticsCapture } from "./lib/diagnostics";
import { isTauri } from "./lib/is-tauri";
import { installStaleChunkReload } from "./lib/stale-chunk-reload";
import { resolveAuthGate, type AuthGateConfig } from "./lib/auth-gate";
import { getInitialThemeMode } from "./hooks/useThemeMode";
import { applyTemporaryDesktopSettings } from "./hooks/useDesktopSettings";
import {
  desktopSettingsUrl,
  fetchDesktopSettings,
  sharedSettingsLanguage,
} from "./lib/desktop-settings-url";

installDiagnosticsCapture();
// In the desktop build, route geocoding (place search / reverse geocode)
// through Tauri's native HTTP client so it bypasses WebView CORS: public
// Nominatim's CDN intermittently omits the CORS header on cached responses,
// which the WebView rejects as "Search failed. Try again." Lazy + desktop-only
// so the web/embedded bundles never import the Tauri HTTP plugin.
if (isTauri()) {
  void import("./lib/geocoding-fetch")
    .then(({ installNativeGeocodingFetch }) => installNativeGeocodingFetch())
    .catch((error: unknown) => {
      // If the install fails, geocoding stays on the browser fetch (the
      // CORS-buggy path this fixes), so surface it rather than let it become a
      // silent unhandled rejection.
      console.error("[GeoLibre] Failed to install native geocoding fetch", error);
    });
  // Likewise route share.geolibre.app (project Share + gallery) through the
  // native HTTP client: the share server's CORS policy allows the web origin but
  // not the Tauri WebView origin, so a browser fetch fails as "Could not reach
  // share.geolibre.app." Lazy + desktop-only so web/embedded never import the
  // Tauri HTTP plugin.
  void import("./lib/share-fetch")
    .then(({ installNativeShareFetch }) => installNativeShareFetch())
    .catch((error: unknown) => {
      // On failure the share client stays on the browser fetch (the CORS-blocked
      // path this fixes); surface it rather than swallow the rejection.
      console.error("[GeoLibre] Failed to install native share fetch", error);
    });
  // GeoLens sends X-Api-Key, which preflights in a WebView. Keep the built-in
  // datasets.geolibre.app connection working even when its CORS origin
  // allowlist does not include the packaged desktop origin.
  void import("./lib/geolens-fetch")
    .then(({ installNativeGeoLensFetch }) => installNativeGeoLensFetch())
    .catch((error: unknown) => {
      console.error("[GeoLibre] Failed to install native GeoLens fetch", error);
    });
}
// Recover from chunks orphaned by a web redeploy (stale lazy import → 404). A
// no-op in the desktop build, whose chunks are bundled locally.
installStaleChunkReload();
// "Web app" here means the *build*, never anything the visitor controls: the
// desktop shell and the Jupyter embed wheel are compiled without the gate, but a
// hosted deployment gates every request. In particular this must NOT consult
// `isEmbedded()` — that returns true for a plain `?embed=1` query parameter, so
// any visitor could disable a configured sign-in wall by typing a URL.
const isHostedWebApp = !isTauri() && !__GEOLIBRE_EMBED_BUILD__;
// Google Analytics, if this deployment was built with a measurement ID (only
// the geolibre.app and web.geolibre.app Pages deploys are, see analytics.ts).
// A no-op in every other build, so nothing is loaded and nothing is sent.
startAnalytics(isHostedWebApp);
// Clerk or Auth0, whichever this deployment configured (neither, normally).
const authGate = resolveAuthGate(isHostedWebApp);
if (authGate) {
  // Apply the initial theme now rather than leaving it to <App />. A gate paints
  // a full-screen signed-out page *before* App mounts, and App is where
  // useThemeMode adds the `dark` class — so without this a dark-mode visitor
  // gets a white sign-in screen that flips to dark only after signing in. This
  // sets exactly what useThemeMode's layout effect will set a moment later
  // (same helper, same `?theme=` handling), so it is a no-op once App mounts.
  const initialTheme = getInitialThemeMode();
  document.documentElement.classList.toggle("dark", initialTheme === "dark");
  document.documentElement.style.colorScheme = initialTheme;
}

/**
 * Load the configured gate's chunk and return a wrapper for the app tree.
 *
 * Each provider lives in its own dynamically imported module, so a deployment
 * downloads only the SDK it actually uses — and an ungated build downloads
 * neither. Returns null when no gate is configured.
 */
function loadAuthGate(
  config: AuthGateConfig | undefined,
): Promise<((children: ReactNode) => ReactNode) | null> {
  if (!config) return Promise.resolve(null);
  if (config.provider === "clerk") {
    return import("./components/auth/ClerkGate").then(({ ClerkGate }) => (children: ReactNode) => (
      <ClerkGate publishableKey={config.publishableKey} waitlist={config.waitlist}>
        {children}
      </ClerkGate>
    ));
  }
  return import("./components/auth/Auth0Gate").then(({ Auth0Gate }) => (children: ReactNode) => (
    <Auth0Gate domain={config.domain} clientId={config.clientId}>
      {children}
    </Auth0Gate>
  ));
}
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

const sharedSettingsUrl = desktopSettingsUrl(window.location.search);
const sharedSettingsReady = sharedSettingsUrl
  ? fetchDesktopSettings(sharedSettingsUrl)
      .then((settings) => {
        applyTemporaryDesktopSettings(settings);
        return settings;
      })
      .catch((error: unknown) => {
        // A shared settings file is optional configuration. Keep the app usable
        // with the visitor's local settings, but make a bad URL visible in the
        // diagnostics capture and developer console.
        console.error("[GeoLibre] Failed to load shared desktop settings", error);
        return null;
      })
  : Promise.resolve(null);

const startupLanguageReady = Promise.all([i18nReady, sharedSettingsReady]).then(
  async ([, settings]) => {
    if (!settings) return;
    const language = sharedSettingsLanguage(
      window.location.search,
      settings.language,
      AVAILABLE_LANGUAGES,
    );
    if (!language) return;
    try {
      await setActiveLanguage(language);
    } catch (error) {
      // Shared language is optional presentation configuration. If its lazy
      // catalog cannot load, retain the language i18next already initialized.
      console.error("[GeoLibre] Failed to apply shared settings language", error);
    }
  },
);

// Fetch both chunks in parallel rather than waterfalling the boundary import
// after App resolves — a free win, and it matters over the network in the web
// build where these are separate fetches.
void Promise.all([
  import("./App"),
  import("./components/common/error-boundaries"),
  loadAuthGate(authGate),
  // Gate the first render on i18next being initialized with the active locale's
  // (lazily loaded) catalog, so the UI never paints raw translation keys.
  startupLanguageReady,
])
  .then(([{ default: App }, { AppErrorBoundary }, withAuthGate]) => {
    const app = <App />;
    const authenticatedApp = withAuthGate ? withAuthGate(app) : app;
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <I18nextProvider i18n={i18n}>
          <AppErrorBoundary>
            <TooltipProvider delayDuration={200}>{authenticatedApp}</TooltipProvider>
          </AppErrorBoundary>
        </I18nextProvider>
      </React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    console.error("Failed to start GeoLibre", error);
  });
