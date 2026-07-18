import { useTranslation } from "react-i18next";
import {
  useAppStore,
  type GeoLibreLayer,
  type ProcessingModel,
  type ProcessingModelStep,
} from "@geolibre/core";
import { detectGeometryProfile, type MapController } from "@geolibre/map";
import {
  VECTOR_TOOLS,
  getVectorTool,
  runAlgorithmCapture,
  runModel,
  type AlgorithmParameter,
  type GeometryFamily,
  type ProcessingAlgorithm,
  type RunnerHost,
} from "@geolibre/processing";
import { createDuckDbCapability } from "../../lib/duckdb-processing";
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
  Separator,
  cn,
} from "@geolibre/ui";
import { ParameterField } from "./ParameterField";
import {
  ArrowDown,
  ArrowUp,
  Layers,
  Loader2,
  Play,
  Plus,
  Save,
  Trash2,
  Workflow,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

interface ModelBuilderDialogProps {
  mapControllerRef: React.RefObject<MapController | null>;
}

/** The conventional id of a tool's primary input layer parameter. */
const PRIMARY_INPUT_PARAM = "layer";
/** Sample size when scanning a layer's attribute field names. */
const FIELD_SCAN_SAMPLE = 1000;

/** A best-effort unique id (webview always has crypto.randomUUID). */
function createId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `id-${Math.floor(performance.now())}-${VECTOR_TOOLS.length}`;
}

/** Vector tools grouped by their `group` label, preserving registry order. */
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

