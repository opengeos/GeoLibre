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
} from "@geolibre/processing";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  ScrollArea,
  Select,
  cn,
} from "@geolibre/ui";
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

type Engine = "client" | "sidecar";

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
    if (!tool.supportsSidecar) setEngine("client");
  }, [tool]);

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

  const setParam = useCallback(
    (id: string, value: unknown) =>
      setParams((prev) => ({ ...prev, [id]: value })),
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

  const handleRun = useCallback(async () => {
    setLog([]);
    // Validate required parameters before doing any work.
    for (const param of tool.parameters) {
      if (!param.required) continue;
      const value = params[param.id];
      if (value === undefined || value === "" || value === null) {
        appendLog(`Error: "${param.label}" is required`);
        return;
      }
    }

    setRunning(true);
    try {
      if (engine === "sidecar") {
        const inputLayer = layers.find((l) => l.id === params.layer);
        const overlayLayer = layers.find((l) => l.id === params.overlay);
        appendLog(`Running "${tool.name}" on the Python sidecar...`);
        const result = await runVectorTool({
          tool_id: tool.id,
          geojson: inputLayer?.geojson,
          overlay: overlayLayer?.geojson,
          parameters: params,
        });
        for (const message of result.messages) appendLog(message);
        addResultLayer(tool.name, result.geojson as FeatureCollection);
      } else {
        const ctx: ProcessingContext = {
          layers,
          parameters: params,
          log: appendLog,
          fitBounds: (bounds) => mapControllerRef.current?.fitBounds(bounds),
          addResultLayer,
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
    mapControllerRef,
  ]);

  const groups = useMemo(groupedTools, []);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
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
              {tool.parameters.map((param) => (
                <ParameterField
                  key={param.id}
                  param={param}
                  value={params[param.id]}
                  layerOptions={layerOptions(param.geometryFilter)}
                  onChange={(value) => setParam(param.id, value)}
                />
              ))}
            </div>

            {tool.supportsSidecar ? (
              <div className="flex flex-col gap-1">
                <Label className="flex items-center gap-1.5 text-xs">
                  <Server className="h-3.5 w-3.5" /> Engine
                </Label>
                <Select
                  value={engine}
                  onChange={(e) => setEngine(e.target.value as Engine)}
                >
                  <option value="client">Client (Turf.js)</option>
                  <option value="sidecar">Sidecar (GeoPandas)</option>
                </Select>
                {engine === "sidecar" && sidecarAvailable === false ? (
                  <p className="text-xs text-destructive">
                    The GeoPandas sidecar is not available. Start the sidecar
                    with the vector extra, or switch to the client engine.
                  </p>
                ) : null}
              </div>
            ) : null}

            <div>
              <Button
                onClick={handleRun}
                disabled={running}
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

interface ParameterFieldProps {
  param: AlgorithmParameter;
  value: unknown;
  layerOptions: { id: string; name: string }[];
  onChange: (value: unknown) => void;
}

function ParameterField({
  param,
  value,
  layerOptions,
  onChange,
}: ParameterFieldProps): ReactElement {
  const label = (
    <Label htmlFor={param.id} className="text-xs">
      {param.label}
      {param.required ? <span className="text-destructive"> *</span> : null}
    </Label>
  );

  if (param.type === "layer") {
    return (
      <div className="flex flex-col gap-1">
        {label}
        <Select
          id={param.id}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Select a layer...</option>
          {layerOptions.map((layer) => (
            <option key={layer.id} value={layer.id}>
              {layer.name}
            </option>
          ))}
        </Select>
        {param.description ? (
          <p className="text-xs text-muted-foreground">{param.description}</p>
        ) : null}
      </div>
    );
  }

  if (param.type === "select") {
    return (
      <div className="flex flex-col gap-1">
        {label}
        <Select
          id={param.id}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        >
          {param.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>
    );
  }

  if (param.type === "boolean") {
    return (
      <label className="flex items-center gap-2 text-sm" htmlFor={param.id}>
        <input
          id={param.id}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded border-input"
        />
        {param.label}
      </label>
    );
  }

  if (param.type === "number") {
    return (
      <div className="flex flex-col gap-1">
        {label}
        <Input
          id={param.id}
          type="number"
          value={value === undefined || value === null ? "" : String(value)}
          min={param.min}
          max={param.max}
          step={param.step}
          onChange={(e) =>
            onChange(e.target.value === "" ? "" : Number(e.target.value))
          }
        />
      </div>
    );
  }

  // string
  return (
    <div className="flex flex-col gap-1">
      {label}
      <Input
        id={param.id}
        type="text"
        value={(value as string) ?? ""}
        onChange={(e) => onChange(e.target.value)}
      />
      {param.description ? (
        <p className="text-xs text-muted-foreground">{param.description}</p>
      ) : null}
    </div>
  );
}
