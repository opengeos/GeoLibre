import {
  useAppStore,
  type ModelGraphNode,
  type ProcessingModel,
  type ProcessingModelGraph,
  useLayersWhen,
} from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import type { FeatureCollection } from "geojson";
import {
  VECTOR_TOOLS,
  fetchRemoteWhiteboxCatalogSnapshot,
  listWasmToolManifests,
  mergeWasmToolManifests,
  runModelGraph,
  validateModelGraph,
  graphToLinearSteps,
  type ModelGraphIssue,
  type ModelToolDescriptor,
} from "@geolibre/processing";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Input,
  ScrollArea,
  cn,
} from "@geolibre/ui";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  CopyPlus,
  BookOpen,
  Download,
  GripVertical,
  LayoutGrid,
  Maximize2,
  Minimize2,
  PanelLeft,
  PanelRight,
  Loader2,
  Play,
  Plus,
  Redo2,
  Save,
  Undo2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import type { ParseKeys } from "i18next";
import { createDuckDbCapability } from "../../../lib/duckdb-processing";
import { modelGraphToPython } from "../../../lib/model-python-script";
import {
  buildModelToolCatalog,
  groupModelTools,
  searchModelTools,
} from "../../../lib/model-tool-catalog";
import {
  modelProviderCatalog,
  translateToolGroup,
  translateToolName,
} from "../../../lib/processing-tool-i18n";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  addDataNode,
  addControlNode,
  addOutputForPort,
  addToolNode,
  autoLayout,
  clampCanvasZoom,
  connectNodes,
  createModelHistory,
  duplicateNodes,
  emptyModelGraph,
  graphsEqual,
  layoutGraph,
  moveNode,
  moveNodes,
  pushModelHistory,
  redoModelHistory,
  removeEdge,
  removeNodes,
  settleNode,
  undoModelHistory,
  type ModelHistoryState,
} from "../../../lib/model-graph-edit";
import { ModelBuilderMinimap } from "./ModelBuilderMinimap";
import { fieldNamesByLayer } from "../../../lib/layer-field-names";
import {
  MAX_IMPORT_BYTES,
  parseModelFile,
  readTextCapped,
  serializeModelFile,
  type ModelFileError,
} from "../../../lib/model-file";
import {
  SAMPLE_MODELS,
  bindSampleModelInputs,
  findSampleDataLayer,
  type SampleModel,
} from "../../../lib/sample-models";
import { createId, cardLayout, portsOf } from "./model-builder-layout";
import { translateIssue } from "./model-builder-labels";
import { stepsToGraph, layerToModelValue, executeModelTool } from "./model-tool-execution";
import { GraphEdges } from "./GraphEdges";
import { GraphNodeCard } from "./GraphNodeCard";
import { TOOL_DRAG_TYPE } from "./model-builder-constants";
import { ModelBuilderInspectorPane } from "./ModelBuilderInspectorPane";
import { ModelBuilderPalette } from "./ModelBuilderPalette";
import { useModelBuilderWindow } from "./useModelBuilderWindow";

interface ModelBuilderPanelProps {
  mapControllerRef: React.RefObject<MapEngine | null>;
  /** Adds a raster result (COG bytes) to the map, when the host supports it. */
  onAddRaster?: (bytes: Uint8Array, name: string, fileName: string) => Promise<void> | void;
  /**
   * Adds a remote COG to the map and resolves to its layer id, when the host
   * supports it. Loading a sample workflow uses it for the sample's DEM.
   */
  onAddRasterUrl?: (url: string, name: string) => Promise<string>;
}

/** How long a sample's model or data fetch may take before it is abandoned. */
const SAMPLE_FETCH_TIMEOUT_MS = 30_000;
/** Size cap on a sample's GeoJSON data; the bundled samples are a few KB. */
const MAX_SAMPLE_DATA_BYTES = 64 * 1024 * 1024;

/**
 * Settle with `promise`, or reject once `ms` pass. The underlying work is not
 * cancelled; this only stops a caller waiting on a host that has stalled.
 *
 * @param promise The work to wait for.
 * @param ms How long to wait, in milliseconds.
 * @returns The promise's value, if it settles in time.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Catalog key for each reason a model file is rejected. */
const MODEL_FILE_ERROR_KEYS: Record<ModelFileError, ParseKeys> = {
  tooLarge: "processing.modelBuilder.importTooLarge",
  unsupported: "processing.modelBuilder.importUnsupported",
  invalid: "processing.modelBuilder.importInvalid",
};

/**
 * ArcGIS-ModelBuilder-style canvas: drag tools from the palette onto the canvas,
 * wire their ports together, and run the resulting graph. Lives in a floating,
 * resizable panel over the map so the user can see their layers while building.
 */
