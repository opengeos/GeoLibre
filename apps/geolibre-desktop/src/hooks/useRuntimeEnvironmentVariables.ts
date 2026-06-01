import { useAppStore } from "@geolibre/core";
import { useEffect, useRef } from "react";

export function useRuntimeEnvironmentVariables() {
  const environmentVariables = useAppStore(
    (s) => s.preferences.environmentVariables,
  );
  const lastSerializedEnv = useRef<string | null>(null);
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const runtimeEnv = Object.fromEntries(
      environmentVariables
        .filter((variable) => variable.enabled && variable.key.trim())
        .map((variable) => [variable.key.trim(), variable.value]),
    );

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
  }, [environmentVariables]);
}
