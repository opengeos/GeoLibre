import { DesktopShell } from "./components/layout/DesktopShell";
import { usePlugins } from "./hooks/usePlugins";
import { useThemeMode } from "./hooks/useThemeMode";

export default function App() {
  const { themeMode, toggleThemeMode } = useThemeMode();

  usePlugins();
  return (
    <DesktopShell
      themeMode={themeMode}
      onToggleThemeMode={toggleThemeMode}
    />
  );
}
