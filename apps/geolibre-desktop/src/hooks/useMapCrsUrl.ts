import { normalizeMapCrs, useAppStore } from "@geolibre/core";
import { resolveMapCrs } from "@geolibre/map";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { mapCrsRequestFromSearch } from "../lib/map-crs-url";
import { notify } from "../lib/notify";

/**
 * Report a link's `crs` that cannot be drawn, and take it back out of the
 * preferences `useStartupProject` seeded, so it is not saved with the project.
 * The map itself has already fallen back to the default map.
 */
export function useMapCrsUrl(): void {
  const { t } = useTranslation();
  useEffect(() => {
    const request = mapCrsRequestFromSearch(window.location.search);
    if (!request || request.mapCrs === null) return;
    const { raw, mapCrs } = request;
    let cancelled = false;
    void (mapCrs === undefined ? Promise.resolve(null) : resolveMapCrs(mapCrs))
      .catch(() => null)
      .then((crs) => {
        if (crs || cancelled) return;
        notify.warning(t("settings.map.mapCrsLinkUnknown", { crs: raw }), {
          dedupeKey: "map-crs-link",
        });
        const { preferences } = useAppStore.getState();
        if (mapCrs === undefined || normalizeMapCrs(preferences.map.mapCrs) !== mapCrs) return;
        useAppStore.setState({
          preferences: { ...preferences, map: { ...preferences.map, mapCrs: undefined } },
        });
      });
    return () => {
      cancelled = true;
    };
    // One-shot: the link is read once, and changing language must not re-report it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