/** Render a `<select>`'s tool options grouped by registry group. */
function ToolOptions(): ReactElement {
  return (
    <>
      {groupedTools().map((group) => (
        <optgroup key={group.group} label={group.group}>
          {group.tools.map((tool) => (
            <option key={tool.id} value={tool.id}>
              {tool.name}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

/** GeoJSON layers usable as inputs, optionally filtered by geometry family. */
function geojsonLayers(layers: GeoLibreLayer[], filter?: GeometryFamily[]): GeoLibreLayer[] {
  return layers.filter((layer) => {
    if (layer.type !== "geojson" || !layer.geojson) return false;
    if (!filter?.length) return true;
    const profile = detectGeometryProfile(layer.geojson);
    return filter.some(
      (family) =>
        (family === "point" && profile.hasPoint) ||
        (family === "line" && profile.hasLine) ||
        (family === "polygon" && profile.hasPolygon),
    );
  });
}

/** Default parameter values for a tool, keyed by parameter id. */
function defaultParams(tool: ProcessingAlgorithm): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const param of tool.parameters) {
    if (param.default !== undefined) out[param.id] = param.default;
  }
  return out;
}

/** Whether a parameter is visible given the current parameter values. */
function isParamVisible(param: AlgorithmParameter, params: Record<string, unknown>): boolean {
  const vw = param.visibleWhen;
  if (!vw) return true;
  const current = params[vw.param] as string | undefined;
  if ("in" in vw) return current != null && vw.in.includes(current);
  return current == null || !vw.notIn.includes(current);
}

/** Attribute field names per GeoJSON layer, sampled for schemaless data. */
function useFieldsByLayer(layers: GeoLibreLayer[], enabled: boolean): Map<string, string[]> {
  return useMemo(() => {
    const map = new Map<string, string[]>();
    if (!enabled) return map;
    for (const layer of layers) {
      if (layer.type !== "geojson" || !layer.geojson) continue;
      const keys = new Set<string>();
      for (const feature of layer.geojson.features.slice(0, FIELD_SCAN_SAMPLE)) {
        for (const key of Object.keys(feature.properties ?? {})) keys.add(key);
      }
      map.set(layer.id, [...keys]);
    }
    return map;
  }, [layers, enabled]);
}

/** Read the current map viewport as [west, south, east, north]. */
function viewportBoundsReader(
  mapControllerRef: React.RefObject<MapController | null>,
): () => [number, number, number, number] | null {
  return () => {
    const map = mapControllerRef.current?.getMap();
    if (!map) return null;
    const b = map.getBounds();
    return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  };
}

/**
 * Batch and pipeline runner UI (issue #344). Two modes share the vector-tools
 * registry and run on the client engine:
 *
 * - **Batch**: apply one tool across many input layers with shared parameters.
 * - **Models**: chain tools so each step's output feeds the next; saved with the
 *   project and re-runnable.
 */
export function ModelBuilderDialog({ mapControllerRef }: ModelBuilderDialogProps): ReactElement {
  const open = useAppStore((s) => s.ui.modelBuilderOpen);
  const setOpen = useAppStore((s) => s.setModelBuilderOpen);
  const [mode, setMode] = useState<"batch" | "models">("batch");

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        if (!next) setOpen(false);
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Batch &amp; Models</DialogTitle>
          <DialogDescription>
            Run a vector tool across many layers, or chain tools into a reusable model saved with
            your project.
          </DialogDescription>
        </DialogHeader>

        <div className="inline-flex w-fit rounded-md border p-0.5 text-sm">
          <button
            type="button"
            onClick={() => setMode("batch")}
            className={cn(
              "flex items-center gap-1.5 rounded px-3 py-1 transition-colors",
              mode === "batch"
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Layers className="h-3.5 w-3.5" /> Batch
          </button>
          <button
            type="button"
            onClick={() => setMode("models")}
            className={cn(
              "flex items-center gap-1.5 rounded px-3 py-1 transition-colors",
              mode === "models"
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Workflow className="h-3.5 w-3.5" /> Models
          </button>
        </div>

        {mode === "batch" ? (
          <BatchPanel mapControllerRef={mapControllerRef} />
        ) : (
          <ModelPanel mapControllerRef={mapControllerRef} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Output log shared by both panels. */
function LogView({ log }: { log: string[] }): ReactElement {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [log]);
  return (
    <ScrollArea className="h-24 rounded-md border bg-muted/30 p-2 font-mono text-xs">
      {log.length === 0 ? (
        <span className="text-muted-foreground">Output will appear here.</span>
      ) : (
        log.map((line, index) => (
          <div key={index} className="whitespace-pre-wrap">
            {line}
          </div>
        ))
      )}
      <div ref={endRef} />
    </ScrollArea>
  );
}

/** Batch mode: one tool over many input layers with shared parameters. */
function BatchPanel({ mapControllerRef }: ModelBuilderDialogProps): ReactElement {
  const layers = useAppStore((s) => s.layers);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const duckdb = useMemo(() => createDuckDbCapability(), []);

  const [toolId, setToolId] = useState<string>(VECTOR_TOOLS[0].id);
  const tool = useMemo(() => getVectorTool(toolId) ?? VECTOR_TOOLS[0], [toolId]);
  const [params, setParams] = useState<Record<string, unknown>>(() => defaultParams(tool));
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  const appendLog = useCallback((message: string) => setLog((prev) => [...prev, message]), []);

  // Reset parameters and selection when the tool changes.
  useEffect(() => {
    setParams(defaultParams(tool));
    setSelectedIds([]);
    setLog([]);
  }, [tool]);

  const fieldsByLayer = useFieldsByLayer(layers, true);

  const primaryParam = tool.parameters.find(
    (p) => p.id === PRIMARY_INPUT_PARAM && p.type === "layer",
  );
  const inputLayers = useMemo(
    () => geojsonLayers(layers, primaryParam?.geometryFilter),
    [layers, primaryParam],
  );
  // Every parameter except the primary input, which the batch iterates over.
  const sharedParams = useMemo(
    () => tool.parameters.filter((p) => p.id !== PRIMARY_INPUT_PARAM),
    [tool],
  );

  const layerOptions = useCallback(
    (filter?: GeometryFamily[]) => geojsonLayers(layers, filter),
    [layers],
  );

  // Field options come from the param's source layer; a `field` whose source is
  // the (iterated) primary input samples the first selected layer, assuming the
  // batched layers share a schema.
  const fieldOptions = useCallback(
    (param: AlgorithmParameter): string[] => {
      const sourceId = param.fieldSource ?? PRIMARY_INPUT_PARAM;
      const layerId =
        sourceId === PRIMARY_INPUT_PARAM
          ? selectedIds[0]
          : (params[sourceId] as string | undefined);
      return (layerId && fieldsByLayer.get(layerId)) || [];
    },
    [fieldsByLayer, params, selectedIds],
  );

  const handleParamChange = useCallback(
    (id: string, value: unknown) => {
      setParams((prev) => {
        const next = { ...prev, [id]: value };
        // Clear any field parameter that drew its options from this layer.
        for (const param of tool.parameters) {
          if (param.type === "field" && (param.fieldSource ?? PRIMARY_INPUT_PARAM) === id) {
            next[param.id] = undefined;
          }
        }
        return next;
      });
    },
    [tool],
  );

  const toggleLayer = useCallback((id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const allSelected = inputLayers.length > 0 && selectedIds.length === inputLayers.length;
  const toggleAll = useCallback(() => {
    setSelectedIds(allSelected ? [] : inputLayers.map((l) => l.id));
  }, [allSelected, inputLayers]);

  const handleRun = useCallback(async () => {
    setLog([]);
    if (selectedIds.length === 0) {
      appendLog("Error: select at least one input layer");
      return;
    }
    for (const param of sharedParams) {
      if (!param.required || !isParamVisible(param, params)) continue;
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
    const host: RunnerHost = {
      layers,
      log: appendLog,
      duckdb,
      viewportBounds: viewportBoundsReader(mapControllerRef),
    };
    try {
      let produced = 0;
      for (const id of selectedIds) {
        const layer = layers.find((l) => l.id === id);
        if (!layer) continue;
        appendLog(`Running "${tool.name}" on ${layer.name}...`);
        const output = await runAlgorithmCapture(
          tool,
          { ...params, [PRIMARY_INPUT_PARAM]: id },
          host,
        );
        if (output && output.features.length) {
          addGeoJsonLayer(`${tool.name}: ${layer.name}`, output);
          produced++;
        } else {
          appendLog(`No features produced for ${layer.name}`);
        }
      }
      appendLog(`Batch complete: ${produced}/${selectedIds.length} layer(s) produced output`);
    } catch (error) {
      appendLog(`Error: ${(error as Error).message}`);
    } finally {
      setRunning(false);
    }
  }, [
    selectedIds,
    sharedParams,
    params,
    layers,
    appendLog,
    duckdb,
    mapControllerRef,
    tool,
    addGeoJsonLayer,
  ]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Label className="text-xs">Tool</Label>
        <Select value={toolId} onChange={(e) => setToolId(e.target.value)}>
          <ToolOptions />
        </Select>
        <p className="text-xs text-muted-foreground">{tool.description}</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Shared parameters */}
        <div className="flex flex-col gap-3">
          <Label className="text-xs font-medium">Shared parameters</Label>
          {sharedParams.filter((p) => isParamVisible(p, params)).length === 0 ? (
            <p className="text-xs text-muted-foreground">This tool has no extra parameters.</p>
          ) : (
            sharedParams
              .filter((p) => isParamVisible(p, params))
              .map((param) => (
                <ParameterField
                  key={param.id}
                  param={param}
                  value={params[param.id]}
                  layerOptions={layerOptions(param.geometryFilter)}
                  fieldOptions={param.type === "field" ? fieldOptions(param) : undefined}
                  onChange={(value) => handleParamChange(param.id, value)}
                />
              ))
          )}
        </div>

        {/* Input layers to iterate over */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-medium">Input layers</Label>
            {inputLayers.length > 0 ? (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={toggleAll}
              >
                {allSelected ? "Clear" : "Select all"}
              </button>
            ) : null}
          </div>
          <ScrollArea className="h-44 rounded-md border p-1">
            {inputLayers.length === 0 ? (
              <p className="p-2 text-xs text-muted-foreground">No compatible GeoJSON layers.</p>
            ) : (
              inputLayers.map((layer) => (
                <label
                  key={layer.id}
                  className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-accent"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-input"
                    checked={selectedIds.includes(layer.id)}
                    onChange={() => toggleLayer(layer.id)}
                  />
                  <span className="truncate">{layer.name}</span>
                </label>
              ))
            )}
          </ScrollArea>
        </div>
      </div>

      <div>
        <Button onClick={handleRun} disabled={running} className="gap-2">
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Run batch
        </Button>
      </div>

      <LogView log={log} />
    </div>
  );
}

/** Models mode: chain tools into a saved, re-runnable pipeline. */
function ModelPanel({ mapControllerRef }: ModelBuilderDialogProps): ReactElement {
  const layers = useAppStore((s) => s.layers);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const models = useAppStore((s) => s.models);
  const saveModel = useAppStore((s) => s.saveModel);
  const deleteModel = useAppStore((s) => s.deleteModel);
  const duckdb = useMemo(() => createDuckDbCapability(), []);

  const [draft, setDraft] = useState<ProcessingModel>(() => ({
    id: createId(),
    name: "Untitled model",
    steps: [],
  }));
  const [addToolId, setAddToolId] = useState<string>(VECTOR_TOOLS[0].id);
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  const appendLog = useCallback((message: string) => setLog((prev) => [...prev, message]), []);
  const fieldsByLayer = useFieldsByLayer(layers, true);
  const isSaved = models.some((m) => m.id === draft.id);

  const newDraft = useCallback(() => {
    setDraft({ id: createId(), name: "Untitled model", steps: [] });
    setLog([]);
  }, []);

  const loadModel = useCallback((model: ProcessingModel) => {
    // Deep clone so editing the draft never mutates the stored model.
    setDraft({
      id: model.id,
      name: model.name,
      steps: model.steps.map((s) => ({ ...s, parameters: { ...s.parameters } })),
    });
    setLog([]);
  }, []);

  const addStep = useCallback(() => {
    const tool = getVectorTool(addToolId);
    if (!tool) return;
    setDraft((prev) => ({
      ...prev,
      steps: [...prev.steps, { id: createId(), toolId: tool.id, parameters: defaultParams(tool) }],
    }));
  }, [addToolId]);

  const removeStep = useCallback((stepId: string) => {
    setDraft((prev) => ({
      ...prev,
      steps: prev.steps.filter((s) => s.id !== stepId),
    }));
  }, []);

  const moveStep = useCallback((stepId: string, dir: -1 | 1) => {
    setDraft((prev) => {
      const index = prev.steps.findIndex((s) => s.id === stepId);
      const target = index + dir;
      if (index < 0 || target < 0 || target >= prev.steps.length) return prev;
      const steps = [...prev.steps];
      [steps[index], steps[target]] = [steps[target], steps[index]];
      return { ...prev, steps };
    });
  }, []);

  const updateStepParam = useCallback((stepId: string, paramId: string, value: unknown) => {
    setDraft((prev) => ({
      ...prev,
      steps: prev.steps.map((step) => {
        if (step.id !== stepId) return step;
        const tool = getVectorTool(step.toolId);
        const parameters = { ...step.parameters, [paramId]: value };
        // Clear a field parameter when its source layer changes.
        if (tool) {
          for (const param of tool.parameters) {
            if (param.type === "field" && (param.fieldSource ?? PRIMARY_INPUT_PARAM) === paramId) {
              parameters[param.id] = undefined;
            }
          }
        }
        return { ...step, parameters };
      }),
    }));
  }, []);

  const handleSave = useCallback(() => {
    const name = draft.name.trim();
    if (!name) {
      appendLog("Error: give the model a name before saving");
      return;
    }
    if (draft.steps.length === 0) {
      appendLog("Error: add at least one step before saving");
      return;
    }
    saveModel({ ...draft, name });
    appendLog(`Saved model "${name}"`);
  }, [draft, saveModel, appendLog]);

  const handleDelete = useCallback(() => {
    deleteModel(draft.id);
    appendLog(`Deleted model "${draft.name}"`);
    newDraft();
  }, [deleteModel, draft.id, draft.name, appendLog, newDraft]);

  const handleRun = useCallback(async () => {
    setLog([]);
    if (draft.steps.length === 0) {
      appendLog("Error: the model has no steps");
      return;
    }
    const firstStep = draft.steps[0];
    const inputParam = firstStep.inputParam ?? PRIMARY_INPUT_PARAM;
    const inputId = firstStep.parameters[inputParam];
    if (!inputId || !layers.some((l) => l.id === inputId)) {
      appendLog("Error: pick an input layer for the first step");
      return;
    }

    setRunning(true);
    const host: RunnerHost = {
      layers,
      log: appendLog,
      duckdb,
      viewportBounds: viewportBoundsReader(mapControllerRef),
    };
    try {
      const results = await runModel(draft, host);
      const final = results[results.length - 1];
      if (results.every((r) => !r.error) && final?.output?.features.length) {
        addGeoJsonLayer(draft.name.trim() || final.toolName, final.output);
        appendLog(`Model complete: added "${draft.name.trim()}"`);
      } else if (results.some((r) => r.error)) {
        appendLog("Model stopped before completing (see errors above)");
      } else {
        appendLog("Model produced no features");
      }
    } catch (error) {
      appendLog(`Error: ${(error as Error).message}`);
    } finally {
      setRunning(false);
    }
  }, [draft, layers, appendLog, duckdb, mapControllerRef, addGeoJsonLayer]);

  return (
    <div className="flex gap-4">
      {/* Saved models */}
      <div className="flex w-44 shrink-0 flex-col gap-2">
        <Button variant="outline" size="sm" className="gap-1.5" onClick={newDraft}>
          <Plus className="h-3.5 w-3.5" /> New model
        </Button>
        <ScrollArea className="h-72 rounded-md border p-1">
          {models.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">No saved models yet.</p>
          ) : (
            models.map((model) => (
              <button
                key={model.id}
                type="button"
                onClick={() => loadModel(model)}
                className={cn(
                  "w-full truncate rounded-md px-2 py-1.5 text-start text-sm transition-colors hover:bg-accent",
                  model.id === draft.id && "bg-accent font-medium text-accent-foreground",
                )}
              >
                {model.name || "Untitled model"}
              </button>
            ))
          )}
        </ScrollArea>
      </div>

      {/* Editor */}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="model-name" className="text-xs">
            Model name
          </Label>
          <Input
            id="model-name"
            value={draft.name}
            onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
          />
        </div>

        <ScrollArea className="h-56 rounded-md border p-2">
          {draft.steps.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">
              Add a step to start building the pipeline. The first step reads an input layer; each
              later step receives the previous step&apos;s output.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {draft.steps.map((step, index) => (
                <StepCard
                  key={step.id}
                  step={step}
                  index={index}
                  total={draft.steps.length}
                  layers={layers}
                  fieldsByLayer={fieldsByLayer}
                  onParamChange={(paramId, value) => updateStepParam(step.id, paramId, value)}
                  onRemove={() => removeStep(step.id)}
                  onMove={(dir) => moveStep(step.id, dir)}
                />
              ))}
            </div>
          )}
        </ScrollArea>

        <div className="flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1">
            <Label className="text-xs">Add step</Label>
            <Select value={addToolId} onChange={(e) => setAddToolId(e.target.value)}>
              <ToolOptions />
            </Select>
          </div>
          <Button variant="outline" className="gap-1.5" onClick={addStep}>
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>

        <Separator />

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={handleRun} disabled={running} className="gap-2">
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Run model
          </Button>
          <Button variant="outline" className="gap-2" onClick={handleSave}>
            <Save className="h-4 w-4" /> Save
          </Button>
          <Button variant="outline" className="gap-2" onClick={handleDelete} disabled={!isSaved}>
            <Trash2 className="h-4 w-4" /> Delete
          </Button>
        </div>

        <LogView log={log} />
      </div>
    </div>
  );
}

interface StepCardProps {
  step: ProcessingModelStep;
  index: number;
  total: number;
  layers: GeoLibreLayer[];
  fieldsByLayer: Map<string, string[]>;
  onParamChange: (paramId: string, value: unknown) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}

/** One step in the model editor: its tool, parameters, and reorder controls. */
function StepCard({
  step,
  index,
  total,
  layers,
  fieldsByLayer,
  onParamChange,
  onRemove,
  onMove,
}: StepCardProps): ReactElement {
  const { t } = useTranslation();
  const tool = getVectorTool(step.toolId);
  const inputParam = step.inputParam ?? PRIMARY_INPUT_PARAM;
  const isFirst = index === 0;

  const layerOptions = useCallback(
    (filter?: GeometryFamily[]) => geojsonLayers(layers, filter),
    [layers],
  );

  // The chained input parameter is hidden on every step after the first (the
  // runner supplies it from the previous step's output). Hidden `visibleWhen`
  // parameters are skipped too.
  const visibleParams = (tool?.parameters ?? []).filter((param) => {
    if (!isFirst && param.id === inputParam) return false;
    return isParamVisible(param, step.parameters);
  });

  const fieldOptions = (param: AlgorithmParameter): string[] => {
    const sourceId = param.fieldSource ?? PRIMARY_INPUT_PARAM;
    // A field drawn from the chained input has no resolvable layer on later
    // steps (the upstream output is in-memory only), so offer no options there.
    if (!isFirst && sourceId === inputParam) return [];
    const layerId = step.parameters[sourceId] as string | undefined;
    return (layerId && fieldsByLayer.get(layerId)) || [];
  };

  return (
    <div className="rounded-md border p-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">
          {index + 1}. {tool?.name ?? step.toolId}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-30"
            onClick={() => onMove(-1)}
            disabled={index === 0}
            aria-label={t("processing.modelBuilder.moveStepUp")}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-30"
            onClick={() => onMove(1)}
            disabled={index === total - 1}
            aria-label={t("processing.modelBuilder.moveStepDown")}
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            onClick={onRemove}
            aria-label={t("processing.modelBuilder.removeStep")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {!isFirst ? (
        <p className="mb-2 text-xs text-muted-foreground">Input: ← previous step output</p>
      ) : null}

      {!tool ? (
        <p className="text-xs text-destructive">Unknown tool &quot;{step.toolId}&quot;</p>
      ) : visibleParams.length === 0 ? (
        <p className="text-xs text-muted-foreground">No parameters.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {visibleParams.map((param) => (
            <ParameterField
              key={param.id}
              param={param}
              value={step.parameters[param.id]}
              layerOptions={layerOptions(param.geometryFilter)}
              fieldOptions={param.type === "field" ? fieldOptions(param) : undefined}
              onChange={(value) => onParamChange(param.id, value)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
