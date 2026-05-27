import { DesktopShell } from "./components/layout/DesktopShell";
import { usePlugins } from "./hooks/usePlugins";

export default function App() {
  usePlugins();
  return <DesktopShell />;
}
