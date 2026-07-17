import { useAppStore } from "@geolibre/core";
import type { GeoLibreLayer } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { addCogRasterLayer } from "@geolibre/plugins";
import {
  RASTER_TOOLS,
  getRasterTool,
  fetchRasterStatus,
  fetchConversionJob,
  runRasterTool,
  readRasterData,
  runRasterToolClient,
  buildSpectralIndexExpression,
  type AlgorithmParameter,
  type ConversionJob,
  type RasterTool,
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
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FolderOpen,
  Loader2,
  Play,
  Save,
  Server,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import type { ParseKeys } from "i18next";
import {
  isTauri,
  openLocalDataFileWithFallback,
  pickLocalPathWithFallback,
  pickSavePathWithFallback,
  saveBinaryFileWithFallback,
} from "../../lib/tauri-io";
import { startGeoLibreSidecar } from "../../lib/sidecar";
import {
  beginProcessingRun,
  MAX_TRACKED_HISTORY_JOBS,
  type ProcessingRunTracker,
} from "../../lib/processing-history";
import { createAppAPI } from "../../hooks/usePlugins";
import { canExportRasterLayer, rasterExportUrl } from "../../lib/raster-export";
import { fetchableUrl } from "../../lib/url-utils";

/**
 * The input URL the Python sidecar can read for an added raster layer, or null
 * if there is none. Only raster layers with an `http(s)` source qualify:
 * rasterio/GDAL fetches remote COGs over the network (via `/vsicurl`), but
 * file-loaded rasters keep only a blob URL plus a bare file name in the store —
 * neither is readable by the backend process — and blob/data URLs cannot be
 * opened server-side. `fetchableUrl` unwraps `scheme://` wrappers (e.g.
 * `cog://https://…`) before the `http(s)` check.
 */
function sidecarRasterUrl(layer: GeoLibreLayer): string | null {
  if (layer.type !== "cog" && layer.type !== "raster") return null;
  const url = fetchableUrl((layer.source as { url?: unknown }).url);
  return url && /^https?:\/\//i.test(url) ? url : null;
}

/** Which engine runs the selected tool: Python sidecar or the browser. */
type RasterEngine = "sidecar" | "client";

const RUNNING_JOB_STATUSES = new Set(["pending", "running"]);

/** Tools grouped by their `group` label, preserving registry order. */
function groupedTools(): { group: string; tools: RasterTool[] }[] {
  const groups: { group: string; tools: RasterTool[] }[] = [];
  for (const tool of RASTER_TOOLS) {
    let entry = groups.find((g) => g.group === tool.group);
    if (!entry) {
      entry = { group: tool.group, tools: [] };
      groups.push(entry);
    }
    entry.tools.push(tool);
  }
  return groups;
}

/** Collect the default values declared by a tool's parameters. */
function toolDefaults(tool: RasterTool): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const param of tool.parameters) {
    if (param.default !== undefined) defaults[param.id] = param.default;
  }
  return defaults;
}

interface RasterToolsDialogProps {
  mapControllerRef: RefObject<MapController | null>;
}

