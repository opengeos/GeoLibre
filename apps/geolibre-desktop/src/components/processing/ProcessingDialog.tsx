import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  clearRemoteWhiteboxCatalogSnapshotCache,
  fetchWhiteboxJob,
  fetchWhiteboxJsonOutput,
  fetchRemoteWhiteboxCatalogSnapshot,
  fetchWhiteboxStatus,
  fetchWhiteboxTools,
  runWhiteboxTool,
  type WhiteboxJob,
  type WhiteboxLayerInput,
  type WhiteboxTool,
  type WhiteboxToolParameter,
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
import type { FeatureCollection } from "geojson";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FolderOpen,
  Loader2,
  Play,
  RefreshCw,
  Save,
  Search,
  Server,
  ServerOff,
} from "lucide-react";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  pickLocalPathWithFallback,
  pickSavePathWithFallback,
  type FileDialogFilter,
} from "../../lib/tauri-io";
import { startGeoLibreSidecar, stopGeoLibreSidecar } from "../../lib/sidecar";

interface ProcessingDialogProps {
  mapControllerRef: React.RefObject<MapController | null>;
}

type ParameterValues = Record<string, unknown>;

const LAYER_TOKEN_PREFIX = "layer:";
const RUNNING_JOB_STATUSES = new Set(["pending", "running"]);

function toolLabel(tool: WhiteboxTool): string {
  return tool.display_name || humanize(tool.id);
}

function humanize(value: string): string {
  return (
    value
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Tool"
  );
}

function parameterLabel(param: WhiteboxToolParameter): string {
  return param.description || humanize(param.name);
}

function parameterKind(param: WhiteboxToolParameter): string {
  if (param.kind) return param.kind;
  const schema = param.schema;
  const schemaObject =
    schema && typeof schema === "object"
      ? (schema as Record<string, unknown>)
      : {};
  const dataset =
    schemaObject.dataset && typeof schemaObject.dataset === "object"
      ? (schemaObject.dataset as Record<string, unknown>)
      : {};
  const dataKind = String(
    param.data_kind ?? dataset.kind ?? param.type ?? "",
  ).toLowerCase();
  const role = String(param.io_role ?? schemaObject.kind ?? "").toLowerCase();
  if (role === "input") return datasetParameterKind(dataKind, "in");
  if (role === "output") return datasetParameterKind(dataKind, "out");
  if (dataKind === "bool" || schemaObject.kind === "bool") return "bool";
  if (schemaObject.kind === "enum" || param.options?.length) return "enum";
  if (dataKind === "number" || schemaObject.kind === "scalar") {
    const scalar = String(schemaObject.scalar ?? "").toLowerCase();
    return scalar.includes("int") ? "int" : "double";
  }
  return "string";
}

function datasetParameterKind(dataKind: string, suffix: "in" | "out"): string {
  if (["raster", "vector", "lidar", "file"].includes(dataKind)) {
    return `${dataKind}_${suffix}`;
  }
  return `file_${suffix}`;
}

function isOutputParameter(param: WhiteboxToolParameter): boolean {
  return parameterKind(param).endsWith("_out");
}

function isDataInputParameter(param: WhiteboxToolParameter): boolean {
  return ["raster_in", "vector_in", "lidar_in", "file_in"].includes(
    parameterKind(param),
  );
}

function isPathParameter(param: WhiteboxToolParameter): boolean {
  const kind = parameterKind(param);
  if (isDataInputParameter(param) || isOutputParameter(param)) return true;
  const text = `${param.name} ${param.description ?? ""} ${param.type ?? ""}`.toLowerCase();
  return /\b(path|file|folder|directory)\b/.test(text);
}

function isDirectoryParameter(param: WhiteboxToolParameter): boolean {
  const text = `${param.name} ${param.description ?? ""} ${param.type ?? ""}`.toLowerCase();
  return /\b(folder|directory|dir)\b/.test(text);
}

