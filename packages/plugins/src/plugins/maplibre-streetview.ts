import {
  StreetViewControl,
  type StreetViewControlOptions,
} from "maplibre-gl-streetview";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "../types";

const streetViewEnv = (
  import.meta as ImportMeta & {
    env?: Record<string, string | undefined>;
  }
).env;

function getRuntimeEnvironment(): Record<string, string | undefined> {
  if (typeof window === "undefined") return streetViewEnv ?? {};

  // __GEOLIBRE_RUNTIME_ENV__ is declared globally in @geolibre/core.
  return {
    ...(streetViewEnv ?? {}),
    ...(window.__GEOLIBRE_RUNTIME_ENV__ ?? {}),
  };
}

function getStreetViewCredentials(): Pick<
  StreetViewControlOptions,
  "defaultProvider" | "googleApiKey" | "mapillaryAccessToken"
> {
  const env = getRuntimeEnvironment();
  const googleApiKey = env.VITE_GOOGLE_MAPS_API_KEY?.trim() || undefined;
  const mapillaryAccessToken =
    env.VITE_MAPILLARY_ACCESS_TOKEN?.trim() || undefined;

  // Pick a default provider that actually has credentials so the panel does not
  // open onto a provider it cannot authenticate. Google wins when both are set.
  const defaultProvider: StreetViewControlOptions["defaultProvider"] =
    googleApiKey ? "google" : mapillaryAccessToken ? "mapillary" : "google";

  return {
    defaultProvider,
    googleApiKey,
    mapillaryAccessToken,
  };
}

let streetViewPosition: GeoLibreMapControlPosition = "top-right";

const STREET_VIEW_OPTIONS = {
  collapsed: false,
  title: "Street View",
  panelWidth: 420,
  panelHeight: 320,
} satisfies Omit<
  StreetViewControlOptions,
  "defaultProvider" | "googleApiKey" | "mapillaryAccessToken" | "position"
>;

let streetViewControl: StreetViewControl | null = null;
let activeApp: GeoLibreAppAPI | null = null;
let removeRuntimeEnvListener: (() => void) | null = null;

export const maplibreStreetViewPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-streetview",
  name: "Street View",
  version: "0.4.0",
  activate: (app: GeoLibreAppAPI) => {
    activeApp = app;
    addRuntimeEnvListener();
    if (!streetViewControl) {
      streetViewControl = new StreetViewControl(getStreetViewOptions());
    }

    const added = app.addMapControl(streetViewControl, streetViewPosition);
    if (!added) {
      streetViewControl = null;
      cleanupRuntimeEnvListener();
      return false;
    }
    setTimeout(() => streetViewControl?.expand(), 0);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    if (streetViewControl) app.removeMapControl(streetViewControl);
    streetViewControl = null;
    cleanupRuntimeEnvListener();
  },
  getMapControlPosition: () => streetViewPosition,
  setMapControlPosition: (
    app: GeoLibreAppAPI,
    position: GeoLibreMapControlPosition,
  ) => {
    streetViewPosition = position;
    if (!streetViewControl) return;
    app.removeMapControl(streetViewControl);
    const added = app.addMapControl(streetViewControl, streetViewPosition);
    if (!added) return false;
    setTimeout(() => streetViewControl?.expand(), 0);
  },
};

function getStreetViewOptions(): StreetViewControlOptions {
  return {
    ...STREET_VIEW_OPTIONS,
    ...getStreetViewCredentials(),
    position: streetViewPosition,
  };
}

function addRuntimeEnvListener(): void {
  if (removeRuntimeEnvListener || typeof window === "undefined") return;

  const handleRuntimeEnvChange = () => {
    if (!activeApp) return;
    if (streetViewControl) activeApp.removeMapControl(streetViewControl);
    streetViewControl = new StreetViewControl(getStreetViewOptions());
    const added = activeApp.addMapControl(streetViewControl, streetViewPosition);
    if (!added) {
      // Keep the listener registered so a later credential change can retry.
      // addMapControl failures here are typically transient (e.g. the map is
      // not fully initialized yet); the guard above only requires activeApp,
      // so the next event re-attempts the add.
      streetViewControl = null;
      console.warn(
        "[maplibre-streetview] addMapControl failed during credential update; will retry on next env change.",
      );
      return;
    }
    setTimeout(() => streetViewControl?.expand(), 0);
  };

  window.addEventListener(
    "geolibre:runtime-env-change",
    handleRuntimeEnvChange,
  );
  removeRuntimeEnvListener = () => {
    window.removeEventListener(
      "geolibre:runtime-env-change",
      handleRuntimeEnvChange,
    );
  };
}

function cleanupRuntimeEnvListener(): void {
  activeApp = null;
  removeRuntimeEnvListener?.();
  removeRuntimeEnvListener = null;
}
