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

const googleApiKey = streetViewEnv?.VITE_GOOGLE_MAPS_API_KEY;
const mapillaryAccessToken = streetViewEnv?.VITE_MAPILLARY_ACCESS_TOKEN;

// Pick a default provider that actually has credentials so the panel does not
// open onto a provider it cannot authenticate. Google wins when both are set.
const defaultProvider: StreetViewControlOptions["defaultProvider"] = googleApiKey
  ? "google"
  : mapillaryAccessToken
    ? "mapillary"
    : "google";

let streetViewPosition: GeoLibreMapControlPosition = "top-right";

const STREET_VIEW_OPTIONS = {
  collapsed: false,
  title: "Street View",
  panelWidth: 420,
  panelHeight: 320,
  defaultProvider,
  googleApiKey,
  mapillaryAccessToken,
} satisfies Omit<StreetViewControlOptions, "position">;

let streetViewControl: StreetViewControl | null = null;

export const maplibreStreetViewPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-streetview",
  name: "Street View",
  version: "0.4.0",
  activate: (app: GeoLibreAppAPI) => {
    if (!streetViewControl) {
      streetViewControl = new StreetViewControl(getStreetViewOptions());
    }

    const added = app.addMapControl(streetViewControl, streetViewPosition);
    if (!added) {
      streetViewControl = null;
      return false;
    }
    setTimeout(() => streetViewControl?.expand(), 0);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    if (!streetViewControl) return;
    app.removeMapControl(streetViewControl);
    streetViewControl = null;
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
    position: streetViewPosition,
  };
}
