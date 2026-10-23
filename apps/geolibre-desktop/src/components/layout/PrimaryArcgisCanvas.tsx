import {
  ArcgisCanvas,
  type ArcgisEngineMessages,
  type MapCanvasIdentifyAllLabels,
  type MapCanvasRasterIdentify,
  type MapDiagnosticEvent,
  type MapEngine,
} from "@geolibre/map";
import { useMemo, type ComponentType, type ReactElement, type RefObject } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useArcgisApiKey } from "../../hooks/useArcgisApiKey";
import { openSettingsSection } from "./SettingsDialog";

// `Trans` is typed against the catalog's key union; the cast keeps the rich
// hint text (a button that deep-links into Settings) type-checkable here the
// same way `PrimaryMapboxCanvas` does.
const HintTrans = Trans as ComponentType<{
  i18nKey: string;
  components: Record<string, ReactElement>;
}>;

/**
 * The map area drawn by the ArcGIS Maps SDK for JavaScript (issue #2421).
 * Shared by the primary workspace and split panes.
 *
 * Unlike the Mapbox pane, the map is mounted with or without an API key: the
 * engine translates the shared project basemap into tiles the SDK can draw,
 * and only Esri's own basemap styles need the key. The hint says what a key
 * would add rather than hiding the view, mirroring the Cesium Ion token hint.
 */
export function PrimaryArcgisCanvas({
  engineRef,
  onEngineReady,
  onMapDiagnosticEvent,
  canUseRemoteElevation,
  identifyAllLabels,
  identifyRasterLayerAt,
  viewId,
}: {
  engineRef?: RefObject<MapEngine | null>;
  onEngineReady?: () => void;
  onMapDiagnosticEvent?: (event: MapDiagnosticEvent) => void;
  canUseRemoteElevation?: () => boolean;
  identifyAllLabels?: MapCanvasIdentifyAllLabels;
  identifyRasterLayerAt?: MapCanvasRasterIdentify;
  viewId?: string;
}) {
  const { t } = useTranslation();
  const apiKey = useArcgisApiKey();
  const messages = useMemo<Partial<ArcgisEngineMessages>>(
    () => ({
      filterNoSql: (layer) => t("renderer.arcgisFilterNoSql", { layer }),
      imageFailed: (layer) => t("renderer.arcgisImageFailed", { layer }),
      pluginLayer: (layer) => t("renderer.arcgisPluginLayer", { layer }),
    }),
    [t],
  );
  return (
    <div className="absolute inset-0" data-testid="primary-arcgis">
      <ArcgisCanvas
        // Key on the API key so a changed key recreates the map: the SDK reads
        // `config.apiKey` when the basemap and view are constructed.
        key={apiKey ?? ""}
        apiKey={apiKey}
        engineRef={engineRef}
        onEngineReady={onEngineReady}
        viewId={viewId}
        closeLabel={t("common.close")}
        retryLabel={t("common.retry")}
        onMapDiagnosticEvent={onMapDiagnosticEvent}
        messages={messages}
        canUseRemoteElevation={canUseRemoteElevation}
        identifyAllLabels={identifyAllLabels}
        identifyRasterLayerAt={identifyRasterLayerAt}
      />
      {apiKey ? null : (
        <div className="pointer-events-none absolute bottom-10 start-2 z-10 max-w-[70%] rounded-md border border-input map-glass px-2 py-1 text-xs text-muted-foreground shadow-sm">
          <span className="pointer-events-auto">
            <HintTrans
              i18nKey="renderer.arcgisKeyHint"
              components={{
                settingsLink: (
                  <button
                    type="button"
                    className="underline underline-offset-2 hover:text-foreground"
                    onClick={() => openSettingsSection("environment", { focus: "arcgisKey" })}
                  />
                ),
              }}
            />
          </span>
        </div>
      )}
    </div>
  );
}
