import { DesktopShell } from "./components/layout/DesktopShell";
import { usePlugins } from "./hooks/usePlugins";
import { useProjectUrlLoader } from "./hooks/useProjectUrlLoader";
import { useThemeMode } from "./hooks/useThemeMode";

export default function App() {
  const { themeMode, toggleThemeMode } = useThemeMode();
  const projectUrlLoadState = useProjectUrlLoader();

  usePlugins();
  return (
    <DesktopShell
      projectUrlLoadState={projectUrlLoadState}
      themeMode={themeMode}
      onToggleThemeMode={toggleThemeMode}
    />
  );
}
