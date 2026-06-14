import { getRoutingConfig, useAppStore } from "@geolibre/core";
import { detectGeometryProfile, type MapController } from "@geolibre/map";
import {
  NETWORK_TOOLS,
  getNetworkTool,
  type GeometryFamily,
  type ProcessingContext,
} from "@geolibre/processing";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  ScrollArea,
  cn,
} from "@geolibre/ui";
import type { FeatureCollection } from "geojson";
import { Loader2, Play } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import { ParameterField } from "./ParameterField";

interface NetworkToolsDialogProps {
  mapControllerRef: React.RefObject<MapController | null>;
}

/**
 * Processing → Network analysis dialog: isochrones / service areas and OD cost
 * matrices. Runs client-side against a configurable Valhalla routing server and
 * adds the result as a GeoJSON layer. A slimmer sibling of VectorToolsDialog
 * (no sidecar/engine selector); the parameter form is shared via ParameterField.
 *
 * @param props.mapControllerRef - Map controller, used to zoom to result layers.
 */
export function NetworkToolsDialog({
  mapControllerRef,
}: NetworkToolsDialogProps): ReactElement {
  const { t } = useTranslation();
  const openTool = useAppStore((s) => s.ui.networkToolOpen);
  const setNetworkToolOpen = useAppStore((s) => s.setNetworkToolOpen);
  const layers = useAppStore((s) => s.layers);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);

  const open = openTool !== null;
  const [selectedId, setSelectedId] = useState<string>(
    openTool ?? NETWORK_TOOLS[0].id,
  );
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  // Cancels the in-flight run (and any pending routing requests) when the
  // dialog closes or a new run starts, so closing the dialog mid-batch does not
  // keep hitting the server and silently adding result layers.
  const abortRef = useRef<AbortController | null>(null);

  const tool = useMemo(
    () => getNetworkTool(selectedId) ?? NETWORK_TOOLS[0],
    [selectedId],
  );

  // When the menu opens the dialog with a specific tool, preselect it.
  useEffect(() => {
    if (openTool) setSelectedId(openTool);
  }, [openTool]);

  // Reset parameters to the selected tool's defaults whenever it changes. The
  // endpoint is seeded from the live routing config so a project-configured
  // VITE_ROUTING_ENDPOINT wins over the registry's static default.
  useEffect(() => {
    const defaults: Record<string, unknown> = {};
    for (const param of tool.parameters) {
      if (param.id === "endpoint") defaults[param.id] = getRoutingConfig().endpoint;
      else if (param.default !== undefined) defaults[param.id] = param.default;
    }
    setParams(defaults);
    setLog([]);
  }, [tool]);

  // Keep the newest log lines in view as they stream in.
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "end" });
  }, [log]);

  const appendLog = useCallback(
    (message: string) => setLog((prev) => [...prev, message]),
    [],
  );

  const layerOptions = useCallback(
    (filter?: GeometryFamily[]) =>
      layers.filter((layer) => {
        if (layer.type !== "geojson" || !layer.geojson) return false;
        if (!filter?.length) return true;
        const profile = detectGeometryProfile(layer.geojson);
        return filter.some(
          (family) =>
            (family === "point" && profile.hasPoint) ||
            (family === "line" && profile.hasLine) ||
            (family === "polygon" && profile.hasPolygon),
        );
      }),
    [layers],
  );

  const addResultLayer = useCallback(
    (name: string, fc: FeatureCollection) => {
      if (!fc.features.length) {
        appendLog(`No features produced for "${name}"`);
        return;
      }
      const layerId = addGeoJsonLayer(name, fc);
      const layer = useAppStore
        .getState()
        .layers.find((item) => item.id === layerId);
      if (layer) mapControllerRef.current?.fitLayer(layer);
    },
    [addGeoJsonLayer, appendLog, mapControllerRef],
  );

  const handleParamChange = useCallback((id: string, value: unknown) => {
    setParams((prev) => ({ ...prev, [id]: value }));
  }, []);

  const handleRun = useCallback(async () => {
    setLog([]);
    for (const param of tool.parameters) {
      if (!param.required) continue;
      const value = params[param.id];
      if (
        value === undefined ||
        value === "" ||
        value === null ||
        (param.type === "number" &&
          typeof value === "number" &&
          Number.isNaN(value))
      ) {
        appendLog(`Error: "${param.label}" is required`);
        return;
      }
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    try {
      const ctx: ProcessingContext = {
        layers,
        parameters: params,
        log: appendLog,
        fitBounds: (bounds) => mapControllerRef.current?.fitBounds(bounds),
        addResultLayer,
        signal: controller.signal,
      };
      await tool.run(ctx);
    } catch (error) {
      appendLog(`Error: ${(error as Error).message}`);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setRunning(false);
    }
  }, [tool, params, layers, appendLog, addResultLayer, mapControllerRef]);

  const endpoint = (params.endpoint as string) || getRoutingConfig().endpoint;

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        if (!next) {
          abortRef.current?.abort();
          abortRef.current = null;
          setNetworkToolOpen(null);
        }
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("network.title")}</DialogTitle>
          <DialogDescription>{t("network.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex gap-4">
          {/* Tool list */}
          <ScrollArea className="h-[22rem] w-48 shrink-0 rounded-md border">
            <div className="p-1">
              <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
                {t("network.heading")}
              </div>
              {NETWORK_TOOLS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setSelectedId(entry.id)}
                  className={cn(
                    "w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                    entry.id === selectedId &&
                      "bg-accent font-medium text-accent-foreground",
                  )}
                >
                  {entry.name}
                </button>
              ))}
            </div>
          </ScrollArea>

          {/* Parameter form + run + log */}
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <p className="text-sm text-muted-foreground">{tool.description}</p>

            <div className="flex flex-col gap-3">
              {tool.parameters.map((param) => (
                <ParameterField
                  key={param.id}
                  param={param}
                  value={params[param.id]}
                  layerOptions={layerOptions(param.geometryFilter)}
                  onChange={(value) => handleParamChange(param.id, value)}
                />
              ))}
            </div>

            <p className="text-xs text-muted-foreground">
              {t("network.endpointNotice", { endpoint })}
            </p>

            <div>
              <Button onClick={handleRun} disabled={running} className="gap-2">
                {running ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                {t("network.run")}
              </Button>
            </div>

            <ScrollArea className="h-24 rounded-md border bg-muted/30 p-2 font-mono text-xs">
              {log.length === 0 ? (
                <span className="text-muted-foreground">
                  {t("network.outputPlaceholder")}
                </span>
              ) : (
                log.map((line, index) => (
                  <div key={index} className="whitespace-pre-wrap">
                    {line}
                  </div>
                ))
              )}
              <div ref={logEndRef} />
            </ScrollArea>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
