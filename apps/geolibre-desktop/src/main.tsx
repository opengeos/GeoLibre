import "./lib/symbol-dispose-polyfill";
import "./lib/crypto-random-uuid-polyfill";
// Must precede any Map construction (see the module docs).
import "./lib/maplibre-worker";
// Wraps `fetch` before Diagnostics does, so its restore keeps this wrapper:
// adds the Earthdata Login token to Earthdata relay requests (NASA COG layers).
import "./lib/earthdata-fetch-auth";
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
import "@geolibre/plugins/maplibre-vantor/style.css";
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
import { notify } from "./lib/notify";
import { isDesktopRuntime, isWindows } from "./lib/is-mobile";
import { isTauri } from "./lib/is-tauri";
import { installStaleChunkReload } from "./lib/stale-chunk-reload";
import { resolveAuthGate, type AuthGateConfig } from "./lib/auth-gate";
import { getInitialThemeMode } from "./hooks/useThemeMode";
import { KeychainWaitScreen } from "./components/common/KeychainWaitScreen";
import { applyTemporaryDesktopSettings } from "./hooks/useDesktopSettings";
import {
  desktopSettingsUrl,
  fetchDesktopSettings,
  sharedSettingsLanguage,
} from "./lib/desktop-settings-url";
import { parseDeploymentCapabilities, useAppStore } from "@geolibre/core";
import { readConfiguredAppName } from "./lib/app-name";
import { readDeploymentEnvValue } from "./lib/deployment-env";
import { loadDeploymentPolicy } from "./lib/deployment-policy";
import { initializeNativeProjectOpen } from "./lib/native-project-open";

import { initializeNativeCoordinateOpen } from "./lib/native-coordinate-open";
import { initializeNativeShareAuth } from "./lib/native-share-auth";
import { configureShareOAuthReadiness, markColdShareCallback } from "./lib/share-oauth";

installDiagnosticsCapture();

// A deployment-configured app name also titles the browser tab; index.html's
// static <title> stays the fallback when none is set. Best effort: a title
// failure must not stop the app from rendering. Applied once up front from the
// env so the tab is right while deployment.json is in flight, and again once
// the policy (which can set branding.appName) has been applied.
function applyConfiguredAppName(): void {
  try {
    const configuredAppName = readConfiguredAppName();
    if (configuredAppName) document.title = configuredAppName;
  } catch (error) {
    console.error("[GeoLibre] Failed to apply the configured app name", error);
  }
}
applyConfiguredAppName();

// deployment.json (issue #2783): the deployment's policy, fetched before the
// app renders so nothing paints with settings it then retracts. Absent
// (404/HTML fallback/error/timeout) means today's env-driven behavior. The
// fetch goes through the diagnostics wrapper installed above, whose optional
// marker keeps a 404 at info level.
const deploymentPolicyReady = loadDeploymentPolicy().then((policy) => {
  applyConfiguredAppName();
  // Capability application below is deliberately NOT guarded: if it throws, the
  // app must fail to start rather than render with the default full grant.

  // What this deployment is allowed to do (issue #1673). Applied before the
  // app renders, so no surface ever paints with the full grant and then
  // retracts it. Primary source: deployment.json. The legacy
  // VITE_GEOLIBRE_CAPABILITIES input is still honoured as a fallback:
  // policy > window.__GEOLIBRE_DEPLOYMENT_ENV__ > build environment.
  // `capabilities: []` grants none; an omitted value uses the legacy env
  // fallback when set, then the default full grant only if that is unset.
  if (policy?.capabilities !== undefined) {
    useAppStore.getState().setDeploymentCapabilities(policy.capabilities);
    return;
  }
  const configuredCapabilities = readDeploymentEnvValue("VITE_GEOLIBRE_CAPABILITIES");
  if (configuredCapabilities) {
    useAppStore
      .getState()
      .setDeploymentCapabilities(parseDeploymentCapabilities(configuredCapabilities));
  }
});

