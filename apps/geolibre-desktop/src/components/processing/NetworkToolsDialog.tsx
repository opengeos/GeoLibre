import { isProcessingParameterVisible } from "../../lib/processing-parameter-visibility";
import {
  shouldZoomToNewLayers,
  getRoutingConfig,
  useAppStore,
  useLayersWhen,
} from "@geolibre/core";
import { detectGeometryProfile, type MapEngine } from "@geolibre/map";
import {
  NETWORK_TOOLS,
  getNetworkTool,
  runAlgorithmInBackground,
  type AlgorithmParameter,
  type GeometryFamily,
  type ProcessingContext,
  type ResultLayerOptions,
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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { buildSymbologyStyle } from "../../lib/assistant/symbology";
import { beginProcessingRun, type ProcessingRunTracker } from "../../lib/processing-history";
import { hasRoutingConsent } from "../../lib/routing-consent";
import { uniqueLayerName } from "../../lib/unique-layer-name";
import {
  translateParameter,
  translateToolDescription,
  translateToolName,
} from "../../lib/processing-tool-i18n";
import { ParameterField } from "./ParameterField";

interface NetworkToolsDialogProps {
  mapControllerRef: React.RefObject<MapEngine | null>;
}

/**
 * Processing → Network analysis dialog: isochrones / service areas and OD cost
 * matrices against a configurable Valhalla routing server, plus shortest path,
 * closest facility and service area over a user line layer computed in the
 * browser. Each result is added as a GeoJSON layer. A slimmer sibling of VectorToolsDialog
 * (no sidecar/engine selector); the parameter form is shared via ParameterField.
 *
 * @param props.mapControllerRef - Map controller, used to zoom to result layers.
 */
export function NetworkToolsDialog({ mapControllerRef }: NetworkToolsDialogProps): ReactElement {
  const { t } = useTranslation();
  const openTool = useAppStore((s) => s.ui.networkToolOpen);
  const setNetworkToolOpen = useAppStore((s) => s.setNetworkToolOpen);
  // Layers are only read while the dialog is open; closed, it stays mounted (to
  // keep its form, log and in-flight run) without re-rendering on layer edits.
  const layers = useLayersWhen(openTool !== null);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const setLayerStyle = useAppStore((s) => s.setLayerStyle);
  const rerun = useAppStore((s) => s.ui.processingRerun);
  const setProcessingRerun = useAppStore((s) => s.setProcessingRerun);

  const open = openTool !== null;
  const [selectedId, setSelectedId] = useState<string>(openTool ?? NETWORK_TOOLS[0].id);
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

  const tool = useMemo(() => getNetworkTool(selectedId) ?? NETWORK_TOOLS[0], [selectedId]);

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
      const sourceId = params[param.fieldSource ?? "layer"] as string | undefined;
      return (sourceId && fieldsByLayer.get(sourceId)) || [];
    },
    [fieldsByLayer, params],
  );

  const addResultLayer = useCallback(
    (name: string, fc: FeatureCollection, options?: ResultLayerOptions) => {
      if (!fc.features.length) {
        appendLog(`No features produced for "${name}"`);
        return;
      }
      const layerName = uniqueLayerName(name, useAppStore.getState().layers);
      const layerId = addGeoJsonLayer(layerName, fc);
      runTrackerRef.current?.addOutputLayer(layerName);
      const layer = useAppStore.getState().layers.find((item) => item.id === layerId);
      // Service areas ask for a graduated renderer on their cost break, so the
      // nested areas read apart instead of as one flat color.
      const distinctBreaks = options?.graduatedField
        ? new Set(
            fc.features
              .map((feature) => feature.properties?.[options.graduatedField!])
              .filter((value) => typeof value === "number" && Number.isFinite(value)),
          )
        : null;
      if (layer && options?.graduatedField && distinctBreaks && distinctBreaks.size > 1) {
        try {
          setLayerStyle(
            layerId,
            buildSymbologyStyle(layer, {
              mode: "graduated",
              property: options.graduatedField,
              colorRamp: options.colorRamp ?? "viridis",
              classCount: options.classCount ?? 5,
              scheme: "quantile",
            }),
          );
        } catch (error) {
          appendLog(t("network.styleFailed", { name, reason: (error as Error).message }));
        }
      }
      if (layer && shouldZoomToNewLayers()) mapControllerRef.current?.fitLayer(layer);
    },
    [addGeoJsonLayer, appendLog, mapControllerRef, setLayerStyle, t],
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

  // Hide a parameter whose `visibleWhen` condition is not met (e.g. the cost
  // field while the local-network tools cost edges by length).
  const isParamVisible = useCallback(
    (param: AlgorithmParameter) => isProcessingParameterVisible(param, params),
    [params],
  );
  const handleRun = useCallback(async () => {
    setLog([]);
    softErrorRef.current = null;
    // A local-network tool opens without the routing notice; switching to a
    // server tool inside the dialog must not skip that consent.
    if (tool.parameters.some((param) => param.id === "endpoint") && !hasRoutingConsent()) {
      appendLog(`Error: ${t("network.consentRequired")}`);
      return;
    }
    for (const param of tool.parameters) {
      if (!param.required || !isParamVisible(param)) continue;
      const value = params[param.id];
      if (
        value === undefined ||
        value === "" ||
        value === null ||
        (param.type === "number" && typeof value === "number" && Number.isNaN(value))
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
        // A late result from a cancelled run must not reach the map.
        addResultLayer: (...args) => {
          controller.signal.throwIfAborted();
          addResultLayer(...args);
        },
        signal: controller.signal,
      };
      // The local-network tools build their graph and search it on the
      // processing worker, so a large network no longer freezes the map;
      // Cancel terminates that worker. The Valhalla tools run inline.
      await runAlgorithmInBackground(tool, ctx);
      controller.signal.throwIfAborted();
      // A logged "Error: ..." line marks a soft failure (the client tools
      // bail out without throwing); don't record those as successes.
      if (softErrorRef.current) tracker.finish("error", softErrorRef.current);
      else tracker.finish("success");
    } catch (error) {
      // A user-initiated cancel (closing the dialog, starting a new run or
      // the Cancel button) rejects with an AbortError; that is not a failed
      // run, so don't record it in the Processing History. Only the Cancel
      // button leaves this run's controller current, and only then is the log
      // still on screen to say so.
      if (controller.signal.aborted) {
        if (abortRef.current === controller) appendLog(t("network.cancelled"));
        return;
      }
      appendLog(`Error: ${(error as Error).message}`);
      tracker.finish("error", (error as Error).message);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setRunning(false);
    }
  }, [tool, params, layers, appendLog, addResultLayer, mapControllerRef, isParamVisible, t]);

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
  // Only the Valhalla tools take an endpoint; the local-network tools never
  // send coordinates anywhere.
  const usesRoutingServer = tool.parameters.some((param) => param.id === "endpoint");

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
                    entry.id === selectedId && "bg-accent font-medium text-accent-foreground",
                  )}
                >
                  {translateToolName(t, "network", entry)}
                </button>
              ))}
            </div>
          </ScrollArea>

          {/* Parameter form + run + log */}
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              {translateToolDescription(t, "network", tool)}
            </p>

            <div className="flex flex-col gap-3">
              {tool.parameters.filter(isParamVisible).map((param) => (
                <ParameterField
                  key={param.id}
                  param={translateParameter(t, "network", tool.id, param)}
                  value={params[param.id]}
                  layerOptions={layerOptions(param.geometryFilter)}
                  fieldOptions={param.type === "field" ? fieldOptions(param) : undefined}
                  onChange={(value) => handleParamChange(param.id, value)}
                />
              ))}
            </div>

            <p className="text-xs text-muted-foreground">
              {usesRoutingServer
                ? t("network.endpointNotice", { endpoint })
                : t("network.localNotice")}
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
              {running && (
                <Button
                  variant="outline"
                  className="ms-2"
                  onClick={() => abortRef.current?.abort()}
                >
                  {t("common.cancel")}
                </Button>
              )}
            </div>

            <ScrollArea className="h-24 rounded-md border bg-muted/30 p-2 font-mono text-xs">
              {log.length === 0 ? (
                <span className="text-muted-foreground">{t("network.outputPlaceholder")}</span>
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
