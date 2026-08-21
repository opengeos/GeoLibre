import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { detectGeometryProfile, type MapController } from "@geolibre/map";
import {
  VECTOR_TOOLS,
  getVectorTool,
  runAlgorithmCapture,
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
  Label,
  ScrollArea,
  Select,
} from "@geolibre/ui";
import {
  translateParameter,
  translateToolDescription,
  translateToolGroup,
  translateToolName,
} from "../../lib/processing-tool-i18n";
import { ParameterField } from "./ParameterField";
import { Loader2, Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

interface BatchToolsDialogProps {
  mapControllerRef: React.RefObject<MapController | null>;
}

/** The conventional id of a tool's primary input layer parameter. */
const PRIMARY_INPUT_PARAM = "layer";
/** Sample size when scanning a layer's attribute field names. */
const FIELD_SCAN_SAMPLE = 1000;

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
function ToolOptions({ t }: { t: TFunction }): ReactElement {
  return (
    <>
      {groupedTools().map((group) => (
        <optgroup key={group.group} label={translateToolGroup(t, group.group)}>
          {group.tools.map((tool) => (
            <option key={tool.id} value={tool.id}>
              {translateToolName(t, "vector", tool)}
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
 * Batch runner UI (issue #344): apply one vector tool across many input layers
 * with shared parameters, on the client engine. Chaining tools into a model
 * moved to the Model Builder canvas (`model-builder/ModelBuilderPanel.tsx`).
 */
export function BatchToolsDialog({ mapControllerRef }: BatchToolsDialogProps): ReactElement {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.ui.batchToolsOpen);
  const setOpen = useAppStore((s) => s.setBatchToolsOpen);

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        if (!next) setOpen(false);
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("processing.batchTools.title")}</DialogTitle>
          <DialogDescription>{t("processing.batchTools.description")}</DialogDescription>
        </DialogHeader>
        <BatchPanel mapControllerRef={mapControllerRef} />
      </DialogContent>
    </Dialog>
  );
}

/** Output log for a batch run. */
function LogView({ log }: { log: string[] }): ReactElement {
  const { t } = useTranslation();
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [log]);
  return (
    <ScrollArea className="h-24 rounded-md border bg-muted/30 p-2 font-mono text-xs">
      {log.length === 0 ? (
        <span className="text-muted-foreground">
          {t("processing.batchTools.outputPlaceholder")}
        </span>
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
function BatchPanel({ mapControllerRef }: BatchToolsDialogProps): ReactElement {
  const { t } = useTranslation();
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
        <Label className="text-xs">{t("processing.batchTools.tool")}</Label>
        <Select value={toolId} onChange={(e) => setToolId(e.target.value)}>
          <ToolOptions t={t} />
        </Select>
        <p className="text-xs text-muted-foreground">
          {translateToolDescription(t, "vector", tool)}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Shared parameters */}
        <div className="flex flex-col gap-3">
          <Label className="text-xs font-medium">
            {t("processing.batchTools.sharedParameters")}
          </Label>
          {sharedParams.filter((p) => isParamVisible(p, params)).length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("processing.batchTools.noExtraParameters")}
            </p>
          ) : (
            sharedParams
              .filter((p) => isParamVisible(p, params))
              .map((param) => (
                <ParameterField
                  key={param.id}
                  param={translateParameter(t, "vector", tool.id, param)}
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
            <Label className="text-xs font-medium">{t("processing.batchTools.inputLayers")}</Label>
            {inputLayers.length > 0 ? (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={toggleAll}
              >
                {allSelected
                  ? t("processing.batchTools.clearSelection")
                  : t("processing.batchTools.selectAll")}
              </button>
            ) : null}
          </div>
          <ScrollArea className="h-44 rounded-md border p-1">
            {inputLayers.length === 0 ? (
              <p className="p-2 text-xs text-muted-foreground">
                {t("processing.batchTools.noCompatibleLayers")}
              </p>
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
          {t("processing.batchTools.runBatch")}
        </Button>
      </div>

      <LogView log={log} />
    </div>
  );
}
