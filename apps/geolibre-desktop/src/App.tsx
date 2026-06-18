import { DesktopShell } from "./components/layout/DesktopShell";
import { OnboardingDialog } from "./components/layout/OnboardingDialog";
import { useDesktopSettingsPersistence } from "./hooks/useDesktopSettings";
import { useLayoutOptions } from "./hooks/useLayoutOptions";
import { useProjectUrlLoader } from "./hooks/useProjectUrlLoader";
import { useBeforeUnloadGuard } from "./hooks/useBeforeUnloadGuard";
import { useRecentProjectsPersistence } from "./hooks/useRecentProjectsPersistence";
import { useRuntimeEnvironmentVariables } from "./hooks/useRuntimeEnvironmentVariables";
import { useThemeMode } from "./hooks/useThemeMode";
import { useUiProfileBootstrap } from "./hooks/useUiProfileBootstrap";
import { useUndoRedoShortcuts } from "./hooks/useUndoRedoShortcuts";

export default function App() {
  const layoutOptions = useLayoutOptions();
  const { themeMode, toggleThemeMode } = useThemeMode();
  const projectUrlLoadState = useProjectUrlLoader();
  const { showOnboarding, dismissOnboarding } = useUiProfileBootstrap();

  useDesktopSettingsPersistence();
  useRecentProjectsPersistence();
  useRuntimeEnvironmentVariables();
  useUndoRedoShortcuts();
  useBeforeUnloadGuard();
  return (
    <>
      <DesktopShell
        layoutOptions={layoutOptions}
        projectUrlLoadState={projectUrlLoadState}
        themeMode={themeMode}
        onToggleThemeMode={toggleThemeMode}
      />
      <OnboardingDialog open={showOnboarding} onClose={dismissOnboarding} />
    </>
  );
}
