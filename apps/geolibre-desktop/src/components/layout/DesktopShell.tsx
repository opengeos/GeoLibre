import type { MapController } from "@geolibre/map";
import { MapCanvas } from "@geolibre/map";
import { useRef } from "react";
import { AttributeTable } from "../panels/AttributeTable";
import { LayerPanel } from "../panels/LayerPanel";
import { StylePanel } from "../panels/StylePanel";
import { ProcessingDialog } from "../processing/ProcessingDialog";
import { StatusBar } from "./StatusBar";
import { TopToolbar } from "./TopToolbar";

export function DesktopShell() {
  const mapControllerRef = useRef<MapController | null>(null);

  return (
    <div className="flex h-full flex-col bg-background">
      <TopToolbar mapControllerRef={mapControllerRef} />
      <div className="flex min-h-0 flex-1">
        <LayerPanel mapControllerRef={mapControllerRef} />
        <main className="relative min-w-0 flex-1">
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