function pathFiltersForParameter(param: WhiteboxToolParameter): FileDialogFilter[] {
  const kind = parameterKind(param);
  if (kind.startsWith("raster")) {
    return [
      {
        name: "Raster",
        extensions: ["tif", "tiff", "img", "bil", "flt", "sdat", "rdc", "asc"],
      },
    ];
  }
  if (kind.startsWith("vector")) {
    return [
      {
        name: "Vector",
        extensions: [
          "geojson",
          "json",
          "shp",
          "gpkg",
          "fgb",
          "sqlite",
          "gml",
          "kml",
        ],
      },
    ];
  }
  if (kind.startsWith("lidar")) {
    return [
      {
        name: "LiDAR",
        extensions: ["las", "laz", "zlidar", "copc", "e57", "ply"],
      },
    ];
  }
  if (/\b(csv|json|html|txt|xml)\b/i.test(`${param.name} ${param.type ?? ""}`)) {
    return [
      {
        name: "Files",
        extensions: ["csv", "json", "geojson", "html", "txt", "xml"],
      },
    ];
  }
  return [];
}

function acceptForParameter(param: WhiteboxToolParameter): string {
  return pathFiltersForParameter(param)
    .flatMap((filter) => filter.extensions)
    .map((extension) => `.${extension}`)
    .join(",");
}

function outputExtensionForParameter(param: WhiteboxToolParameter): string {
  const kind = parameterKind(param);
  if (kind === "raster_out") return ".tif";
  if (kind === "vector_out") return ".shp";
  if (kind === "lidar_out") return ".laz";
  if (/\bcsv\b/i.test(`${param.name} ${param.type ?? ""}`)) return ".csv";
  if (/\bhtml\b/i.test(`${param.name} ${param.type ?? ""}`)) return ".html";
  if (/\bjson\b/i.test(`${param.name} ${param.type ?? ""}`)) return ".json";
  return ".txt";
}

