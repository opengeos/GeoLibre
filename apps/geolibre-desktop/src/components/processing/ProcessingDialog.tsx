import {
  useWhiteboxToolboxController,
  type WhiteboxToolboxServices,
} from "../../hooks/useWhiteboxToolboxController";
import { type GeoLibreLayer } from "@geolibre/core";
import { type MapEngine } from "@geolibre/map";
import {
  normalizeVectorOutputFormat,
  type WhiteboxJob,
  type WhiteboxTool,
  type WhiteboxToolParameter,
} from "@geolibre/processing";
import { Button, Input, Label, ScrollArea, Select, cn } from "@geolibre/ui";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FolderOpen,
  GripHorizontal,
  Link2,
  Loader2,
  Play,
  RefreshCw,
  Save,
  Scan,
  Search,
  Server,
  ServerOff,
  SquareDashed,
  X,
} from "lucide-react";
import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  isTauri,
  openLocalDataFileWithFallback,
  openLocalDataFilesWithFallback,
  pickLocalPathWithFallback,
  pickLocalPathsWithFallback,
  pickSavePathWithFallback,
} from "../../lib/tauri-io";
import { clamp } from "../../lib/clamp";
import { layersForSubsetUrl } from "../../lib/subset-tool-url";
import {
  DISTANCE_UNITS,
  parseDistanceInput,
  type DistanceUnit,
} from "../../lib/whitebox-distance-params";
import {
  isDirectoryParameter,
  isMultipleDatasetParameter,
  parameterKind,
} from "../../lib/whitebox-param-kind";
import { canUseLayerForParameter } from "../../lib/whitebox-layer-inputs";
import { isBboxExtentParameter, isCornerExtentParameter } from "../../lib/whitebox-extent";
import { IS_MAS_BUILD } from "../../lib/build-flags";
import { CrsPickerInput } from "./CrsPickerInput";
import { DOWNLOAD_GLOBAL_DEM_TOOL_ID } from "../../lib/global-dem";
import { SidecarHelpBanner } from "./SidecarHelpBanner";
import {
  whiteboxParameterLabel,
  translateToolDescription,
  humanizeParameterName,
  translateWhiteboxParameterDescription,
  translateWhiteboxCategory,
} from "../../lib/processing-tool-i18n";
import {
  LAYER_TOKEN_PREFIX,
  acceptForParameter,
  defaultOutputName,
  isCrsParameter,
  isDataInputParameter,
  isDistanceParameter,
  isOutputParameter,
  isPathParameter,
  isSubsetUrlParameter,
  jobStatusTone,
  outputEntries,
  pathFiltersForParameter,
  toolLabel,
  type ParameterValues,
} from "../../lib/processing-params";
import {
  distanceDraftForUnit,
  distanceDraftToStored,
  extentKindLabel,
  isRunDisabled,
  latitudeLabelKey,
  runtimeStatusText,
  stepNumberValue,
} from "../../lib/processing-dialog-model";

interface ProcessingDialogProps {
  mapControllerRef: React.RefObject<MapEngine | null>;
  // Renders a raster tool output (a Cloud Optimized GeoTIFF, from the WASM
  // runner) as a new map layer. Wired by the desktop shell, which owns the
  // raster control / app API.
  onAddRaster?: (bytes: Uint8Array, name: string, fileName?: string) => Promise<void> | void;
  // Renders a LiDAR tool output (LAS/LAZ/COPC bytes from the WASM runner) as a
  // new point cloud layer. Resolves false when the LiDAR control could not be
  // mounted, so the dialog falls back to downloading the file.
  onAddLidar?: (bytes: Uint8Array, name: string, fileName: string) => Promise<boolean>;
  // Catalog, runtime and download services; defaults to the real sidecar and
  // WASM runner. Tests pass stand-ins so no network or WASM module is needed.
  services?: WhiteboxToolboxServices;
}

// Smallest the floating panel can be resized to, so the two-column tool browser
// stays usable (left list + a readable parameter form).
const PANEL_MIN_W = 560;
const PANEL_MIN_H = 400;

