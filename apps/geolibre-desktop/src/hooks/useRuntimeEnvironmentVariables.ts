import { useAppStore } from "@geolibre/core";
import { useEffect } from "react";

export function useRuntimeEnvironmentVariables() {
  const environmentVariables = useAppStore(
    (s) => s.preferences.environmentVariables,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    const runtimeEnv = Object.fromEntries(
      environmentVariables
        .filter((variable) => variable.enabled && variable.key.trim())
        .map((variable) => [variable.key.trim(), variable.value]),
    );
    window.__GEOLIBRE_RUNTIME_ENV__ = runtimeEnv;
    window.dispatchEvent(
      new CustomEvent("geolibre:runtime-env-change", { detail: runtimeEnv }),
    );
  }, [environmentVariables]);
}
