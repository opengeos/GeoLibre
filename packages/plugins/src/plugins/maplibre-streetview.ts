import { getGoogleMapsApiKey } from "@geolibre/core";
import {
  StreetViewControl,
  type CreateStreetViewMarker,
  type StreetViewControlOptions,
} from "maplibre-gl-streetview";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition, GeoLibrePlugin } from "../types";

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

/** The `app.credentials` names the keys applied in the panel are saved under. */
const GOOGLE_CREDENTIAL_NAME = "google";
const MAPILLARY_CREDENTIAL_NAME = "mapillary";

/** Street View keys from runtime env, before any key saved in the panel. */
function getEnvCredentials(): { googleApiKey?: string; mapillaryAccessToken?: string } {
  const env = getRuntimeEnvironment();
  return {
    googleApiKey: getGoogleMapsApiKey(env),
    mapillaryAccessToken: env.VITE_MAPILLARY_ACCESS_TOKEN?.trim() || undefined,
  };
}

function getStreetViewCredentials(): Pick<
  StreetViewControlOptions,
  "defaultProvider" | "googleApiKey" | "mapillaryAccessToken"
> {
  const env = getEnvCredentials();
  // A key applied in the panel wins over env, as the Mapillary plugin's pasted
  // token does.
  const googleApiKey =
    activeApp?.credentials?.get(GOOGLE_CREDENTIAL_NAME).trim() || env.googleApiKey;
  const mapillaryAccessToken =
    activeApp?.credentials?.get(MAPILLARY_CREDENTIAL_NAME).trim() || env.mapillaryAccessToken;

  // Pick a default provider that actually has credentials so the panel does not
  // open onto a provider it cannot authenticate. Google wins when both are set.
  const defaultProvider: StreetViewControlOptions["defaultProvider"] = googleApiKey
    ? "google"
    : mapillaryAccessToken
      ? "mapillary"
      : "google";

  return {
    defaultProvider,
    // "" rather than undefined for an unset key: the control writes the option
    // straight into its key input, which would otherwise read "undefined" and be
    // applied (and saved) as a literal token by the next Apply click.
    googleApiKey: googleApiKey ?? "",
    mapillaryAccessToken: mapillaryAccessToken ?? "",
  };
}

/**
 * Save the keys the user applies in the control's API keys inputs. The control
 * keeps them only in memory, so without this they are lost when the panel
 * closes or the app restarts. Its Apply button calls `this.setApiKeys`, so
 * wrapping the instance method catches every apply. That relies on the form
 * looking the method up at submit time; tests/streetview-plugin.test.ts submits
 * the real form so an upstream change that captures it earlier fails there. A value equal to the env
 * key is not an override, so it (like a cleared field) deletes the saved key
 * rather than copying the env key into the credential store.
 *
 * @param app - The plugin host API, whose `credentials` store the keys.
 * @param control - The control whose applied keys are saved.
 */
function persistAppliedApiKeys(app: GeoLibreAppAPI, control: StreetViewControl): void {
  const setApiKeys = control.setApiKeys.bind(control);
  control.setApiKeys = (keys) => {
    const env = getEnvCredentials();
    const save = (name: string, value: string | null | undefined, envValue: string | undefined) => {
      // Omitted keeps the current key; null clears it (the upstream contract).
      if (value === undefined) return;
      const trimmed = (value ?? "").trim();
      // The result is ignored: on a failed write the host keeps the key for this
      // session and raises the credential-storage warning on desktop.
      app.credentials?.set(name, trimmed === (envValue ?? "") ? "" : trimmed);
    };
    save(GOOGLE_CREDENTIAL_NAME, keys.googleApiKey, env.googleApiKey);
    save(MAPILLARY_CREDENTIAL_NAME, keys.mapillaryAccessToken, env.mapillaryAccessToken);
    setApiKeys(keys);
    // The live control already holds these keys, so a later unrelated env
    // change must not rebuild it just because the saved keys moved.
    if (control === streetViewControl) appliedCredentialsSignature = credentialsSignature();
  };
}

