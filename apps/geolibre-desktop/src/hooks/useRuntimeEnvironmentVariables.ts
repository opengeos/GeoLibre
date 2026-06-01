import { useAppStore } from "@geolibre/core";
import { useEffect, useRef } from "react";

export function useRuntimeEnvironmentVariables() {
  const environmentVariables = useAppStore(
    (s) => s.preferences.environmentVariables,
  );
  const lastSerializedEnv = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const runtimeEnv = Object.fromEntries(
      environmentVariables
        .filter((variable) => variable.enabled && variable.key.trim())
        .map((variable) => [variable.key.trim(), variable.value]),
    );

    // Skip the update when the derived env is unchanged. Saving unrelated
    // settings (e.g. map preferences) recreates the array reference without
    // changing its contents, and a redundant dispatch needlessly reinitializes
    // plugins such as Street View.
    const serializedEnv = JSON.stringify(runtimeEnv);
    if (serializedEnv === lastSerializedEnv.current) return;
    lastSerializedEnv.current = serializedEnv;

    window.__GEOLIBRE_RUNTIME_ENV__ = runtimeEnv;
    window.dispatchEvent(
      new CustomEvent("geolibre:runtime-env-change", { detail: runtimeEnv }),
    );
  }, [environmentVariables]);
}
