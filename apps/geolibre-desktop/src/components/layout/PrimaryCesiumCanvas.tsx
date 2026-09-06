import { CesiumCanvas, type CesiumWidgetControlLabels, type MapEngine } from "@geolibre/map";
import { useMemo, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useCesiumIonToken } from "../../hooks/useCesiumIonToken";

export interface PrimaryCesiumCanvasProps {
  /**
   * The shared engine ref the rest of the app drives the map through. The globe
   * publishes its `CesiumEngine` into it exactly as `MapCanvas` publishes its
   * `MapController`, so menus, panels, and shortcuts act on whichever renderer
   * is live (issue #2260).
   */
  engineRef: RefObject<MapEngine | null>;
  /** Called once the engine is live, to re-arm anything keyed to map readiness. */
  onEngineReady: () => void;
}

/**
 * The primary map area drawn by the CesiumJS globe (issue #2217).
 *
 * Mounted in place of `MapCanvas` when the project's `primaryRenderer` is
 * `"cesium"`. The globe reads the same store state the 2D map does — camera,
 * basemap, layers, groups, visibility, opacity — so switching engines changes
 * only what draws the project, never the project itself.
 *
 * It publishes a `CesiumEngine` into the shared engine ref rather than a
 * `MapController`, so camera work, terrain, and layer sync all reach the globe
 * through the same calls the 2D map answers. The MapLibre-only overlays
 * (context menu, legend, comments, story map, the ML panels) are still not
 * mounted beside it, and the menus gate those on `engine.capabilities` rather
 * than on the renderer's name.
 */
export function PrimaryCesiumCanvas({ engineRef, onEngineReady }: PrimaryCesiumCanvasProps) {
  const { t } = useTranslation();
  const ionToken = useCesiumIonToken();
  // Cesium's toolbar widgets render outside React and hardcode English, so the
  // translated tooltips are handed to the canvas the way `MapController`'s
  // compass and terrain labels are pushed in. Memoized on the language rather
  // than rebuilt every render: the canvas re-pushes them whenever this object's
  // identity changes.
  const controlLabels = useMemo<CesiumWidgetControlLabels>(
    () => ({
      home: t("renderer.resetView"),
      sceneMode3D: t("renderer.scene3D"),
      sceneMode2D: t("renderer.scene2D"),
      sceneModeColumbus: t("renderer.sceneColumbus"),
      fullscreenEnter: t("renderer.fullscreenEnter"),
      fullscreenExit: t("renderer.fullscreenExit"),
      fullscreenUnavailable: t("renderer.fullscreenUnavailable"),
    }),
    [t],
  );

  return (
    <div className="absolute inset-0" data-testid="primary-cesium">
      {/* Key on the token so changing the Cesium Ion token in Settings remounts
          the globe: `Cesium.Ion.defaultAccessToken` is applied once at viewer
          creation, so without a remount a swapped token would never take
          effect. Mirrors the globe panes in MapGrid. */}
      <CesiumCanvas
        key={ionToken}
        ionToken={ionToken}
        engineRef={engineRef}
        onEngineReady={onEngineReady}
        controlLabels={controlLabels}
      />
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
