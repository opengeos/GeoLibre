import { MapboxCanvas, type MapDiagnosticEvent, type MapEngine } from "@geolibre/map";
import type { ComponentType, ReactElement, RefObject } from "react";
import { Trans } from "react-i18next";
import { useMapboxAccessToken } from "../../hooks/useMapboxAccessToken";
import { openSettingsSection } from "./SettingsDialog";

// `Trans` is typed against the catalog's key union; the cast keeps the rich
// hint text (a button that deep-links into Settings) type-checkable here the
// same way SettingsDialog's own `SettingsTrans` does.
const HintTrans = Trans as ComponentType<{
  i18nKey: string;
  components: Record<string, ReactElement>;
}>;

/** Shared by the primary workspace and split panes, including the token hint. */
export function PrimaryMapboxCanvas({
  engineRef,
  onEngineReady,
  onMapDiagnosticEvent,
  viewId,
}: {
  engineRef?: RefObject<MapEngine | null>;
  onEngineReady?: () => void;
  onMapDiagnosticEvent?: (event: MapDiagnosticEvent) => void;
  viewId?: string;
}) {
  const token = useMapboxAccessToken();
  return (
    <div className="absolute inset-0" data-testid="primary-mapbox">
      {token ? (
        <MapboxCanvas
          accessToken={token}
          engineRef={engineRef}
          onEngineReady={onEngineReady}
          onMapDiagnosticEvent={onMapDiagnosticEvent}
          viewId={viewId}
        />
      ) : (
        <div
          role="status"
          className="flex h-full items-center justify-center bg-background p-8 text-center text-sm text-muted-foreground"
        >
          {/* The Settings part of the hint opens the Environment section with
              the Mapbox token field focused, so first-time setup is one click.
              One block child: as direct flex items the text fragments around
              the inline button would lose their surrounding spaces. */}
          <p className="max-w-md">
            <HintTrans
              i18nKey="renderer.mapboxTokenHint"
              components={{
                settingsLink: (
                  <button
                    type="button"
                    className="underline underline-offset-2 hover:text-foreground"
                    onClick={() => openSettingsSection("environment", { focus: "mapboxToken" })}
                  />
                ),
              }}
            />
          </p>
        </div>
      )}
    </div>
  );
}
