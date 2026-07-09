import { normalizeGeocodingProviderId, useAppStore } from "@geolibre/core";
import { useEffect, useRef } from "react";
import { useDesktopSettingsStore } from "./useDesktopSettings";

export function useRuntimeEnvironmentVariables() {
  const environmentVariables = useAppStore(
    (s) => s.preferences.environmentVariables,
  );
  const geocoding = useAppStore((s) => s.preferences.geocoding);
  // Device-local Cesium Ion token (Settings → Environment). Projected below so
  // getCesiumIonToken() picks it up as a runtime override without a rebuild.
  const cesiumIonToken = useDesktopSettingsStore(
    (s) => s.desktopSettings.cesiumIonToken,
  );
  const lastSerializedEnv = useRef<string | null>(null);
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Derive the VITE_GEOCODER_* vars from the structured geocoding preference
    // so the reverse-geocode plugin (which reads runtime env, not the store)
    // honors the selected provider. Explicit user-defined env vars below win,
    // preserving the documented endpoint override escape hatch.
    const providerId = normalizeGeocodingProviderId(geocoding.providerId);
    const geocoderEnv: Record<string, string> = {
      VITE_GEOCODER_PROVIDER: providerId,
    };
    const apiKey = geocoding.apiKeys?.[providerId]?.trim();
    if (apiKey) geocoderEnv.VITE_GEOCODER_API_KEY = apiKey;
    if (geocoding.forwardEndpoint?.trim())
      geocoderEnv.VITE_GEOCODER_ENDPOINT = geocoding.forwardEndpoint.trim();
    if (geocoding.reverseEndpoint?.trim())
      geocoderEnv.VITE_GEOCODER_REVERSE_ENDPOINT =
        geocoding.reverseEndpoint.trim();
    if (geocoding.email?.trim())
      geocoderEnv.VITE_GEOCODER_EMAIL = geocoding.email.trim();

    // Only inject the Cesium token when set: an empty value would override (and
    // so blank out) a build-time VITE_CESIUM_TOKEN via getRuntimeEnvironment's
    // spread. A free-form env-var row of the same name still wins over this.
    const cesiumEnv: Record<string, string> = cesiumIonToken.trim()
      ? { VITE_CESIUM_TOKEN: cesiumIonToken.trim() }
      : {};

    const runtimeEnv = {
      ...geocoderEnv,
      ...cesiumEnv,
      ...Object.fromEntries(
        environmentVariables
          .filter((variable) => variable.enabled && variable.key.trim())
          .map((variable) => [variable.key.trim(), variable.value]),
      ),
    };

    // Always keep the global env in sync so plugins can read it when they
    // activate, even before the first change event.
    window.__GEOLIBRE_RUNTIME_ENV__ = runtimeEnv;

    // Skip the change event on the initial mount: plugins read the global
    // directly when they activate, so dispatching here would only trigger a
    // spurious Street View control remove/re-add on startup.
    const serializedEnv = JSON.stringify(runtimeEnv);
    if (isFirstRender.current) {
      isFirstRender.current = false;
      lastSerializedEnv.current = serializedEnv;
      return;
    }

    // Skip the dispatch when the derived env is unchanged. Saving unrelated
    // settings (e.g. map preferences) recreates the array reference without
    // changing its contents, and a redundant dispatch needlessly reinitializes
    // plugins such as Street View.
    if (serializedEnv === lastSerializedEnv.current) return;
    lastSerializedEnv.current = serializedEnv;

    window.dispatchEvent(
      new CustomEvent("geolibre:runtime-env-change", { detail: runtimeEnv }),
    );
  }, [environmentVariables, geocoding, cesiumIonToken]);
}
