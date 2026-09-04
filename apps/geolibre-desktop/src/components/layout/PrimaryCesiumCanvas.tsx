import { CesiumCanvas } from "@geolibre/map";
import { useTranslation } from "react-i18next";
import { useCesiumIonToken } from "../../hooks/useCesiumIonToken";

/**
 * The primary map area drawn by the CesiumJS globe (issue #2217).
 *
 * Mounted in place of `MapCanvas` when the project's `primaryRenderer` is
 * `"cesium"`. The globe reads the same store state the 2D map does — camera,
 * basemap, layers, groups, visibility, opacity — so switching engines changes
 * only what draws the project, never the project itself.
 *
 * It renders no `MapController`, so the MapLibre-only overlays (context menu,
 * legend, comments, story map, terrain, the ML panels) are not mounted beside
 * it, and the View menu greys out the items that drive one.
 */
export function PrimaryCesiumCanvas() {
  const { t } = useTranslation();
  const ionToken = useCesiumIonToken();

  return (
    <div className="absolute inset-0" data-testid="primary-cesium">
      {/* Key on the token so changing the Cesium Ion token in Settings remounts
          the globe: `Cesium.Ion.defaultAccessToken` is applied once at viewer
          creation, so without a remount a swapped token would never take
          effect. Mirrors the globe panes in MapGrid. */}
      <CesiumCanvas key={ionToken} ionToken={ionToken} />
      {/* The globe works without an Ion token — it draws the project basemap —
          so say what a token would add rather than hiding the view. Bottom-end
          keeps it clear of Cesium's own credit display (bottom-left) and of the
          pane label along the top, matching the globe panes in MapGrid. */}
      {ionToken ? null : (
        <div className="pointer-events-none absolute bottom-2 end-2 z-10 max-w-[70%] truncate rounded-md border border-input map-glass px-2 py-1 text-xs text-muted-foreground shadow-sm">
          {t("mapGrid.cesiumTokenHint")}
        </div>
      )}
    </div>
  );
}