const nativeShareAuthReady = isDesktopRuntime()
  ? initializeNativeShareAuth(markColdShareCallback)
  : Promise.resolve();
const nativeCoordinateOpenReady = initializeNativeCoordinateOpen();
const nativeProjectOpenReady = initializeNativeProjectOpen();
let nativeShareFetchReady: Promise<void> = Promise.resolve();
let nativeArcGISFetchReady: Promise<void> = Promise.resolve();
let nativeSidecarFetchReady: Promise<void> = Promise.resolve();
let nativeWmsIdentifyFetchReady: Promise<void> = Promise.resolve();
// Install desktop-only transports before requests can be issued. ArcGIS uses
// a dedicated guarded Rust command; the other adapters use scoped HTTP hosts.
if (isTauri()) {
  nativeArcGISFetchReady = import("./lib/arcgis-fetch")
    .then(({ installNativeArcGISFetch }) => installNativeArcGISFetch())
    .catch((error: unknown) => {
      console.error("[GeoLibre] Failed to install native ArcGIS fetch", error);
    });
  // WebView2 can apply browser CORS and Local Network Access restrictions to
  // the loopback processing server. Route those requests through Tauri's
  // scoped native client so Windows uses the same reliable path as the shell
  // that launched the server. Windows-only: the macOS and Linux webviews reach
  // the sidecar directly, and the native client serializes request bodies over
  // IPC, which would tax large uploads (ML segmentation) on platforms that were
  // never broken.
  if (isWindows()) {
    nativeSidecarFetchReady = import("./lib/sidecar-fetch")
      .then(({ installNativeSidecarFetch }) => installNativeSidecarFetch())
      .catch((error: unknown) => {
        console.error("[GeoLibre] Failed to install native sidecar fetch", error);
      });
  }
  nativeWmsIdentifyFetchReady = import("./lib/wms-identify-fetch")
    .then(({ installNativeWmsIdentifyFetch }) => installNativeWmsIdentifyFetch())
    .catch((error: unknown) => {
      // Identify would stay on the webview fetch, which fails on WMS servers
      // without CORS headers (#2712), so surface the install failure.
      console.error("[GeoLibre] Failed to install native WMS identify fetch", error);
    });
  void import("./lib/geocoding-fetch")
    .then(({ installNativeGeocodingFetch }) => installNativeGeocodingFetch())
    .catch((error: unknown) => {
      // If the install fails, geocoding stays on the browser fetch (the
      // CORS-buggy path this fixes), so surface it rather than let it become a
      // silent unhandled rejection.
      console.error("[GeoLibre] Failed to install native geocoding fetch", error);
    });
  // Built-in share host only: await the narrow native HTTP adapter before
  // either OAuth sign-in or token requests. Self-hosted origins retain browser
  // fetch and must explicitly allow this Tauri origin in their CORS policy.
  nativeShareFetchReady = import("./lib/share-fetch").then(({ installNativeShareFetch }) =>
    installNativeShareFetch(),
  );
  // GeoLens sends X-Api-Key, which preflights in a WebView. Keep the built-in
  // datasets.geolibre.app connection working even when its CORS origin
  // allowlist does not include the packaged desktop origin.
  void import("./lib/geolens-fetch")
    .then(({ installNativeGeoLensFetch }) => installNativeGeoLensFetch())
    .catch((error: unknown) => {
      console.error("[GeoLibre] Failed to install native GeoLens fetch", error);
    });
}
if (isDesktopRuntime()) {
  configureShareOAuthReadiness(
    Promise.all([nativeShareAuthReady, nativeShareFetchReady, deploymentPolicyReady]).then(
      () => undefined,
    ),
  );
} else {
  void nativeShareFetchReady.catch(() => {
    console.error("[GeoLibre] Failed to install native share transport");
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
if (authGate || isDesktopRuntime()) {
  // Apply the initial theme now rather than leaving it to <App />. A gate paints
  // a full-screen signed-out page, and desktop may paint the keychain waiting
  // screen, *before* App mounts, and App is where useThemeMode adds the `dark`
  // class — so without this a dark-mode user gets a white screen that flips to
  // dark only once the app renders. This sets exactly what useThemeMode's
  // layout effect will set a moment later (same helper, same `?theme=`
  // handling), so it is a no-op once App mounts.
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
        // The link promised a configured app; say why it looks like the
        // visitor's own instead. Worded once translations are up.
        void i18nReady.then(() =>
          notify.warning(i18n.t("notifications.sharedSettingsFailed"), {
            dedupeKey: "shared-settings",
          }),
        );
        return null;
      })
  : Promise.resolve(null);

const root = ReactDOM.createRoot(document.getElementById("root")!);

const desktopCredentialsReady = sharedSettingsReady
  .then(() =>
    import("./lib/credential-hydration").then(({ hydrateDesktopCredentials }) =>
      hydrateDesktopCredentials(),
    ),
  )
  .catch((error: unknown) => {
    console.error("[GeoLibre] Failed to load desktop credentials", error);
  });

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
      notify.warning(i18n.t("notifications.sharedLanguageFailed"), {
        dedupeKey: "shared-settings-language",
      });
    }
  },
);

