import {
  DEFAULT_LAYER_STYLE,
  useAppStore,
  type GeoLibreLayer,
  type ModelGraphNode,
  type ProcessingModel,
  type ProcessingModelGraph,
} from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  VECTOR_TOOLS,
  fetchRemoteWhiteboxCatalogSnapshot,
  getVectorTool,
  listWasmToolManifests,
  mergeWasmToolManifests,
  runAlgorithmCapture,
  runModelGraph,
  runWhiteboxToolWasm,
  validateModelGraph,
  graphToLinearSteps,
  type ModelGraphIssue,
  type ModelToolDescriptor,
  type ModelValue,
  type WhiteboxLayerInput,
  type WhiteboxTool,
} from "@geolibre/processing";
import { Button, Input, Label, ScrollArea, Select, cn } from "@geolibre/ui";
import { Download, GripVertical, Loader2, Play, Plus, Save, Trash2, Upload, X } from "lucide-react";
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
import { clamp } from "../../../lib/clamp";
import { createDuckDbCapability } from "../../../lib/duckdb-processing";
import {
  buildModelToolCatalog,
  groupModelTools,
  searchModelTools,
} from "../../../lib/model-tool-catalog";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  addDataNode,
  addToolNode,
  autoLayout,
  connectNodes,
  emptyModelGraph,
  moveNode,
  removeEdge,
  removeNode,
  setNodeField,
  setNodeParameter,
} from "../../../lib/model-graph-edit";
import { fetchLayerBytes } from "../../../lib/whitebox-layer-inputs";
import { ParameterField } from "../ParameterField";

/** MIME type carrying a palette tool key through an HTML5 drag. */
const TOOL_DRAG_TYPE = "application/x-geolibre-model-tool";

const MIN_WIDTH = 820;
const MIN_HEIGHT = 420;
const EDGE_MARGIN = 12;

