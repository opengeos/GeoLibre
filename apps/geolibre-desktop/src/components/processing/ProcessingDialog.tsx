import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  ALGORITHMS,
  getAlgorithm,
} from "@geolibre/processing";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Label,
  ScrollArea,
  Select,
} from "@geolibre/ui";
import { useState } from "react";

interface ProcessingDialogProps {
  mapControllerRef: React.RefObject<MapController | null>;
}

export function ProcessingDialog({
  mapControllerRef,
}: ProcessingDialogProps) {
  const open = useAppStore((s) => s.ui.processingOpen);
  const setProcessingOpen = useAppStore((s) => s.setProcessingOpen);
  const layers = useAppStore((s) => s.layers);

  const [algorithmId, setAlgorithmId] = useState(ALGORITHMS[0]?.id ?? "");
  const [layerId, setLayerId] = useState("");
  const [logs, setLogs] = useState<string[]>([]);

  const geojsonLayers = layers.filter((l) => l.geojson);
  const algorithm = getAlgorithm(algorithmId);

  const run = async () => {
    if (!algorithm) return;
    const log = (msg: string) =>
      setLogs((prev) => [
        ...prev,
        `[${new Date().toLocaleTimeString()}] ${msg}`,
      ]);
    log(`Running ${algorithm.name}…`);
    await algorithm.run({
      layers,
      parameters: { layer: layerId || geojsonLayers[0]?.id },
      log,
      fitBounds: (bounds) => mapControllerRef.current?.fitBounds(bounds),
    });
  };

  return (
    <Dialog open={open} onOpenChange={setProcessingOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Processing toolbox</DialogTitle>
          <DialogDescription>
            Run geoprocessing algorithms locally. Python sidecar optional.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Algorithm</Label>
            <Select
              className="mt-1"
              value={algorithmId}
              onChange={(e) => setAlgorithmId(e.target.value)}
            >
              {ALGORITHMS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
            {algorithm && (
              <p className="mt-1 text-xs text-muted-foreground">
                {algorithm.description}
              </p>
            )}
          </div>
          <div>
            <Label>Layer</Label>
            <Select
              className="mt-1"
              value={layerId || geojsonLayers[0]?.id || ""}
              onChange={(e) => setLayerId(e.target.value)}
            >
              {geojsonLayers.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>
          <Button onClick={run} disabled={geojsonLayers.length === 0}>
            Run
          </Button>
          <div>
            <Label>Log</Label>
            <ScrollArea className="mt-1 h-32 rounded-md border bg-muted/30 p-2 font-mono text-xs">
              {logs.length === 0 ? (
                <span className="text-muted-foreground">No output yet.</span>
              ) : (
                logs.map((line, i) => <div key={i}>{line}</div>)
              )}
            </ScrollArea>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
