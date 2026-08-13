import { DirectionProvider } from "@geolibre/ui";
import { useTranslation } from "react-i18next";
import { useCallback, useState } from "react";
import { DesktopShell } from "./components/layout/DesktopShell";
import { OnboardingDialog } from "./components/layout/OnboardingDialog";
import { UpdateNotificationModal } from "./components/layout/UpdateNotificationModal";
import { useDesktopSettingsPersistence } from "./hooks/useDesktopSettings";
import { useLayoutOptions } from "./hooks/useLayoutOptions";
import { useProjectUrlLoader } from "./hooks/useProjectUrlLoader";
import { useDataUrlLoader } from "./hooks/useDataUrlLoader";
import { useBeforeUnloadGuard } from "./hooks/useBeforeUnloadGuard";
import { useRecentProjectsPersistence } from "./hooks/useRecentProjectsPersistence";
import { useLayerLibraryPersistence } from "./hooks/useLayerLibraryPersistence";
import { useLastBasemapPersistence } from "./hooks/useLastBasemapPersistence";
import { useStyleLibraryPersistence } from "./hooks/useStyleLibraryPersistence";
import { useTemplateLibraryPersistence } from "./hooks/useTemplateLibraryPersistence";
import { useRuntimeEnvironmentVariables } from "./hooks/useRuntimeEnvironmentVariables";
import { useStartupUpdateCheck } from "./hooks/useStartupUpdateCheck";
import { useStartupProject } from "./hooks/useStartupProject";
import { useThemeMode } from "./hooks/useThemeMode";
import { useThemeScheme } from "./hooks/useThemeScheme";
import { useUiProfileBootstrap } from "./hooks/useUiProfileBootstrap";
import { useUndoRedoShortcuts } from "./hooks/useUndoRedoShortcuts";
import { useWhiteboxToolUrl } from "./hooks/useWhiteboxToolUrl";
import { createAppAPI } from "./hooks/usePlugins";
import { languageDirection } from "./i18n/languages";

export default function App() {
  useLastBasemapPersistence();
  // Re-renders on language change, so Radix primitives (menus, sliders, tabs)
  // pick up the right-to-left direction together with the document `dir`.
  const { i18n } = useTranslation();
  const layoutOptions = useLayoutOptions();
  const { themeMode, toggleThemeMode } = useThemeMode();
  // `onMapReady` fires again on every basemap swap (MapCanvas re-emits
  // controller-ready from its `style.load` handler) and hands back a freshly
  // built API object each time. Keep the first one: the identity feeds the
  // `?data=` loader's effect deps, and a changing identity would re-run that
  // one-shot import and duplicate its layers.
  const [mapAppAPI, setMapAppAPI] = useState<ReturnType<typeof createAppAPI> | null>(null);
  const handleMapReady = useCallback((api: ReturnType<typeof createAppAPI>) => {
    setMapAppAPI((current) => current ?? api);
  }, []);
  const projectUrlLoadState = useProjectUrlLoader();
  const dataUrlLoadState = useDataUrlLoader(mapAppAPI);
  const { showOnboarding, dismissOnboarding } = useUiProfileBootstrap();
  const { pending: pendingUpdate, remindLater, skipVersion } = useStartupUpdateCheck();
  useDesktopSettingsPersistence();
  useThemeScheme();
  useRecentProjectsPersistence();
  const startupProjectWarning = useStartupProject();
  useStyleLibraryPersistence();
  useLayerLibraryPersistence();
  useTemplateLibraryPersistence();
  useRuntimeEnvironmentVariables();
  useUndoRedoShortcuts();
  useBeforeUnloadGuard();
  useWhiteboxToolUrl();
  return (
    <DirectionProvider dir={languageDirection(i18n.language)}>
      <DesktopShell
        layoutOptions={layoutOptions}
        projectUrlLoadState={projectUrlLoadState}
        dataUrlLoadState={dataUrlLoadState}
        mapAppAPI={mapAppAPI}
        themeMode={themeMode}
        onToggleThemeMode={toggleThemeMode}
        onMapReady={handleMapReady}
      />
      <OnboardingDialog open={showOnboarding} onClose={dismissOnboarding} />
      <UpdateNotificationModal
        pending={pendingUpdate}
        onRemindLater={remindLater}
        onSkipVersion={skipVersion}
      />
      {startupProjectWarning ? (
        <div
          role="alert"
          className="fixed bottom-10 left-1/2 z-50 -translate-x-1/2 rounded-md border bg-background px-4 py-3 text-sm shadow-lg"
        >
          {startupProjectWarning}
        </div>
      ) : null}
    </DirectionProvider>
  );
}
