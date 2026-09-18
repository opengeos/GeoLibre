import { getMapboxAccessToken } from "@geolibre/core";
import { useEffect, useState } from "react";

/** Recreate Mapbox maps when a runtime token is added, replaced, or removed. */
export function useMapboxAccessToken(): string | undefined {
  const [token, setToken] = useState(() => getMapboxAccessToken());
  useEffect(() => {
    const refresh = () => setToken(getMapboxAccessToken());
    refresh();
    window.addEventListener("geolibre:runtime-env-change", refresh);
    return () => window.removeEventListener("geolibre:runtime-env-change", refresh);
  }, []);
  return token;
}