export function ProcessingDialog({
  mapControllerRef,
  onAddRaster,
  onAddLidar,
  services,
}: ProcessingDialogProps) {
  const {
    open,
    setProcessingOpen,
    layers,
    desktop,
    desktopServer,
    tools,
    selectedToolId,
    setSelectedToolId,
    selectedTool,
    values,
    historyRestoreRevision,
    query,
    setQuery,
    category,
    setCategory,
    source,
    setSource,
    loadingTools,
    runtimeMessage,
    runtimeAvailable,
    runLocal,
    setRunLocal,
    error,
    setError,
    startingServer,
    stoppingServer,
    job,
    linkCopied,
    drawing,
    drawPoints,
    hasGeolibreTools,
    cornerExtentParams,
    cornerExtentAnchor,
    vectorInputParams,
    distanceLatitude,
    showDistanceNote,
    fieldOptions,
    sourceCounts,
    categories,
    filteredTools,
    semantic,
    semanticTools,
    keywordTools,
    running,
    sidecarJobRunning,
    cancellingJob,
    serverBusy,
    loadWhitebox,
    handleCopyLink,
    updateValue,
    handlePopulateSubsetUrl,
    handleUseMapExtent,
    handleDrawBbox,
    handleRunLocalChange,
    handlePickInputFile,
    handlePickInputFiles,
    runSelectedTool,
    startServer,
    stopServer,
    cancelSidecarJob,
  } = useWhiteboxToolboxController({ mapControllerRef, onAddRaster, onAddLidar, services });
  const { t } = useTranslation();

  // Floating, non-modal panel (GH: whitebox modal -> floating panel). Rendered
  // as a draggable `fixed` window instead of a Radix modal so the map stays
  // interactive while a tool is open (e.g. to pan/zoom and use "Use map extent"
  // for the subset tools). Mirrors RecordVideoDialog's drag pattern. `pos` is
  // null until first dragged, when the default corner placement (CSS) applies;
  // afterwards it pins to explicit coords.
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragOffset = useRef<{ x: number; y: number } | null>(null);
  // Explicit size, null until first resized (the default responsive CSS size
  // applies). A drag from the bottom-right grip grows the panel from its pinned
  // top-left corner.
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const resizeStart = useRef<{
    x: number;
    y: number;
    w: number;
    h: number;
    left: number;
    top: number;
  } | null>(null);

  const onDragStart = (event: React.PointerEvent) => {
    if (window.innerWidth < 640 && document.documentElement.dataset.touchUi === "true") return;
    // Never begin a drag from an interactive control: the pointer capture would
    // swallow the ensuing click (e.g. the close button).
    if ((event.target as Element).closest("button, a, input, [role='button']")) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOffset.current = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    setPos({ x: rect.left, y: rect.top });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onDragMove = (event: React.PointerEvent) => {
    if (!dragOffset.current) return;
    const width = panelRef.current?.offsetWidth ?? 0;
    const height = panelRef.current?.offsetHeight ?? 0;
    // Keep the panel within the viewport so it can't be dragged off-screen.
    const x = Math.max(
      0,
      Math.min(event.clientX - dragOffset.current.x, window.innerWidth - width),
    );
    const y = Math.max(
      0,
      Math.min(event.clientY - dragOffset.current.y, window.innerHeight - height),
    );
    setPos({ x, y });
  };

  const onDragEnd = (event: React.PointerEvent) => {
    dragOffset.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const onResizeStart = (event: React.PointerEvent) => {
    if (window.innerWidth < 640 && document.documentElement.dataset.touchUi === "true") return;
    // Don't also start a header drag; the grip lives outside the header but stop
    // propagation defensively.
    event.stopPropagation();
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Pin the top-left so the panel grows toward the grip instead of staying
    // centered (the default placement uses a translate to center it).
    setPos({ x: rect.left, y: rect.top });
    resizeStart.current = {
      x: event.clientX,
      y: event.clientY,
      w: rect.width,
      h: rect.height,
      left: rect.left,
      top: rect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onResizeMove = (event: React.PointerEvent) => {
    const start = resizeStart.current;
    if (!start) return;
    // Grow from the pinned top-left, clamped to a usable minimum and the room
    // available to the viewport edge. The minimum is itself capped to that room,
    // so a panel pinned near the edge (or a viewport smaller than the minimum)
    // shrinks to fit rather than being forced off-screen past the grip.
    const availW = window.innerWidth - start.left;
    const availH = window.innerHeight - start.top;
    const w = clamp(start.w + (event.clientX - start.x), Math.min(PANEL_MIN_W, availW), availW);
    const h = clamp(start.h + (event.clientY - start.y), Math.min(PANEL_MIN_H, availH), availH);
    setSize({ w, h });
  };

  const onResizeEnd = (event: React.PointerEvent) => {
    resizeStart.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  // Escape closes the panel, mirroring the affordance the Radix modal provided.
  // Since the panel is non-modal, only act when focus is inside it, so pressing
  // Escape to cancel an unrelated map/panel interaction doesn't also close this
  // one. Suppressed while drawing so Escape cancels the in-progress rubber-band
  // (the draw helper's own Escape handler) instead of closing the whole panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !drawing &&
        panelRef.current?.contains(document.activeElement)
      ) {
        setProcessingOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, drawing, setProcessingOpen]);

  // Re-clamp an explicit size and dragged position to the viewport, so a
  // resized/moved panel can't be left oversized or partly off-screen. Runs once
  // on open (position/size persist across opens, so the window may have shrunk
  // while the panel was closed) and on every subsequent resize. Functional
  // updates read the latest values, so the listener isn't re-subscribed on every
  // drag/resize frame; a never-moved/never-resized panel (null) keeps its
  // responsive CSS placement. The size minimum is capped to the viewport so a
  // window smaller than the minimum shrinks the panel to fit.
  useEffect(() => {
    if (!open) return;
    const clampToViewport = () => {
      setSize((current) =>
        current
          ? {
              w: clamp(current.w, Math.min(PANEL_MIN_W, window.innerWidth), window.innerWidth),
              h: clamp(current.h, Math.min(PANEL_MIN_H, window.innerHeight), window.innerHeight),
            }
          : null,
      );
      const panel = panelRef.current;
      if (!panel) return;
      setPos((current) =>
        current
          ? {
              x: Math.max(0, Math.min(current.x, window.innerWidth - panel.offsetWidth)),
              y: Math.max(0, Math.min(current.y, window.innerHeight - panel.offsetHeight)),
            }
          : null,
      );
    };
    // Coalesce the flurry of `resize` events during a live OS window-resize drag
    // into one clamp per frame (matching the rAF pattern used by the pointer
    // drag/resize handlers), so the tool browser doesn't re-render every tick.
    let raf = 0;
    const onResize = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        clampToViewport();
      });
    };
    clampToViewport();
    window.addEventListener("resize", onResize);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  // The non-modal panel no longer gets Radix's focus management, so move focus
  // into it on open (it carries role="dialog", so a screen reader announces it),
  // and best-effort restore focus to the opener on close. The focus is deferred
  // two frames: the panel is opened from a Radix menu that restores focus to its
  // trigger as it closes, so a single frame would be stolen back.
  const previousFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => panelRef.current?.focus());
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      // Only if the opener is still around; otherwise focus falls to the document.
      const prev = previousFocusRef.current;
      if (prev?.isConnected) prev.focus();
    };
  }, [open]);
  // The selected tool's row in the left list, so a preselection arriving from the
  // Processing menu can be scrolled into view (it may sit far down the catalog).
  const selectedButtonRef = useRef<HTMLButtonElement>(null);

  const renderToolRow = useCallback(
    (tool: WhiteboxTool) => (
      <button
        key={tool.id}
        type="button"
        ref={selectedTool?.id === tool.id ? selectedButtonRef : undefined}
        className={cn(
          "block w-full px-3 py-2 text-start text-sm transition-colors hover:bg-accent",
          selectedTool?.id === tool.id && "bg-accent",
          tool.locked && "opacity-60",
        )}
        onClick={() => setSelectedToolId(tool.id)}
      >
        <span className="block truncate font-medium">
          {tool.locked ? t("processing.whitebox.lockedPrefix") : ""}
          {toolLabel(t, tool)}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {translateWhiteboxCategory(t, tool.category)}
        </span>
      </button>
    ),
    [selectedTool?.id, setSelectedToolId, t],
  );

  // Keep the highlighted row visible: when the selection changes (e.g. a tool
  // preselected from the menu lands deep in the catalog), scroll its list row
  // into view. "nearest" leaves an already-visible row untouched.
  useEffect(() => {
    if (loadingTools) return;
    selectedButtonRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedToolId, loadingTools, filteredTools]);

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      data-processing-dialog=""
      data-drawing={drawing ? "true" : undefined}
      role="dialog"
      tabIndex={-1}
      aria-labelledby="whitebox-toolbox-title"
      aria-modal={false}
      style={{
        // Inline width/height (once resized) override the responsive w-/h- classes.
        ...(pos ? { left: pos.x, top: pos.y } : null),
        ...(size ? { width: size.w, height: size.h } : null),
      }}
      className={cn(
        // Height leaves room for the top offset (top-16) plus a bottom margin so
        // the whole panel - including the bottom-right resize grip - stays on
        // screen at small viewport heights.
        //
        // `@container/panel`: the responsive breakpoints inside measure this
        // panel, not the viewport. They cannot use `sm:`/`md:` because the panel
        // is draggable *and* resizable - `style.width` above overrides the
        // w-[min(72rem,95vw)] class - so a viewport media query would keep the
        // two-column layout after the user has dragged the panel down to 400px
        // on a desktop, which is the same squeeze as a phone.
        "@container/panel fixed z-40 flex h-[min(760px,calc(100vh-6rem))] w-[min(72rem,95vw)] flex-col overflow-hidden rounded-lg border bg-background shadow-xl",
        pos ? "" : "left-1/2 top-16 -translate-x-1/2",
      )}
    >
      {/* Draw-bbox preview, portaled to <body> as a viewport-space SVG overlay
          so it sits above an interleaved deck.gl raster (which occludes MapLibre
          layers) and escapes the panel's own transform/overflow. Non-interactive
          so it never blocks the drag on the map below. */}
      {drawPoints
        ? createPortal(
            <svg
              className="pointer-events-none fixed inset-0 z-30 h-full w-full"
              aria-hidden="true"
            >
              <polygon
                points={drawPoints.map((p) => `${p.x},${p.y}`).join(" ")}
                style={{
                  fill: "hsl(var(--primary))",
                  stroke: "hsl(var(--primary))",
                }}
                fillOpacity={0.12}
                strokeWidth={2}
                strokeDasharray="6 3"
              />
            </svg>,
            document.body,
          )
        : null}
      {/* Draggable title bar (replaces the Radix modal header) so the map stays
          interactive underneath the panel. */}
      <div
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        className="flex cursor-move touch-none select-none items-start justify-between gap-3 border-b px-5 py-3"
      >
        <div className="flex min-w-0 items-start gap-2">
          <GripHorizontal
            className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <h2
              id="whitebox-toolbox-title"
              className="text-lg font-semibold leading-none tracking-tight"
            >
              {t("processing.whitebox.toolbox")}
            </h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {runtimeStatusText(t, runtimeAvailable, runtimeMessage, tools.length)}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {drawing ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void handleDrawBbox()}
            >
              {t("common.cancel")}
            </Button>
          ) : null}
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={() => setProcessingOpen(false)}
            className="rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Tool list beside the parameter form, but only while the panel is wide
          enough for both. The list column's 260px floor is a hard minimum, so
          below roughly 576px it ate everything and left the form ~120px, where
          the label/value rows overflowed the panel entirely (a parameter label
          wrapped to one word per line and its input ran off the right edge).
          Under @xl the two stack into equal-height rows instead, each scrolling
          on its own. */}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-4 overflow-hidden p-5 @xl/panel:grid-cols-[minmax(260px,320px)_minmax(0,1fr)] @xl/panel:grid-rows-[minmax(0,1fr)]">
        {/* Divider follows the axis: a bottom rule between stacked rows, an end
            rule between side-by-side columns. */}
        <div className="flex min-h-0 flex-col gap-3 border-b pb-4 @xl/panel:border-b-0 @xl/panel:border-e @xl/panel:pb-0 @xl/panel:pe-4">
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                // The end padding is reserved whenever the lookup could run, not
                // only while it is running: letting it appear with the spinner
                // would reflow the text under the cursor mid-typing.
                className={cn("ps-9", semantic.available && "pe-9")}
                placeholder={
                  semantic.available
                    ? t("processing.whitebox.searchToolsByMeaning")
                    : t("processing.searchTools")
                }
              />
              {semantic.pending && (
                <Loader2
                  role="status"
                  aria-label={t("processing.whitebox.searchingByMeaning")}
                  className="absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground"
                />
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={loadWhitebox}
              disabled={serverBusy}
              title={t("processing.refreshCatalog")}
            >
              <RefreshCw className={cn("h-4 w-4", loadingTools && "animate-spin")} />
            </Button>
          </div>

          {/* The processing server is a local Python process that only the
              desktop app can spawn or stop. In the browser these buttons
              would always fail, and a same-origin sidecar (when deployed) is
              auto-detected without them, so gate both on the desktop build. */}
          {desktopServer && runtimeAvailable !== true && (
            <Button type="button" variant="outline" onClick={startServer} disabled={serverBusy}>
              {startingServer ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Server className="h-4 w-4" />
              )}
              {t("processing.whitebox.startServer")}
            </Button>
          )}

          {desktopServer && runtimeAvailable === true && (
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
              {t("processing.whitebox.stopServer")}
            </Button>
          )}

          {/* Side by side while the panel is stacked, so the two filters cost
              one row of height instead of two and the tool list keeps most of
              its half. Back to a column once the list has a column of its own,
              which is narrower than the panel. Flex, not a 2-col grid, so the
              category select still fills the row when the source filter is
              absent (no GeoLibre-authored tools in the catalog). */}
          <div className="flex gap-2 @xl/panel:flex-col @xl/panel:gap-3">
            <Select
              className="min-w-0 flex-1"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              aria-label={t("processing.whitebox.filterByCategory")}
            >
              {categories.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>

            {hasGeolibreTools && (
              <Select
                className="min-w-0 flex-1"
                value={source}
                // Reset the category too: a category with no tools in the newly
                // chosen source would otherwise leave the list empty.
                onChange={(e) => {
                  setSource(e.target.value);
                  setCategory("All");
                }}
                aria-label={t("processing.whitebox.filterBySource")}
              >
                <option value="All">
                  {t("processing.whitebox.allSources")} ({sourceCounts.all})
                </option>
                <option value="geolibre">
                  {t("processing.whitebox.geolibreTools")} ({sourceCounts.geolibre})
                </option>
                <option value="whitebox">
                  {t("processing.whitebox.whiteboxTools")} ({sourceCounts.whitebox})
                </option>
              </Select>
            )}
          </div>

          {/* `[&>div>div]:block!` targets the wrapper Radix puts inside the
              ScrollArea viewport, which ships as `display: table; min-width:
              100%`. Table layout sizes to content, so the widest tool name set
              the list's width and the rows' `truncate` never engaged - at a
              260px column, "Build Object Hierarchy Multiscale" laid out 330px
              wide and only the scrollport's clip hid it. As a block it fills the
              viewport instead and the names ellipsize as intended. The bang is
              load-bearing (Radix sets that display inline) and trails the
              utility, which is Tailwind v4's syntax and matches the same
              override in LayerPanel. Applied here rather than in the shared
              primitive: 129 call sites use ScrollArea and some legitimately want
              the content-sized, horizontally scrollable behaviour (the log pane
              below is one). */}
          <ScrollArea className="min-h-0 flex-1 rounded-md border [&>div>div]:block!">
            <div className="divide-y">
              {loadingTools ? (
                <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("processing.whitebox.loadingTools")}
                </div>
              ) : filteredTools.length === 0 && semanticTools.length === 0 ? (
                // A phrase with no substring hits is exactly the case the
                // lookup exists for, so saying "no tools found" while still
                // asking would have the dialog contradict itself for ~900ms.
                semantic.pending ? (
                  <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t("processing.whitebox.searchingByMeaning")}
                  </div>
                ) : (
                  <div className="p-3 text-sm text-muted-foreground">
                    {t("processing.whitebox.noToolsFound")}
                  </div>
                )
              ) : (
                <>
                  {/* Headings appear only once the lookup has answered, so with
                      it off or unanswered this is the flat list it always was. */}
                  {semanticTools.length > 0 && (
                    <div className="bg-muted/50 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                      {t("processing.whitebox.bestMatches")}
                    </div>
                  )}
                  {semanticTools.map(renderToolRow)}
                  {semanticTools.length > 0 && keywordTools.length > 0 && (
                    <div className="bg-muted/50 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                      {t("processing.whitebox.otherMatches")}
                    </div>
                  )}
                  {keywordTools.map(renderToolRow)}
                </>
              )}
            </div>
          </ScrollArea>
        </div>

        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-3">
          <div className="min-w-0 border-b pb-3">
            {/* Wraps rather than overflowing: the run-local toggle and the two
                buttons need ~250px between them, so on a narrow panel they drop
                to their own line under the tool name instead of running past
                the panel edge. The name asks for 12rem (`basis-48`) so that
                wrap actually triggers - with `flex-1` its basis is 0, and it
                would shrink to "Build..." to keep everything on one line rather
                than let the controls move down. `grow` still lets it take the
                slack on a wide panel. */}
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
              <div className="min-w-0 grow basis-48">
                <h3 className="truncate text-base font-semibold">
                  {selectedTool
                    ? toolLabel(t, selectedTool)
                    : t("processing.whitebox.noToolSelected")}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {selectedTool?.id}
                  {selectedTool?.license_tier ? ` | ${selectedTool.license_tier}` : ""}
                </p>
              </div>
              {/* The Mac App Store build has no sidecar to switch to, so the
                  local/server toggle is dropped (WASM is the only runtime). */}
              {!IS_MAS_BUILD && selectedTool?.id !== DOWNLOAD_GLOBAL_DEM_TOOL_ID && (
                <label
                  // whitespace-nowrap: the label is short enough to keep on one
                  // line, and letting it wrap turned "Run locally (WASM)" into a
                  // three-line stack squeezed against the buttons.
                  className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground"
                  title={t("processing.whitebox.runLocalHint")}
                >
                  <input
                    type="checkbox"
                    data-testid="whitebox-run-local"
                    checked={runLocal}
                    onChange={(e) => handleRunLocalChange(e.target.checked)}
                  />
                  {t("processing.whitebox.runLocal")}
                </label>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={handleCopyLink}
                disabled={!selectedTool}
                title={t("processing.whitebox.copyLinkHint")}
                aria-label={t("processing.whitebox.copyLink")}
              >
                {linkCopied ? <Check className="h-4 w-4" /> : <Link2 className="h-4 w-4" />}
                {linkCopied
                  ? t("processing.whitebox.copyLinkCopied")
                  : t("processing.whitebox.copyLink")}
              </Button>
              {sidecarJobRunning ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void cancelSidecarJob()}
                  disabled={cancellingJob}
                >
                  {t("common.cancel")}
                </Button>
              ) : null}
              <Button
                type="button"
                onClick={runSelectedTool}
                disabled={isRunDisabled({
                  tool: selectedTool,
                  running,
                  runLocal,
                  runtimeAvailable,
                })}
              >
                {running ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                {running ? t("processing.whitebox.running") : t("processing.whitebox.run")}
              </Button>
            </div>
            {selectedTool?.summary && (
              // Height-bounded and scrollable, not clamped. Catalog summaries
              // run from one line to ~2,400 characters (`lee_filter`), and the
              // long ones rendered 340px tall in a 624px dialog — pushing the
              // parameter form and the Run button below the fold on the tools
              // whose parameters most need explaining. Scrolling keeps the full
              // text, which is the useful half of it, without letting it take
              // the dialog over.
              <p className="mt-2 max-h-24 max-w-3xl overflow-y-auto text-sm text-muted-foreground">
                {translateToolDescription(t, "whitebox", {
                  id: selectedTool.id,
                  name: toolLabel(t, selectedTool),
                  description: selectedTool.summary,
                })}
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
            {/* A second container, because the picker/input rows below care
                about the width of this form, not of the whole panel: once the
                layout stacks, the form is full width even though the panel is
                narrow. */}
            <div className="@container/params grid gap-4 pb-2 pe-5">
              {/* The chosen layers are WGS84 and this tool takes a ground
                  distance, so its distance fields carry a unit picker
                  (GeoLibre#1540). Say once, up front, that the layers are
                  geographic and what to do about it, rather than repeating the
                  reprojection advice under every field. This note supersedes the
                  degrees warning below, which says the same thing without the
                  way out, so only one of the two ever renders. */}
              {showDistanceNote ? (
                <p className="text-xs text-muted-foreground">
                  {t("processing.distance.geographicNote")}
                </p>
              ) : null}
              {/* Local (WASM) mode hands every vector input to the runner as
                  GeoJSON, which RFC 7946 fixes to WGS84 — so a tool's distance,
                  spacing or tolerance parameter is measured in degrees, not
                  metres. Nothing in the tool descriptions says so, which is how
                  a 0.1 "spacing" (≈ 11 km) yielded a handful of points on a
                  city-scale line (GeoLibre#1458). */}
              {!showDistanceNote && runLocal && vectorInputParams.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("processing.whitebox.vectorUnitsNote")}
                </p>
              ) : null}
              {(selectedTool?.params ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("processing.whitebox.noParameters")}
                </p>
              ) : (
                selectedTool?.params?.map((param) => {
                  // The four boundary numbers are rendered together, once, at the
                  // position of the first of them; the other three are folded
                  // into that group rather than repeated below it.
                  if (isCornerExtentParameter(selectedTool, param)) {
                    if (param.name !== cornerExtentAnchor) return null;
                    return (
                      <ExtentParameterGroup
                        key="extent"
                        toolId={selectedTool.id}
                        params={cornerExtentParams}
                        values={values}
                        onChange={updateValue}
                        onUseMapExtent={handleUseMapExtent}
                        onDrawMapExtent={handleDrawBbox}
                        drawingMapExtent={drawing}
                      />
                    );
                  }
                  return (
                    <ParameterField
                      // Keyed by tool as well as parameter name: dozens of tools
                      // share names like `tolerance` or `radius`, and without the
                      // tool id React reuses the field instance across a tool
                      // switch, carrying a distance field's unit and typed draft
                      // over to a parameter that reset to another tool's default.
                      // History restores also reset those local drafts, while
                      // ordinary input-layer changes retain their metric units.
                      key={`${selectedTool.id}:${param.name}:${historyRestoreRevision}`}
                      param={param}
                      layers={layers}
                      toolId={selectedTool.id}
                      runLocal={runLocal}
                      value={values[param.name]}
                      fieldOptions={fieldOptions(param)}
                      degreeLatitude={
                        distanceLatitude !== null && isDistanceParameter(param)
                          ? distanceLatitude
                          : undefined
                      }
                      onChange={(value) => updateValue(param.name, value)}
                      onPickFile={(fileName, bytes) =>
                        handlePickInputFile(param.name, fileName, bytes)
                      }
                      onPickFiles={(files) => handlePickInputFiles(param.name, files)}
                      onUseMapExtent={
                        isBboxExtentParameter(selectedTool, param) ? handleUseMapExtent : undefined
                      }
                      onDrawMapExtent={
                        isBboxExtentParameter(selectedTool, param) ? handleDrawBbox : undefined
                      }
                      drawingMapExtent={drawing}
                      onPopulateFromLayer={
                        isSubsetUrlParameter(selectedTool, param)
                          ? handlePopulateSubsetUrl
                          : undefined
                      }
                    />
                  );
                })
              )}
            </div>
          </ScrollArea>

          <div className="grid gap-2 border-t pt-3">
            {/* Sidecar mode but the server is unreachable: show interactive
                troubleshooting with a one-click switch to the WASM runner.
                Otherwise fall back to a plain error line (e.g. a parameter or
                tool-run error that has nothing to do with the sidecar). */}
            {!IS_MAS_BUILD &&
            selectedTool?.id !== DOWNLOAD_GLOBAL_DEM_TOOL_ID &&
            !runLocal &&
            runtimeAvailable === false ? (
              <SidecarHelpBanner
                isDesktop={desktop}
                error={error}
                onRunLocally={() => {
                  // Clear the stale sidecar error in the same batch as the
                  // mode switch, so it cannot flash as a plain error line on
                  // the render before loadWhitebox resets it.
                  setError(null);
                  setRunLocal(true);
                }}
              />
            ) : (
              error && (
                <p className="flex items-center gap-2 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4" />
                  {error}
                </p>
              )
            )}
            {job && <JobOutputPanel job={job} />}
          </div>
        </div>
      </div>

      {/* Resize grip (bottom-right). The diagonal lines hint the affordance.
          Pointer-only, so it is presentational - there is no keyboard resize to
          expose to assistive tech. */}
      <div
        role="presentation"
        data-processing-resize-handle=""
        // eslint-disable-next-line local/no-physical-tailwind -- the resize grip's drag math and cursor are physical (bottom-right).
        className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize touch-none"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
      >
        <svg viewBox="0 0 10 10" className="h-full w-full text-muted-foreground" aria-hidden="true">
          <path d="M9 1 L1 9 M9 5 L5 9" stroke="currentColor" strokeWidth={1} fill="none" />
        </svg>
      </div>
    </div>
  );
}