/** Build a control seeded with the current keys, saving any the user applies. */
function createStreetViewControl(app: GeoLibreAppAPI): StreetViewControl {
  const control = new StreetViewControl(getStreetViewOptions(app));
  persistAppliedApiKeys(app, control);
  return control;
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
// The credentials the current control was built with, so a runtime-env change
// that doesn't touch Street View's own vars (a common case now that the desktop
// app loads unrelated AI keys from the OS environment on launch) doesn't force a
// needless control remove/recreate + re-expand.
let appliedCredentialsSignature: string | null = null;

function credentialsSignature(): string {
  const { defaultProvider, googleApiKey, mapillaryAccessToken } = getStreetViewCredentials();
  return JSON.stringify([defaultProvider, googleApiKey ?? "", mapillaryAccessToken ?? ""]);
}

/**
 * How the control should place its location marker on this host.
 *
 * MapLibre's `Marker` reads `map._camera.transform` on every position update,
 * which a mapbox-gl map does not have — it throws on the first map click there.
 * Everything else the control touches (`getContainer`, `on`/`off`, a click
 * event's `lngLat`) is on the surface both engines share, so the marker is the
 * only piece that needs an engine of its own. On Mapbox the control's own
 * marker element is positioned by mapbox-gl's `Marker` instead, through
 * `maplibre-gl-streetview`'s `createMarker` option; `undefined` leaves the
 * upstream default, which is MapLibre's.
 *
 * Two deliberate choices about *when* things are read. The engine is decided
 * from the renderer alone, and the namespace is read only when a marker is
 * actually built — inside the control's `onAdd`, by which point the map it is
 * being added to necessarily exists.
 *
 * Both halves matter because the two signals disagree during a swap, in
 * opposite directions. The store flips `primaryRenderer` synchronously;
 * `getMapboxGl()` answers off the engine ref, which changes a beat later. So
 * while a swap *to* Mapbox is in flight the namespace is still absent — reading
 * it then would keep MapLibre's `Marker` for the control's whole lifetime and
 * throw on the first map click, the exact bug this exists to prevent. And while
 * a swap *away* from Mapbox is in flight the namespace is still present —
 * accepting it then would commit a control being rebuilt for MapLibre to a
 * Mapbox marker, which by `onAdd` has no namespace left to build. The renderer
 * is right in both directions, so it is the only signal consulted; the
 * namespace is a fallback purely for a host that does not report a renderer.
 *
 * @param app - The plugin host API, read for the renderer and the namespace.
 * @returns A marker factory on a Mapbox host, else `undefined`.
 */
export function streetViewMarkerFactory(
  app: Pick<GeoLibreAppAPI, "getMapboxGl" | "getMapRenderer"> | null,
): CreateStreetViewMarker | undefined {
  const renderer = app?.getMapRenderer?.();
  // eslint-disable-next-line local/no-renderer-kind-checks -- builds the Mapbox marker factory
  const mapbox = renderer === undefined ? !!app?.getMapboxGl?.() : renderer === "mapbox";
  if (!mapbox) return undefined;
  return (options) => {
    const mapboxgl = app?.getMapboxGl?.();
    if (!mapboxgl) {
      // Unreachable in practice (see above); loud rather than silently placing
      // a MapLibre marker that would throw later with a confusing message.
      throw new Error("Street View needs the mapbox-gl namespace to place its marker.");
    }
    return new mapboxgl.Marker(options);
  };
}

export const maplibreStreetViewPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-streetview",
  name: "Street View",
  version: "0.5.0",
  // Both 2D engines: the control stays on the Style Spec surface they share,
  // and the one MapLibre class it built itself — the location `Marker` — now
  // comes from `createMarker` (see streetViewMarkerFactory). A renderer swap
  // tears every active plugin down and re-activates it, so the rebuilt control
  // picks up the new engine's factory.
  engines: ["maplibre", "mapbox"],
  activate: (app: GeoLibreAppAPI) => {
    activeApp = app;
    addRuntimeEnvListener();
    if (!streetViewControl) {
      streetViewControl = createStreetViewControl(app);
    }

    const added = app.addMapControl(streetViewControl, streetViewPosition);
    if (!added) {
      streetViewControl = null;
      cleanupRuntimeEnvListener();
      return false;
    }
    appliedCredentialsSignature = credentialsSignature();
    setTimeout(() => streetViewControl?.expand(), 0);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    if (streetViewControl) app.removeMapControl(streetViewControl);
    streetViewControl = null;
    appliedCredentialsSignature = null;
    cleanupRuntimeEnvListener();
  },
  getMapControlPosition: () => streetViewPosition,
  setMapControlPosition: (app: GeoLibreAppAPI, position: GeoLibreMapControlPosition) => {
    streetViewPosition = position;
    if (!streetViewControl) return;
    app.removeMapControl(streetViewControl);
    const added = app.addMapControl(streetViewControl, streetViewPosition);
    if (!added) return false;
    setTimeout(() => streetViewControl?.expand(), 0);
  },
};

function getStreetViewOptions(app: GeoLibreAppAPI | null): StreetViewControlOptions {
  return {
    ...STREET_VIEW_OPTIONS,
    ...getStreetViewCredentials(),
    position: streetViewPosition,
    createMarker: streetViewMarkerFactory(app),
  };
}

function addRuntimeEnvListener(): void {
  if (removeRuntimeEnvListener || typeof window === "undefined") return;

  const handleRuntimeEnvChange = () => {
    if (!activeApp) return;
    // Ignore env changes that don't affect Street View's own credentials so we
    // don't tear down and re-expand the control for unrelated updates (e.g. the
    // OS-environment AI keys the desktop app loads shortly after launch).
    const signature = credentialsSignature();
    if (streetViewControl && signature === appliedCredentialsSignature) return;
    if (streetViewControl) activeApp.removeMapControl(streetViewControl);
    streetViewControl = createStreetViewControl(activeApp);
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
    appliedCredentialsSignature = signature;
    setTimeout(() => streetViewControl?.expand(), 0);
  };

  window.addEventListener("geolibre:runtime-env-change", handleRuntimeEnvChange);
  removeRuntimeEnvListener = () => {
    window.removeEventListener("geolibre:runtime-env-change", handleRuntimeEnvChange);
  };
}

function cleanupRuntimeEnvListener(): void {
  activeApp = null;
  removeRuntimeEnvListener?.();
  removeRuntimeEnvListener = null;
}