/** A best-effort unique id (the webview always has crypto.randomUUID). */
function createId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}`;
}

/** Where a port's connector dot sits, in canvas coordinates. */
function portPosition(
  node: ModelGraphNode,
  index: number,
  count: number,
  side: "in" | "out",
): { x: number; y: number } {
  const x = side === "in" ? node.x : node.x + NODE_WIDTH;
  const spacing = NODE_HEIGHT / (count + 1);
  return { x, y: node.y + spacing * (index + 1) };
}

interface ModelBuilderPanelProps {
  mapControllerRef: React.RefObject<MapController | null>;
  /** Adds a raster result (COG bytes) to the map, when the host supports it. */
  onAddRaster?: (bytes: Uint8Array, name: string, fileName: string) => Promise<void> | void;
}

/**
 * ArcGIS-ModelBuilder-style canvas: drag tools from the palette onto the canvas,
 * wire their ports together, and run the resulting graph. Lives in a floating,
 * resizable panel over the map so the user can see their layers while building.
 */
export function ModelBuilderPanel({
  mapControllerRef,
  onAddRaster,
}: ModelBuilderPanelProps): ReactElement | null {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.ui.modelBuilderOpen);
  const setOpen = useAppStore((s) => s.setModelBuilderOpen);
  const layers = useAppStore((s) => s.layers);
  const savedModels = useAppStore((s) => s.models);
  const saveModel = useAppStore((s) => s.saveModel);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);

  const [position, setPosition] = useState({ x: 48, y: 48 });
  const [size, setSize] = useState({ width: 980, height: 560 });
  const [modelId, setModelId] = useState<string>(() => createId());
  const [modelName, setModelName] = useState("");
  const [graph, setGraph] = useState<ProcessingModelGraph>(emptyModelGraph);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ModelToolDescriptor[]>([]);
  const [search, setSearch] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [nodeStatus, setNodeStatus] = useState<Record<string, "running" | "done" | "error">>({});
  const abortRef = useRef<AbortController | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);

  const appendLog = useCallback((line: string) => setLog((prev) => [...prev, line]), []);

  // The default size assumes a full-width map; open side panels can leave much
  // less, which would push the inspector column out of view. Shrink to whatever
  // the map area actually offers the first time the panel is shown.
  useLayoutEffect(() => {
    if (!open) return;
    const bounds = sectionRef.current?.parentElement?.getBoundingClientRect();
    if (!bounds) return;
    setSize((current) => ({
      width: clamp(current.width, MIN_WIDTH, Math.max(MIN_WIDTH, bounds.width - EDGE_MARGIN * 2)),
      height: clamp(
        current.height,
        MIN_HEIGHT,
        Math.max(MIN_HEIGHT, bounds.height - EDGE_MARGIN * 2),
      ),
    }));
    setPosition((current) => ({
      x: clamp(current.x, 0, Math.max(0, bounds.width - MIN_WIDTH - EDGE_MARGIN)),
      y: clamp(current.y, 0, Math.max(0, bounds.height - MIN_HEIGHT - EDGE_MARGIN)),
    }));
  }, [open]);

  // Load both registries once the panel is first opened. The Whitebox catalog is
  // a fetched snapshot and the WASM manifests load the binary, so they run
  // concurrently and each degrades independently: losing one still leaves a
  // usable palette built from the other.
  useEffect(() => {
    if (!open || catalog.length > 0) return;
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
    })();
    return () => {
      cancelled = true;
    };
  }, [open, catalog.length]);

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
  const filtered = useMemo(() => searchModelTools(catalog, search), [catalog, search]);
  const groups = useMemo(() => groupModelTools(filtered), [filtered]);

  const resetRunState = useCallback(() => {
    setNodeStatus({});
    setLog([]);
  }, []);

  const handleNewModel = useCallback(() => {
    setModelId(createId());
    setModelName("");
    setGraph(emptyModelGraph());
    setSelectedNodeId(null);
    resetRunState();
  }, [resetRunState]);

  const handleLoadModel = useCallback(
    (model: ProcessingModel) => {
      setModelId(model.id);
      setModelName(model.name);
      setGraph(autoLayout(model.graph ?? stepsToGraph(model)));
      setSelectedNodeId(null);
      resetRunState();
    },
    [resetRunState],
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
    const json = JSON.stringify({ name: modelName, graph }, null, 2);
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
      try {
        const parsed = JSON.parse(await file.text()) as {
          name?: unknown;
          graph?: ProcessingModelGraph;
        };
        if (!parsed.graph || !Array.isArray(parsed.graph.nodes)) {
          throw new Error(t("processing.modelBuilder.importInvalid"));
        }
        setModelName(typeof parsed.name === "string" ? parsed.name : "");
        setGraph(autoLayout(parsed.graph));
        setSelectedNodeId(null);
        resetRunState();
        appendLog(t("processing.modelBuilder.importedLog", { nodes: parsed.graph.nodes.length }));
      } catch (err) {
        appendLog(`${t("processing.modelBuilder.importFailed")}: ${(err as Error).message}`);
      }
    },
    [appendLog, resetRunState, t],
  );

  // --- Canvas interaction -------------------------------------------------

  const canvasPoint = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const scrollLeft = canvasRef.current?.scrollLeft ?? 0;
    const scrollTop = canvasRef.current?.scrollTop ?? 0;
    return {
      x: clientX - (rect?.left ?? 0) + scrollLeft,
      y: clientY - (rect?.top ?? 0) + scrollTop,
    };
  }, []);

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
        { x: Math.max(0, point.x - NODE_WIDTH / 2), y: Math.max(0, point.y - NODE_HEIGHT / 2) },
        createId,
      );
      setGraph(next.graph);
      setSelectedNodeId(next.nodeId);
    },
    [descriptorByKey, graph, canvasPoint],
  );

  const addNode = useCallback(
    (kind: "input" | "output") => {
      // Inputs go in the first column and outputs in the second; the placement
      // helper pushes a new card down until it has a clear footprint. Both stay
      // near the origin so they land in view even in a narrow panel, rather
      // than off the right edge where the user would have to scroll to find
      // them.
      const next = addDataNode(
        graph,
        kind,
        { x: kind === "input" ? 24 : 24 + NODE_WIDTH + 72, y: 24 },
        createId,
      );
      setGraph(next.graph);
      setSelectedNodeId(next.nodeId);
    },
    [graph],
  );

  // Node dragging.
  const handleNodePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, node: ModelGraphNode) => {
      if ((event.target as HTMLElement).closest("[data-port]")) return;
      event.preventDefault();
      setSelectedNodeId(node.id);
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startY = event.clientY;
      const origin = { x: node.x, y: node.y };
      const handleMove = (move: PointerEvent) => {
        setGraph((current) =>
          moveNode(current, node.id, {
            x: Math.max(0, origin.x + (move.clientX - startX)),
            y: Math.max(0, origin.y + (move.clientY - startY)),
          }),
        );
      };
      const handleEnd = () => {
        if (handle.hasPointerCapture(event.pointerId))
          handle.releasePointerCapture(event.pointerId);
        handle.removeEventListener("pointermove", handleMove);
        handle.removeEventListener("pointerup", handleEnd);
        handle.removeEventListener("pointercancel", handleEnd);
      };
      handle.addEventListener("pointermove", handleMove);
      handle.addEventListener("pointerup", handleEnd);
      handle.addEventListener("pointercancel", handleEnd);
    },
    [],
  );

  // Port-to-port wiring.
  const [linking, setLinking] = useState<{
    nodeId: string;
    portId: string;
    x: number;
    y: number;
  } | null>(null);

  const handlePortPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, nodeId: string, portId: string) => {
      event.preventDefault();
      event.stopPropagation();
      const start = canvasPoint(event.clientX, event.clientY);
      setLinking({ nodeId, portId, x: start.x, y: start.y });
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const handleMove = (move: PointerEvent) => {
        const point = canvasPoint(move.clientX, move.clientY);
        setLinking((current) => (current ? { ...current, x: point.x, y: point.y } : current));
      };
      const handleEnd = (end: PointerEvent) => {
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
        if (toNode && toPort) {
          setGraph((current) => {
            const result = connectNodes(
              current,
              { nodeId, portId },
              { nodeId: toNode, portId: toPort },
              createId,
            );
            if ("rejected" in result) {
              appendLog(
                result.rejected === "cycle"
                  ? t("processing.modelBuilder.connectCycle")
                  : t("processing.modelBuilder.connectSameNode"),
              );
              return current;
            }
            return result.graph;
          });
        }
        setLinking(null);
      };
      handle.addEventListener("pointermove", handleMove);
      handle.addEventListener("pointerup", handleEnd);
      handle.addEventListener("pointercancel", handleEnd);
    },
    [canvasPoint, appendLog, t],
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
    setNodeStatus({});
    const duckdb = createDuckDbCapability();
    try {
      const result = await runModelGraph(graph, {
        resolveDescriptor,
        resolveInput: (layerId) => layerToModelValue(layers, layerId),
        emitOutput: (name, value) => {
          if (value.kind === "vector") {
            addGeoJsonLayer(name, value.geojson);
          } else if (onAddRaster) {
            void onAddRaster(value.bytes, name, `${name.replace(/\s+/g, "_")}.tif`);
          } else {
            appendLog(t("processing.modelBuilder.rasterOutputUnsupported", { name }));
          }
        },
        log: appendLog,
        signal: controller.signal,
        onNodeStatus: (nodeId, status) =>
          setNodeStatus((current) => ({ ...current, [nodeId]: status })),
        executeTool: async ({ node, descriptor, inputs, signal }) =>
          executeModelTool({
            node,
            descriptor,
            inputs,
            signal,
            layers,
            duckdb,
            log: appendLog,
          }),
      });
      appendLog(
        result.error
          ? `${t("processing.modelBuilder.runFailed")}: ${result.error.message}`
          : t("processing.modelBuilder.runFinished", {
              outputs: Object.keys(result.outputs).length,
            }),
      );
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [issues.length, graph, resolveDescriptor, layers, addGeoJsonLayer, onAddRaster, appendLog, t]);

  // --- Panel chrome -------------------------------------------------------

  const handleDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button, input")) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const card = handle.closest("section") as HTMLElement;
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = position;
    const handleMove = (move: PointerEvent) => {
      const bounds = card.parentElement?.getBoundingClientRect();
      const maxX = bounds ? bounds.width - card.offsetWidth - EDGE_MARGIN : Infinity;
      const maxY = bounds ? bounds.height - card.offsetHeight - EDGE_MARGIN : Infinity;
      setPosition({
        x: clamp(origin.x + (move.clientX - startX), 0, Math.max(0, maxX)),
        y: clamp(origin.y + (move.clientY - startY), 0, Math.max(0, maxY)),
      });
    };
    const handleEnd = () => {
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener("pointermove", handleMove);
      handle.removeEventListener("pointerup", handleEnd);
      handle.removeEventListener("pointercancel", handleEnd);
    };
    handle.addEventListener("pointermove", handleMove);
    handle.addEventListener("pointerup", handleEnd);
    handle.addEventListener("pointercancel", handleEnd);
  };

  const handleResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const start = size;
    const handleMove = (move: PointerEvent) => {
      const bounds = (
        handle.closest("section") as HTMLElement
      )?.parentElement?.getBoundingClientRect();
      const maxWidth = bounds ? bounds.width - position.x - EDGE_MARGIN : Infinity;
      const maxHeight = bounds ? bounds.height - position.y - EDGE_MARGIN : Infinity;
      setSize({
        width: clamp(
          start.width + (move.clientX - startX),
          MIN_WIDTH,
          Math.max(MIN_WIDTH, maxWidth),
        ),
        height: clamp(
          start.height + (move.clientY - startY),
          MIN_HEIGHT,
          Math.max(MIN_HEIGHT, maxHeight),
        ),
      });
    };
    const handleEnd = () => {
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener("pointermove", handleMove);
      handle.removeEventListener("pointerup", handleEnd);
      handle.removeEventListener("pointercancel", handleEnd);
    };
    handle.addEventListener("pointermove", handleMove);
    handle.addEventListener("pointerup", handleEnd);
    handle.addEventListener("pointercancel", handleEnd);
  };

  if (!open) return null;

  const canvasExtent = graph.nodes.reduce(
    (acc, node) => ({
      width: Math.max(acc.width, node.x + NODE_WIDTH + 80),
      height: Math.max(acc.height, node.y + NODE_HEIGHT + 80),
    }),
    { width: 640, height: 400 },
  );

  return (
    <section
      ref={sectionRef}
      aria-label={t("processing.modelBuilder.title")}
      className="pointer-events-auto absolute z-20 flex flex-col overflow-hidden rounded-lg border bg-card shadow-xl"
      style={
        {
          left: position.x,
          top: position.y,
          width: size.width,
          height: size.height,
        } as CSSProperties
      }
    >
      {/* Title bar doubles as the drag handle. */}
      <div
        className="flex shrink-0 cursor-grab items-center gap-2 border-b bg-muted/40 px-2 py-1.5 active:cursor-grabbing"
        onPointerDown={handleDragStart}
      >
        <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="shrink-0 text-sm font-medium">{t("processing.modelBuilder.title")}</span>
        <Input
          value={modelName}
          onChange={(event) => setModelName(event.target.value)}
          placeholder={t("processing.modelBuilder.modelNamePlaceholder")}
          aria-label={t("processing.modelBuilder.modelName")}
          className="h-7 max-w-56 text-xs"
        />
        <div className="ms-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-7 gap-1 px-2" onClick={handleNewModel}>
            <Plus className="h-3.5 w-3.5" /> {t("processing.modelBuilder.newModel")}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 gap-1 px-2" onClick={handleSave}>
            <Save className="h-3.5 w-3.5" /> {t("common.save")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2"
            onClick={() => importRef.current?.click()}
          >
            <Upload className="h-3.5 w-3.5" /> {t("processing.modelBuilder.importModel")}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 gap-1 px-2" onClick={handleExport}>
            <Download className="h-3.5 w-3.5" /> {t("processing.modelBuilder.exportModel")}
          </Button>
          <Button
            size="sm"
            className="h-7 gap-1 px-2"
            onClick={() => void handleRun()}
            disabled={running || issues.length > 0}
          >
            {running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            {t("processing.modelBuilder.runModel")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={() => setOpen(false)}
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

      <div className="flex min-h-0 flex-1">
        {/* Palette */}
        <div className="flex w-52 shrink-0 flex-col border-e">
          <div className="space-y-1 border-b p-2">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("processing.modelBuilder.searchTools")}
              aria-label={t("processing.modelBuilder.searchTools")}
              className="h-7 text-xs"
            />
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="outline"
                className="h-6 flex-1 px-1 text-[11px]"
                onClick={() => addNode("input")}
              >
                {t("processing.modelBuilder.addInputNode")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-6 flex-1 px-1 text-[11px]"
                onClick={() => addNode("output")}
              >
                {t("processing.modelBuilder.addOutputNode")}
              </Button>
            </div>
          </div>
          <ScrollArea className="min-h-0 flex-1 p-2">
            {catalog.length === 0 ? (
              <p className="p-2 text-xs text-muted-foreground">
                {t("processing.modelBuilder.loadingTools")}
              </p>
            ) : groups.length === 0 ? (
              <p className="p-2 text-xs text-muted-foreground">
                {t("processing.modelBuilder.noToolsMatch")}
              </p>
            ) : (
              groups.map((group) => (
                <div key={group.group} className="mb-2">
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {group.group}
                  </p>
                  {group.tools.map((tool) => (
                    <div
                      key={tool.key}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData(TOOL_DRAG_TYPE, tool.key);
                        event.dataTransfer.effectAllowed = "copy";
                      }}
                      title={tool.description ?? tool.name}
                      className="cursor-grab truncate rounded px-1.5 py-1 text-xs hover:bg-accent active:cursor-grabbing"
                    >
                      {tool.name}
                    </div>
                  ))}
                </div>
              ))
            )}
          </ScrollArea>
        </div>

        {/* Canvas */}
        <div
          ref={canvasRef}
          className="relative min-w-0 flex-1 overflow-auto bg-muted/20"
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes(TOOL_DRAG_TYPE)) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }
          }}
          onDrop={handleCanvasDrop}
          onClick={(event) => {
            if (event.target === event.currentTarget) setSelectedNodeId(null);
          }}
        >
          <div
            className="relative"
            style={{ width: canvasExtent.width, height: canvasExtent.height }}
          >
            <GraphEdges
              graph={graph}
              resolveDescriptor={resolveDescriptor}
              linking={linking}
              onRemoveEdge={(edgeId) => setGraph((current) => removeEdge(current, edgeId))}
            />
            {graph.nodes.map((node) => (
              <GraphNodeCard
                key={node.id}
                node={node}
                descriptor={resolveDescriptor(node.provider, node.toolId)}
                layers={layers}
                selected={node.id === selectedNodeId}
                status={nodeStatus[node.id]}
                hasIssue={issuesByNode.has(node.id)}
                onPointerDown={handleNodePointerDown}
                onPortPointerDown={handlePortPointerDown}
              />
            ))}
          </div>
          {/* Centred on the visible canvas rather than the scroll extent, which
              is wider than the viewport and would push the hint out of sight. */}
          {graph.nodes.length === 0 && (
            <p className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-muted-foreground">
              {t("processing.modelBuilder.canvasEmpty")}
            </p>
          )}
        </div>

        {/* Inspector */}
        <div className="flex w-56 shrink-0 flex-col border-s">
          <ScrollArea className="min-h-0 flex-1 p-2">
            <NodeInspector
              node={selectedNode}
              descriptor={
                selectedNode
                  ? resolveDescriptor(selectedNode.provider, selectedNode.toolId)
                  : undefined
              }
              layers={layers}
              issues={selectedNode ? (issuesByNode.get(selectedNode.id) ?? []) : []}
              onFieldChange={(field, value) =>
                selectedNode &&
                setGraph((current) => setNodeField(current, selectedNode.id, field, value))
              }
              onParamChange={(paramId, value) =>
                selectedNode &&
                setGraph((current) => setNodeParameter(current, selectedNode.id, paramId, value))
              }
              onRemove={() => {
                if (!selectedNode) return;
                setGraph((current) => removeNode(current, selectedNode.id));
                setSelectedNodeId(null);
              }}
            />
          </ScrollArea>
          {savedModels.length > 0 && (
            <div className="border-t p-2">
              <Label htmlFor="model-saved-picker" className="text-[11px]">
                {t("processing.modelBuilder.savedModels")}
              </Label>
              <Select
                id="model-saved-picker"
                className="mt-1 h-7 w-full text-xs"
                value=""
                onChange={(event) => {
                  const model = savedModels.find((entry) => entry.id === event.target.value);
                  if (model) handleLoadModel(model);
                }}
              >
                <option value="">{t("processing.modelBuilder.loadModelPlaceholder")}</option>
                {savedModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name || t("processing.modelBuilder.untitledModel")}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>
      </div>

      {/* Issues + log */}
      <div className="h-24 shrink-0 border-t">
        <ScrollArea className="h-full p-2 font-mono text-[11px]">
          {issues.map((issue, index) => (
            <div key={index} className="text-destructive">
              {issue.message}
            </div>
          ))}
          {log.map((line, index) => (
            <div key={index} className="whitespace-pre-wrap">
              {line}
            </div>
          ))}
          {issues.length === 0 && log.length === 0 && (
            <span className="text-muted-foreground">
              {t("processing.modelBuilder.outputPlaceholder")}
            </span>
          )}
        </ScrollArea>
      </div>

      {/* Resize grip */}
      <div
        onPointerDown={handleResizeStart}
        role="separator"
        aria-label={t("processing.modelBuilder.resizePanel")}
        className="absolute bottom-0 end-0 h-4 w-4 cursor-nwse-resize"
      />
    </section>
  );
}

/** SVG layer drawing every connection, plus the in-progress link. */
function GraphEdges({
  graph,
  resolveDescriptor,
  linking,
  onRemoveEdge,
}: {
  graph: ProcessingModelGraph;
  resolveDescriptor: (provider?: string, toolId?: string) => ModelToolDescriptor | undefined;
  linking: { nodeId: string; portId: string; x: number; y: number } | null;
  onRemoveEdge: (edgeId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));

  const anchor = (nodeId: string, portId: string, side: "in" | "out") => {
    const node = byId.get(nodeId);
    if (!node) return null;
    const ports = portsOf(node, resolveDescriptor(node.provider, node.toolId));
    const list = side === "in" ? ports.inputs : ports.outputs;
    const index = list.findIndex((port) => port.id === portId);
    if (index < 0) return null;
    return portPosition(node, index, list.length, side);
  };

  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
      {graph.edges.map((edge) => {
        const from = anchor(edge.from, edge.fromPort, "out");
        const to = anchor(edge.to, edge.toPort, "in");
        if (!from || !to) return null;
        const midX = (from.x + to.x) / 2;
        return (
          <g key={edge.id} className="pointer-events-auto">
            <path
              d={`M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`}
              className="fill-none stroke-primary/70"
              strokeWidth={2}
            />
            {/* Fat invisible hit area so the thin curve is clickable. */}
            <path
              d={`M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`}
              className="cursor-pointer fill-none stroke-transparent"
              strokeWidth={12}
              onClick={() => onRemoveEdge(edge.id)}
            >
              <title>{t("processing.modelBuilder.removeConnection")}</title>
            </path>
          </g>
        );
      })}
      {linking &&
        (() => {
          const from = anchor(linking.nodeId, linking.portId, "out");
          if (!from) return null;
          return (
            <path
              d={`M ${from.x} ${from.y} L ${linking.x} ${linking.y}`}
              className="fill-none stroke-primary"
              strokeDasharray="4 3"
              strokeWidth={2}
            />
          );
        })()}
    </svg>
  );
}

/** The ports a node exposes, mirroring the graph engine's own rule. */
function portsOf(
  node: ModelGraphNode,
  descriptor: ModelToolDescriptor | undefined,
): { inputs: { id: string; label: string }[]; outputs: { id: string; label: string }[] } {
  if (node.kind === "input") return { inputs: [], outputs: [{ id: "out", label: "Output" }] };
  if (node.kind === "output") return { inputs: [{ id: "in", label: "Input" }], outputs: [] };
  return { inputs: descriptor?.inputs ?? [], outputs: descriptor?.outputs ?? [] };
}

/** One draggable card on the canvas. */
function GraphNodeCard({
  node,
  descriptor,
  layers,
  selected,
  status,
  hasIssue,
  onPointerDown,
  onPortPointerDown,
}: {
  node: ModelGraphNode;
  descriptor: ModelToolDescriptor | undefined;
  layers: GeoLibreLayer[];
  selected: boolean;
  status?: "running" | "done" | "error";
  hasIssue: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, node: ModelGraphNode) => void;
  onPortPointerDown: (
    event: ReactPointerEvent<HTMLButtonElement>,
    nodeId: string,
    portId: string,
  ) => void;
}): ReactElement {
  const { t } = useTranslation();
  const ports = portsOf(node, descriptor);
  const title =
    node.kind === "input"
      ? (layers.find((layer) => layer.id === node.layerId)?.name ??
        t("processing.modelBuilder.inputNode"))
      : node.kind === "output"
        ? node.name?.trim() || t("processing.modelBuilder.outputNode")
        : (descriptor?.name ?? node.toolId ?? "");

  return (
    <div
      onPointerDown={(event) => onPointerDown(event, node)}
      style={{ left: node.x, top: node.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
      className={cn(
        "absolute cursor-grab select-none rounded-md border bg-card p-2 shadow-sm active:cursor-grabbing",
        selected && "border-primary ring-2 ring-primary/30",
        hasIssue && !selected && "border-destructive",
        status === "running" && "ring-2 ring-primary",
        status === "done" && "border-primary/60",
        status === "error" && "border-destructive ring-2 ring-destructive/40",
      )}
    >
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {node.kind === "tool"
          ? (node.provider ?? "")
          : node.kind === "input"
            ? t("processing.modelBuilder.inputNode")
            : t("processing.modelBuilder.outputNode")}
      </p>
      <p className="truncate text-xs font-medium" title={title}>
        {title}
      </p>

      {ports.inputs.map((port, index) => {
        const at = portPosition(node, index, ports.inputs.length, "in");
        return (
          <button
            key={port.id}
            type="button"
            data-port="in"
            data-node-id={node.id}
            data-port-id={port.id}
            title={port.label}
            aria-label={t("processing.modelBuilder.inputPort", { port: port.label })}
            style={{ left: -6, top: at.y - node.y - 5 }}
            className="absolute h-2.5 w-2.5 rounded-full border border-primary bg-background"
          />
        );
      })}
      {ports.outputs.map((port, index) => {
        const at = portPosition(node, index, ports.outputs.length, "out");
        return (
          <button
            key={port.id}
            type="button"
            data-port="out"
            data-node-id={node.id}
            data-port-id={port.id}
            title={port.label}
            aria-label={t("processing.modelBuilder.outputPort", { port: port.label })}
            onPointerDown={(event) => onPortPointerDown(event, node.id, port.id)}
            style={{ right: -6, top: at.y - node.y - 5 }}
            className="absolute h-2.5 w-2.5 cursor-crosshair rounded-full border border-primary bg-primary"
          />
        );
      })}
    </div>
  );
}

/** Right-hand properties panel for whichever node is selected. */
function NodeInspector({
  node,
  descriptor,
  layers,
  issues,
  onFieldChange,
  onParamChange,
  onRemove,
}: {
  node: ModelGraphNode | null;
  descriptor: ModelToolDescriptor | undefined;
  layers: GeoLibreLayer[];
  issues: ModelGraphIssue[];
  onFieldChange: (field: "layerId" | "name", value: string) => void;
  onParamChange: (paramId: string, value: unknown) => void;
  onRemove: () => void;
}): ReactElement {
  const { t } = useTranslation();
  if (!node) {
    return (
      <p className="p-2 text-xs text-muted-foreground">
        {t("processing.modelBuilder.selectNodeHint")}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs font-semibold">
          {node.kind === "tool"
            ? (descriptor?.name ?? node.toolId)
            : node.kind === "input"
              ? t("processing.modelBuilder.inputNode")
              : t("processing.modelBuilder.outputNode")}
        </p>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0"
          onClick={onRemove}
          aria-label={t("processing.modelBuilder.removeNode")}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {issues.map((issue, index) => (
        <p key={index} className="text-[11px] text-destructive">
          {issue.message}
        </p>
      ))}

      {node.kind === "input" && (
        <div className="space-y-1">
          <Label htmlFor="model-node-layer" className="text-[11px]">
            {t("processing.modelBuilder.sourceLayer")}
          </Label>
          <Select
            id="model-node-layer"
            className="h-7 w-full text-xs"
            value={node.layerId ?? ""}
            onChange={(event) => onFieldChange("layerId", event.target.value)}
          >
            <option value="">{t("processing.modelBuilder.chooseLayer")}</option>
            {layers.map((layer) => (
              <option key={layer.id} value={layer.id}>
                {layer.name}
              </option>
            ))}
          </Select>
        </div>
      )}

      {node.kind === "output" && (
        <div className="space-y-1">
          <Label htmlFor="model-node-name" className="text-[11px]">
            {t("processing.modelBuilder.resultName")}
          </Label>
          <Input
            id="model-node-name"
            className="h-7 text-xs"
            value={node.name ?? ""}
            onChange={(event) => onFieldChange("name", event.target.value)}
            placeholder={t("processing.modelBuilder.resultNamePlaceholder")}
          />
        </div>
      )}

      {node.kind === "tool" && descriptor && (
        <div className="space-y-2">
          {descriptor.description && (
            <p className="text-[11px] text-muted-foreground">{descriptor.description}</p>
          )}
          {descriptor.parameters.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              {t("processing.modelBuilder.noParameters")}
            </p>
          ) : (
            descriptor.parameters.map((param) => (
              <ParameterField
                key={param.id}
                param={param}
                value={node.parameters?.[param.id]}
                layerOptions={layers.map((layer) => ({ id: layer.id, name: layer.name }))}
                onChange={(value) => onParamChange(param.id, value)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** Rebuild a graph from a legacy linear model, so old saves open on the canvas. */
function stepsToGraph(model: ProcessingModel): ProcessingModelGraph {
  const nodes: ModelGraphNode[] = [];
  const edges: ProcessingModelGraph["edges"] = [];
  let previousId: string | null = null;
  model.steps.forEach((step, index) => {
    nodes.push({
      id: step.id,
      kind: "tool",
      x: 40 + index * 240,
      y: 40,
      provider: "vector",
      toolId: step.toolId,
      parameters: { ...step.parameters },
    });
    if (previousId) {
      edges.push({
        id: `${previousId}-${step.id}`,
        from: previousId,
        fromPort: "out",
        to: step.id,
        toPort: step.inputParam ?? "layer",
      });
    }
    previousId = step.id;
  });
  if (previousId) {
    const outputId = `${previousId}-output`;
    nodes.push({
      id: outputId,
      kind: "output",
      x: 40 + model.steps.length * 240,
      y: 40,
      name: model.name,
    });
    edges.push({
      id: `${previousId}-to-output`,
      from: previousId,
      fromPort: "out",
      to: outputId,
      toPort: "in",
    });
  }
  return { nodes, edges };
}

/**
 * Wrap a project layer as a model value the graph runner can carry.
 *
 * A vector layer hands over its in-memory GeoJSON directly. A raster layer has
 * to have its bytes fetched — the same path the Whitebox toolbox uses for a
 * `raster_in`, so a locally loaded GeoTIFF resolves through its blob URL rather
 * than a file path the browser cannot read.
 *
 * @param layers The project layers.
 * @param layerId The layer an input node points at.
 * @returns The value, or `null` when the layer holds nothing runnable.
 */
async function layerToModelValue(
  layers: GeoLibreLayer[],
  layerId: string,
): Promise<ModelValue | null> {
  const layer = layers.find((entry) => entry.id === layerId);
  if (!layer) return null;
  if (layer.geojson) return { kind: "vector", geojson: layer.geojson };
  if (["raster", "cog", "wms", "wmts", "xyz", "zarr"].includes(layer.type)) {
    const bytes = await fetchLayerBytes(layer);
    if (bytes) return { kind: "raster", bytes, name: layer.name };
  }
  return null;
}

/**
 * Run one tool node, dispatching to whichever engine owns it.
 *
 * Client vector tools take a synthetic in-memory layer per wired input, exactly
 * as the linear runner does. Whitebox tools take their inputs as
 * `layer_inputs` — GeoJSON for a `vector_in`, raw GeoTIFF bytes for a
 * `raster_in` — and their job outputs are mapped back onto the descriptor's
 * output ports so the next node receives the right payload.
 */
async function executeModelTool({
  node,
  descriptor,
  inputs,
  signal,
  layers,
  duckdb,
  log,
}: {
  node: ModelGraphNode;
  descriptor: ModelToolDescriptor;
  inputs: Record<string, ModelValue>;
  signal?: AbortSignal;
  layers: GeoLibreLayer[];
  duckdb: ReturnType<typeof createDuckDbCapability>;
  log: (message: string) => void;
}): Promise<Record<string, ModelValue>> {
  if (descriptor.provider === "vector") {
    const tool = getVectorTool(descriptor.toolId);
    if (!tool) throw new Error(`Unknown vector tool "${descriptor.toolId}"`);
    // Each wired input becomes a synthetic layer the tool resolves by id, the
    // same trick the linear runner uses to chain a step's output forward.
    const synthetic: GeoLibreLayer[] = [];
    const parameters = { ...(node.parameters ?? {}) };
    for (const [portId, value] of Object.entries(inputs)) {
      if (value.kind !== "vector") {
        throw new Error(`"${portId}" needs vector data, but a raster arrived.`);
      }
      const syntheticId = `__geolibre_model_${node.id}_${portId}`;
      synthetic.push(syntheticLayer(syntheticId, portId, value.geojson));
      parameters[portId] = syntheticId;
    }
    const output = await runAlgorithmCapture(tool, parameters, {
      layers: [...layers, ...synthetic],
      log,
      duckdb,
      signal,
    });
    if (!output) throw new Error(`"${descriptor.name}" produced no output.`);
    return { out: { kind: "vector", geojson: output } };
  }

  const layerInputs: Record<string, WhiteboxLayerInput> = {};
  for (const [portId, value] of Object.entries(inputs)) {
    layerInputs[portId] =
      value.kind === "vector"
        ? { name: portId, kind: "vector_in", geojson: value.geojson }
        : { name: portId, kind: "raster_in", bytes: value.bytes };
  }
  const job = await runWhiteboxToolWasm({
    tool_id: descriptor.toolId,
    parameters: { ...(node.parameters ?? {}) },
    // The WASM runner builds its CLI arguments by walking `tool.params`; without
    // the manifest it passes none and the binary rejects the run as missing a
    // required parameter.
    tool: descriptor.native as WhiteboxTool | undefined,
    layer_inputs: layerInputs,
    include_pro: false,
    tier: "open",
  });
  if (job.error) throw new Error(job.error);
  for (const message of job.messages ?? []) log(message);

  const results: Record<string, ModelValue> = {};
  for (const port of descriptor.outputs) {
    const value = job.outputs?.[port.id];
    if (value instanceof Uint8Array) {
      results[port.id] = { kind: "raster", bytes: value, name: port.id };
    } else if (
      value &&
      typeof value === "object" &&
      (value as { type?: string }).type === "FeatureCollection"
    ) {
      results[port.id] = {
        kind: "vector",
        geojson: value as ModelValue extends { kind: "vector"; geojson: infer G } ? G : never,
      };
    }
  }
  if (Object.keys(results).length === 0) {
    throw new Error(`"${descriptor.name}" produced no usable output.`);
  }
  return results;
}

/** A throwaway in-memory layer wrapping one wired input for a client tool. */
function syntheticLayer(
  id: string,
  name: string,
  geojson: NonNullable<GeoLibreLayer["geojson"]>,
): GeoLibreLayer {
  return {
    id,
    name,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson,
  };
}
