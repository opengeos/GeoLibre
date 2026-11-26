import { isProcessingParameterVisible } from "../../lib/processing-parameter-visibility";
import { useAppCapability, useAppStore, useLayersWhen } from "@geolibre/core";
import type { GeoLibreLayer } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { addRasterToMap } from "@geolibre/plugins/maplibre-raster";
import {
  RASTER_TOOLS,
  getRasterTool,
  fetchRasterStatus,
  fetchConversionJob,
  runRasterTool,
  readRasterData,
  runRasterToolClientAsync,
  rasterToolTakesVectorInput,
  type RasterData,
  convertRasterDataToCog,
  exceedsBrowserCogConversionLimit,
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
  FileTooLargeError,
  openLocalDataFileWithFallback,
  pickLocalPathWithFallback,
  pickSavePathWithFallback,
  saveBinaryFileWithFallback,
} from "../../lib/tauri-io";
import { IS_MAS_BUILD } from "../../lib/build-flags";
import { isDesktopRuntime } from "../../lib/is-mobile";
import { startGeoLibreSidecar } from "../../lib/sidecar";
import {
  beginProcessingRun,
  MAX_TRACKED_HISTORY_JOBS,
  type ProcessingRunTracker,
} from "../../lib/processing-history";
import { createAppAPI } from "../../hooks/usePlugins";
import {
  ClientRasterInputError,
  MAX_CLIENT_VECTOR_BYTES,
  clientInputForParam,
  clientRasterOutputBands,
  parseGeoJsonBytes,
  loadClientAdditionalRasters,
  omitClientSecondaryInput,
  type ClientRasterInputEntry,
} from "../../lib/client-raster-inputs";
import { RasterParameterField } from "./RasterParameterField";
import { canExportRasterLayer, rasterExportUrl } from "../../lib/raster-export";
import { fetchableUrl } from "../../lib/url-utils";
import {
  translateParameter,
  translateToolDescription,
  translateToolGroup,
  translateToolName,
} from "../../lib/processing-tool-i18n";

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
  mapControllerRef: RefObject<MapEngine | null>;
}

/** Read current privileges at execution time, including stale UI handlers. */
function sidecarRestriction(
  platformAvailable: boolean,
):
  | "toolbar.rasterTool.processingRestricted"
  | "toolbar.rasterTool.sidecarRestricted"
  | "toolbar.rasterTool.needsDesktopSidecar"
  | "masBuild.unavailable"
  | null {
  const privileges = useAppStore.getState().capabilities.privileges;
  if (!privileges.includes("processing:run")) return "toolbar.rasterTool.processingRestricted";
  if (!platformAvailable)
    return IS_MAS_BUILD ? "masBuild.unavailable" : "toolbar.rasterTool.needsDesktopSidecar";
  return privileges.includes("processing:sidecar") ? null : "toolbar.rasterTool.sidecarRestricted";
}

