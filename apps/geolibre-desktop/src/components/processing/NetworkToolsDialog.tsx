import { getRoutingConfig, useAppStore } from "@geolibre/core";
import { detectGeometryProfile, type MapController } from "@geolibre/map";
import {
  NETWORK_TOOLS,
  getNetworkTool,
  type AlgorithmParameter,
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
import {
  beginProcessingRun,
  type ProcessingRunTracker,
} from "../../lib/processing-history";
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
  const rerun = useAppStore((s) => s.ui.processingRerun);
  const setProcessingRerun = useAppStore((s) => s.setProcessingRerun);

  const open = openTool !== null;
  const [selectedId, setSelectedId] = useState<string>(
    openTool ?? NETWORK_TOOLS[0].id,
  );
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [autoRunPending, setAutoRunPending] = useState(false);
  const runTrackerRef = useRef<ProcessingRunTracker | null>(null);
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

  // Pre-fill from a pending History re-run once the requested tool is selected.
  // Declared after the defaults-reset effect above so the recorded parameters
  // win over the defaults when both effects fire in the same commit.
  useEffect(() => {
    if (!open || !rerun || rerun.kind !== "network") return;
    // A saved-project history entry can reference a tool that was renamed or
    // removed since; drop the request instead of leaving it pending forever.
    if (!getNetworkTool(rerun.toolId)) {
      setLog((prev) => [
        ...prev,
        `Error: ${t("processing.history.toolUnavailable", { toolId: rerun.toolId })}`,
      ]);
      setProcessingRerun(null);
      return;
    }
    if (rerun.toolId !== tool.id) return;
    setParams({ ...rerun.parameters });
    setProcessingRerun(null);
    if (rerun.autoRun) setAutoRunPending(true);
  }, [open, rerun, tool, setProcessingRerun, t]);

  // Keep the newest log lines in view as they stream in.
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "end" });
  }, [log]);

  // Client tools report validation failures via ctx.log("Error: ...") plus a
  // plain return rather than throwing; capture the last such line so the run
  // is recorded as failed in the Processing History (#1292). Reset per run.
  const softErrorRef = useRef<string | null>(null);
  const appendLog = useCallback((message: string) => {
    if (message.startsWith("Error:")) {
      softErrorRef.current = message.slice("Error:".length).trim();
    }
    setLog((prev) => [...prev, message]);
  }, []);

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

  // Attribute-field names per layer, memoized on the layer set (and the dialog
  // being open). GeoJSON is schemaless, so sample the first FIELD_SCAN_SAMPLE
  // features rather than scanning a whole large layer on the React commit path.
  const fieldsByLayer = useMemo(() => {
    const FIELD_SCAN_SAMPLE = 1000;
    const map = new Map<string, string[]>();
    if (!open) return map;
    for (const layer of layers) {
      if (layer.type !== "geojson" || !layer.geojson) continue;
      const keys = new Set<string>();
      for (const feature of layer.geojson.features.slice(0, FIELD_SCAN_SAMPLE)) {
        for (const key of Object.keys(feature.properties ?? {})) keys.add(key);
      }
      map.set(layer.id, [...keys]);
    }
    return map;
  }, [layers, open]);

  // Attribute-field options for a `type: "field"` parameter, read from the layer
  // chosen in its `fieldSource` parameter (default "layer").
  const fieldOptions = useCallback(
    (param: AlgorithmParameter): string[] => {
      const sourceId = params[param.fieldSource ?? "layer"] as
        | string
        | undefined;
      return (sourceId && fieldsByLayer.get(sourceId)) || [];
    },
    [fieldsByLayer, params],
  );

  const addResultLayer = useCallback(
    (name: string, fc: FeatureCollection) => {
      if (!fc.features.length) {
        appendLog(`No features produced for "${name}"`);
        return;
      }
      const layerId = addGeoJsonLayer(name, fc);
      runTrackerRef.current?.addOutputLayer(name);
      const layer = useAppStore
        .getState()
        .layers.find((item) => item.id === layerId);
      if (layer) mapControllerRef.current?.fitLayer(layer);
    },
    [addGeoJsonLayer, appendLog, mapControllerRef],
  );

  // Update a parameter. When a layer parameter changes, also clear any
  // `type: "field"` parameter that draws its options from it, so the field
  // dropdown never keeps a value from the previous layer.
  const handleParamChange = useCallback(
    (id: string, value: unknown) => {
      setParams((prev) => {
        const next = { ...prev, [id]: value };
        for (const param of tool.parameters) {
          if (param.type === "field" && (param.fieldSource ?? "layer") === id) {
            next[param.id] = undefined;
          }
        }
        return next;
      });
    },
    [tool],
  );

  const handleRun = useCallback(async () => {
    setLog([]);
    softErrorRef.current = null;
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
    const tracker = beginProcessingRun({
      kind: "network",
      toolId: tool.id,
      toolName: tool.name,
      engine: "client",
      parameters: params,
    });
    runTrackerRef.current = tracker;
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
      // A logged "Error: ..." line marks a soft failure (the client tools
      // bail out without throwing); don't record those as successes.
      if (softErrorRef.current) tracker.finish("error", softErrorRef.current);
      else tracker.finish("success");
    } catch (error) {
      // A user-initiated cancel (closing the dialog or starting a new run)
      // rejects with an AbortError; that is not a failed run, so don't log it
      // or record it in the Processing History.
      if (controller.signal.aborted) return;
      appendLog(`Error: ${(error as Error).message}`);
      tracker.finish("error", (error as Error).message);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setRunning(false);
    }
  }, [tool, params, layers, appendLog, addResultLayer, mapControllerRef]);

  // Auto-run for a History "Re-run": kick off handleRun on the render after the
  // pre-fill effect committed the recorded parameters. The ref always points at
  // the latest handleRun closure, so the run sees the pre-filled state.
  const handleRunRef = useRef(handleRun);
  useEffect(() => {
    handleRunRef.current = handleRun;
  });
  useEffect(() => {
    if (!autoRunPending) return;
    setAutoRunPending(false);
    void handleRunRef.current();
  }, [autoRunPending]);

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
                    "w-full rounded-md px-2 py-1.5 text-start text-sm transition-colors hover:bg-accent",
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
                  fieldOptions={
                    param.type === "field" ? fieldOptions(param) : undefined
                  }
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