export function ModelBuilderPanel({
  mapControllerRef,
  onAddRaster,
  onAddRasterUrl,
}: ModelBuilderPanelProps): ReactElement | null {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.ui.modelBuilderOpen);
  const requestedModelId = useAppStore((s) => s.ui.modelBuilderRequestedModelId);
  const setOpen = useAppStore((s) => s.setModelBuilderOpen);
  const setRequestedModelId = useAppStore((s) => s.setModelBuilderRequestedModelId);
  // Layers are only read while the panel is open (it stays mounted closed to
  // keep the model on the canvas).
  const layers = useLayersWhen(open);
  // Column names per layer for the inspector's field pickers (GeoLibre#2710),
  // recomputed only when the layer set changes rather than on every graph edit.
  const fieldsByLayer = useMemo(() => fieldNamesByLayer(layers), [layers]);
  const savedModels = useAppStore((s) => s.models);
  const saveModel = useAppStore((s) => s.saveModel);
  const deleteModel = useAppStore((s) => s.deleteModel);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const {
    position,
    size,
    maximized,
    paletteWidth,
    inspectorWidth,
    logHeight,
    minimized,
    setMinimized,
    sectionRef,
    handleDragStart,
    compact,
    maxSideWidth,
    handleSideResizeStart,
    maxLogHeight,
    handleLogResizeStart,
    handleLogResizeKey,
    handleSideResizeKey,
    handleResizeKey,
    handleResizeStart,
    toggleMaximized,
  } = useModelBuilderWindow({ open });
  /**
   * Which side pane is showing in compact mode, where they overlay the canvas
   * rather than sit beside it. Null means neither, which is the useful default
   * on a small screen: the canvas is what there is least room for.
   */
  const [compactPane, setCompactPane] = useState<"palette" | "inspector" | null>(null);
  const [modelId, setModelId] = useState<string>(() => createId());
  const [modelName, setModelName] = useState("");
  /** The sample workflow being fetched, so the menu can show progress and ignore repeats. */
  const [loadingSampleId, setLoadingSampleId] = useState<string | null>(null);
  const [graph, setGraph] = useState<ProcessingModelGraph>(emptyModelGraph);
  const [history, setHistory] = useState<ModelHistoryState>(createModelHistory);
  const [canvasZoom, setCanvasZoom] = useState(1);
  const graphRef = useRef(graph);
  const historyRef = useRef(history);
  const dragGenerationRef = useRef(0);
  useLayoutEffect(() => {
    graphRef.current = graph;
  }, [graph]);
  useLayoutEffect(() => {
    historyRef.current = history;
  }, [history]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(() => new Set());
  const selectedNodeIdsRef = useRef(selectedNodeIds);
  const canvasZoomRef = useRef(canvasZoom);
  useLayoutEffect(() => {
    selectedNodeIdsRef.current = selectedNodeIds;
  }, [selectedNodeIds]);
  useLayoutEffect(() => {
    canvasZoomRef.current = canvasZoom;
  }, [canvasZoom]);

  const pruneSelectionToGraph = useCallback((targetGraph: ProcessingModelGraph) => {
    const validIds = new Set(targetGraph.nodes.map((node) => node.id));
    setSelectedNodeIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (validIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
    setSelectedNodeId((prev) => (prev && validIds.has(prev) ? prev : null));
  }, []);

  const selectSingleNode = useCallback((id: string | null) => {
    setSelectedNodeId(id);
    setSelectedNodeIds(id ? new Set([id]) : new Set());
  }, []);

  const lastCoalesceEditRef = useRef<{
    key: string;
    at: number;
    graph: ProcessingModelGraph;
  } | null>(null);

  const commitGraph = useCallback(
    (
      updater: ProcessingModelGraph | ((current: ProcessingModelGraph) => ProcessingModelGraph),
      coalesceKey?: string,
    ) => {
      const current = graphRef.current;
      const next = typeof updater === "function" ? updater(current) : updater;
      if (next === current) return;
      const now = Date.now();
      const lastEdit = lastCoalesceEditRef.current;
      const shouldCoalesce =
        Boolean(coalesceKey) &&
        lastEdit !== null &&
        lastEdit.key === coalesceKey &&
        lastEdit.graph === current &&
        now - lastEdit.at < 800 &&
        historyRef.current.past.length > 0;
      const nextHistory = shouldCoalesce
        ? historyRef.current
        : pushModelHistory(historyRef.current, current);
      lastCoalesceEditRef.current = coalesceKey ? { key: coalesceKey, at: now, graph: next } : null;
      graphRef.current = next;
      historyRef.current = nextHistory;
      setGraph(next);
      if (!shouldCoalesce) setHistory(nextHistory);
    },
    [],
  );

  const handleUndo = useCallback(() => {
    const result = undoModelHistory(historyRef.current, graphRef.current);
    if (!result) return;
    lastCoalesceEditRef.current = null;
    dragGenerationRef.current += 1;
    graphRef.current = result.graph;
    historyRef.current = result.history;
    setGraph(result.graph);
    setHistory(result.history);
    pruneSelectionToGraph(result.graph);
  }, [pruneSelectionToGraph]);

  const handleRedo = useCallback(() => {
    const result = redoModelHistory(historyRef.current, graphRef.current);
    if (!result) return;
    lastCoalesceEditRef.current = null;
    dragGenerationRef.current += 1;
    graphRef.current = result.graph;
    historyRef.current = result.history;
    setGraph(result.graph);
    setHistory(result.history);
    pruneSelectionToGraph(result.graph);
  }, [pruneSelectionToGraph]);

  const handleDuplicateSelected = useCallback(() => {
    const ids =
      selectedNodeIds.size > 0
        ? Array.from(selectedNodeIds)
        : selectedNodeId
          ? [selectedNodeId]
          : [];
    if (ids.length === 0) return;
    const result = duplicateNodes(graphRef.current, ids, createId);
    if (result.nodeIds.length === 0) return;
    commitGraph(result.graph);
    setSelectedNodeIds(new Set(result.nodeIds));
    setSelectedNodeId(result.nodeIds[result.nodeIds.length - 1] ?? null);
  }, [commitGraph, selectedNodeId, selectedNodeIds]);

  const handleDeleteSelected = useCallback(() => {
    const ids =
      selectedNodeIds.size > 0
        ? Array.from(selectedNodeIds)
        : selectedNodeId
          ? [selectedNodeId]
          : [];
    if (ids.length === 0) return;
    commitGraph((current) => removeNodes(current, ids));
    setArmedPort((current) => (current && ids.includes(current.nodeId) ? null : current));
    selectSingleNode(null);
  }, [commitGraph, selectSingleNode, selectedNodeId, selectedNodeIds]);
  const [catalog, setCatalog] = useState<ModelToolDescriptor[]>([]);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  /** Bumped to re-run the catalog load after a failure. */
  const [retryToken, setRetryToken] = useState(0);
  const [search, setSearch] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  /** Script for the last graph that completed successfully, not later canvas edits. */
  const [pythonScript, setPythonScript] = useState<string | null>(null);
  const [nodeStatus, setNodeStatus] = useState<
    Record<string, "running" | "done" | "error" | "skipped">
  >({});
  /**
   * The output port a keyboard/click user has armed, waiting for an input port
   * to complete the connection. Null during pointer drags, which carry their
   * own in-flight state in {@link linking}.
   */
  const [armedPort, setArmedPort] = useState<{
    nodeId: string;
    portId: string;
  } | null>(null);
  const armedPortRef = useRef(armedPort);
  useLayoutEffect(() => {
    armedPortRef.current = armedPort;
  }, [armedPort]);
  const abortRef = useRef<AbortController | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  /**
   * The canvas and run state as of the latest render, so a sample that is
   * still fetching can tell whether the user edited the model or started a
   * run in the meantime.
   */
  const latestRef = useRef({ graph, modelName, running });
  useEffect(() => {
    latestRef.current = { graph, modelName, running };
  }, [graph, modelName, running]);
  const importRef = useRef<HTMLInputElement | null>(null);

  const appendLog = useCallback((line: string) => setLog((prev) => [...prev, line]), []);

  // Load both registries once the panel is first opened. The Whitebox catalog is
  // a fetched snapshot and the WASM manifests load the binary, so they run
  // concurrently and each degrades independently: losing one still leaves a
  // usable palette built from the other.
  useEffect(() => {
    if (!open || catalogLoaded) return;
    let cancelled = false;
    void (async () => {
      const [catalogResult, wasmResult] = await Promise.allSettled([
        fetchRemoteWhiteboxCatalogSnapshot(),
        listWasmToolManifests(),
      ]);
      if (cancelled) return;
      const catalogTools = catalogResult.status === "fulfilled" ? catalogResult.value : [];
      const wasmTools = wasmResult.status === "fulfilled" ? wasmResult.value : [];
      if (catalogResult.status === "rejected") {
        console.warn(
          "[GeoLibre] Model Builder could not load the Whitebox catalog:",
          catalogResult.reason,
        );
      }
      if (wasmResult.status === "rejected") {
        console.warn(
          "[GeoLibre] Model Builder could not enumerate WASM manifests:",
          wasmResult.reason,
        );
      }
      setCatalog(
        buildModelToolCatalog(VECTOR_TOOLS, mergeWasmToolManifests(catalogTools, wasmTools)),
      );
      // Both registries failing leaves a palette that can resolve nothing, which
      // must not read as "no problems found" on a canvas full of tool nodes.
      const bothFailed = catalogResult.status === "rejected" && wasmResult.status === "rejected";
      setCatalogFailed(bothFailed);
      // Only a successful load closes the door on retrying. Gating on
      // `catalog.length` instead would latch after the first attempt, since
      // VECTOR_TOOLS alone makes the catalog non-empty even when both remote
      // sources failed — leaving no way back short of reloading the app.
      setCatalogLoaded(!bothFailed);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, catalogLoaded, retryToken]);

  const descriptorByKey = useMemo(
    () => new Map(catalog.map((descriptor) => [descriptor.key, descriptor])),
    [catalog],
  );
  const resolveDescriptor = useCallback(
    (provider: string | undefined, toolId: string | undefined) =>
      provider && toolId ? descriptorByKey.get(`${provider}:${toolId}`) : undefined,
    [descriptorByKey],
  );

  const issues = useMemo(
    // An untouched canvas is not a broken model, and the palette has to be
    // loaded before an unknown-tool verdict means anything.
    () =>
      catalog.length && graph.nodes.length ? validateModelGraph(graph, resolveDescriptor) : [],
    [graph, resolveDescriptor, catalog.length],
  );
  const issuesByNode = useMemo(() => {
    const map = new Map<string, ModelGraphIssue[]>();
    for (const issue of issues) {
      if (!issue.nodeId) continue;
      const list = map.get(issue.nodeId) ?? [];
      list.push(issue);
      map.set(issue.nodeId, list);
    }
    return map;
  }, [issues]);

  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId) ?? null;
  // The palette renders translated names and owned-catalog group headings, so
  // the search has to see them too or a user can only find a tool by its
  // English name.
  const filtered = useMemo(
    () =>
      searchModelTools(catalog, search, (descriptor) => {
        const catalogName = modelProviderCatalog(descriptor.provider);
        // Whitebox categories render verbatim (see translateModelToolGroup), so
        // only its tool name is added to the localized haystack.
        if (!catalogName) return "";
        const name = translateToolName(t, catalogName, {
          id: descriptor.toolId,
          name: descriptor.name,
        });
        const group =
          descriptor.provider === "vector" ? translateToolGroup(t, descriptor.group) : "";
        return `${name} ${group}`;
      }),
    [catalog, search, t],
  );
  const groups = useMemo(() => groupModelTools(filtered), [filtered]);

  /**
   * Abandon any run still in flight. Its closure holds the graph and layers of
   * the session being replaced, so without this its log lines, node highlighting
   * and result layers would bleed into whatever the user switched to.
   */
  const abortRun = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const resetRunState = useCallback(() => {
    abortRun();
    // A port armed against the outgoing graph would wire the wrong node once a
    // different model is loaded under it.
    setArmedPort(null);
    // abortRun() clears the ref, so the in-flight run's `finally` no longer
    // matches its own controller and will not clear this itself.
    setRunning(false);
    setPythonScript(null);
    setNodeStatus({});
    setLog([]);
  }, [abortRun]);

  /** The name Save would write, so the dirty check compares like with like. */
  const savedName = modelName.trim() || t("processing.modelBuilder.untitledModel");

  /**
   * True when the canvas holds work Save has not written to the project.
   *
   * An untouched empty canvas is not unsaved work, so a freshly opened panel
   * never prompts. A model that has never been saved counts as dirty as soon
   * as it has a node or a name.
   */
  const dirty = useMemo(() => {
    if (graph.nodes.length === 0 && graph.edges.length === 0 && !modelName.trim()) return false;
    const saved = savedModels.find((model) => model.id === modelId);
    if (!saved) return true;
    if (saved.name !== savedName) return true;
    return !graphsEqual(saved.graph ?? emptyModelGraph(), graph);
  }, [graph, modelName, savedName, modelId, savedModels]);

  /**
   * Gate an action that replaces the canvas. New, Load and Import all throw
   * the current model away, so each asks first rather than discarding unsaved
   * work silently. `window.confirm` is blocking and matches how the rest of
   * the app confirms a discard (see PythonEditorPane).
   *
   * A run in flight is unsaved work of a different kind — `resetRunState`
   * aborts it — and a saved, unmodified model is not `dirty`, so it needs its
   * own prompt. That matters most for the AI Assistant, which can request a
   * model load the user never clicked; without this a background trigger would
   * kill a running job with no confirmation at all.
   */
  const confirmDiscard = useCallback(() => {
    if (running && !window.confirm(t("processing.modelBuilder.discardRunning"))) return false;
    return !dirty || window.confirm(t("processing.modelBuilder.discardChanges"));
  }, [dirty, running, t]);

  /**
   * Room the layout gets to work with: the canvas's own visible width, so a
   * long chain wraps into bands that stay on screen rather than running off
   * the right edge. `clientWidth` excludes the scrollbar, which is what the
   * nodes actually have to fit inside.
   */
  const layoutOptions = useCallback(
    () => ({ width: canvasRef.current?.clientWidth || undefined }),
    [],
  );

  const handleNewModel = useCallback(() => {
    if (!confirmDiscard()) return;
    setModelId(createId());
    setModelName("");
    setGraph(emptyModelGraph());
    setHistory(createModelHistory());
    selectSingleNode(null);
    resetRunState();
  }, [confirmDiscard, resetRunState, selectSingleNode]);

  /** @returns False when the user declined to discard what was on the canvas. */
  const handleLoadModel = useCallback(
    (model: ProcessingModel): boolean => {
      if (!confirmDiscard()) return false;
      setModelId(model.id);
      setModelName(model.name);
      setGraph(autoLayout(model.graph ?? stepsToGraph(model), layoutOptions()));
      setHistory(createModelHistory());
      selectSingleNode(null);
      resetRunState();
      return true;
    },
    [confirmDiscard, layoutOptions, resetRunState, selectSingleNode],
  );

  /** Re-run the depth-based layout over the nodes the user has moved around. */
  const handleArrange = useCallback(() => {
    commitGraph((current) => layoutGraph(current, layoutOptions()));
    // The layout starts at the origin, so a canvas left scrolled somewhere
    // else would open on empty space right after tidying it up.
    canvasRef.current?.scrollTo({ left: 0, top: 0 });
  }, [commitGraph, layoutOptions]);

  // Programmatic entry points (notably the AI Assistant) save a normal project
  // model and request that it be shown. Reuse the regular load path so an
  // unsaved canvas still receives its discard confirmation.
  useEffect(() => {
    if (!open || !requestedModelId) return;
    const requested = savedModels.find((model) => model.id === requestedModelId);
    setRequestedModelId(null);
    if (!requested || !handleLoadModel(requested)) return;
    // This request usually opens the panel, so on this pass the canvas is
    // still mounting and the `layoutOptions()` inside handleLoadModel measures
    // a width of zero — the layout then falls back to its default and a long
    // assistant-built chain lands off the visible area. Re-arrange on the next
    // frame, once the canvas has real width, so the model appears tidied and
    // scrolled to its start rather than needing a manual Arrange.
    const frame = requestAnimationFrame(() => handleArrange());
    return () => cancelAnimationFrame(frame);
  }, [open, requestedModelId, savedModels, setRequestedModelId, handleLoadModel, handleArrange]);

  /**
   * Forget the loaded model. The picker only offers models the project already
   * holds, so the button is meaningful exactly when the open model is one of
   * them; deleting leaves the canvas as-is so an accidental click loses only
   * the saved copy, which Save writes straight back.
   */
  const handleDeleteModel = useCallback(() => {
    if (!savedModels.some((model) => model.id === modelId)) return;
    deleteModel(modelId);
    appendLog(t("processing.modelBuilder.deletedLog"));
  }, [savedModels, deleteModel, modelId, appendLog, t]);

  /**
   * Keep a tool's result: drop an `output` node next to it and wire the two.
   * The port can still feed the next tool as well, so keeping an intermediate
   * step costs nothing downstream.
   */
  const handleKeepResult = useCallback(
    (nodeId: string, portId: string, name: string) => {
      commitGraph((current) => {
        const next = addOutputForPort(current, nodeId, portId, createId, name);
        return next ? next.graph : current;
      });
    },
    [commitGraph],
  );

  const handleSave = useCallback(() => {
    // Also write the legacy linear projection when the graph happens to be a
    // single vector chain, so a build without the canvas can still run it.
    saveModel({
      id: modelId,
      name: modelName.trim() || t("processing.modelBuilder.untitledModel"),
      steps: graphToLinearSteps(graph),
      graph,
    });
    appendLog(t("processing.modelBuilder.savedLog"));
  }, [saveModel, modelId, modelName, graph, appendLog, t]);

  const handleExport = useCallback(() => {
    const json = serializeModelFile(modelName, graph);
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const anchor = document.createElement("a");
    const slug = modelName
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "");
    anchor.href = url;
    anchor.download = `${slug || "model"}.model.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Defer revoke so the browser can fetch the blob first (Firefox races and
    // silently drops the download if the URL is revoked synchronously).
    setTimeout(() => URL.revokeObjectURL(url), 0);
    appendLog(t("processing.modelBuilder.exportedLog", { name: anchor.download }));
  }, [modelName, graph, appendLog, t]);

  const handleImport = useCallback(
    async (file: File) => {
      if (!confirmDiscard()) return;
      try {
        // Bounded before the read, so an obviously-too-large file never gets
        // decoded and parsed in full just to be rejected afterwards.
        if (file.size > MAX_IMPORT_BYTES) {
          throw new Error(t("processing.modelBuilder.importTooLarge"));
        }
        const parsed = parseModelFile(await file.text());
        if (!parsed.ok) throw new Error(t(MODEL_FILE_ERROR_KEYS[parsed.error]));
        const { graph } = parsed;
        setModelId(createId());
        setModelName(parsed.name);
        setGraph(autoLayout(graph, layoutOptions()));
        setHistory(createModelHistory());
        selectSingleNode(null);
        resetRunState();
        appendLog(
          t("processing.modelBuilder.importedLog", {
            nodes: graph.nodes.length,
          }),
        );
      } catch (err) {
        appendLog(`${t("processing.modelBuilder.importFailed")}: ${(err as Error).message}`);
      }
    },
    [appendLog, confirmDiscard, layoutOptions, resetRunState, selectSingleNode, t],
  );

  /**
   * Load one of the bundled sample workflows: fetch its `.model.json`, add (or
   * reuse) the sample datasets its input nodes read, and bind each input to
   * the matching layer so the model is ready to run as soon as it lands.
   *
   * The sample gets a fresh model id, so saving it never overwrites a model
   * the project already holds.
   */
  const handleLoadSample = useCallback(
    async (sample: SampleModel) => {
      if (loadingSampleId || !confirmDiscard()) return;
      const before = latestRef.current;
      setLoadingSampleId(sample.id);
      appendLog(t("processing.modelBuilder.samples.loadingLog", { name: sample.title }));
      try {
        // A timeout, so a stalled host cannot leave the Samples menu disabled.
        const response = await fetch(sample.modelUrl, {
          signal: AbortSignal.timeout(SAMPLE_FETCH_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        // Streamed with a byte cap, so an oversized file is never buffered
        // in full just to be rejected (the same bound Import puts on file.size).
        const text = await readTextCapped(response, MAX_IMPORT_BYTES);
        if (text === null) throw new Error(t("processing.modelBuilder.importTooLarge"));
        const parsed = parseModelFile(text);
        if (!parsed.ok) throw new Error(t(MODEL_FILE_ERROR_KEYS[parsed.error]));

        // Bind the sample datasets. Read the store directly: a dataset added
        // for an earlier entry must be visible to the reuse check of the next.
        // Log lines are collected and written after resetRunState(), which
        // clears the log; otherwise a failed dataset would leave the input
        // unbound with nothing saying why.
        const bindings = new Map<string, string>();
        const notes: string[] = [];
        for (const data of sample.data) {
          const existing = findSampleDataLayer(useAppStore.getState().layers, data.url);
          if (existing) {
            bindings.set(data.layerId, existing);
            continue;
          }
          try {
            let layerId: string | undefined;
            if (data.kind === "raster") {
              if (!onAddRasterUrl) {
                notes.push(
                  t("processing.modelBuilder.samples.rasterUnsupported", {
                    name: data.name,
                  }),
                );
                continue;
              }
              // Same bound as the fetches: addRasterToMap takes no signal, so
              // a stalled COG host is raced rather than cancelled.
              layerId = await withTimeout(
                onAddRasterUrl(data.url, data.name),
                SAMPLE_FETCH_TIMEOUT_MS,
              );
            } else {
              const res = await fetch(data.url, {
                signal: AbortSignal.timeout(SAMPLE_FETCH_TIMEOUT_MS),
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const text = await readTextCapped(res, MAX_SAMPLE_DATA_BYTES);
              if (text === null) {
                throw new Error(
                  t("processing.modelBuilder.samples.dataTooLarge", {
                    size: MAX_SAMPLE_DATA_BYTES / (1024 * 1024),
                  }),
                );
              }
              let geojson: FeatureCollection | null = null;
              try {
                geojson = JSON.parse(text) as FeatureCollection;
              } catch {
                // Malformed JSON gets the same message as a non-collection,
                // not the parser's raw (and untranslated) error.
              }
              if (geojson?.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
                throw new Error(t("processing.modelBuilder.samples.dataUnusable"));
              }
              layerId = addGeoJsonLayer(data.name, geojson, data.url);
            }
            if (layerId) {
              bindings.set(data.layerId, layerId);
              notes.push(
                t("processing.modelBuilder.samples.dataAddedLog", {
                  name: data.name,
                }),
              );
            }
          } catch (err) {
            // The model still loads; its input is left for the user to pick.
            notes.push(
              `${t("processing.modelBuilder.samples.dataFailed", {
                name: data.name,
              })}: ${(err as Error).message}`,
            );
          }
        }
        // The fetches above can take seconds while the canvas stays editable.
        // The discard prompt covered the model as it was then; ask again if
        // it changed or a run started since, rather than overwriting it.
        // Declining keeps the current canvas, but the data added above stays
        // on the map, so the log still says what was added.
        const now = latestRef.current;
        const declined =
          // Only a run that started during the load: one already running at
          // the click was covered by the first prompt.
          (now.running &&
            !before.running &&
            !window.confirm(t("processing.modelBuilder.discardRunning"))) ||
          ((now.graph !== before.graph || now.modelName !== before.modelName) &&
            !window.confirm(t("processing.modelBuilder.discardChanges")));
        if (declined) {
          notes.forEach(appendLog);
          return;
        }
        const graph = bindSampleModelInputs(
          parsed.graph,
          bindings,
          new Set(sample.data.map((data) => data.layerId)),
        );
        setModelId(createId());
        setModelName(parsed.name || sample.title);
        setGraph(autoLayout(graph, layoutOptions()));
        setHistory(createModelHistory());
        selectSingleNode(null);
        resetRunState();
        canvasRef.current?.scrollTo({ left: 0, top: 0 });
        notes.forEach(appendLog);
        appendLog(t("processing.modelBuilder.samples.loadedLog", { name: sample.title }));
      } catch (err) {
        appendLog(`${t("processing.modelBuilder.samples.loadFailed")}: ${(err as Error).message}`);
      } finally {
        setLoadingSampleId(null);
      }
    },
    [
      addGeoJsonLayer,
      appendLog,
      confirmDiscard,
      layoutOptions,
      loadingSampleId,
      onAddRasterUrl,
      resetRunState,
      selectSingleNode,
      t,
    ],
  );

  // --- Canvas interaction -------------------------------------------------

  const canvasPoint = useCallback(
    (clientX: number, clientY: number) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      const scrollLeft = canvasRef.current?.scrollLeft ?? 0;
      const scrollTop = canvasRef.current?.scrollTop ?? 0;
      const zoom = canvasZoom || 1;
      return {
        x: (clientX - (rect?.left ?? 0) + scrollLeft) / zoom,
        y: (clientY - (rect?.top ?? 0) + scrollTop) / zoom,
      };
    },
    [canvasZoom],
  );

  // Sync keyboard shortcuts (Undo/Redo/Duplicate/Delete) while Model Builder is open.
  useEffect(() => {
    if (!open || minimized) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const boundary = sectionRef.current;
      if (event.defaultPrevented) return;
      if (
        !boundary ||
        !target ||
        (!boundary.contains(target) && !boundary.contains(document.activeElement))
      ) {
        return;
      }
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable
      ) {
        return;
      }
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) handleRedo();
        else handleUndo();
      } else if (mod && event.key.toLowerCase() === "y") {
        event.preventDefault();
        handleRedo();
      } else if (mod && event.key.toLowerCase() === "d") {
        if (selectedNodeIds.size > 0 || selectedNodeId) {
          event.preventDefault();
          handleDuplicateSelected();
        }
      } else if (event.key === "Delete" || event.key === "Backspace") {
        const inCanvas = canvasRef.current?.contains(target) || target === boundary;
        if (inCanvas && (selectedNodeIds.size > 0 || selectedNodeId)) {
          event.preventDefault();
          handleDeleteSelected();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    open,
    minimized,
    handleUndo,
    handleRedo,
    handleDuplicateSelected,
    handleDeleteSelected,
    selectedNodeId,
    selectedNodeIds.size,
    sectionRef,
  ]);

  const handleCanvasDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const key = event.dataTransfer.getData(TOOL_DRAG_TYPE);
      const descriptor = descriptorByKey.get(key);
      if (!descriptor) return;
      const point = canvasPoint(event.clientX, event.clientY);
      const next = addToolNode(
        graph,
        descriptor,
        {
          x: Math.max(0, point.x - NODE_WIDTH / 2),
          y: Math.max(0, point.y - NODE_HEIGHT / 2),
        },
        createId,
      );
      commitGraph(next.graph);
      selectSingleNode(next.nodeId);
    },
    [descriptorByKey, graph, canvasPoint, commitGraph, selectSingleNode],
  );

  /** Drop a palette tool onto the canvas without a pointer drag. */
  const addToolAtDefault = useCallback(
    (descriptor: ModelToolDescriptor) => {
      const next = addToolNode(graph, descriptor, { x: 24 + NODE_WIDTH + 72, y: 24 }, createId);
      commitGraph(next.graph);
      selectSingleNode(next.nodeId);
    },
    [graph, commitGraph, selectSingleNode],
  );

  const addNode = useCallback(
    (kind: "input" | "output") => {
      const next = addDataNode(
        graph,
        kind,
        { x: kind === "input" ? 24 : 24 + NODE_WIDTH + 72, y: 24 },
        createId,
      );
      commitGraph(next.graph);
      selectSingleNode(next.nodeId);
    },
    [graph, commitGraph, selectSingleNode],
  );

  const addControlFlowNode = useCallback(
    (
      kind:
        | "iterate-features"
        | "iterate-rasters"
        | "collect-results"
        | "conditional-switch"
        | "conditional-merge",
    ) => {
      const next = addControlNode(graph, kind, { x: 24 + NODE_WIDTH + 36, y: 48 }, createId);
      commitGraph(next.graph);
      selectSingleNode(next.nodeId);
    },
    [graph, commitGraph, selectSingleNode],
  );

  // Non-passive native wheel listener so Ctrl/Cmd+wheel zooms the model canvas
  // without triggering browser page zoom.
  useEffect(() => {
    const el = canvasRef.current;
    if (!open || minimized || !el) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        setCanvasZoom((z) => clampCanvasZoom(z + (event.deltaY < 0 ? 0.1 : -0.1)));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [open, minimized]);

  // Node dragging (supports Shift/Ctrl multi-selection and group drag).
  const handleNodePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, node: ModelGraphNode) => {
      // Leave middle-button and Alt+left pan gestures to the canvas pan handler.
      if (event.button !== 0 || event.altKey) return;
      if ((event.target as HTMLElement).closest("[data-port]")) return;
      event.preventDefault();
      const additive = event.shiftKey || event.ctrlKey || event.metaKey;
      const currentSelection = selectedNodeIdsRef.current;
      let activeSelection: Set<string>;
      if (additive) {
        const nextSet = new Set(currentSelection);
        if (nextSet.has(node.id)) {
          nextSet.delete(node.id);
          setSelectedNodeIds(nextSet);
          setSelectedNodeId(nextSet.size > 0 ? Array.from(nextSet)[nextSet.size - 1] : null);
          return;
        }
        nextSet.add(node.id);
        setSelectedNodeIds(nextSet);
        setSelectedNodeId(node.id);
        activeSelection = nextSet;
      } else if (currentSelection.has(node.id) && currentSelection.size > 1) {
        setSelectedNodeId(node.id);
        activeSelection = currentSelection;
      } else {
        selectSingleNode(node.id);
        activeSelection = new Set([node.id]);
      }

      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startY = event.clientY;
      const zoom = canvasZoomRef.current || 1;
      const dragGen = dragGenerationRef.current;
      const snapshotBeforeDrag = graphRef.current;
      const origins = new Map<string, { x: number; y: number }>();
      let minOriginX = Infinity;
      let minOriginY = Infinity;
      for (const item of snapshotBeforeDrag.nodes) {
        if (activeSelection.has(item.id)) {
          origins.set(item.id, { x: item.x, y: item.y });
          if (item.x < minOriginX) minOriginX = item.x;
          if (item.y < minOriginY) minOriginY = item.y;
        }
      }
      if (!Number.isFinite(minOriginX)) minOriginX = 0;
      if (!Number.isFinite(minOriginY)) minOriginY = 0;
      let moved = false;
      let frame = 0;
      let pendingDelta: { dx: number; dy: number } | null = null;
      const commit = () => {
        frame = 0;
        const delta = pendingDelta;
        pendingDelta = null;
        if (!delta || dragGen !== dragGenerationRef.current) return;
        moved = true;
        const clampedDx = Math.max(-minOriginX, delta.dx);
        const clampedDy = Math.max(-minOriginY, delta.dy);
        if (origins.size === 1) {
          const origin = origins.get(node.id)!;
          setGraph((current) =>
            moveNode(current, node.id, {
              x: origin.x + clampedDx,
              y: origin.y + clampedDy,
            }),
          );
        } else {
          const positions = new Map<string, { x: number; y: number }>();
          for (const [id, origin] of origins) {
            positions.set(id, {
              x: origin.x + clampedDx,
              y: origin.y + clampedDy,
            });
          }
          setGraph((current) => moveNodes(current, positions));
        }
      };
      const handleMove = (move: PointerEvent) => {
        if (dragGen !== dragGenerationRef.current) return;
        pendingDelta = {
          dx: (move.clientX - startX) / zoom,
          dy: (move.clientY - startY) / zoom,
        };
        if (!frame) frame = requestAnimationFrame(commit);
      };
      const handleEnd = () => {
        if (handle.hasPointerCapture(event.pointerId))
          handle.releasePointerCapture(event.pointerId);
        handle.removeEventListener("pointermove", handleMove);
        handle.removeEventListener("pointerup", handleEnd);
        handle.removeEventListener("pointercancel", handleEnd);
        if (frame) cancelAnimationFrame(frame);
        if (dragGen !== dragGenerationRef.current) return;
        commit();
        if (moved) {
          const nextHistory = pushModelHistory(historyRef.current, snapshotBeforeDrag);
          historyRef.current = nextHistory;
          setHistory(nextHistory);
          setGraph((current) => {
            let settled = current;
            for (const movedId of origins.keys()) {
              settled = settleNode(settled, movedId);
            }
            return settled;
          });
        }
      };
      handle.addEventListener("pointermove", handleMove);
      handle.addEventListener("pointerup", handleEnd);
      handle.addEventListener("pointercancel", handleEnd);
    },
    [selectSingleNode],
  );

  // Port-to-port wiring.
  const [linking, setLinking] = useState<{
    nodeId: string;
    portId: string;
    x: number;
    y: number;
  } | null>(null);

  /**
   * Connect two ports, reporting a refusal the way the pointer path does.
   * Shared by the pointer drop and the keyboard click path so both wire nodes
   * through exactly the same rules.
   */
  const connectPorts = useCallback(
    (from: { nodeId: string; portId: string }, to: { nodeId: string; portId: string }) => {
      const current = graphRef.current;
      // connectNodes does not check that both endpoints still exist, and an
      // edge onto a deleted node renders nowhere.
      if (!current.nodes.some((node) => node.id === from.nodeId)) return;
      if (!current.nodes.some((node) => node.id === to.nodeId)) return;
      const result = connectNodes(current, from, to, createId);
      if ("rejected" in result) {
        appendLog(
          result.rejected === "cycle"
            ? t("processing.modelBuilder.connectCycle")
            : t("processing.modelBuilder.connectSameNode"),
        );
        return;
      }
      commitGraph(result.graph);
    },
    [appendLog, commitGraph, t],
  );

  /**
   * Keyboard/click wiring: activating an output port arms it, activating an
   * input port completes the connection. Native button activation (Enter or
   * Space) fires `click`, never `pointerdown`, so without this the whole
   * canvas is unusable without a pointing device. Activating the armed port
   * again disarms it, so there is a way out that does not need the mouse.
   *
   * Activating an already-wired input port with nothing armed disconnects it.
   * Removing an edge is otherwise only possible by clicking its curve, which
   * leaves a keyboard user who mis-wires two ports with no way to undo it.
   */
  const handlePortActivate = useCallback(
    (side: "in" | "out", nodeId: string, portId: string) => {
      if (side === "out") {
        setArmedPort((current) =>
          current && current.nodeId === nodeId && current.portId === portId
            ? null
            : { nodeId, portId },
        );
        return;
      }
      const current = armedPortRef.current;
      armedPortRef.current = null;
      setArmedPort(null);
      if (current) {
        connectPorts(current, { nodeId, portId });
      } else {
        setGraph((graphNow) => {
          const wired = graphNow.edges.find((edge) => edge.to === nodeId && edge.toPort === portId);
          return wired ? removeEdge(graphNow, wired.id) : graphNow;
        });
      }
    },
    [connectPorts],
  );

  const handlePortPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, nodeId: string, portId: string) => {
      event.preventDefault();
      event.stopPropagation();
      const start = canvasPoint(event.clientX, event.clientY);
      setLinking({ nodeId, portId, x: start.x, y: start.y });
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      // Coalesced to one commit per frame for the same reason the node drag is:
      // each update repaints every edge in GraphEdges, and a high-poll-rate
      // pointer reports several moves per frame.
      let frame = 0;
      let pending: { x: number; y: number } | null = null;
      const commit = () => {
        frame = 0;
        const next = pending;
        pending = null;
        if (next) setLinking((current) => (current ? { ...current, ...next } : current));
      };
      const handleMove = (move: PointerEvent) => {
        pending = canvasPoint(move.clientX, move.clientY);
        if (!frame) frame = requestAnimationFrame(commit);
      };
      const handleEnd = (end: PointerEvent) => {
        if (frame) cancelAnimationFrame(frame);
        if (handle.hasPointerCapture(end.pointerId)) handle.releasePointerCapture(end.pointerId);
        handle.removeEventListener("pointermove", handleMove);
        handle.removeEventListener("pointerup", handleEnd);
        handle.removeEventListener("pointercancel", handleEnd);
        // Resolve the drop target from the element under the pointer, since the
        // pointer is captured and the target port never receives its own event.
        const dropped = document
          .elementFromPoint(end.clientX, end.clientY)
          ?.closest<HTMLElement>("[data-port='in']");
        const toNode = dropped?.dataset.nodeId;
        const toPort = dropped?.dataset.portId;
        if (toNode && toPort) connectPorts({ nodeId, portId }, { nodeId: toNode, portId: toPort });
        setLinking(null);
      };
      handle.addEventListener("pointermove", handleMove);
      handle.addEventListener("pointerup", handleEnd);
      handle.addEventListener("pointercancel", handleEnd);
    },
    [canvasPoint, connectPorts],
  );

  // --- Running ------------------------------------------------------------

  const handleRun = useCallback(async () => {
    if (issues.length > 0) {
      appendLog(t("processing.modelBuilder.fixIssuesFirst"));
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setPythonScript(null);
    setNodeStatus({});
    const duckdb = createDuckDbCapability();
    // Outputs the host refused after the graph itself finished, so the summary
    // does not claim success for a layer that never reached the map. The adds
    // are awaited before the summary is logged, since they settle after
    // runModelGraph returns.
    const failedOutputs: string[] = [];
    const pendingAdds: Promise<unknown>[] = [];
    try {
      const result = await runModelGraph(graph, {
        resolveDescriptor,
        resolveInput: (layerId) => layerToModelValue(layers, layerId),
        emitOutput: (name, value) => {
          // A cancelled run must not drop layers into the session that replaced it.
          if (controller.signal.aborted) return;
          if (value.kind === "vector") {
            addGeoJsonLayer(name, value.geojson);
          } else if (value.kind === "raster") {
            if (onAddRaster) {
              pendingAdds.push(
                Promise.resolve(
                  onAddRaster(value.bytes, name, `${name.replace(/\s+/g, "_")}.tif`),
                ).catch((err: unknown) => {
                  // Otherwise this is an unhandled rejection and the run still
                  // reports success for an output that never reached the map.
                  failedOutputs.push(name);
                  appendLog(
                    `${t("processing.modelBuilder.outputAddFailed", {
                      name,
                    })}: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }),
              );
            } else {
              appendLog(t("processing.modelBuilder.rasterOutputUnsupported", { name }));
            }
          } else {
            // runModelGraph already splits a raster collection into one call
            // per raster; anything else (a count, a string) has no map form.
            failedOutputs.push(name);
            appendLog(
              t("processing.modelBuilder.outputUnsupported", {
                name,
                kind: value.kind,
              }),
            );
          }
        },
        log: (message) => {
          if (!controller.signal.aborted) appendLog(message);
        },
        signal: controller.signal,
        onNodeStatus: (nodeId, status) => {
          if (controller.signal.aborted) return;
          setNodeStatus((current) => ({ ...current, [nodeId]: status }));
        },
        executeTool: async ({ node, descriptor, inputs, signal }) =>
          executeModelTool({
            node,
            descriptor,
            inputs,
            signal,
            layers,
            duckdb,
            log: appendLog,
            t,
          }),
      });
      // Wait for the host's raster adds before summarising: they settle after
      // runModelGraph returns, so counting failures first would always read 0.
      await Promise.allSettled(pendingAdds);
      if (!controller.signal.aborted) {
        if (!result.error) setPythonScript(modelGraphToPython(graph, resolveDescriptor));
        appendLog(
          result.error
            ? `${t("processing.modelBuilder.runFailed")}: ${result.error.message}`
            : t("processing.modelBuilder.runFinished", {
                outputs: Object.keys(result.outputs).length - failedOutputs.length,
              }),
        );
      }
    } finally {
      // Only the run that still owns the controller clears the busy state; a
      // superseded run must not stop the spinner for the one that replaced it.
      if (abortRef.current === controller) {
        setRunning(false);
        abortRef.current = null;
      }
    }
  }, [issues.length, graph, resolveDescriptor, layers, addGeoJsonLayer, onAddRaster, appendLog, t]);

  const handleCopyPython = useCallback(async () => {
    if (!pythonScript) return;
    try {
      await navigator.clipboard.writeText(pythonScript);
      appendLog(t("processing.modelBuilder.pythonCopied"));
    } catch (error) {
      appendLog(
        `${t("processing.modelBuilder.pythonCopyFailed")}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }, [pythonScript, appendLog, t]);

  if (!open) return null;

  const canvasExtent = graph.nodes.reduce(
    (acc, node) => ({
      width: Math.max(acc.width, node.x + NODE_WIDTH + 80),
      // Per-node height, since a multi-port card is taller than NODE_HEIGHT and
      // the deepest one decides how far the canvas has to scroll.
      height: Math.max(
        acc.height,
        node.y +
          cardLayout(portsOf(node, resolveDescriptor(node.provider, node.toolId)), node.kind)
            .height +
          80,
      ),
    }),
    { width: 640, height: 400 },
  );

  return (
    <section
      ref={sectionRef}
      aria-label={t("processing.modelBuilder.title")}
      className={cn(
        "pointer-events-auto absolute z-20 flex flex-col overflow-hidden border bg-card shadow-xl",
        maximized ? "rounded-none" : "rounded-lg",
      )}
      style={
        {
          left: position.x,
          top: position.y,
          width: size.width,
          // Collapsed, the section shrinks to whatever the title bar needs
          // rather than painting a card-coloured rectangle over the map.
          height: minimized ? "auto" : size.height,
        } as CSSProperties
      }
    >
      {/* Title bar doubles as the drag handle. */}
      <div
        className="flex shrink-0 cursor-grab items-center gap-2 overflow-x-auto border-b bg-muted/40 px-2 py-1.5 active:cursor-grabbing"
        onPointerDown={handleDragStart}
      >
        <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        {/* The section's own aria-label still names the panel, so dropping the
            visible title on a narrow panel costs nothing and buys the toolbar
            the room its buttons need. */}
        {!compact && (
          <span className="shrink-0 text-sm font-medium">{t("processing.modelBuilder.title")}</span>
        )}
        <Input
          value={modelName}
          onChange={(event) => setModelName(event.target.value)}
          placeholder={t("processing.modelBuilder.modelNamePlaceholder")}
          aria-label={t("processing.modelBuilder.modelName")}
          className="h-7 min-w-16 max-w-56 text-xs"
        />
        {compact && !minimized && (
          <>
            <Button
              size="sm"
              variant={compactPane === "palette" ? "secondary" : "ghost"}
              className="h-7 w-7 shrink-0 p-0"
              onClick={() =>
                setCompactPane((current) => (current === "palette" ? null : "palette"))
              }
              aria-pressed={compactPane === "palette"}
              aria-label={t("processing.modelBuilder.searchTools")}
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant={compactPane === "inspector" ? "secondary" : "ghost"}
              className="h-7 w-7 shrink-0 p-0"
              onClick={() =>
                setCompactPane((current) => (current === "inspector" ? null : "inspector"))
              }
              aria-pressed={compactPane === "inspector"}
              aria-label={t("processing.modelBuilder.selectNodeHint")}
            >
              <PanelRight className="h-4 w-4" />
            </Button>
          </>
        )}
        <div className="ms-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 gap-1 px-2"
            onClick={handleNewModel}
            aria-label={t("processing.modelBuilder.newModel")}
            title={t("processing.modelBuilder.newModel")}
          >
            <Plus className="h-3.5 w-3.5" /> {!compact && t("processing.modelBuilder.newModel")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 gap-1 px-2"
            onClick={handleSave}
            aria-label={t("common.save")}
            title={t("common.save")}
          >
            <Save className="h-3.5 w-3.5" /> {!compact && t("common.save")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 shrink-0 p-0"
            onClick={handleUndo}
            disabled={history.past.length === 0}
            aria-label={t("processing.modelBuilder.undo")}
            title={t("processing.modelBuilder.undo")}
          >
            <Undo2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 shrink-0 p-0"
            onClick={handleRedo}
            disabled={history.future.length === 0}
            aria-label={t("processing.modelBuilder.redo")}
            title={t("processing.modelBuilder.redo")}
          >
            <Redo2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 shrink-0 p-0"
            onClick={handleDuplicateSelected}
            disabled={selectedNodeIds.size === 0 && !selectedNodeId}
            aria-label={t("processing.modelBuilder.duplicateSelected")}
            title={t("processing.modelBuilder.duplicateSelected")}
          >
            <CopyPlus className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 shrink-0 p-0"
            onClick={() => setCanvasZoom((z) => clampCanvasZoom(z - 0.15))}
            aria-label={t("processing.modelBuilder.zoomOut")}
            title={t("processing.modelBuilder.zoomOut")}
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 px-1.5 text-[11px] tabular-nums"
            onClick={() => setCanvasZoom(1)}
            aria-label={t("processing.modelBuilder.resetZoom")}
            title={t("processing.modelBuilder.resetZoom")}
          >
            {Math.round(canvasZoom * 100)}%
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 shrink-0 p-0"
            onClick={() => setCanvasZoom((z) => clampCanvasZoom(z + 0.15))}
            aria-label={t("processing.modelBuilder.zoomIn")}
            title={t("processing.modelBuilder.zoomIn")}
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 gap-1 px-2"
            onClick={handleArrange}
            disabled={graph.nodes.length === 0}
            aria-label={t("processing.modelBuilder.arrange")}
            title={t("processing.modelBuilder.arrangeHint")}
          >
            <LayoutGrid className="h-3.5 w-3.5" />{" "}
            {!compact && t("processing.modelBuilder.arrange")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 shrink-0 gap-1 px-2"
                disabled={loadingSampleId !== null}
                aria-label={t("processing.modelBuilder.samples.menu")}
                title={t("processing.modelBuilder.samples.menuHint")}
              >
                {loadingSampleId ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <BookOpen className="h-3.5 w-3.5" />
                )}{" "}
                {!compact && t("processing.modelBuilder.samples.menu")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80">
              <DropdownMenuLabel>{t("processing.modelBuilder.samples.heading")}</DropdownMenuLabel>
              {SAMPLE_MODELS.map((sample) => (
                <DropdownMenuItem
                  key={sample.id}
                  className="flex-col items-start gap-0.5"
                  onSelect={() => void handleLoadSample(sample)}
                >
                  <span className="text-sm font-medium">{sample.title}</span>
                  <span className="text-xs text-muted-foreground">{sample.description}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 gap-1 px-2"
            onClick={() => importRef.current?.click()}
            aria-label={t("processing.modelBuilder.importModel")}
            title={t("processing.modelBuilder.importModel")}
          >
            <Upload className="h-3.5 w-3.5" />{" "}
            {!compact && t("processing.modelBuilder.importModel")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 gap-1 px-2"
            onClick={handleExport}
            aria-label={t("processing.modelBuilder.exportModel")}
            title={t("processing.modelBuilder.exportModel")}
          >
            <Download className="h-3.5 w-3.5" />{" "}
            {!compact && t("processing.modelBuilder.exportModel")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 gap-1 px-2"
            onClick={() => void handleCopyPython()}
            disabled={!pythonScript || running}
            aria-label={t("processing.modelBuilder.copyPython")}
            title={t("processing.modelBuilder.copyPython")}
          >
            <Copy className="h-3.5 w-3.5" />
            {!compact && t("processing.modelBuilder.copyPython")}
          </Button>
          {running ? (
            <Button
              size="sm"
              variant="destructive"
              className="h-7 shrink-0 gap-1 px-2"
              onClick={() => {
                abortRun();
                setRunning(false);
                appendLog(t("processing.modelBuilder.runCancelled"));
              }}
              aria-label={t("processing.modelBuilder.cancelRun")}
              title={t("processing.modelBuilder.cancelRun")}
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {!compact && t("processing.modelBuilder.cancelRun")}
            </Button>
          ) : (
            <Button
              size="sm"
              className="h-7 shrink-0 gap-1 px-2"
              onClick={() => void handleRun()}
              // catalog.length === 0 is also the window where `issues` is
              // short-circuited to [], so without it Run looks enabled on a
              // just-loaded model that no tool can resolve yet.
              disabled={
                issues.length > 0 ||
                catalogFailed ||
                catalog.length === 0 ||
                graph.nodes.length === 0
              }
              aria-label={t("processing.modelBuilder.runModel")}
              title={t("processing.modelBuilder.runModel")}
            >
              <Play className="h-3.5 w-3.5" />
              {!compact && t("processing.modelBuilder.runModel")}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={() => setMinimized((current) => !current)}
            aria-expanded={!minimized}
            aria-label={
              minimized
                ? t("processing.modelBuilder.restorePanel")
                : t("processing.modelBuilder.minimizePanel")
            }
          >
            {minimized ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 shrink-0 p-0"
            onClick={toggleMaximized}
            aria-pressed={maximized}
            aria-label={
              maximized
                ? t("processing.modelBuilder.restorePanelSize")
                : t("processing.modelBuilder.maximizePanel")
            }
            title={
              maximized
                ? t("processing.modelBuilder.restorePanelSize")
                : t("processing.modelBuilder.maximizePanel")
            }
          >
            {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={() => {
              // Closing abandons the run too; nothing is left writing into a
              // panel the user has dismissed.
              abortRun();
              setRunning(false);
              setOpen(false);
            }}
            aria-label={t("common.close")}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <input
          ref={importRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleImport(file);
            event.target.value = "";
          }}
        />
      </div>

      {!minimized && (
        <div className="relative flex min-h-0 flex-1">
          {/* Palette. Compact: an overlay over the canvas, opened from the
              toolbar, so three columns never have to share a narrow row. */}
          {(!compact || compactPane === "palette") && (
            <ModelBuilderPalette
              compact={compact}
              size={size}
              paletteWidth={paletteWidth}
              maxSideWidth={maxSideWidth}
              search={search}
              setSearch={setSearch}
              t={t}
              addNode={addNode}
              addControlFlowNode={addControlFlowNode}
              catalog={catalog}
              groups={groups}
              addToolAtDefault={addToolAtDefault}
            />
          )}
          {!compact && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t("processing.modelBuilder.resizePalette")}
              tabIndex={0}
              onPointerDown={(event) => handleSideResizeStart(event, "palette")}
              onKeyDown={(event) => handleSideResizeKey(event, "palette")}
              className="w-1 shrink-0 cursor-col-resize bg-border/60 hover:bg-primary/60 focus-visible:bg-primary focus-visible:outline-none"
            />
          )}

          {/* Canvas */}
          <div
            ref={canvasRef}
            className="relative min-w-0 flex-1 overflow-auto bg-muted/20"
            onPointerDown={(event) => {
              // Middle-button or Alt+drag pans the scrollable canvas smoothly.
              if (event.button !== 1 && !(event.button === 0 && event.altKey)) return;
              const container = canvasRef.current;
              if (!container) return;
              event.preventDefault();
              const startX = event.clientX;
              const startY = event.clientY;
              const startLeft = container.scrollLeft;
              const startTop = container.scrollTop;
              const onMove = (move: PointerEvent) => {
                container.scrollLeft = startLeft - (move.clientX - startX);
                container.scrollTop = startTop - (move.clientY - startY);
              };
              const onUp = () => {
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
              };
              window.addEventListener("pointermove", onMove);
              window.addEventListener("pointerup", onUp);
            }}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes(TOOL_DRAG_TYPE)) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }
            }}
            onDrop={handleCanvasDrop}
            onClick={(event) => {
              if (event.target === event.currentTarget) selectSingleNode(null);
            }}
          >
            <div
              className="relative"
              style={{
                width: canvasExtent.width * canvasZoom,
                height: canvasExtent.height * canvasZoom,
              }}
            >
              <div
                className="relative origin-top-left"
                style={{
                  width: canvasExtent.width,
                  height: canvasExtent.height,
                  transform: `scale(${canvasZoom})`,
                }}
              >
                <GraphEdges
                  graph={graph}
                  resolveDescriptor={resolveDescriptor}
                  linking={linking}
                  onRemoveEdge={(edgeId) => commitGraph((current) => removeEdge(current, edgeId))}
                />
                {graph.nodes.map((node) => (
                  <GraphNodeCard
                    key={node.id}
                    node={node}
                    descriptor={resolveDescriptor(node.provider, node.toolId)}
                    layers={layers}
                    selected={selectedNodeIds.has(node.id) || node.id === selectedNodeId}
                    status={nodeStatus[node.id]}
                    hasIssue={issuesByNode.has(node.id)}
                    armedPortId={armedPort?.nodeId === node.id ? armedPort.portId : undefined}
                    onSelect={selectSingleNode}
                    onPointerDown={handleNodePointerDown}
                    onPortPointerDown={handlePortPointerDown}
                    onPortActivate={handlePortActivate}
                  />
                ))}
              </div>
            </div>
            <ModelBuilderMinimap
              graph={graph}
              selectedIds={selectedNodeIds}
              extentWidth={canvasExtent.width}
              extentHeight={canvasExtent.height}
              zoom={canvasZoom}
              canvasRef={canvasRef}
              onNavigate={(worldX, worldY) => {
                const container = canvasRef.current;
                if (!container) return;
                container.scrollTo({
                  left: Math.max(0, worldX * canvasZoom - container.clientWidth / 2),
                  top: Math.max(0, worldY * canvasZoom - container.clientHeight / 2),
                  behavior: "smooth",
                });
              }}
            />
            {/* Centred on the visible canvas rather than the scroll extent, which
              is wider than the viewport and would push the hint out of sight. */}
            {graph.nodes.length === 0 && (
              <p className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-muted-foreground">
                {t("processing.modelBuilder.canvasEmpty")}
              </p>
            )}
          </div>

          {!compact && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t("processing.modelBuilder.resizeInspector")}
              tabIndex={0}
              onPointerDown={(event) => handleSideResizeStart(event, "inspector")}
              onKeyDown={(event) => handleSideResizeKey(event, "inspector")}
              className="w-1 shrink-0 cursor-col-resize bg-border/60 hover:bg-primary/60 focus-visible:bg-primary focus-visible:outline-none"
            />
          )}

          {/* Inspector */}
          {(!compact || compactPane === "inspector") && (
            <ModelBuilderInspectorPane
              compact={compact}
              size={size}
              inspectorWidth={inspectorWidth}
              maxSideWidth={maxSideWidth}
              selectedNode={selectedNode}
              resolveDescriptor={resolveDescriptor}
              layers={layers}
              graph={graph}
              fieldsByLayer={fieldsByLayer}
              issuesByNode={issuesByNode}
              handleKeepResult={handleKeepResult}
              commitGraph={commitGraph}
              setArmedPort={setArmedPort}
              selectSingleNode={selectSingleNode}
              savedModels={savedModels}
              t={t}
              handleLoadModel={handleLoadModel}
              handleDeleteModel={handleDeleteModel}
              modelId={modelId}
            />
          )}
        </div>
      )}

      {/* Issues + log */}
      {!minimized && (
        <>
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label={t("processing.modelBuilder.resizeLog")}
            tabIndex={0}
            onPointerDown={handleLogResizeStart}
            onKeyDown={handleLogResizeKey}
            className="h-1 shrink-0 cursor-row-resize bg-border/60 hover:bg-primary/60 focus-visible:bg-primary focus-visible:outline-none"
          />
          <div className="shrink-0 border-t" style={{ height: Math.min(logHeight, maxLogHeight) }}>
            <ScrollArea className="h-full p-2 font-mono text-[11px]">
              {catalogFailed && (
                <div className="flex items-center gap-2 text-destructive">
                  <span>{t("processing.modelBuilder.catalogUnavailable")}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-5 px-1.5 text-[11px]"
                    onClick={() => {
                      setCatalogFailed(false);
                      setRetryToken((token) => token + 1);
                    }}
                  >
                    {t("common.retry")}
                  </Button>
                </div>
              )}
              {issues.map((issue, index) => (
                <div key={index} className="text-destructive">
                  {translateIssue(t, issue)}
                </div>
              ))}
              {log.map((line, index) => (
                <div key={index} className="whitespace-pre-wrap">
                  {line}
                </div>
              ))}
              {issues.length === 0 && log.length === 0 && !catalogFailed && (
                <span className="text-muted-foreground">
                  {t("processing.modelBuilder.outputPlaceholder")}
                </span>
              )}
            </ScrollArea>
          </div>
        </>
      )}

      {/* Resize grip */}
      {!minimized && !maximized && (
        <div
          onPointerDown={handleResizeStart}
          onKeyDown={handleResizeKey}
          role="separator"
          tabIndex={0}
          aria-label={t("processing.modelBuilder.resizePanel")}
          className="absolute bottom-0 end-0 h-4 w-4 cursor-nwse-resize focus-visible:bg-primary focus-visible:outline-none"
        />
      )}
    </section>
  );
}
