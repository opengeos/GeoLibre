import { useAppStore } from "@geolibre/core";
import { detectGeometryProfile, type MapController } from "@geolibre/map";
import {
  VECTOR_TOOLS,
  getVectorTool,
  runVectorTool,
  fetchVectorStatus,
  type AlgorithmParameter,
  type GeometryFamily,
  type ProcessingAlgorithm,
  type ProcessingContext,
  type VectorToolRequest,
  type VectorToolResult,
} from "@geolibre/processing";
import {
  onPyodideProgress,
  runVectorToolInPyodide,
} from "../../lib/pyodide/pyodide-vector-loader";
import { createDuckDbCapability } from "../../lib/duckdb-processing";
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
  cn,
} from "@geolibre/ui";
import { ParameterField } from "./ParameterField";
import { Loader2, Play, Server } from "lucide-react";
import type { FeatureCollection } from "geojson";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";

interface VectorToolsDialogProps {
  mapControllerRef: React.RefObject<MapController | null>;
}

type Engine = "client" | "sidecar" | "pyodide";

/** Tools grouped by their `group` label, preserving registry order. */
function groupedTools(): { group: string; tools: ProcessingAlgorithm[] }[] {
  const groups: { group: string; tools: ProcessingAlgorithm[] }[] = [];
  for (const tool of VECTOR_TOOLS) {
    const label = tool.group ?? "Tools";
    let entry = groups.find((g) => g.group === label);
    if (!entry) {
      entry = { group: label, tools: [] };
      groups.push(entry);
    }
    entry.tools.push(tool);
  }
  return groups;
}