// A locked keyring (common on Linux when it is not unlocked at login) holds
// hydration until the user answers the unlock prompt. Say so rather than
// leaving the window blank, which looks frozen when the prompt is behind it.
const KEYCHAIN_WAIT_SCREEN_DELAY_MS = 300;
let appRendered = false;
if (isDesktopRuntime()) {
  const waitTimer = window.setTimeout(() => {
    void startupLanguageReady
      .catch(() => undefined)
      .then(() => {
        if (appRendered) return;
        root.render(
          <KeychainWaitScreen
            title={i18n.t("startup.keychainWaitTitle")}
            detail={i18n.t("startup.keychainWaitDetail")}
          />,
        );
      });
  }, KEYCHAIN_WAIT_SCREEN_DELAY_MS);
  void desktopCredentialsReady.finally(() => window.clearTimeout(waitTimer));
}

// Fetch both chunks in parallel rather than waterfalling the boundary import
// after App resolves — a free win, and it matters over the network in the web
// build where these are separate fetches.
void Promise.all([
  // Start App's chunk downloading and evaluating while deployment.json is in
  // flight, then apply the policy-dependent module setup once both are done.
  // Nothing in App's module graph reads deployment settings at import time
  // (the GeoLens default URL is seeded by initGeoLensDefaultUrl below), so the
  // chunk can evaluate before the policy is applied; nothing renders until the
  // policy has been.
  Promise.all([import("./App"), import("./hooks/usePlugins"), deploymentPolicyReady]).then(
    ([app, plugins]) => {
      plugins.initGeoLensDefaultUrl();
      return app;
    },
  ),
  import("./components/common/error-boundaries"),
  loadAuthGate(authGate),
  // Sidecar-dependent panels can issue a request as soon as App mounts. On
  // Windows, wait until those requests have the native transport installed.
  nativeSidecarFetchReady,
  // Restored ArcGIS layers can query immediately when App mounts.
  nativeArcGISFetchReady,
  // An Identify click on a restored WMS layer must not beat the native fetcher.
  nativeWmsIdentifyFetchReady,
  // Capture a file-association or command-line project path before App decides
  // whether to restore a configured startup project or the default workspace.
  nativeProjectOpenReady,
  nativeCoordinateOpenReady,
  // Gate the first render on i18next being initialized with the active locale's
  // (lazily loaded) catalog, so the UI never paints raw translation keys.
  startupLanguageReady,
  // Keychain-held tokens must be in the settings store before any consumer reads them.
  desktopCredentialsReady,
])
  .then(([{ default: App }, { AppErrorBoundary }, withAuthGate]) => {
    const app = <App />;
    const authenticatedApp = withAuthGate ? withAuthGate(app) : app;
    appRendered = true;
    root.render(
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
