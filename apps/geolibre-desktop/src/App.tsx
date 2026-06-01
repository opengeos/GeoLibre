import { DesktopShell } from "./components/layout/DesktopShell";
import { useLayoutOptions } from "./hooks/useLayoutOptions";
import { usePlugins } from "./hooks/usePlugins";
import { useProjectUrlLoader } from "./hooks/useProjectUrlLoader";
import { useThemeMode } from "./hooks/useThemeMode";

export default function App() {
  const layoutOptions = useLayoutOptions();
  const { themeMode, toggleThemeMode } = useThemeMode();
  const projectUrlLoadState = useProjectUrlLoader();

  usePlugins();
  return (
    <DesktopShell
      layoutOptions={layoutOptions}
      projectUrlLoadState={projectUrlLoadState}
      themeMode={themeMode}
      onToggleThemeMode={toggleThemeMode}
    />
  );
}