export function VectorToolsDialog({
  mapControllerRef,
}: VectorToolsDialogProps): ReactElement {
  const openTool = useAppStore((s) => s.ui.vectorToolOpen);
  const setVectorToolOpen = useAppStore((s) => s.setVectorToolOpen);
  const layers = useAppStore((s) => s.layers);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);

  const open = openTool !== null;
  const [selectedId, setSelectedId] = useState<string>(
    openTool ?? VECTOR_TOOLS[0].id,
  );
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [engine, setEngine] = useState<Engine>("client");
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [sidecarAvailable, setSidecarAvailable] = useState<boolean | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  const tool = useMemo(
    () => getVectorTool(selectedId) ?? VECTOR_TOOLS[0],
    [selectedId],
  );

  // One DuckDB capability per dialog instance; the H3 tools use it via ctx.
  const duckdb = useMemo(() => createDuckDbCapability(), []);

  // When the menu opens the dialog with a specific tool, preselect it.
  useEffect(() => {
    if (openTool) setSelectedId(openTool);
  }, [openTool]);

  // Reset parameters to the selected tool's defaults whenever it changes.
  useEffect(() => {
    const defaults: Record<string, unknown> = {};
    for (const param of tool.parameters) {
      if (param.default !== undefined) defaults[param.id] = param.default;
    }
    setParams(defaults);
    setLog([]);
    // Pick the engine that can actually run this tool: sidecar-only tools (e.g.
    // Reproject, whose client run just defers) default to "sidecar" so Run
    // produces a result without touching the selector; client-only tools force
    // "client". requiresSidecar is checked first so it wins even if a tool ever
    // sets it without supportsSidecar (the JSDoc says it implies supportsSidecar).
    if (tool.requiresSidecar) setEngine("sidecar");
    else if (!tool.supportsSidecar) setEngine("client");
  }, [tool]);

  // Prefill the H3 grid's manual bounding-box fields from the current map
  // viewport when the user first switches to that source, so they can tweak the
  // box rather than type it from scratch. Only fills empty fields, so it never
  // clobbers manual edits. Keyed on the source value, not every keystroke.
  useEffect(() => {
    if (selectedId !== "h3-grid" || params.source !== "bbox") return;
    if (
      params.west !== undefined ||
      params.south !== undefined ||
      params.east !== undefined ||
      params.north !== undefined
    )
      return;
    const map = mapControllerRef.current?.getMap();
    if (!map) return;
    const b = map.getBounds();
    const round = (n: number) => Number(n.toFixed(6));
    setParams((prev) => ({
      ...prev,
      west: round(b.getWest()),
      south: round(b.getSouth()),
      east: round(b.getEast()),
      north: round(b.getNorth()),
    }));
    // params.west/south/east/north are read as a one-time guard; re-running only
    // when the source changes is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, params.source, mapControllerRef]);

  // Probe the sidecar's vector capability when the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchVectorStatus()
      .then((status) => {
        if (!cancelled) setSidecarAvailable(status.available);
      })
      .catch(() => {
        if (!cancelled) setSidecarAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

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

  // Attribute-field names per layer, memoized on the layer set (and the dialog
  // being open) so it doesn't recompute on every keystroke. GeoJSON is
  // schemaless, so sample the first FIELD_SCAN_SAMPLE features rather than
  // scanning a whole large layer on the React commit path.
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
  // chosen in its `fieldSource` parameter (default "layer"). O(1) lookup.
  const fieldOptions = useCallback(
    (param: AlgorithmParameter): string[] => {
      const sourceId = params[param.fieldSource ?? "layer"] as
        | string
        | undefined;
      return (sourceId && fieldsByLayer.get(sourceId)) || [];
    },
    [fieldsByLayer, params],
  );

  // Update a parameter. When a layer parameter changes, also clear any
  // `type: "field"` parameter that draws its options from it, so the field
  // dropdown never keeps a value from the previous layer. Doing this at the
  // mutation site (rather than in an effect) avoids re-running on every keystroke
  // and means closing the dialog never wipes a valid selection.
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

  // Whether a parameter should be shown, given another parameter's value
  // (e.g. hide the Value field for is-empty/is-not-empty operators).
  const isParamVisible = useCallback(
    (param: AlgorithmParameter): boolean => {
      const vw = param.visibleWhen;
      if (!vw) return true;
      const current = params[vw.param] as string | undefined;
      if ("in" in vw) return current != null && vw.in.includes(current);
      return current == null || !vw.notIn.includes(current);
    },
    [params],
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

  // Shared tail for the two Python engines (sidecar and Pyodide): both take the
  // same {tool_id, geojson, overlay, parameters} request and return
  // {geojson, messages}. Resolve the layers, invoke, then validate and add the
  // result. `label` describes where it ran, for the log line.
  const runRemoteEngine = useCallback(
    async (
      label: string,
      invoke: (request: VectorToolRequest) => Promise<VectorToolResult>,
    ) => {
      const inputLayer = layers.find((l) => l.id === params.layer);
      const overlayLayer = layers.find((l) => l.id === params.overlay);
      // A layer may have been removed from the project after the dialog opened;
      // bail out with a clear message instead of sending null GeoJSON.
      if (!inputLayer?.geojson) {
        appendLog("Error: input layer no longer exists in the project");
        return;
      }
      if (params.overlay && !overlayLayer?.geojson) {
        appendLog("Error: overlay layer no longer exists in the project");
        return;
      }
      appendLog(`Running "${tool.name}" ${label}...`);
      const result = await invoke({
        tool_id: tool.id,
        geojson: inputLayer.geojson,
        overlay: overlayLayer?.geojson,
        parameters: params,
      });
      for (const message of result.messages) appendLog(message);
      // The engine response is untyped JSON; verify it is a FeatureCollection
      // before handing it to the map.
      const remoteResult = result.geojson as
        | { type?: string; features?: unknown }
        | null;
      if (
        remoteResult?.type === "FeatureCollection" &&
        Array.isArray(remoteResult.features)
      ) {
        addResultLayer(tool.name, remoteResult as unknown as FeatureCollection);
      } else {
        appendLog("Error: engine returned invalid GeoJSON");
      }
    },
    [layers, params, tool, appendLog, addResultLayer],
  );

  const handleRun = useCallback(async () => {
    setLog([]);
    // Validate required parameters before doing any work.
    for (const param of tool.parameters) {
      if (!param.required || !isParamVisible(param)) continue;
      const value = params[param.id];
      if (
        value === undefined ||
        value === "" ||
        value === null ||
        (param.type === "number" && Number.isNaN(value))
      ) {
        appendLog(`Error: "${param.label}" is required`);
        return;
      }
    }

    setRunning(true);
    try {
      if (engine === "sidecar") {
        await runRemoteEngine("on the Python sidecar", runVectorTool);
      } else if (engine === "pyodide") {
        // Progress phases (one-time runtime + GeoPandas download) stream into
        // the log; the subscription is dropped once the run finishes.
        const unsubscribe = onPyodideProgress((phase) =>
          appendLog(`${phase}...`),
        );
        try {
          await runRemoteEngine(
            "in your browser (Pyodide)",
            runVectorToolInPyodide,
          );
        } finally {
          unsubscribe();
        }
      } else {
        const ctx: ProcessingContext = {
          layers,
          parameters: params,
          log: appendLog,
          fitBounds: (bounds) => mapControllerRef.current?.fitBounds(bounds),
          addResultLayer,
          duckdb,
          viewportBounds: () => {
            const map = mapControllerRef.current?.getMap();
            if (!map) return null;
            const b = map.getBounds();
            return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
          },
        };
        await tool.run(ctx);
      }
    } catch (error) {
      appendLog(`Error: ${(error as Error).message}`);
    } finally {
      setRunning(false);
    }
  }, [
    tool,
    params,
    engine,
    layers,
    appendLog,
    addResultLayer,
    runRemoteEngine,
    mapControllerRef,
    isParamVisible,
    duckdb,
  ]);

  const groups = useMemo(groupedTools, []);

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        if (!next) setVectorToolOpen(null);
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Vector tools</DialogTitle>
          <DialogDescription>
            Run common vector geometry operations on your GeoJSON layers.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-4">
          {/* Tool list */}
          <ScrollArea className="h-[22rem] w-48 shrink-0 rounded-md border">
            <div className="p-1">
              {groups.map((group) => (
                <div key={group.group} className="mb-1">
                  <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
                    {group.group}
                  </div>
                  {group.tools.map((entry) => (
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
              ))}
            </div>
          </ScrollArea>

          {/* Parameter form + run + log */}
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <p className="text-sm text-muted-foreground">{tool.description}</p>

            <div className="flex flex-col gap-3">
              {tool.parameters.filter(isParamVisible).map((param) => (
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

            {tool.supportsSidecar || tool.requiresSidecar ? (
              <div className="flex flex-col gap-1">
                <Label className="flex items-center gap-1.5 text-xs">
                  <Server className="h-3.5 w-3.5" /> Engine
                </Label>
                <Select
                  value={engine}
                  onChange={(e) => setEngine(e.target.value as Engine)}
                >
                  {/* requiresSidecar tools (e.g. Reproject) have no working client
                      path, so don't let the user pick a dead-end engine. */}
                  <option value="client" disabled={tool.requiresSidecar}>
                    Client (Turf.js)
                  </option>
                  <option value="sidecar">Sidecar (GeoPandas)</option>
                  <option value="pyodide">Python (Pyodide)</option>
                </Select>
                {engine === "sidecar" && sidecarAvailable === null ? (
                  <p className="text-xs text-muted-foreground">
                    Checking sidecar availability...
                  </p>
                ) : null}
                {engine === "sidecar" && sidecarAvailable === false ? (
                  <p className="text-xs text-destructive">
                    The GeoPandas sidecar is not available. Start the sidecar
                    with the vector extra, or switch to
                    {tool.requiresSidecar
                      ? " Python (Pyodide)."
                      : " the client engine."}
                  </p>
                ) : null}
                {engine === "pyodide" ? (
                  <p className="text-xs text-muted-foreground">
                    Runs GeoPandas in your browser. The first run downloads the
                    Python runtime (one-time, needs an internet connection).
                  </p>
                ) : null}
              </div>
            ) : null}

            <div>
              <Button
                onClick={handleRun}
                disabled={
                  running ||
                  (engine === "sidecar" && sidecarAvailable !== true)
                }
                className="gap-2"
              >
                {running ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                Run
              </Button>
            </div>

            <ScrollArea className="h-24 rounded-md border bg-muted/30 p-2 font-mono text-xs">
              {log.length === 0 ? (
                <span className="text-muted-foreground">
                  Output will appear here.
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