function JobOutputPanel({ job }: { job: WhiteboxJob }) {
  const { t } = useTranslation();
  const outputs = outputEntries(job.outputs);
  const hasMessages = job.messages.length > 0;
  const hasOutputs = outputs.length > 0;
  const statusLabel = t(`processing.whitebox.jobStatus.${job.status}`, {
    defaultValue: job.status,
  });

  return (
    <div className="grid gap-2">
      <p className={cn("flex items-center gap-2 text-sm font-medium", jobStatusTone(job))}>
        {job.status === "succeeded" ? (
          <CheckCircle2 className="h-4 w-4" />
        ) : job.status === "cancelled" ? null : job.status === "failed" ? (
          <AlertCircle className="h-4 w-4" />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin" />
        )}
        {statusLabel}
        {job.error ? `: ${job.error}` : ""}
      </p>
      <ScrollArea className="h-24 rounded-md border bg-muted/30 p-2 font-mono text-xs">
        {!hasMessages && !hasOutputs ? (
          <span className="text-muted-foreground">{t("processing.whitebox.noOutput")}</span>
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

const EXTENT_GROUP_LABEL_ID = "whitebox-extent-label";

// Short label per boundary field. The parameter descriptions ("West boundary
// longitude (EPSG:4326).") are too long to sit over a half-width box, and they
// repeat the CRS four times; the full text stays as the field's tooltip.
const EXTENT_LABEL_KEYS = {
  north: "processing.whitebox.extentNorth",
  south: "processing.whitebox.extentSouth",
  west: "processing.whitebox.extentWest",
  east: "processing.whitebox.extentEast",
} as const;

interface ExtentParameterGroupProps {
  /** The tool whose boundary parameters are rendered; used for i18n keys. */
  toolId: string;
  /** The tool's four boundary parameters, in reading order. */
  params: WhiteboxToolParameter[];
  values: ParameterValues;
  onChange: (name: string, value: unknown) => void;
  /** Fills all four fields (and the extent CRS) from the current map view. */
  onUseMapExtent: () => void;
  /** Fills them by rubber-banding a box on the map. */
  onDrawMapExtent: () => void;
  /** Whether a draw is in progress (toggles the button's label/state). */
  drawingMapExtent: boolean;
}

/**
 * Area-of-interest control for a tool that takes its extent as four separate
 * boundary numbers (`download_osm_vector`). The four fields sit in one block
 * under a shared label, with the map shortcuts above them, so the box can be
 * picked from the map instead of typed a coordinate at a time (GeoLibre#1541).
 * Laid out like the Extract subset panel's bounding box, so the app's two extent
 * controls read the same.
 *
 * @param props - The boundary parameters, their current values, and the change /
 *   map-shortcut callbacks.
 */
function ExtentParameterGroup({
  toolId,
  params,
  values,
  onChange,
  onUseMapExtent,
  onDrawMapExtent,
  drawingMapExtent,
}: ExtentParameterGroupProps) {
  const { t, i18n } = useTranslation();
  if (params.length === 0) return null;
  // One badge stands for all four fields, so it names every kind present rather
  // than the first field's: a tool that mixed an int boundary with double ones
  // would otherwise have three of them labelled by the wrong kind. (Each field
  // still takes its own stepper behavior from its own kind, below.)
  const kindLabel = extentKindLabel(params);

  return (
    // A labelled group rather than one field's label: the four boxes each carry
    // their own, so pointing this one at the first of them would leave that box
    // named "Area of interest North".
    <div className="grid gap-1.5" role="group" aria-labelledby={EXTENT_GROUP_LABEL_ID}>
      <div className="flex items-center justify-between gap-3">
        <span id={EXTENT_GROUP_LABEL_ID} className="text-sm font-medium leading-none">
          {t("processing.whitebox.extentLabel")}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {kindLabel}
          {params.some((param) => param.required) ? t("processing.whitebox.requiredSuffix") : ""}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onUseMapExtent}>
          <Scan className="h-3.5 w-3.5" aria-hidden="true" />
          {t("processing.whitebox.useMapExtent")}
        </Button>
        <Button
          type="button"
          variant={drawingMapExtent ? "secondary" : "outline"}
          size="sm"
          aria-pressed={drawingMapExtent}
          onClick={onDrawMapExtent}
        >
          <SquareDashed className="h-3.5 w-3.5" aria-hidden="true" />
          {drawingMapExtent
            ? t("processing.whitebox.drawingBbox")
            : t("processing.whitebox.drawBbox")}
        </Button>
      </div>
      {drawingMapExtent ? (
        <p className="text-xs text-muted-foreground">{t("processing.whitebox.drawBboxHint")}</p>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        {params.map((param) => {
          // EXTENT_LABEL_KEYS covers every name cornerExtentParameters can
          // return, so the humanized fallback is only a guard for a manifest
          // that renames a boundary: such a field keeps a readable label instead
          // of an empty one.
          const labelKey = EXTENT_LABEL_KEYS[param.name as keyof typeof EXTENT_LABEL_KEYS];
          const value = values[param.name];
          const description = translateWhiteboxParameterDescription(
            t,
            i18n.language,
            toolId,
            param,
          );
          return (
            <div key={param.name} className="grid gap-1">
              <Label
                htmlFor={`whitebox-${param.name}`}
                className="text-xs text-muted-foreground"
                title={description || undefined}
              >
                {labelKey ? t(labelKey) : humanizeParameterName(param.name)}
              </Label>
              <NumberStepperInput
                id={`whitebox-${param.name}`}
                integer={parameterKind(param) === "int"}
                value={value === undefined || value === null ? "" : String(value)}
                onChange={(next) => onChange(param.name, next)}
              />
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">{t("processing.whitebox.extentHint")}</p>
    </div>
  );
}

interface ParameterFieldProps {
  param: WhiteboxToolParameter;
  layers: GeoLibreLayer[];
  /** Attribute names to offer for a `*_field` parameter; empty keeps it free text. */
  fieldOptions?: string[];
  /**
   * Reference latitude for a distance parameter whose input is a WGS84 map
   * layer, which turns the number box into a value + unit pair. Undefined
   * leaves it a plain number field.
   */
  degreeLatitude?: number;
  onChange: (value: unknown) => void;
  onPickFile?: (fileName: string, bytes: Uint8Array) => void;
  onPickFiles?: (files: Array<{ fileName: string; bytes: Uint8Array }>) => void;
  /** When set, renders a "Use map extent" button that fills this bbox field
   * (and its companion CRS) from the current map view. */
  onUseMapExtent?: () => void;
  /** When set, renders a "Draw on map" button that fills this bbox field by
   * rubber-banding a box on the map. */
  onDrawMapExtent?: () => void;
  /** Whether a draw is currently in progress (toggles the button's label/state). */
  drawingMapExtent?: boolean;
  /** When set, renders a "From layer" picker on this (`url`) field that fills it
   * (and any companion fields) from a compatible loaded raster layer. */
  onPopulateFromLayer?: (layer: GeoLibreLayer) => void;
  toolId: string;
  runLocal: boolean;
  value: unknown;
}

function ParameterField({
  param,
  layers,
  fieldOptions,
  degreeLatitude,
  onChange,
  onPickFile,
  onPickFiles,
  onUseMapExtent,
  onDrawMapExtent,
  drawingMapExtent,
  onPopulateFromLayer,
  toolId,
  runLocal,
  value,
}: ParameterFieldProps) {
  const { t, i18n } = useTranslation();
  const kind = parameterKind(param);
  const availableLayers = layers.filter((layer) => canUseLayerForParameter(layer, param));
  // Loaded layers that can fill this subset `url` field, only computed for the
  // url param the dialog wired `onPopulateFromLayer` to.
  const subsetUrlLayers = onPopulateFromLayer ? layersForSubsetUrl(toolId, layers) : [];
  // Display text resolves through i18n, while the original manifest parameter
  // continues to feed the control-selection heuristics below.
  const label = whiteboxParameterLabel(t, i18n.language, toolId, param);
  const valueText = value === undefined || value === null ? "" : String(value);

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={`whitebox-${param.name}`}>{label}</Label>
        <span className="shrink-0 text-xs text-muted-foreground">
          {kind}
          {param.required && !isOutputParameter(param)
            ? t("processing.whitebox.requiredSuffix")
            : ""}
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
          {t("processing.whitebox.enabled")}
        </label>
      ) : param.options?.length ? (
        <Select
          id={`whitebox-${param.name}`}
          value={valueText}
          onChange={(event) => onChange(event.target.value)}
        >
          {!param.required && <option value="">{t("processing.whitebox.optionDefault")}</option>}
          {param.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      ) : isCrsParameter(param) ? (
        // Checked before the path and number branches (like the map-extent one
        // below): an EPSG code is a number, but a bare stepper walks to
        // unrelated systems, so this field gets the searchable CRS list instead
        // (GeoLibre#1538). Placed ahead of isPathParameter so an epsg
        // description that happens to mention a file can't shadow the picker.
        <CrsPickerInput id={`whitebox-${param.name}`} value={valueText} onChange={onChange} />
      ) : onUseMapExtent ? (
        // Checked before the path/data-input branches: once isMapExtentParameter
        // has identified this bbox field, the "Use map extent" affordance should
        // always win, even if the param's description happens to contain a word
        // (path/file/…) that isPathParameter's heuristic would otherwise match.
        <div className="grid gap-1.5">
          <Input
            id={`whitebox-${param.name}`}
            type="text"
            value={valueText}
            placeholder={t("processing.whitebox.mapExtentPlaceholder")}
            onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onUseMapExtent}>
              <Scan className="h-3.5 w-3.5" aria-hidden="true" />
              {t("processing.whitebox.useMapExtent")}
            </Button>
            {onDrawMapExtent ? (
              <Button
                type="button"
                variant={drawingMapExtent ? "secondary" : "outline"}
                size="sm"
                aria-pressed={drawingMapExtent}
                onClick={onDrawMapExtent}
              >
                <SquareDashed className="h-3.5 w-3.5" aria-hidden="true" />
                {drawingMapExtent
                  ? t("processing.whitebox.drawingBbox")
                  : t("processing.whitebox.drawBbox")}
              </Button>
            ) : null}
          </div>
          {drawingMapExtent ? (
            <p className="text-xs text-muted-foreground">{t("processing.whitebox.drawBboxHint")}</p>
          ) : null}
        </div>
      ) : onPopulateFromLayer && subsetUrlLayers.length > 0 ? (
        // A subset extractor's `url`, with loaded layers that can supply it: a
        // "From layer" picker fills the url (and companion fields) from a
        // COG/WMS/XYZ layer, while the field stays freely typeable. Placed
        // before the path/data-input branches (like the "Use map extent" one
        // above) so a `url` description that happens to contain a word
        // isPathParameter matches (path/file/…) can't shadow this picker into a
        // local file-browse control.
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2 @sm/params:grid-cols-[minmax(150px,200px)_minmax(0,1fr)]">
          <Select
            aria-label={t("processing.whitebox.fromLayer")}
            value=""
            onChange={(event) => {
              const layer = subsetUrlLayers.find((item) => item.id === event.target.value);
              if (layer) onPopulateFromLayer(layer);
            }}
          >
            <option value="">{t("processing.whitebox.fromLayer")}</option>
            {subsetUrlLayers.map((layer) => (
              <option key={layer.id} value={layer.id}>
                {layer.name}
              </option>
            ))}
          </Select>
          <Input
            id={`whitebox-${param.name}`}
            type="text"
            value={valueText}
            onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
          />
        </div>
      ) : isDataInputParameter(param) && isMultipleDatasetParameter(param) ? (
        <MultiLayerOrPathInput
          id={`whitebox-${param.name}`}
          label={label}
          layers={availableLayers}
          param={param}
          value={value}
          onChange={onChange}
          onPickFiles={onPickFiles}
        />
      ) : isDataInputParameter(param) && availableLayers.length > 0 ? (
        <LayerOrPathInput
          id={`whitebox-${param.name}`}
          label={label}
          layers={availableLayers}
          param={param}
          value={valueText}
          onChange={onChange}
          onPickFile={onPickFile}
        />
      ) : kind === "vector_out" && runLocal ? (
        // In WASM mode a vector output is either a WGS84 map layer (GeoJSON) or a
        // downloaded file in a CRS-preserving format that keeps a reprojection's
        // target CRS (which the map, being EPSG:4326, cannot show). Normalize the
        // value so a stale sidecar-mode output path doesn't leak into the Select.
        <div className="grid gap-1.5">
          <Select
            id={`whitebox-${param.name}`}
            value={normalizeVectorOutputFormat(valueText)}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="geojson">{t("processing.whitebox.output.geojson")}</option>
            <option value="geoparquet">{t("processing.whitebox.output.geoparquet")}</option>
            <option value="flatgeobuf">{t("processing.whitebox.output.flatgeobuf")}</option>
            <option value="shapefile">{t("processing.whitebox.output.shapefile")}</option>
          </Select>
          {normalizeVectorOutputFormat(valueText) !== "geojson" && (
            <p className="text-xs text-muted-foreground">
              {t("processing.whitebox.output.projectedHint")}
            </p>
          )}
        </div>
      ) : fieldOptions?.length ? (
        // A `*_field` parameter with a layer chosen for its vector input: offer
        // that layer's attribute names so the column need not be typed from
        // memory (GeoLibre#1459). The text box stays editable alongside the
        // picker, so a column the property sample missed can still be typed.
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2 @sm/params:grid-cols-[minmax(150px,200px)_minmax(0,1fr)]">
          <Select
            aria-label={t("processing.whitebox.selectField")}
            value={fieldOptions.includes(valueText) ? valueText : ""}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="">{t("processing.whitebox.selectField")}</option>
            {fieldOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
          <Input
            id={`whitebox-${param.name}`}
            type="text"
            value={valueText}
            placeholder={t("processing.whitebox.fieldName")}
            onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
          />
        </div>
      ) : kind === "double" && degreeLatitude !== undefined ? (
        // A ground distance whose input is a WGS84 map layer: the tool measures
        // it in degrees, so pair the number box with a unit picker that converts
        // metres/km/feet/miles for the user (GeoLibre#1540). Placed ahead of
        // isPathParameter like the CRS and map-extent pickers above: that
        // fallback matches path/file/folder anywhere in a parameter's name or
        // description, so a distance whose wording mentions one would otherwise
        // render as a file browser.
        <DistanceInput
          id={`whitebox-${param.name}`}
          latitude={degreeLatitude}
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
          onPickFile={onPickFile}
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
          placeholder={isOutputParameter(param) ? t("processing.whitebox.auto") : undefined}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        />
      )}

      {param.type && <p className="text-xs text-muted-foreground">{param.type}</p>}
    </div>
  );
}

interface NumberStepperInputProps {
  id: string;
  integer: boolean;
  onChange: (value: unknown) => void;
  value: string;
}

function NumberStepperInput({ id, integer, onChange, value }: NumberStepperInputProps) {
  const { t } = useTranslation();
  const updateByStep = (direction: 1 | -1) => onChange(stepNumberValue(value, integer, direction));

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] overflow-hidden rounded-md border border-input bg-background shadow-xs focus-within:border-2 focus-within:border-ring">
      <input
        id={id}
        inputMode={integer ? "numeric" : "decimal"}
        className="h-9 min-w-0 border-0 bg-transparent px-3 py-1 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="grid h-9 border-s">
        <button
          type="button"
          aria-label={t("processing.increaseValue")}
          className="flex h-[18px] items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => updateByStep(1)}
        >
          <ChevronUp className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label={t("processing.decreaseValue")}
          className="flex h-[18px] items-center justify-center border-t text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => updateByStep(-1)}
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

interface DistanceInputProps {
  id: string;
  /** Latitude the metric conversion is anchored at (the input layer's centre). */
  latitude: number;
  onChange: (value: unknown) => void;
  /** The stored parameter value, always in degrees. */
  value: string;
}

/**
 * A distance field with a unit picker, for a tool whose coordinates come from a
 * WGS84 map layer (GeoLibre#1540).
 *
 * The parameter itself is always stored in degrees, because that is what the
 * tool will read. Choosing metres (or km/ft/mi) keeps a local draft of what the
 * user typed and pushes the converted degrees up on every keystroke, so the
 * round trip through the conversion cannot rewrite the digits being typed. The
 * conversion varies with latitude and direction, so the field states the degree
 * value it produced and points at reprojection for exact work.
 */
function DistanceInput({ id, latitude, onChange, value }: DistanceInputProps) {
  const { t } = useTranslation();
  const [unit, setUnit] = useState<DistanceUnit>("degrees");
  // What the user typed, in `unit`. Only used while `unit` is not degrees; kept
  // out of the parameter so the stored value stays in the tool's own unit.
  const [draft, setDraft] = useState("");

  // What the metric box currently holds: a number to convert, or null when it is
  // empty or not a complete number (so nothing was converted).
  const draftValue = parseDistanceInput(draft);

  // The last value this field pushed up, so a `value` that changed for some
  // other reason (a re-run pre-filled from Processing History, say) can be told
  // apart from the field's own edits.
  const lastPushed = useRef(value);
  const push = (next: string) => {
    lastPushed.current = next;
    onChange(next);
  };

  const changeUnit = (next: DistanceUnit) => {
    setUnit(next);
    if (next === "degrees") {
      setDraft("");
      return;
    }
    // Carry the current distance over to the new unit rather than clearing it.
    // A stored value that is no number at all (malformed text a previous edit
    // pushed through verbatim) has no conversion to carry, so it moves across
    // as-is: blanking the box instead would leave the field looking empty while
    // Run still submitted the old text. Formatted to the same digits the stored
    // degrees were written with, so a precisely typed value survives a trip
    // through Degrees and back rather than coming back rounded.
    setDraft(distanceDraftForUnit(value, next, latitude));
  };

  const changeDraft = (text: string) => {
    setDraft(text);
    // Text that is not a complete number is stored verbatim rather than
    // converted, so a half-typed or malformed value fails at the tool instead of
    // being silently reinterpreted as a different distance.
    push(distanceDraftToStored(text, unit, latitude));
  };

  // Reconcile the field against changes it did not make itself. Both cases live
  // in one effect so their precedence is stated rather than left to the order
  // two effects happen to flush in: a Processing History re-run rewrites the
  // stored value *and* can rebind the input layer in a single `setValues`, and
  // as separate effects the latitude branch would still see the pre-reset `unit`
  // and `draft` from this render's closure and push a reconversion of the old
  // draft over the value the reset was restoring.
  const lastLatitude = useRef(latitude);
  useEffect(() => {
    const latitudeChanged = lastLatitude.current !== latitude;
    lastLatitude.current = latitude;
    if (value !== lastPushed.current) {
      // Someone else rewrote the parameter, so the typed draft and its unit
      // describe a distance that is no longer stored: show the degrees that are,
      // and let that win over any re-conversion.
      lastPushed.current = value;
      setUnit("degrees");
      setDraft("");
      return;
    }
    // The input layer moved under a metric entry: switching a tool's vector
    // input from a layer at 44°N to one at 10°N leaves the typed distance on
    // screen while the stored degrees still come from the old latitude, so the
    // note would show the new latitude beside a value converted at the old one
    // and Run would send the stale degrees.
    if (!latitudeChanged || unit === "degrees") return;
    if (parseDistanceInput(draft) === null) return;
    const next = distanceDraftToStored(draft, unit, latitude);
    lastPushed.current = next;
    onChange(next);
  }, [draft, latitude, onChange, unit, value]);

  // A hemisphere suffix only means something away from the equator, and a
  // worldwide layer's combined extent lands on 0.0 often enough for "0.0°N" to
  // read as a mistake.
  const latitudeKey = latitudeLabelKey(latitude);
  const latitudeLabel = t(latitudeKey.key, { latitude: latitudeKey.latitude });

  // Only claim a conversion when one actually happened. Text the field could not
  // read went through untouched, so saying it was "converted at 44.0°N" would
  // describe something the tool is about to reject.
  const conversionNote =
    draft.trim() === ""
      ? t("processing.distance.convertedEmpty", { latitude: latitudeLabel })
      : draftValue === null
        ? t("processing.distance.notANumber")
        : t("processing.distance.converted", {
            degrees: value,
            latitude: latitudeLabel,
          });

  return (
    <div className="grid gap-1.5">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(120px,160px)] gap-2">
        {unit === "degrees" ? (
          // Routed through `push` like the metric box, so an edit made in
          // degrees keeps `lastPushed` accurate and does not read as an
          // outside rewrite to the reconcile effect below.
          <NumberStepperInput
            id={id}
            integer={false}
            value={value}
            onChange={(next) => push(String(next ?? ""))}
          />
        ) : (
          <Input
            id={id}
            inputMode="decimal"
            value={draft}
            onChange={(event: ChangeEvent<HTMLInputElement>) => changeDraft(event.target.value)}
          />
        )}
        <Select
          aria-label={t("processing.distance.unitLabel")}
          value={unit}
          onChange={(event) => changeUnit(event.target.value as DistanceUnit)}
        >
          {DISTANCE_UNITS.map((option) => (
            <option key={option} value={option}>
              {t(`processing.distance.units.${option}`)}
            </option>
          ))}
        </Select>
      </div>
      {unit !== "degrees" && <p className="text-xs text-muted-foreground">{conversionNote}</p>}
    </div>
  );
}

interface LayerOrPathInputProps {
  id: string;
  /** The parameter's visible label, which also names the layer picker. */
  label: string;
  layers: GeoLibreLayer[];
  onChange: (value: unknown) => void;
  onPickFile?: (fileName: string, bytes: Uint8Array) => void;
  param: WhiteboxToolParameter;
  value: string;
}

interface MultiLayerOrPathInputProps {
  id: string;
  label: string;
  layers: GeoLibreLayer[];
  onChange: (value: unknown) => void;
  onPickFiles?: (files: Array<{ fileName: string; bytes: Uint8Array }>) => void;
  param: WhiteboxToolParameter;
  value: unknown;
}

/** Dataset-list picker used by merge, overlay, statistics, and stack tools. */
function MultiLayerOrPathInput({
  id,
  label,
  layers,
  onChange,
  onPickFiles,
  param,
  value,
}: MultiLayerOrPathInputProps) {
  const { t } = useTranslation();
  const selected = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
  const usingLayers = Array.isArray(value);
  return (
    <div className="grid gap-2">
      {layers.length > 0 ? (
        <div
          role="group"
          aria-label={label}
          className="grid max-h-40 gap-1 overflow-y-auto rounded-md border p-2"
        >
          {layers.map((layer) => {
            const token = `${LAYER_TOKEN_PREFIX}${layer.id}`;
            return (
              <label key={layer.id} className="flex items-center gap-2 rounded px-1 py-1 text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(token)}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...selected, token]
                        : selected.filter((item) => item !== token),
                    )
                  }
                />
                <span className="truncate">{layer.name}</span>
              </label>
            );
          })}
        </div>
      ) : null}
      <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2">
        <Input
          id={id}
          value={usingLayers ? "" : String(value ?? "")}
          placeholder={
            usingLayers ? t("processing.whitebox.selectedLayer") : t("processing.whitebox.filePath")
          }
          disabled={usingLayers && selected.length > 0}
          onChange={(event) => onChange(event.target.value)}
        />
        <PathBrowseButton
          disabled={usingLayers && selected.length > 0}
          mode="open"
          multiple
          param={param}
          onPick={(paths) => onChange(paths)}
          onPickFiles={onPickFiles}
        />
      </div>
    </div>
  );
}

function LayerOrPathInput({
  id,
  label,
  layers,
  onChange,
  onPickFile,
  param,
  value,
}: LayerOrPathInputProps) {
  const { t } = useTranslation();
  const usingLayer = value.startsWith(LAYER_TOKEN_PREFIX);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2 @sm/params:grid-cols-[minmax(150px,200px)_minmax(0,1fr)_2.25rem]">
      {/* Three children, but the narrow template has only two columns, so the
          picker has to claim the whole first row explicitly. Left to
          auto-placement it lands in column 1, the path Input gets squeezed into
          the 2.25rem browse-button track, and the button wraps to a row of its
          own. The other two converted rows stack to a single column, where any
          child count is fine; this is the one that needs saying. */}
      <Select
        className="col-span-2 @sm/params:col-span-1"
        aria-label={t("processing.whitebox.layerFor", { name: label })}
        value={usingLayer ? value : ""}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{t("processing.whitebox.optionPath")}</option>
        {layers.map((layer) => (
          <option key={layer.id} value={`${LAYER_TOKEN_PREFIX}${layer.id}`}>
            {layer.name}
          </option>
        ))}
      </Select>
      <Input
        id={id}
        value={usingLayer ? "" : value}
        placeholder={
          usingLayer ? t("processing.whitebox.selectedLayer") : t("processing.whitebox.filePath")
        }
        disabled={usingLayer}
        onChange={(event) => onChange(event.target.value)}
      />
      <PathBrowseButton
        disabled={usingLayer}
        mode="open"
        param={param}
        onPick={(path) => onChange(path)}
        onPickFile={onPickFile}
      />
    </div>
  );
}

interface PathPickerInputProps {
  id: string;
  onChange: (value: unknown) => void;
  onPickFile?: (fileName: string, bytes: Uint8Array) => void;
  param: WhiteboxToolParameter;
  toolId: string;
  value: string;
}

function PathPickerInput({ id, onChange, onPickFile, param, toolId, value }: PathPickerInputProps) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2">
      <Input
        id={id}
        value={value}
        placeholder={
          isOutputParameter(param)
            ? t("processing.whitebox.auto")
            : t("processing.whitebox.filePath")
        }
        onChange={(event) => onChange(event.target.value)}
      />
      <PathBrowseButton
        mode={isOutputParameter(param) ? "save" : "open"}
        param={param}
        toolId={toolId}
        onPick={(path) => onChange(path)}
        onPickFile={onPickFile}
      />
    </div>
  );
}

interface PathBrowseButtonProps {
  disabled?: boolean;
  mode: "open" | "save";
  multiple?: boolean;
  onPick: (path: string) => void;
  onPickFile?: (fileName: string, bytes: Uint8Array) => void;
  onPickFiles?: (files: Array<{ fileName: string; bytes: Uint8Array }>) => void;
  param: WhiteboxToolParameter;
  toolId?: string;
}

function PathBrowseButton({
  disabled = false,
  mode,
  multiple = false,
  onPick,
  onPickFile,
  onPickFiles,
  param,
  toolId = "whitebox",
}: PathBrowseButtonProps) {
  const { t } = useTranslation();
  const pickPath = async () => {
    const filters = pathFiltersForParameter(param);
    if (mode === "save") {
      const path = await pickSavePathWithFallback({
        defaultName: defaultOutputName(toolId, param),
        filters,
      });
      if (path) onPick(path);
      return;
    }

    if (multiple) {
      const paths = await pickLocalPathsWithFallback({
        accept: acceptForParameter(param),
        filters,
      });
      if (paths.length > 0) {
        onPick(paths.join(","));
        return;
      }
      if (!isTauri() && onPickFiles) {
        const picked = await openLocalDataFilesWithFallback({
          accept: acceptForParameter(param),
          filters,
          readBinary: true,
        });
        if (picked.length > 0) {
          onPickFiles(
            picked.map((file) => ({
              fileName: file.path,
              bytes: new Uint8Array(file.data),
            })),
          );
        }
      }
      return;
    }

    const path = await pickLocalPathWithFallback({
      accept: acceptForParameter(param),
      directory: isDirectoryParameter(param),
      filters,
    });
    if (path) {
      onPick(path);
      return;
    }

    // The browser cannot expose a real filesystem path, so pickLocalPath returns
    // null there. Fall back to reading the chosen file's bytes for the in-browser
    // WASM runner. (Skipped under Tauri, where null just means the user
    // cancelled the native dialog, and for directory parameters.)
    if (!isTauri() && onPickFile && !isDirectoryParameter(param)) {
      const picked = await openLocalDataFileWithFallback({
        accept: acceptForParameter(param),
        filters,
        readBinary: true,
      });
      if (picked?.data) {
        onPickFile(picked.path, new Uint8Array(picked.data));
      }
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      disabled={disabled}
      title={
        mode === "save"
          ? t("processing.whitebox.chooseOutputPath")
          : t("processing.whitebox.chooseInputPath")
      }
      onClick={() => void pickPath()}
    >
      {mode === "save" ? <Save className="h-4 w-4" /> : <FolderOpen className="h-4 w-4" />}
    </Button>
  );
}