function defaultOutputName(
  toolId: string,
  param: WhiteboxToolParameter,
): string {
  const stem = `${toolId || "whitebox"}_${param.name || "output"}`
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${stem || "whitebox_output"}${outputExtensionForParameter(param)}`;
}

function isFeatureCollection(value: unknown): value is FeatureCollection {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "FeatureCollection" &&
    Array.isArray((value as { features?: unknown }).features)
  );
}

function layerPath(layer: GeoLibreLayer): string {
  if (layer.sourcePath) return layer.sourcePath;
  const url = layer.source.url;
  if (typeof url === "string") return url;
  const tiles = layer.source.tiles;
  if (Array.isArray(tiles) && typeof tiles[0] === "string") return tiles[0];
  return "";
}

function canUseLayerForParameter(
  layer: GeoLibreLayer,
  param: WhiteboxToolParameter,
): boolean {
  const kind = parameterKind(param);
  if (kind === "vector_in") {
    return Boolean(layer.geojson || layerPath(layer));
  }
  if (kind === "raster_in") {
    return ["raster", "cog", "wms", "wmts", "xyz", "zarr"].includes(
      layer.type,
    );
  }
  if (kind === "lidar_in") return layer.type === "lidar";
  return Boolean(layerPath(layer));
}

function defaultParameterValue(param: WhiteboxToolParameter): unknown {
  if (isOutputParameter(param)) return "";
  if (param.default !== undefined && param.default !== null) return param.default;
  if (parameterKind(param) === "bool") return false;
  return "";
}

function createDefaultValues(tool: WhiteboxTool | null): ParameterValues {
  const values: ParameterValues = {};
  for (const param of tool?.params ?? []) {
    values[param.name] = defaultParameterValue(param);
  }
  return values;
}

function mergeCatalogParameterFallbacks(
  liveTools: WhiteboxTool[],
  snapshotTools: WhiteboxTool[],
): WhiteboxTool[] {
  const snapshotById = new Map(
    snapshotTools.map((tool) => [tool.id, tool] as const),
  );
  return liveTools.map((tool) => {
    if (tool.params?.length) return tool;
    const snapshot = snapshotById.get(tool.id);
    if (!snapshot?.params?.length) return tool;
    return {
      ...tool,
      params: snapshot.params,
      return_type: tool.return_type ?? snapshot.return_type,
    };
  });
}

function outputPath(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    const path = (value as { path?: unknown }).path;
    if (typeof path === "string" && path.trim()) return path.trim();
  }
  return null;
}

function outputEntries(outputs: Record<string, unknown>): [string, string][] {
  return Object.entries(outputs)
    .map(([name, value]) => [name, outputPath(value)] as const)
    .filter((entry): entry is [string, string] => Boolean(entry[1]));
}

function isJsonOutputPath(path: string): boolean {
  return /\.(geojson|json)$/i.test(path);
}

function jobStatusTone(job: WhiteboxJob | null): string {
  if (!job) return "text-muted-foreground";
  if (job.status === "succeeded") return "text-emerald-700";
  if (job.status === "failed") return "text-destructive";
  return "text-primary";
}

export function ProcessingDialog({
  mapControllerRef,
}: ProcessingDialogProps) {
  const open = useAppStore((s) => s.ui.processingOpen);
  const setProcessingOpen = useAppStore((s) => s.setProcessingOpen);
  const layers = useAppStore((s) => s.layers);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);

  const [tools, setTools] = useState<WhiteboxTool[]>([]);
  const [selectedToolId, setSelectedToolId] = useState("");
  const [values, setValues] = useState<ParameterValues>({});
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [loadingTools, setLoadingTools] = useState(false);
  const [runtimeMessage, setRuntimeMessage] = useState("");
  const [runtimeAvailable, setRuntimeAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startingServer, setStartingServer] = useState(false);
  const [stoppingServer, setStoppingServer] = useState(false);
  const [job, setJob] = useState<WhiteboxJob | null>(null);
  const importedJobIdRef = useRef<string | null>(null);

  const selectedTool = useMemo(
    () => tools.find((tool) => tool.id === selectedToolId) ?? tools[0] ?? null,
    [selectedToolId, tools],
  );

  const categories = useMemo(() => {
    const unique = Array.from(
      new Set(tools.map((tool) => tool.category || "General")),
    );
    unique.sort((a, b) => a.localeCompare(b));
    return ["All", ...unique];
  }, [tools]);

  const filteredTools = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return tools.filter((tool) => {
      if (category !== "All" && (tool.category || "General") !== category) {
        return false;
      }
      if (!normalizedQuery) return true;
      return [
        tool.id,
        toolLabel(tool),
        tool.category || "",
        tool.summary || "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [category, query, tools]);

  const loadWhitebox = useCallback(async () => {
    setLoadingTools(true);
    setError(null);
    // Drop the in-memory snapshot so a fresh load reflects upstream catalog
    // changes; calls within this load still dedup once it is repopulated.
    clearRemoteWhiteboxCatalogSnapshotCache();

    const applyRemoteCatalogSnapshot = async (
      message: string,
      available: boolean,
    ) => {
      try {
        const snapshotTools = await fetchRemoteWhiteboxCatalogSnapshot();
        setRuntimeAvailable(available);
        setRuntimeMessage(message);
        setTools(snapshotTools);
        setSelectedToolId((current) =>
          snapshotTools.some((tool) => tool.id === current)
            ? current
            : snapshotTools[0]?.id ?? "",
        );
      } catch (err) {
        setRuntimeAvailable(available);
        setRuntimeMessage(message);
        setTools([]);
        setSelectedToolId("");
        setError(
          err instanceof Error
            ? err.message
            : "Could not load Whitebox catalog snapshot.",
        );
      }
    };

    try {
      const status = await fetchWhiteboxStatus();
      setRuntimeAvailable(status.available);
      setRuntimeMessage(status.message);
      if (!status.available) {
        await applyRemoteCatalogSnapshot(
          `${status.message} Showing GitHub catalog only.`,
          false,
        );
        return;
      }
      let nextTools: WhiteboxTool[];
      try {
        nextTools = await fetchWhiteboxTools();
      } catch (err) {
        await applyRemoteCatalogSnapshot(
          `${
            err instanceof Error ? err.message : "Could not load live catalog."
          } Showing GitHub catalog only.`,
          true,
        );
        return;
      }
      if (nextTools.length === 0) {
        await applyRemoteCatalogSnapshot(
          "Live catalog is empty. Showing GitHub catalog only.",
          true,
        );
        return;
      }
      try {
        const snapshotTools = await fetchRemoteWhiteboxCatalogSnapshot();
        nextTools = mergeCatalogParameterFallbacks(nextTools, snapshotTools);
      } catch {
        // Keep the live catalog when the optional parameter fallback is unavailable.
      }
      setTools(nextTools);
      setSelectedToolId((current) =>
        nextTools.some((tool) => tool.id === current)
          ? current
          : nextTools[0]?.id ?? "",
      );
    } catch (err) {
      setRuntimeAvailable(false);
      await applyRemoteCatalogSnapshot(
        `${
          err instanceof Error ? err.message : "Could not connect to sidecar."
        } Showing GitHub catalog only.`,
        false,
      );
    } finally {
      setLoadingTools(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadWhitebox();
  }, [loadWhitebox, open]);

  useEffect(() => {
    setValues(createDefaultValues(selectedTool));
    setJob(null);
    importedJobIdRef.current = null;
  }, [selectedTool?.id]);

  useEffect(() => {
    if (!job || !RUNNING_JOB_STATUSES.has(job.status)) return;
    // Schedule the next poll only after the current request resolves so a slow
    // sidecar cannot accumulate overlapping, out-of-order in-flight requests.
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        const next = await fetchWhiteboxJob(job.id);
        if (cancelled) return;
        setJob(next);
        if (RUNNING_JOB_STATUSES.has(next.status)) {
          window.setTimeout(poll, 1000);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not poll job.");
        }
      }
    };
    const timer = window.setTimeout(poll, 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [job]);

  const updateValue = (name: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  };

  const importGeoJsonOutputs = useCallback(
    async (nextJob: WhiteboxJob) => {
      if (importedJobIdRef.current === nextJob.id) return;
      importedJobIdRef.current = nextJob.id;
      const entries = Object.entries(nextJob.outputs)
        .map(([name, value]) => [name, outputPath(value)] as const)
        .filter((entry): entry is readonly [string, string] =>
          Boolean(entry[1] && isJsonOutputPath(entry[1])),
        );
      // Resolve the producing tool from the job itself, not the live
      // `selectedTool`, so switching tools while a job finishes does not
      // mislabel the imported layer.
      const jobTool = tools.find((item) => item.id === nextJob.tool_id);
      const jobToolLabel = jobTool
        ? toolLabel(jobTool)
        : humanize(nextJob.tool_id);
      for (const [name, path] of entries) {
        const data = await fetchWhiteboxJsonOutput(path);
        if (!isFeatureCollection(data)) continue;
        const layerId = addGeoJsonLayer(
          `${jobToolLabel} ${humanize(name)}`,
          data,
          path,
        );
        const layer = useAppStore
          .getState()
          .layers.find((item) => item.id === layerId);
        if (layer) mapControllerRef.current?.fitLayer(layer);
      }
    },
    [addGeoJsonLayer, mapControllerRef, tools],
  );

  useEffect(() => {
    if (job?.status !== "succeeded") return;
    void importGeoJsonOutputs(job).catch((err) => {
      setError(
        err instanceof Error ? err.message : "Could not import Whitebox output.",
      );
    });
  }, [importGeoJsonOutputs, job]);

  const runSelectedTool = async () => {
    if (!selectedTool || selectedTool.locked) return;
    setError(null);
    importedJobIdRef.current = null;
    const parameters: Record<string, unknown> = {};
    const layerInputs: Record<string, WhiteboxLayerInput> = {};

    for (const param of selectedTool.params ?? []) {
      const value = values[param.name];
      if (
        param.required &&
        !isOutputParameter(param) &&
        (value === undefined || value === null || value === "")
      ) {
        setError(`Missing required parameter: ${parameterLabel(param)}`);
        return;
      }

      if (typeof value === "string" && value.startsWith(LAYER_TOKEN_PREFIX)) {
        const layerId = value.slice(LAYER_TOKEN_PREFIX.length);
        const layer = layers.find((item) => item.id === layerId);
        if (!layer) continue;
        if (layer.geojson && parameterKind(param) === "vector_in") {
          layerInputs[param.name] = {
            name: layer.name,
            kind: parameterKind(param),
            geojson: layer.geojson,
          };
        } else {
          parameters[param.name] = layerPath(layer);
        }
      } else {
        parameters[param.name] = value;
      }
    }

    try {
      setJob(
        await runWhiteboxTool({
          tool_id: selectedTool.id,
          parameters,
          tool: selectedTool,
          layer_inputs: layerInputs,
          include_pro: false,
          tier: "open",
        }),
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not start Whitebox tool.",
      );
    }
  };

  const startServer = async () => {
    setStartingServer(true);
    setError(null);
    try {
      await startGeoLibreSidecar();
      await loadWhitebox();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not start GeoLibre sidecar.",
      );
    } finally {
      setStartingServer(false);
    }
  };

  const stopServer = async () => {
    setStoppingServer(true);
    setError(null);
    try {
      await stopGeoLibreSidecar();
      setRuntimeAvailable(false);
      setRuntimeMessage("GeoLibre sidecar is stopped. Showing GitHub catalog only.");
      setJob(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not stop GeoLibre sidecar.",
      );
    } finally {
      setStoppingServer(false);
    }
  };

  const running = Boolean(job && RUNNING_JOB_STATUSES.has(job.status));
  const serverBusy = loadingTools || startingServer || stoppingServer;

  return (
    <Dialog open={open} onOpenChange={setProcessingOpen}>
      <DialogContent
        className="h-[min(760px,92vh)] max-w-6xl"
        bodyClassName="grid-rows-[auto_minmax(0,1fr)] gap-3 overflow-hidden p-5"
      >
        <DialogHeader>
          <DialogTitle>Whitebox toolbox</DialogTitle>
          <DialogDescription>
            {runtimeAvailable === null
              ? "Checking runtime."
              : runtimeAvailable
                ? runtimeMessage || `${tools.length} tools available.`
                : runtimeMessage || "Whitebox runtime is unavailable."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 grid-cols-[minmax(260px,320px)_minmax(0,1fr)] gap-4">
          <div className="flex min-h-0 flex-col gap-3 border-r pr-4">
            <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="pl-9"
                  placeholder="Search tools"
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={loadWhitebox}
                disabled={serverBusy}
                title="Refresh catalog"
              >
                <RefreshCw
                  className={cn("h-4 w-4", loadingTools && "animate-spin")}
                />
              </Button>
            </div>

            {runtimeAvailable !== true && (
              <Button
                type="button"
                variant="outline"
                onClick={startServer}
                disabled={serverBusy}
              >
                {startingServer ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Server className="h-4 w-4" />
                )}
                Start server
              </Button>
            )}

            {runtimeAvailable === true && (
              <Button
                type="button"
                variant="outline"
                onClick={stopServer}
                disabled={serverBusy || running}
              >
                {stoppingServer ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ServerOff className="h-4 w-4" />
                )}
                Stop server
              </Button>
            )}

            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {categories.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </Select>

            <ScrollArea className="min-h-0 flex-1 rounded-md border">
              <div className="divide-y">
                {loadingTools ? (
                  <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading
                  </div>
                ) : filteredTools.length === 0 ? (
                  <div className="p-3 text-sm text-muted-foreground">
                    No tools found.
                  </div>
                ) : (
                  filteredTools.map((tool) => (
                    <button
                      key={tool.id}
                      type="button"
                      className={cn(
                        "block w-full px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
                        selectedTool?.id === tool.id && "bg-accent",
                        tool.locked && "opacity-60",
                      )}
                      onClick={() => setSelectedToolId(tool.id)}
                    >
                      <span className="block truncate font-medium">
                        {tool.locked ? "[Locked] " : ""}
                        {toolLabel(tool)}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {tool.category || "General"}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </ScrollArea>
          </div>

          <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-3">
            <div className="min-w-0 border-b pb-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-base font-semibold">
                    {selectedTool ? toolLabel(selectedTool) : "No tool selected"}
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {selectedTool?.id}
                    {selectedTool?.license_tier
                      ? ` | ${selectedTool.license_tier}`
                      : ""}
                  </p>
                </div>
                <Button
                  type="button"
                  onClick={runSelectedTool}
                  disabled={
                    !selectedTool ||
                    selectedTool.locked ||
                    running ||
                    runtimeAvailable !== true
                  }
                >
                  {running ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  Run
                </Button>
              </div>
              {selectedTool?.summary && (
                <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                  {selectedTool.summary}
                </p>
              )}
              {selectedTool?.locked && (
                <p className="mt-2 flex items-center gap-2 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4" />
                  {selectedTool.locked_reason || "This tool is locked."}
                </p>
              )}
            </div>

            <ScrollArea className="min-h-0">
              <div className="grid gap-4 pb-2 pr-5">
                {(selectedTool?.params ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    This tool has no parameters.
                  </p>
                ) : (
                  selectedTool?.params?.map((param) => (
                    <ParameterField
                      key={param.name}
                      param={param}
                      layers={layers}
                      toolId={selectedTool.id}
                      value={values[param.name]}
                      onChange={(value) => updateValue(param.name, value)}
                    />
                  ))
                )}
              </div>
            </ScrollArea>

            <div className="grid gap-2 border-t pt-3">
              {error && (
                <p className="flex items-center gap-2 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4" />
                  {error}
                </p>
              )}
              {job && (
                <JobOutputPanel job={job} />
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function JobOutputPanel({ job }: { job: WhiteboxJob }) {
  const outputs = outputEntries(job.outputs);
  const hasMessages = job.messages.length > 0;
  const hasOutputs = outputs.length > 0;

  return (
    <div className="grid gap-2">
      <p
        className={cn(
          "flex items-center gap-2 text-sm font-medium",
          jobStatusTone(job),
        )}
      >
        {job.status === "succeeded" ? (
          <CheckCircle2 className="h-4 w-4" />
        ) : job.status === "failed" ? (
          <AlertCircle className="h-4 w-4" />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin" />
        )}
        {job.status}
        {job.error ? `: ${job.error}` : ""}
      </p>
      <ScrollArea className="h-24 rounded-md border bg-muted/30 p-2 font-mono text-xs">
        {!hasMessages && !hasOutputs ? (
          <span className="text-muted-foreground">No output yet.</span>
        ) : null}
        {job.messages.map((line, index) => (
          <div key={`${index}-${line}`}>{line}</div>
        ))}
        {outputs.map(([name, path]) => (
          <div key={name}>{`${name}: ${path}`}</div>
        ))}
      </ScrollArea>
    </div>
  );
}

interface ParameterFieldProps {
  param: WhiteboxToolParameter;
  layers: GeoLibreLayer[];
  onChange: (value: unknown) => void;
  toolId: string;
  value: unknown;
}

function ParameterField({
  param,
  layers,
  onChange,
  toolId,
  value,
}: ParameterFieldProps) {
  const kind = parameterKind(param);
  const availableLayers = layers.filter((layer) =>
    canUseLayerForParameter(layer, param),
  );
  const label = parameterLabel(param);
  const valueText = value === undefined || value === null ? "" : String(value);

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={`whitebox-${param.name}`}>{label}</Label>
        <span className="shrink-0 text-xs text-muted-foreground">
          {kind}
          {param.required && !isOutputParameter(param) ? " | required" : ""}
        </span>
      </div>

      {kind === "bool" ? (
        <label className="flex h-9 items-center gap-2 rounded-md border px-3 text-sm">
          <input
            id={`whitebox-${param.name}`}
            type="checkbox"
            checked={Boolean(value)}
            onChange={(event) => onChange(event.target.checked)}
          />
          Enabled
        </label>
      ) : param.options?.length ? (
        <Select
          id={`whitebox-${param.name}`}
          value={valueText}
          onChange={(event) => onChange(event.target.value)}
        >
          {!param.required && <option value="">Default</option>}
          {param.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      ) : isDataInputParameter(param) && availableLayers.length > 0 ? (
        <LayerOrPathInput
          id={`whitebox-${param.name}`}
          layers={availableLayers}
          param={param}
          value={valueText}
          onChange={onChange}
        />
      ) : isPathParameter(param) ? (
        <PathPickerInput
          id={`whitebox-${param.name}`}
          param={param}
          toolId={toolId}
          value={valueText}
          onChange={onChange}
        />
      ) : kind === "int" || kind === "double" ? (
        <NumberStepperInput
          id={`whitebox-${param.name}`}
          integer={kind === "int"}
          value={valueText}
          onChange={onChange}
        />
      ) : (
        <Input
          id={`whitebox-${param.name}`}
          type="text"
          value={valueText}
          placeholder={isOutputParameter(param) ? "Auto" : undefined}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            onChange(event.target.value)
          }
        />
      )}

      {param.type && (
        <p className="text-xs text-muted-foreground">{param.type}</p>
      )}
    </div>
  );
}

interface NumberStepperInputProps {
  id: string;
  integer: boolean;
  onChange: (value: unknown) => void;
  value: string;
}

function NumberStepperInput({
  id,
  integer,
  onChange,
  value,
}: NumberStepperInputProps) {
  const step = integer ? 1 : 0.1;
  const updateByStep = (direction: 1 | -1) => {
    const parsed = Number.parseFloat(value);
    const base = Number.isFinite(parsed) ? parsed : 0;
    const next = base + direction * step;
    onChange(integer ? String(Math.trunc(next)) : Number(next.toFixed(6)).toString());
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] overflow-hidden rounded-md border border-input bg-background shadow-xs focus-within:border-2 focus-within:border-ring">
      <input
        id={id}
        inputMode={integer ? "numeric" : "decimal"}
        className="h-9 min-w-0 border-0 bg-transparent px-3 py-1 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="grid h-9 border-l">
        <button
          type="button"
          aria-label="Increase value"
          className="flex h-[18px] items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => updateByStep(1)}
        >
          <ChevronUp className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Decrease value"
          className="flex h-[18px] items-center justify-center border-t text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => updateByStep(-1)}
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

interface LayerOrPathInputProps {
  id: string;
  layers: GeoLibreLayer[];
  onChange: (value: unknown) => void;
  param: WhiteboxToolParameter;
  value: string;
}

function LayerOrPathInput({
  id,
  layers,
  onChange,
  param,
  value,
}: LayerOrPathInputProps) {
  const usingLayer = value.startsWith(LAYER_TOKEN_PREFIX);
  return (
    <div className="grid grid-cols-[minmax(150px,200px)_minmax(0,1fr)_2.25rem] gap-2">
      <Select
        value={usingLayer ? value : ""}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Path</option>
        {layers.map((layer) => (
          <option key={layer.id} value={`${LAYER_TOKEN_PREFIX}${layer.id}`}>
            {layer.name}
          </option>
        ))}
      </Select>
      <Input
        id={id}
        value={usingLayer ? "" : value}
        placeholder={usingLayer ? "Selected layer" : "File path"}
        disabled={usingLayer}
        onChange={(event) => onChange(event.target.value)}
      />
      <PathBrowseButton
        disabled={usingLayer}
        mode="open"
        param={param}
        onPick={(path) => onChange(path)}
      />
    </div>
  );
}

interface PathPickerInputProps {
  id: string;
  onChange: (value: unknown) => void;
  param: WhiteboxToolParameter;
  toolId: string;
  value: string;
}

function PathPickerInput({
  id,
  onChange,
  param,
  toolId,
  value,
}: PathPickerInputProps) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2">
      <Input
        id={id}
        value={value}
        placeholder={isOutputParameter(param) ? "Auto" : "File path"}
        onChange={(event) => onChange(event.target.value)}
      />
      <PathBrowseButton
        mode={isOutputParameter(param) ? "save" : "open"}
        param={param}
        toolId={toolId}
        onPick={(path) => onChange(path)}
      />
    </div>
  );
}

interface PathBrowseButtonProps {
  disabled?: boolean;
  mode: "open" | "save";
  onPick: (path: string) => void;
  param: WhiteboxToolParameter;
  toolId?: string;
}

function PathBrowseButton({
  disabled = false,
  mode,
  onPick,
  param,
  toolId = "whitebox",
}: PathBrowseButtonProps) {
  const pickPath = async () => {
    const filters = pathFiltersForParameter(param);
    const path =
      mode === "save"
        ? await pickSavePathWithFallback({
            defaultName: defaultOutputName(toolId, param),
            filters,
          })
        : await pickLocalPathWithFallback({
            accept: acceptForParameter(param),
            directory: isDirectoryParameter(param),
            filters,
          });
    if (path) onPick(path);
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      disabled={disabled}
      title={mode === "save" ? "Choose output path" : "Choose input path"}
      onClick={() => void pickPath()}
    >
      {mode === "save" ? (
        <Save className="h-4 w-4" />
      ) : (
        <FolderOpen className="h-4 w-4" />
      )}
    </Button>
  );
}