export function RasterToolsDialog({ mapControllerRef }: RasterToolsDialogProps): ReactElement {
  const { t } = useTranslation();
  const openTool = useAppStore((s) => s.ui.rasterToolOpen);
  const setRasterToolOpen = useAppStore((s) => s.setRasterToolOpen);
  // Layers are only read while the dialog is open; closed, it stays mounted (to
  // keep its form, log and in-flight run) without re-rendering on layer edits.
  const layers = useLayersWhen(openTool !== null);
  const rerun = useAppStore((s) => s.ui.processingRerun);
  const setProcessingRerun = useAppStore((s) => s.setProcessingRerun);

  const open = openTool !== null;
  // Whether this build can run the sidecar engine: desktop, except the Mac App
  // Store build, whose App Sandbox forbids the sidecar process. The client
  // (in-browser) engine keeps working either way.
  const desktopServer = isDesktopRuntime() && !IS_MAS_BUILD;
  const processingCap = useAppCapability("processing:run");
  const sidecarCap = useAppCapability("processing:sidecar");
  const sidecarAllowed = desktopServer && processingCap.granted && sidecarCap.granted;
  const [selectedId, setSelectedId] = useState<string>(openTool ?? RASTER_TOOLS[0].id);
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
  // Incremented on reset so stale async primary and secondary reads are ignored.
  const formSessionRef = useRef(0);
  // File and map-layer picks share a sequence so the newest primary input wins.
  const primaryPickTokenRef = useRef(0);
  // Incremented whenever inputs change or the form resets so an in-flight
  // client run cannot write stale result/log/map output after input edits.
  const clientRunIdRef = useRef(0);
  // Per-letter pick sequence tokens so a superseded secondary file read cannot
  // overwrite a newer selection or a Clear action.
  const secondaryPickTokensRef = useRef<Record<string, number>>({});
  // History trackers per dispatched sidecar job id (#1292). Entries stay after
  // finish (finish is idempotent); the map is capped (oldest evicted) so a
  // long session cannot grow it without bound.
  const historyTrackersRef = useRef<Map<string, ProcessingRunTracker>>(new Map());

  // Client-engine state. The browser fallback reads a GeoTIFF into memory,
  // computes a new raster, adds it to the map, and offers a download.
  const [engine, setEngine] = useState<RasterEngine>(sidecarAllowed ? "sidecar" : "client");
  const [clientInput, setClientInput] = useState<{
    name: string;
    bytes: ArrayBuffer;
  } | null>(null);
  const [clientAdditionalInputs, setClientAdditionalInputs] = useState<
    Record<string, ClientRasterInputEntry>
  >({});
  // GeoJSON path parameters (clip mask, zones) for the client engine, keyed by
  // parameter id.
  const [clientVectorInputs, setClientVectorInputs] = useState<
    Record<string, ClientRasterInputEntry>
  >({});
  const [clientLog, setClientLog] = useState<string[]>([]);
  const [clientRunning, setClientRunning] = useState(false);
  // True while fetching a picked layer's bytes for the client engine.
  const [resolvingLayer, setResolvingLayer] = useState(false);
  const [clientResult, setClientResult] = useState<{
    name: string;
    bytes: ArrayBuffer;
    kind: "raster" | "vector";
  } | null>(null);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);

  const tool = useMemo(() => getRasterTool(selectedId) ?? RASTER_TOOLS[0], [selectedId]);
  const groups = useMemo(groupedTools, []);

  // When the menu opens the dialog with a specific tool, preselect it.
  useEffect(() => {
    if (openTool) setSelectedId(openTool);
  }, [openTool]);

  const checkRuntime = useCallback(async () => {
    const restriction = sidecarRestriction(desktopServer);
    if (restriction) {
      // Raster tools' sidecar engine cannot run in a pure web build (no real
      // file paths) or in the Mac App Store build (no sidecar process); only
      // the client engine works there.
      setRuntimeAvailable(false);
      setRuntimeMessage(t(restriction));
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
      setRuntimeMessage(err instanceof Error ? err.message : t("toolbar.rasterTool.errorConnect"));
    }
  }, [desktopServer, processingCap.granted, sidecarCap.granted, t]);

  // Reset per-tool state whenever the dialog opens or the selected tool changes.
  // Also reset the engine here (not only on tool change) so reopening the dialog
  // on the same tool restores the default: client only on a client-capable tool
  // without a sidecar, otherwise sidecar.
  useEffect(() => {
    formSessionRef.current += 1;
    clientRunIdRef.current += 1;
    primaryPickTokenRef.current += 1;
    layerFetchAbortRef.current?.abort();
    setResolvingLayer(false);
    if (!open) return;
    secondaryPickTokensRef.current = {};
    setInputPath("");
    setOutputPath("");
    setParams(toolDefaults(tool));
    setError(null);
    setJob(null);
    setClientInput(null);
    setClientAdditionalInputs({});
    setClientVectorInputs({});
    setClientLog([]);
    setClientResult(null);
    setClientRunning(false);
    setEngine(
      tool.supportsClient && (tool.clientOnly || sidecarRestriction(desktopServer))
        ? "client"
        : "sidecar",
    );
  }, [open, tool, desktopServer]);

  // Permission changes block new runs without discarding an already dispatched
  // job, its polling state, or the user's form inputs.
  useEffect(() => {
    if (!sidecarAllowed && !job && tool.supportsClient) setEngine("client");
  }, [sidecarAllowed, job, tool]);

  // Pre-fill from a pending History re-run once the requested tool is selected.
  // Declared after the reset effect above so the recorded parameters win over
  // the defaults when both effects fire in the same commit. Input/output paths
  // are not restored: the user re-picks files.
  useEffect(() => {
    if (!open || !rerun || rerun.kind !== "raster") return;
    // A saved-project history entry can reference a tool that was renamed or
    // removed since; drop the request instead of leaving it pending forever.
    if (!getRasterTool(rerun.toolId)) {
      setError(t("processing.history.toolUnavailable", { toolId: rerun.toolId }));
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
          setError(err instanceof Error ? err.message : t("toolbar.rasterTool.errorPoll"));
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
      ?.finish(job.status === "succeeded" ? "success" : "error", job.error ?? undefined);
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
    (id: string, value: unknown) => setParams((prev) => ({ ...prev, [id]: value })),
    [],
  );

  const clearClientSecondaryInput = useCallback((kind: "raster" | "vector", key: string) => {
    const token = `${kind}:${key}`;
    secondaryPickTokensRef.current[token] = (secondaryPickTokensRef.current[token] ?? 0) + 1;
    clientRunIdRef.current += 1;
    setClientRunning(false);
    if (kind === "raster") setClientAdditionalInputs((prev) => omitClientSecondaryInput(prev, key));
    else setClientVectorInputs((prev) => omitClientSecondaryInput(prev, key));
    setClientResult(null);
    setClientLog([]);
  }, []);

  // Whether a parameter is shown, given another parameter's value (e.g. hide
  // the IDW power field when the kriging method is selected).
  const isParamVisible = useCallback(
    (param: AlgorithmParameter) => isProcessingParameterVisible(param, params, tool.parameters),
    [params, tool],
  );
  const pickInput = useCallback(async () => {
    const path = await pickLocalPathWithFallback({
      filters: tool.inputFilters,
    });
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
      // The client engine reads secondary GeoTIFFs and GeoJSON layers into
      // memory instead of passing a path to the sidecar.
      const clientParam = engine === "client" ? clientInputForParam(param) : null;
      if (clientParam) {
        const { kind, key } = clientParam;
        const token = `${kind}:${key}`;
        const session = formSessionRef.current;
        const pickToken = (secondaryPickTokensRef.current[token] ?? 0) + 1;
        secondaryPickTokensRef.current[token] = pickToken;
        try {
          const picked = await openLocalDataFileWithFallback({
            filters: param.fileFilters ?? tool.inputFilters,
            accept:
              kind === "raster"
                ? ".tif,.tiff,image/tiff"
                : ".geojson,.json,application/geo+json,application/json",
            readBinary: true,
            maxBytes: kind === "vector" ? MAX_CLIENT_VECTOR_BYTES : undefined,
          });
          if (
            session !== formSessionRef.current ||
            secondaryPickTokensRef.current[token] !== pickToken ||
            !picked?.data
          ) {
            return;
          }
          clientRunIdRef.current += 1;
          setClientRunning(false);
          setError(null);
          setClientResult(null);
          setClientLog([]);
          const entry = { name: picked.path, bytes: picked.data };
          if (kind === "raster") setClientAdditionalInputs((prev) => ({ ...prev, [key]: entry }));
          else setClientVectorInputs((prev) => ({ ...prev, [key]: entry }));
        } catch (err) {
          if (
            session !== formSessionRef.current ||
            secondaryPickTokensRef.current[token] !== pickToken
          ) {
            return;
          }
          setError(
            err instanceof FileTooLargeError
              ? t("toolbar.rasterTool.vectorMemoryLimit", {
                  limit: MAX_CLIENT_VECTOR_BYTES / 1024 ** 2,
                })
              : err instanceof Error
                ? err.message
                : t("toolbar.rasterTool.layerLoadError"),
          );
        }
        return;
      }
      const path = await pickLocalPathWithFallback({
        filters: param.fileFilters,
      });
      if (path) setParam(param.id, path);
    },
    [engine, setParam, tool.inputFilters, t],
  );

  const startServer = useCallback(async () => {
    const restriction = sidecarRestriction(desktopServer);
    if (restriction) {
      setError(t(restriction));
      return;
    }
    setStartingServer(true);
    setError(null);
    try {
      await startGeoLibreSidecar();
      await checkRuntime();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("toolbar.rasterTool.errorStartSidecar"));
    } finally {
      setStartingServer(false);
    }
  }, [checkRuntime, desktopServer, t]);

  // Validate required operation parameters. A hidden parameter (e.g. an IDW
  // knob while kriging is selected) is skipped. Returns an error string or null.
  const validateParams = useCallback((): string | null => {
    for (const param of tool.parameters) {
      if (!param.required || !isParamVisible(param)) continue;
      // The client engine keeps picked files out of `params`.
      const clientParam = engine === "client" ? clientInputForParam(param) : null;
      if (clientParam) {
        const entries = clientParam.kind === "raster" ? clientAdditionalInputs : clientVectorInputs;
        if (!entries[clientParam.key]) return `"${param.label}" is required.`;
        continue;
      }
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
  }, [tool, params, isParamVisible, engine, clientAdditionalInputs, clientVectorInputs]);

  // Interpolation reads a point GeoJSON instead of a raster.
  const vectorPrimaryInput = rasterToolTakesVectorInput(tool.id);

  // Browser engine: pick a GeoTIFF (or the point GeoJSON) and read its bytes
  // into memory (works in both desktop and web, unlike the sidecar path which
  // needs a real file path).
  const pickClientInput = useCallback(async () => {
    const session = formSessionRef.current;
    const token = ++primaryPickTokenRef.current;
    const stale = () => session !== formSessionRef.current || token !== primaryPickTokenRef.current;
    layerFetchAbortRef.current?.abort();
    setResolvingLayer(false);
    setError(null);
    try {
      const picked = await openLocalDataFileWithFallback({
        filters: tool.inputFilters,
        accept: vectorPrimaryInput
          ? ".geojson,.json,application/geo+json,application/json"
          : ".tif,.tiff,image/tiff",
        readBinary: true,
        maxBytes: vectorPrimaryInput ? MAX_CLIENT_VECTOR_BYTES : undefined,
      });
      if (stale()) return;
      if (picked?.data) {
        clientRunIdRef.current += 1;
        setClientRunning(false);
        setClientInput({ name: picked.path, bytes: picked.data });
        // Drop any prior run's result/log so the Download button can't offer a
        // GeoTIFF computed from the previous input.
        setClientResult(null);
        setClientLog([]);
      }
    } catch (err) {
      if (!stale())
        setError(
          err instanceof FileTooLargeError
            ? t("toolbar.rasterTool.vectorMemoryLimit", {
                limit: MAX_CLIENT_VECTOR_BYTES / 1024 ** 2,
              })
            : err instanceof Error
              ? err.message
              : t("toolbar.rasterTool.layerLoadError"),
        );
    }
  }, [tool, vectorPrimaryInput, t]);

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
            engine === "client" ? canExportRasterLayer(layer) : sidecarRasterUrl(layer) !== null,
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
      const session = formSessionRef.current;
      const token = ++primaryPickTokenRef.current;
      const stale = () =>
        session !== formSessionRef.current || token !== primaryPickTokenRef.current;
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
        if (controller.signal.aborted || stale()) return;
        clientRunIdRef.current += 1;
        setClientRunning(false);
        setClientInput({ name: layer.name, bytes });
        setClientResult(null);
        setClientLog([]);
      } catch (err) {
        if (controller.signal.aborted || stale()) return;
        setError(err instanceof Error ? err.message : t("toolbar.rasterTool.layerLoadError"));
      } finally {
        if (!controller.signal.aborted && !stale()) setResolvingLayer(false);
      }
    },
    [layers, engine, t],
  );

  // Abort any in-flight layer-bytes fetch when the dialog unmounts.
  useEffect(
    () => () => {
      formSessionRef.current += 1;
      primaryPickTokenRef.current += 1;
      clientRunIdRef.current += 1;
      layerFetchAbortRef.current?.abort();
    },
    [],
  );

  const runSidecar = useCallback(async () => {
    setError(null);
    const restriction = sidecarRestriction(desktopServer);
    if (restriction) {
      setError(t(restriction));
      return;
    }
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
        setError(err instanceof Error ? err.message : t("toolbar.rasterTool.invalidSpectralIndex"));
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
      const message = err instanceof Error ? err.message : t("toolbar.rasterTool.errorStartTool");
      tracker.finish("error", message);
      setError(message);
    }
  }, [tool, inputPath, outputPath, params, validateParams, desktopServer, t]);

  const runClient = useCallback(async () => {
    setError(null);
    if (!useAppStore.getState().capabilities.privileges.includes("processing:run")) {
      setError(t("toolbar.rasterTool.processingRestricted"));
      return;
    }
    setClientResult(null);
    if (!clientInput) {
      setError(
        t(
          vectorPrimaryInput
            ? tool.id === "interpolate"
              ? "toolbar.rasterTool.chooseInputPoints"
              : "toolbar.rasterTool.chooseInputGeoJson"
            : "toolbar.rasterTool.chooseInputRaster",
        ),
      );
      return;
    }
    const invalid = validateParams();
    if (invalid) {
      setError(invalid);
      return;
    }
    const runId = ++clientRunIdRef.current;
    const isStale = () => clientRunIdRef.current !== runId;
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
      const parseVector = (entry: ClientRasterInputEntry): unknown => {
        const value = parseGeoJsonBytes(entry.bytes);
        if (value == null) {
          throw new Error(t("toolbar.rasterTool.invalidGeoJson", { name: entry.name }));
        }
        return value;
      };
      const vectors: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(clientVectorInputs)) {
        vectors[key] = parseVector(entry);
      }
      let raster: RasterData | undefined;
      if (vectorPrimaryInput) {
        vectors.input = parseVector(clientInput);
      } else {
        raster = await readRasterData(clientInput.bytes);
        if (isStale()) return;
        const loaded = raster;
        setClientLog((prev) => [
          ...prev,
          t("toolbar.rasterTool.loadedRaster", {
            width: loaded.width,
            height: loaded.height,
            bands: loaded.bands.length,
          }),
        ]);
      }
      // Compute is a synchronous pixel loop (millions of iterations for a large
      // DEM). Yield once so React paints the "running" spinner before the main
      // thread blocks; a Web Worker would be the full fix for very large rasters.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (isStale()) return;
      const pixelCount = raster ? raster.width * raster.height : 0;
      if (pixelCount > 2_000_000) {
        setClientLog((prev) => [
          ...prev,
          t("toolbar.rasterTool.largeRasterWarning", {
            mp: (pixelCount / 1_000_000).toFixed(1),
          }),
        ]);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (isStale()) return;
      }
      // The primary is already decoded under readRasterData's size guard.
      // Check its footprint together with output and secondary estimates
      // before decoding the secondary files.
      const additionalInputs = raster
        ? await loadClientAdditionalRasters(raster, clientAdditionalInputs, {
            outputBands: clientRasterOutputBands(tool.id, raster.bands.length),
            expression:
              tool.id === "raster-calc" && typeof params.expression === "string"
                ? params.expression
                : undefined,
          })
        : undefined;
      if (isStale()) return;
      const run = await runRasterToolClientAsync(
        tool.id,
        { raster, rasters: additionalInputs, vectors },
        params,
      );
      if (isStale()) return;
      // Tool-specific log lines (a transition matrix, flood pixel counts, ...).
      setClientLog((prev) => [
        ...prev,
        ...run.detailMessages,
        t("toolbar.rasterTool.computedInBrowser", { tool: tool.name }),
      ]);
      const outName = tool.defaultOutputName;
      if (run.kind === "vector") {
        const text = JSON.stringify(run.geojson);
        setClientResult({
          name: outName,
          bytes: new TextEncoder().encode(text).buffer as ArrayBuffer,
          kind: "vector",
        });
        if (run.wgs84) {
          addGeoJsonLayer(outName.replace(/\.(geo)?json$/i, ""), run.wgs84);
          setClientLog((prev) => [...prev, t("toolbar.rasterTool.addedToMap", { name: outName })]);
          tracker.addOutputLayer(outName);
        }
        tracker.finish("success");
        return;
      }
      const { raster: result, bytes } = run;
      // Persist the result before the map add so the Download button survives a
      // render failure (the compute already succeeded — don't discard it).
      setClientResult({ name: outName, bytes, kind: "raster" });
      const resultSampleCount = result.width * result.height * result.bands.length;
      if (exceedsBrowserCogConversionLimit(resultSampleCount)) {
        const message = t("raster.cogConvertTooLarge", { name: outName });
        setError(message);
        setClientLog((prev) => [...prev, message]);
        tracker.finish("error", message);
        return;
      }
      const app = createAppAPI(mapControllerRef);
      try {
        // Encode the computed Float32 samples directly. Passing the temporary
        // geotiff.js file through the WASM reader can reinterpret its byte
        // order and corrupt otherwise-correct calculated values. NoData goes in
        // as NaN so the overviews the auto stretch reads hold no NoData blends
        // (#3255); the Download button keeps the raster's own sentinel.
        const cogBytes = await convertRasterDataToCog(result, {
          nanNodata: true,
        });
        if (isStale()) return;
        await addRasterToMap(
          app,
          // TypeScript widens wasm byte buffers to ArrayBufferLike, which is
          // not directly assignable to BlobPart's ArrayBufferView.
          new File([cogBytes as Uint8Array<ArrayBuffer>], outName, {
            type: "image/tiff",
          }),
          {
            name: outName.replace(/\.tiff?$/i, ""),
          },
        );
        if (isStale()) return;
        setClientLog((prev) => [...prev, t("toolbar.rasterTool.addedToMap", { name: outName })]);
        tracker.addOutputLayer(outName);
      } catch (mapError) {
        if (isStale()) return;
        const mapMessage =
          mapError instanceof Error ? mapError.message : t("toolbar.rasterTool.mapAddError");
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
      if (isStale()) return;
      const message =
        err instanceof ClientRasterInputError && err.code === "VECTOR_TOO_LARGE"
          ? t("toolbar.rasterTool.vectorMemoryLimit", {
              limit: MAX_CLIENT_VECTOR_BYTES / 1024 ** 2,
            })
          : err instanceof ClientRasterInputError && err.code === "COMBINED_TOO_LARGE"
            ? t("toolbar.rasterTool.clientMemoryLimit")
            : err instanceof Error
              ? err.message
              : t("toolbar.rasterTool.runError");
      tracker.finish("error", message);
      setError(message);
      setClientLog((prev) => [...prev, message]);
    } finally {
      if (isStale()) {
        tracker.finish("error", "Superseded by an input change.");
      } else {
        setClientRunning(false);
      }
    }
  }, [
    tool,
    params,
    clientInput,
    clientAdditionalInputs,
    clientVectorInputs,
    vectorPrimaryInput,
    validateParams,
    mapControllerRef,
    addGeoJsonLayer,
    t,
  ]);

  const handleRun = useCallback(
    () => (engine === "client" ? runClient() : runSidecar()),
    [engine, runClient, runSidecar],
  );

  const downloadClientResult = useCallback(async () => {
    if (!clientResult) return;
    const vector = clientResult.kind === "vector";
    try {
      await saveBinaryFileWithFallback(new Uint8Array(clientResult.bytes), {
        defaultName: clientResult.name,
        filters: tool.outputFilters,
        browserTypes: vector
          ? [
              {
                description: "GeoJSON",
                accept: { "application/geo+json": [".geojson", ".json"] },
              },
            ]
          : [
              {
                description: "GeoTIFF",
                accept: { "image/tiff": [".tif", ".tiff"] },
              },
            ],
        mimeType: vector ? "application/geo+json" : "image/tiff",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("toolbar.rasterTool.saveError"));
    }
  }, [clientResult, tool, t]);

  const running = Boolean(job && RUNNING_JOB_STATUSES.has(job.status)) || clientRunning;

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
          <DialogTitle>{t("toolbar.rasterTool.dialogTitle")}</DialogTitle>
          <DialogDescription>{t("toolbar.rasterTool.dialogDescription")}</DialogDescription>
        </DialogHeader>

        <div className="flex gap-4">
          {/* Tool list */}
          <ScrollArea className="h-[26rem] w-48 shrink-0 rounded-md border">
            <div className="p-1">
              {groups.map((group) => (
                <div key={group.group} className="mb-1">
                  <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
                    {translateToolGroup(t, group.group)}
                  </div>
                  {group.tools.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => setSelectedId(entry.id)}
                      className={cn(
                        "w-full rounded-md px-2 py-1.5 text-start text-sm transition-colors hover:bg-accent",
                        entry.id === selectedId && "bg-accent font-medium text-accent-foreground",
                      )}
                    >
                      {translateToolName(t, "raster", entry)}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </ScrollArea>

          {/* Parameter form + run + log */}
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              {translateToolDescription(t, "raster", tool)}
            </p>

            {/* Engine selector (only for tools with both engines). */}
            {tool.clientOnly && (
              <p className="text-xs text-muted-foreground">
                {t("toolbar.rasterTool.clientOnlyHint")}
              </p>
            )}
            {tool.supportsClient && !tool.clientOnly && (
              <div className="flex flex-col gap-1">
                <Label className="flex items-center gap-1.5 text-xs">
                  <Server className="h-3.5 w-3.5" /> {t("toolbar.rasterTool.engine")}
                </Label>
                <Select
                  value={engine}
                  onChange={(e) =>
                    setEngine(e.target.value === "sidecar" && sidecarAllowed ? "sidecar" : "client")
                  }
                >
                  <option value="client">{t("toolbar.rasterTool.engineClient")}</option>
                  {/* The Mac App Store build has no sidecar at all, so the
                      option is dropped rather than shown disabled. */}
                  {!IS_MAS_BUILD && (
                    <option value="sidecar" disabled={!sidecarAllowed}>
                      {t("toolbar.rasterTool.engineSidecar")}
                    </option>
                  )}
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
                {sidecarAllowed && (
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
                    placeholder={t(
                      vectorPrimaryInput
                        ? "toolbar.rasterTool.chooseGeoJson"
                        : "toolbar.rasterTool.chooseGeoTiff",
                    )}
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
                  {t("toolbar.rasterTool.outputFile")}
                  <span className="text-destructive"> *</span>
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
            {tool.parameters.filter(isParamVisible).map((param) => {
              const clientParam = engine === "client" ? clientInputForParam(param) : null;
              const entry = clientParam
                ? (clientParam.kind === "raster" ? clientAdditionalInputs : clientVectorInputs)[
                    clientParam.key
                  ]
                : undefined;
              return (
                <RasterParameterField
                  key={param.id}
                  param={translateParameter(t, "raster", tool.id, param)}
                  value={clientParam ? (entry?.name ?? "") : params[param.id]}
                  onChange={(value) => setParam(param.id, value)}
                  onPick={() => void pickPathParam(param)}
                  readOnly={clientParam !== null}
                  inputKind={clientParam?.kind}
                  onClear={
                    clientParam && entry
                      ? () => clearClientSecondaryInput(clientParam.kind, clientParam.key)
                      : undefined
                  }
                />
              );
            })}

            <div>
              <Button
                onClick={() => void handleRun()}
                disabled={
                  running ||
                  !processingCap.granted ||
                  (engine === "sidecar" && !sidecarAllowed) ||
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
                      {t("toolbar.rasterTool.noOutput")}
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
                    {clientResult.kind === "vector"
                      ? t("toolbar.rasterTool.downloadGeoJson")
                      : t("toolbar.rasterTool.downloadGeoTiff")}
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
