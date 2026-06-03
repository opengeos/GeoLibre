import { DesktopShell } from "./components/layout/DesktopShell";
import { useDesktopSettingsPersistence } from "./hooks/useDesktopSettings";
import { useLayoutOptions } from "./hooks/useLayoutOptions";
import { useExternalPluginsReady } from "./hooks/usePlugins";
import { useProjectUrlLoader } from "./hooks/useProjectUrlLoader";
import { useRecentProjectsPersistence } from "./hooks/useRecentProjectsPersistence";
import { useRuntimeEnvironmentVariables } from "./hooks/useRuntimeEnvironmentVariables";
import { useThemeMode } from "./hooks/useThemeMode";

export default function App() {
  const layoutOptions = useLayoutOptions();
  const { themeMode, toggleThemeMode } = useThemeMode();
  const projectUrlLoadState = useProjectUrlLoader();

  useDesktopSettingsPersistence();
  // Triggers the external plugin scan; the readiness flag is consumed in
  // DesktopShell to gate project plugin state restoration.
  useExternalPluginsReady();
  useRecentProjectsPersistence();
  useRuntimeEnvironmentVariables();
  return (
    <DesktopShell
      layoutOptions={layoutOptions}
      projectUrlLoadState={projectUrlLoadState}
      themeMode={themeMode}
      onToggleThemeMode={toggleThemeMode}
    />
  );
}
