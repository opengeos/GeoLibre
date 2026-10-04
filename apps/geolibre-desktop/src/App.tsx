import { DirectionProvider } from "@geolibre/ui";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCallback, useState } from "react";
import { DesktopShell } from "./components/layout/DesktopShell";
import { NotificationRegion } from "./components/layout/NotificationRegion";
import { OnboardingDialog } from "./components/layout/OnboardingDialog";
import { UpdateNotificationModal } from "./components/layout/UpdateNotificationModal";
import { useDesktopSettingsPersistence } from "./hooks/useDesktopSettings";
import "./lib/s3-signer-setup";
import { useLayoutOptions } from "./hooks/useLayoutOptions";
import { useProjectUrlLoader } from "./hooks/useProjectUrlLoader";
import { useDataUrlLoader } from "./hooks/useDataUrlLoader";
import { useStacUrlLoader } from "./hooks/useStacUrlLoader";
import { useBeforeUnloadGuard } from "./hooks/useBeforeUnloadGuard";
import { useRecentProjectsPersistence } from "./hooks/useRecentProjectsPersistence";
import { useLayerLibraryPersistence } from "./hooks/useLayerLibraryPersistence";
import { useLastBasemapPersistence } from "./hooks/useLastBasemapPersistence";
import { useLastRendererPersistence } from "./hooks/useLastRendererPersistence";
import { useStyleLibraryPersistence } from "./hooks/useStyleLibraryPersistence";
import { useStartupLayerStyles } from "./hooks/useStartupLayerStyles";
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
  useLastRendererPersistence();
  // Re-renders on language change, so Radix primitives (menus, sliders, tabs)
  // pick up the right-to-left direction together with the document `dir`.
  const { i18n, t } = useTranslation();
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
  useStacUrlLoader(mapAppAPI, layoutOptions.viewer);
  const { showOnboarding, dismissOnboarding } = useUiProfileBootstrap();
  const { pending: pendingUpdate, remindLater, skipVersion } = useStartupUpdateCheck();
  useDesktopSettingsPersistence();
  useThemeScheme();
  useRecentProjectsPersistence();
  const { restoring: restoringStartupProject } = useStartupProject();
  useStyleLibraryPersistence();
  useStartupLayerStyles();
  useLayerLibraryPersistence();
  useTemplateLibraryPersistence();
  useRuntimeEnvironmentVariables();
  useUndoRedoShortcuts();
  useBeforeUnloadGuard();
  useWhiteboxToolUrl();
  return (
    <DirectionProvider dir={languageDirection(i18n.language)}>
      {restoringStartupProject ? (
        // The shell is deliberately unmounted while the startup project loads
        // (see `useStartupProject`), so say what the window is waiting on rather
        // than leaving it blank. `useStartupProject` bounds this state, so it
        // cannot become a permanent splash screen.
        <div
          role="status"
          className="flex h-screen w-screen items-center justify-center gap-3 bg-background text-sm text-muted-foreground"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("settings.startup.restoring")}
        </div>
      ) : (
        <>
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
        </>
      )}
      {/* Mounted once, outside the startup-restore branch, so a failure raised
          while the shell is unmounted still reaches the user. */}
      <NotificationRegion />
      <UpdateNotificationModal
        pending={pendingUpdate}
        onRemindLater={remindLater}
        onSkipVersion={skipVersion}
      />
    </DirectionProvider>
  );
}
