import type { MapController } from "@geolibre/map";
import { MapCanvas } from "@geolibre/map";
import { useRef } from "react";
import { AttributeTable } from "../panels/AttributeTable";
import { LayerPanel } from "../panels/LayerPanel";
import { StylePanel } from "../panels/StylePanel";
import { ProcessingDialog } from "../processing/ProcessingDialog";
import { StatusBar } from "./StatusBar";
import { TopToolbar } from "./TopToolbar";
import type { ThemeMode } from "../../hooks/useThemeMode";

interface DesktopShellProps {
  themeMode: ThemeMode;
  onToggleThemeMode: () => void;
}

export function DesktopShell({
  themeMode,
  onToggleThemeMode,
}: DesktopShellProps) {
  const mapControllerRef = useRef<MapController | null>(null);

  return (
    <div className="flex h-full flex-col bg-background">
      <TopToolbar
        mapControllerRef={mapControllerRef}
        themeMode={themeMode}
        onToggleThemeMode={onToggleThemeMode}
      />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <LayerPanel mapControllerRef={mapControllerRef} />
        <main className="relative min-h-72 min-w-0 flex-1 md:min-h-0">
          <MapCanvas controllerRef={mapControllerRef} />
        </main>
        <StylePanel />
      </div>
      <AttributeTable />
      <StatusBar />
      <ProcessingDialog mapControllerRef={mapControllerRef} />
    </div>
  );
}