export function RasterToolsDialog({
  mapControllerRef,
}: RasterToolsDialogProps): ReactElement {
  const { t } = useTranslation();
  const openTool = useAppStore((s) => s.ui.rasterToolOpen);
  const setRasterToolOpen = useAppStore((s) => s.setRasterToolOpen);
  const layers = useAppStore((s) => s.layers);
  const rerun = useAppStore((s) => s.ui.processingRerun);
  const setProcessingRerun = useAppStore((s) => s.setProcessingRerun);

  const open = openTool !== null;
  const desktop = isTauri();
  const [selectedId, setSelectedId] = useState<string>(
    openTool ?? RASTER_TOOLS[0].id,
  );
  const [inputPath, setInputPath] = useState("");
  const [outputPath, setOutputPath] = useState("");
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [job, setJob] = useState<ConversionJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runtimeAvailable, setRuntimeAvailable] = useState<boolean | null>(null);
  const [runtimeMessage, setRuntimeMessage] = useState("");
  const [startingServer, setStartingServer] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  // The client log has its own sentinel: both logs can be mounted at once
  // (a sidecar job, then switching engine to client), so a shared ref would
  // break the sidecar log's auto-scroll.
  const clientLogEndRef = useRef<HTMLDivElement>(null);
  // Aborts an in-flight layer-bytes fetch when the dialog closes/unmounts or a
  // new pick supersedes it, so its state setters never fire on a dead component.
  const layerFetchAbortRef = useRef<AbortController | null>(null);
  // History trackers per dispatched sidecar job id (#1292). Entries stay after
  // finish (finish is idempotent); the map is capped (oldest evicted) so a
  // long session cannot grow it without bound.
  const historyTrackersRef = useRef<Map<string, ProcessingRunTracker>>(
    new Map(),
  );

  // Client-engine state. The browser fallback reads a GeoTIFF into memory,
  // computes a new raster, adds it to the map, and offers a download.
  const [engine, setEngine] = useState<RasterEngine>(
    desktop ? "sidecar" : "client",
  );
  const [clientInput, setClientInput] = useState<{
    name: string;
    bytes: ArrayBuffer;
  } | null>(null);
  const [clientLog, setClientLog] = useState<string[]>([]);
  const [clientRunning, setClientRunning] = useState(false);
  // True while fetching a picked layer's bytes for the client engine.
  const [resolvingLayer, setResolvingLayer] = useState(false);
  const [clientResult, setClientResult] = useState<{
    name: string;
    bytes: ArrayBuffer;
  } | null>(null);

  const tool = useMemo(
    () => getRasterTool(selectedId) ?? RASTER_TOOLS[0],
    [selectedId],
  );
  const groups = useMemo(groupedTools, []);

  // When the menu opens the dialog with a specific tool, preselect it.
  useEffect(() => {
    if (openTool) setSelectedId(openTool);
  }, [openTool]);

  const checkRuntime = useCallback(async () => {
    if (!desktop) {
      // Raster tools are sidecar-only and the file pickers cannot resolve real
      // paths in a browser, so a pure web build cannot run them.
      setRuntimeAvailable(false);
      setRuntimeMessage(
        "Raster tools need the GeoLibre desktop app with a running sidecar.",
      );
      return;
    }
    setRuntimeAvailable(null);
    setRuntimeMessage("Checking raster runtime.");
    try {
      const status = await fetchRasterStatus();
      setRuntimeAvailable(status.available);
      setRuntimeMessage(status.message);
    } catch (err) {
      setRuntimeAvailable(false);
      setRuntimeMessage(
        err instanceof Error ? err.message : "Could not connect to sidecar.",
      );
    }
  }, [desktop]);

  // Reset per-tool state whenever the dialog opens or the selected tool changes.
  // Also reset the engine here (not only on tool change) so reopening the dialog
  // on the same tool restores the default: client only on a client-capable tool
  // without a sidecar, otherwise sidecar.
  useEffect(() => {
    if (!open) return;
    setInputPath("");
    setOutputPath("");
    setParams(toolDefaults(tool));
    setError(null);
    setJob(null);
    setClientInput(null);
    setClientLog([]);
    setClientResult(null);
    setEngine(tool.supportsClient && !desktop ? "client" : "sidecar");
  }, [open, tool, desktop]);

  // Pre-fill from a pending History re-run once the requested tool is selected.
  // Declared after the reset effect above so the recorded parameters win over
  // the defaults when both effects fire in the same commit. Input/output paths
  // are not restored: the user re-picks files.
  useEffect(() => {
    if (!open || !rerun || rerun.kind !== "raster") return;
    // A saved-project history entry can reference a tool that was renamed or
    // removed since; drop the request instead of leaving it pending forever.
    if (!getRasterTool(rerun.toolId)) {
      setError(
        t("processing.history.toolUnavailable", { toolId: rerun.toolId }),
      );
      setProcessingRerun(null);
      return;
    }
    if (rerun.toolId !== tool.id) return;
    setParams({ ...toolDefaults(tool), ...rerun.parameters });
    setProcessingRerun(null);
  }, [open, rerun, tool, setProcessingRerun, t]);

  // Probe the runtime only when the dialog opens, not on every tool switch
  // (each probe spawns a sidecar subprocess import check).
  useEffect(() => {
    if (!open) return;
    void checkRuntime();
  }, [open, checkRuntime]);

  // Poll the sidecar job until it settles (shared conversion job store).
  useEffect(() => {
    if (!job || !RUNNING_JOB_STATUSES.has(job.status)) return;
    let cancelled = false;
    let timer: number;
    const poll = async () => {
      if (cancelled) return;
      try {
        const next = await fetchConversionJob(job.id);
        if (cancelled) return;
        setJob(next);
        if (RUNNING_JOB_STATUSES.has(next.status)) {
          timer = window.setTimeout(poll, 1000);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not poll job.");
        }
      }
    };
    timer = window.setTimeout(poll, 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [job]);

  // Record a History entry once a sidecar job reaches a terminal status
  // (#1292). `finish` is idempotent, so re-renders with the same job are no-ops.
  useEffect(() => {
    if (!job || RUNNING_JOB_STATUSES.has(job.status)) return;
    historyTrackersRef.current
      .get(job.id)
      ?.finish(
        job.status === "succeeded" ? "success" : "error",
        job.error ?? undefined,
      );
  }, [job]);

  // Keep the newest log lines in view as messages stream in. One effect per log
  // pane so a sidecar update never scrolls the client pane (and vice versa).
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "end" });
  }, [job?.messages.length]);
  useEffect(() => {
    clientLogEndRef.current?.scrollIntoView({ block: "end" });
  }, [clientLog.length]);

  const setParam = useCallback(
    (id: string, value: unknown) =>
      setParams((prev) => ({ ...prev, [id]: value })),
    [],
  );

  // Whether a parameter is shown, given another parameter's value (e.g. hide
  // the IDW power field when the kriging method is selected).
  const isParamVisible = useCallback(
    (param: AlgorithmParameter): boolean => {
      const vw = param.visibleWhen;
      if (!vw) return true;
      // Fall back to the controlling param's declared default, so dependent
      // fields resolve correctly on the first render — before the effect that
      // seeds `params` from toolDefaults has run (avoids a one-frame flicker).
      const controller = tool.parameters.find((p) => p.id === vw.param);
      const current = (params[vw.param] ?? controller?.default) as
        | string
        | undefined;
      if ("in" in vw) return current != null && vw.in.includes(current);
      return current == null || !vw.notIn.includes(current);
    },
    [params, tool],
  );

  const pickInput = useCallback(async () => {
    const path = await pickLocalPathWithFallback({ filters: tool.inputFilters });
    if (path) setInputPath(path);
  }, [tool]);

  const pickOutput = useCallback(async () => {
    const path = await pickSavePathWithFallback({
      defaultName: tool.defaultOutputName,
      filters: tool.outputFilters,
    });
    if (path) setOutputPath(path);
  }, [tool]);

  const pickPathParam = useCallback(
    async (param: AlgorithmParameter) => {
      const path = await pickLocalPathWithFallback({
        filters: param.fileFilters,
      });
      if (path) setParam(param.id, path);
    },
    [setParam],
  );

  const startServer = useCallback(async () => {
    setStartingServer(true);
    setError(null);
    try {
      await startGeoLibreSidecar();
      await checkRuntime();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not start GeoLibre sidecar.",
      );
    } finally {
      setStartingServer(false);
    }
  }, [checkRuntime]);

  // Validate required operation parameters. A hidden parameter (e.g. an IDW
  // knob while kriging is selected) is skipped. Returns an error string or null.
  const validateParams = useCallback((): string | null => {
    for (const param of tool.parameters) {
      if (!param.required || !isParamVisible(param)) continue;
      const value = params[param.id];
      if (
        value === undefined ||
        value === null ||
        value === "" ||
        (param.type === "number" && Number.isNaN(value))
      ) {
        return `"${param.label}" is required.`;
      }
    }
    return null;
  }, [tool, params, isParamVisible]);

  // Browser engine: pick a GeoTIFF and read its bytes into memory (works in both
  // desktop and web, unlike the sidecar path which needs a real file path).
  const pickClientInput = useCallback(async () => {
    setError(null);
    const picked = await openLocalDataFileWithFallback({
      filters: tool.inputFilters,
      accept: ".tif,.tiff,image/tiff",
      readBinary: true,
    });
    if (picked?.data) {
      setClientInput({ name: picked.path, bytes: picked.data });
      // Drop any prior run's result/log so the Download button can't offer a
      // GeoTIFF computed from the previous input.
      setClientResult(null);
      setClientLog([]);
    }
  }, [tool]);

  // Raster layers already on the map that can seed this tool's input, so the
  // user need not browse to a file again. The client engine reads any raster's
  // bytes (URL or local file); the sidecar can only open `http(s)` COGs. The
  // quick-pick is skipped for tools whose primary input is a vector (e.g.
  // interpolation reads point GeoJSON), since those want a different layer kind.
  const toolTakesRasterInput = useMemo(
    () =>
      tool.inputFilters.some((filter) =>
        filter.extensions.some((ext) => ext === "tif" || ext === "tiff"),
      ),
    [tool],
  );
  const inputLayerOptions = useMemo(
    () =>
      toolTakesRasterInput
        ? layers.filter((layer) =>
            engine === "client"
              ? canExportRasterLayer(layer)
              : sidecarRasterUrl(layer) !== null,
          )
        : [],
    [layers, engine, toolTakesRasterInput],
  );

  // Populate the input from a layer chosen in the quick-pick dropdown: a URL for
  // the sidecar, or the fetched bytes for the in-browser engine.
  const chooseInputLayer = useCallback(
    async (layerId: string) => {
      const layer = layers.find((l) => l.id === layerId);
      if (!layer) return;
      setError(null);
      if (engine === "sidecar") {
        const url = sidecarRasterUrl(layer);
        if (url) setInputPath(url);
        return;
      }
      const url = rasterExportUrl(layer);
      if (!url) return;
      // Supersede any prior in-flight fetch and tie this one to an abort signal
      // so closing the dialog mid-fetch cancels it instead of updating state on
      // an unmounted component.
      layerFetchAbortRef.current?.abort();
      const controller = new AbortController();
      layerFetchAbortRef.current = controller;
      setResolvingLayer(true);
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = await response.arrayBuffer();
        if (controller.signal.aborted) return;
        setClientInput({ name: layer.name, bytes });
        setClientResult(null);
        setClientLog([]);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(
          err instanceof Error
            ? err.message
            : t("toolbar.rasterTool.layerLoadError"),
        );
      } finally {
        if (!controller.signal.aborted) setResolvingLayer(false);
      }
    },
    [layers, engine, t],
  );

  // Abort any in-flight layer-bytes fetch when the dialog unmounts.
  useEffect(() => () => layerFetchAbortRef.current?.abort(), []);

  const runSidecar = useCallback(async () => {
    setError(null);
    if (!inputPath.trim()) {
      setError("Choose an input file.");
      return;
    }
    if (!outputPath.trim()) {
      setError("Choose an output file.");
      return;
    }
    const invalid = validateParams();
    if (invalid) {
      setError(invalid);
      return;
    }
    // The Spectral Index tool compiles to a band-math expression the sidecar's
    // `raster-calc` script evaluates, so inject it into the request params.
    let sidecarParams = params;
    if (tool.id === "spectral-index") {
      try {
        sidecarParams = {
          ...params,
          expression: buildSpectralIndexExpression(params).expression,
        };
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t("toolbar.rasterTool.invalidSpectralIndex"),
        );
        return;
      }
    }
    // Record the raw form params (not the injected sidecar expression) so
    // Edit & re-run restores the form exactly (#1292).
    const tracker = beginProcessingRun(
      {
        kind: "raster",
        toolId: tool.id,
        toolName: tool.name,
        engine: "sidecar",
        parameters: params,
      },
      { inputPath: inputPath.trim(), outputPath: outputPath.trim() },
    );
    try {
      const nextJob = await runRasterTool({
        tool_id: tool.id,
        input_path: inputPath.trim(),
        output_path: outputPath.trim(),
        parameters: sidecarParams,
      });
      historyTrackersRef.current.set(nextJob.id, tracker);
      while (historyTrackersRef.current.size > MAX_TRACKED_HISTORY_JOBS) {
        const oldest = historyTrackersRef.current.keys().next().value;
        if (oldest === undefined) break;
        historyTrackersRef.current.delete(oldest);
      }
      setJob(nextJob);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not start raster tool.";
      tracker.finish("error", message);
      setError(message);
    }
  }, [tool, inputPath, outputPath, params, validateParams, t]);

  const runClient = useCallback(async () => {
    setError(null);
    setClientResult(null);
    if (!clientInput) {
      setError(t("toolbar.rasterTool.chooseInputRaster"));
      return;
    }
    const invalid = validateParams();
    if (invalid) {
      setError(invalid);
      return;
    }
    setClientRunning(true);
    setClientLog([t("toolbar.rasterTool.runningInBrowser", { tool: tool.name })]);
    const tracker = beginProcessingRun(
      {
        kind: "raster",
        toolId: tool.id,
        toolName: tool.name,
        engine: "client",
        parameters: params,
      },
      { inputPath: clientInput.name },
    );
    try {
      const raster = await readRasterData(clientInput.bytes);
      setClientLog((prev) => [
        ...prev,
        t("toolbar.rasterTool.loadedRaster", {
          width: raster.width,
          height: raster.height,
          bands: raster.bands.length,
        }),
      ]);
      // Compute is a synchronous pixel loop (millions of iterations for a large
      // DEM). Yield once so React paints the "running" spinner before the main
      // thread blocks; a Web Worker would be the full fix for very large rasters.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const pixelCount = raster.width * raster.height;
      if (pixelCount > 2_000_000) {
        setClientLog((prev) => [
          ...prev,
          t("toolbar.rasterTool.largeRasterWarning", {
            mp: (pixelCount / 1_000_000).toFixed(1),
          }),
        ]);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      const { raster: result, bytes } = runRasterToolClient(
        tool.id,
        raster,
        params,
      );
      setClientLog((prev) => [
        ...prev,
        t("toolbar.rasterTool.computedInBrowser", { tool: tool.name }),
      ]);
      const outName = tool.defaultOutputName;
      // Persist the result before the map add so the Download button survives a
      // render failure (the compute already succeeded — don't discard it).
      setClientResult({ name: outName, bytes });
      const app = createAppAPI(mapControllerRef);
      try {
        await addCogRasterLayer(app, {
          url: outName,
          data: bytes,
          name: outName.replace(/\.tiff?$/i, ""),
          // The renderer reads NoData from options (not the file's tag), so pass
          // it explicitly for correct transparency of masked/edge cells.
          ...(result.nodata != null ? { nodata: result.nodata } : {}),
        });
        setClientLog((prev) => [
          ...prev,
          t("toolbar.rasterTool.addedToMap", { name: outName }),
        ]);
        tracker.addOutputLayer(outName);
      } catch (mapError) {
        const mapMessage =
          mapError instanceof Error
            ? mapError.message
            : t("toolbar.rasterTool.mapAddError");
        setError(mapMessage);
        setClientLog((prev) => [
          ...prev,
          t("toolbar.rasterTool.mapAddFailed", { message: mapMessage }),
        ]);
        // The compute succeeded but the result never made it onto the map, so
        // record the run as failed rather than a green no-output "success".
        tracker.finish("error", mapMessage);
        return;
      }
      tracker.finish("success");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t("toolbar.rasterTool.runError");
      tracker.finish("error", message);
      setError(message);
      setClientLog((prev) => [...prev, message]);
    } finally {
      setClientRunning(false);
    }
  }, [tool, params, clientInput, validateParams, mapControllerRef, t]);

  const handleRun = useCallback(
    () => (engine === "client" ? runClient() : runSidecar()),
    [engine, runClient, runSidecar],
  );

  const downloadClientResult = useCallback(async () => {
    if (!clientResult) return;
    try {
      await saveBinaryFileWithFallback(new Uint8Array(clientResult.bytes), {
        defaultName: clientResult.name,
        filters: tool.outputFilters,
        browserTypes: [
          { description: "GeoTIFF", accept: { "image/tiff": [".tif", ".tiff"] } },
        ],
        mimeType: "image/tiff",
      });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("toolbar.rasterTool.saveError"),
      );
    }
  }, [clientResult, tool, t]);

  const running =
    Boolean(job && RUNNING_JOB_STATUSES.has(job.status)) || clientRunning;

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        if (!next) {
          // Clear the job so the poll effect's cleanup stops fetching; Radix
          // keeps the dialog mounted for the exit animation otherwise.
          setRasterToolOpen(null);
          setJob(null);
        }
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Raster tools</DialogTitle>
          <DialogDescription>
            Run common raster operations on the Python sidecar (rasterio/GDAL),
            or in your browser when no sidecar is available.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-4">
          {/* Tool list */}
          <ScrollArea className="h-[26rem] w-48 shrink-0 rounded-md border">
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
                        "w-full rounded-md px-2 py-1.5 text-start text-sm transition-colors hover:bg-accent",
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

            {/* Engine selector (only for tools with a browser implementation). */}
            {tool.supportsClient && (
              <div className="flex flex-col gap-1">
                <Label className="flex items-center gap-1.5 text-xs">
                  <Server className="h-3.5 w-3.5" />{" "}
                  {t("toolbar.rasterTool.engine")}
                </Label>
                <Select
                  value={engine}
                  onChange={(e) => setEngine(e.target.value as RasterEngine)}
                >
                  <option value="client">
                    {t("toolbar.rasterTool.engineClient")}
                  </option>
                  <option value="sidecar" disabled={!desktop}>
                    {t("toolbar.rasterTool.engineSidecar")}
                  </option>
                </Select>
                {engine === "client" && (
                  <p className="text-xs text-muted-foreground">
                    {t("toolbar.rasterTool.clientHint")}
                  </p>
                )}
              </div>
            )}

            {engine === "sidecar" && runtimeAvailable === false && (
              <div className="grid gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
                <p className="flex items-start gap-2 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  {runtimeMessage}
                </p>
                {desktop && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void startServer()}
                    disabled={startingServer}
                    className="gap-2"
                  >
                    {startingServer ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Server className="h-4 w-4" />
                    )}
                    Start server
                  </Button>
                )}
                {tool.supportsClient && (
                  <p className="text-xs text-muted-foreground">
                    {t("toolbar.rasterTool.switchToClientHint")}
                  </p>
                )}
              </div>
            )}

            {/* Quick-pick from rasters already on the map, mirroring the vector
                tools' layer dropdown so the user need not re-browse to a file. */}
            {inputLayerOptions.length > 0 && (
              <div className="grid gap-1.5">
                <Label htmlFor="raster-input-layer" className="text-xs">
                  {t("toolbar.rasterTool.useAddedLayer")}
                </Label>
                <Select
                  id="raster-input-layer"
                  value=""
                  disabled={resolvingLayer || running}
                  onChange={(e) => {
                    if (e.target.value) void chooseInputLayer(e.target.value);
                  }}
                >
                  <option value="">
                    {resolvingLayer
                      ? t("toolbar.rasterTool.loadingLayer")
                      : t("toolbar.rasterTool.useAddedLayerPlaceholder")}
                  </option>
                  {inputLayerOptions.map((layer) => (
                    <option key={layer.id} value={layer.id}>
                      {layer.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}

            {/* Input file */}
            <div className="grid gap-1.5">
              <Label htmlFor="raster-input" className="text-xs">
                {t((tool.inputLabel ?? "toolbar.rasterTool.inputRaster") as ParseKeys)}
                <span className="text-destructive"> *</span>
              </Label>
              {engine === "client" ? (
                <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2">
                  <Input
                    id="raster-input"
                    value={clientInput?.name ?? ""}
                    placeholder={t("toolbar.rasterTool.chooseGeoTiff")}
                    readOnly
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    title={t("processing.filePicker.chooseInputFile")}
                    onClick={() => void pickClientInput()}
                  >
                    <FolderOpen className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2">
                  <Input
                    id="raster-input"
                    value={inputPath}
                    placeholder={t("processing.filePicker.filePath")}
                    onChange={(event) => setInputPath(event.target.value)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    title={t("processing.filePicker.chooseInputFile")}
                    onClick={() => void pickInput()}
                  >
                    <FolderOpen className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>

            {/* Output file (sidecar only; the client engine adds to the map). */}
            {engine === "sidecar" && (
              <div className="grid gap-1.5">
                <Label htmlFor="raster-output" className="text-xs">
                  Output file<span className="text-destructive"> *</span>
                </Label>
                <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2">
                  <Input
                    id="raster-output"
                    value={outputPath}
                    placeholder={t("processing.filePicker.filePath")}
                    onChange={(event) => setOutputPath(event.target.value)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    title={t("processing.filePicker.chooseOutputFile")}
                    onClick={() => void pickOutput()}
                  >
                    <Save className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}

            {/* Operation parameters */}
            {tool.parameters.filter(isParamVisible).map((param) => (
              <RasterParameterField
                key={param.id}
                param={param}
                value={params[param.id]}
                onChange={(value) => setParam(param.id, value)}
                onPick={() => void pickPathParam(param)}
              />
            ))}

            <div>
              <Button
                onClick={() => void handleRun()}
                disabled={
                  running ||
                  (engine === "sidecar" && runtimeAvailable !== true) ||
                  (engine === "client" && !clientInput)
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

            {error && (
              <p className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {error}
              </p>
            )}

            {job && (
              <div className="grid gap-2">
                <p
                  className={cn(
                    "flex items-center gap-2 text-sm font-medium",
                    job.status === "succeeded" && "text-emerald-700",
                    job.status === "failed" && "text-destructive",
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
                  {job.messages.length === 0 ? (
                    <span className="text-muted-foreground">
                      No output yet.
                    </span>
                  ) : (
                    <>
                      {job.messages.map((line, index) => (
                        <div key={index} className="whitespace-pre-wrap">
                          {line}
                        </div>
                      ))}
                      <div ref={logEndRef} />
                    </>
                  )}
                </ScrollArea>
              </div>
            )}

            {/* Client-engine output: log + a download for the computed raster. */}
            {engine === "client" && clientLog.length > 0 && (
              <div className="grid gap-2">
                <ScrollArea className="h-24 rounded-md border bg-muted/30 p-2 font-mono text-xs">
                  {clientLog.map((line, index) => (
                    <div key={index} className="whitespace-pre-wrap">
                      {line}
                    </div>
                  ))}
                  <div ref={clientLogEndRef} />
                </ScrollArea>
                {clientResult && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void downloadClientResult()}
                    className="gap-2"
                  >
                    <Download className="h-4 w-4" />
                    {t("toolbar.rasterTool.downloadGeoTiff")}
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface RasterParameterFieldProps {
  param: AlgorithmParameter;
  value: unknown;
  onChange: (value: unknown) => void;
  onPick: () => void;
}

function RasterParameterField({
  param,
  value,
  onChange,
  onPick,
}: RasterParameterFieldProps): ReactElement {
  const { t } = useTranslation();
  const label = (
    <Label htmlFor={param.id} className="text-xs">
      {param.label}
      {param.required ? <span className="text-destructive"> *</span> : null}
    </Label>
  );

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
            onChange(e.target.value === "" ? undefined : Number(e.target.value))
          }
        />
        {param.description ? (
          <p className="text-xs text-muted-foreground">{param.description}</p>
        ) : null}
      </div>
    );
  }

  if (param.type === "path") {
    return (
      <div className="flex flex-col gap-1">
        {label}
        <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2">
          <Input
            id={param.id}
            value={(value as string) ?? ""}
            placeholder={t("processing.filePicker.filePath")}
            onChange={(e) => onChange(e.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            title={t("processing.filePicker.chooseFile")}
            onClick={onPick}
          >
            <FolderOpen className="h-4 w-4" />
          </Button>
        </div>
        {param.description ? (
          <p className="text-xs text-muted-foreground">{param.description}</p>
        ) : null}
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
