import {
  useWhiteboxToolboxController,
  type WhiteboxToolboxControllerOptions,
  type WhiteboxToolboxServices,
} from "../../hooks/useWhiteboxToolboxController";
import { type MapEngine } from "@geolibre/map";
import { type WhiteboxJob, type WhiteboxTool } from "@geolibre/processing";
import { Button, Input, ScrollArea, Select, cn } from "@geolibre/ui";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  GripHorizontal,
  Link2,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Server,
  ServerOff,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { clamp } from "../../lib/clamp";
import { isBboxExtentParameter, isCornerExtentParameter } from "../../lib/whitebox-extent";
import { IS_MAS_BUILD } from "../../lib/build-flags";
import { DOWNLOAD_GLOBAL_DEM_TOOL_ID } from "../../lib/global-dem";
import { SidecarHelpBanner } from "./SidecarHelpBanner";
import {
  translateToolDescription,
  translateWhiteboxCategory,
} from "../../lib/processing-tool-i18n";
import {
  isDistanceParameter,
  isSubsetUrlParameter,
  jobStatusTone,
  outputEntries,
  toolLabel,
} from "../../lib/processing-params";
import { isRunDisabled, runtimeStatusText } from "../../lib/processing-dialog-model";
import { ExtentParameterGroup, ParameterField } from "./ProcessingDialogFields";

interface ProcessingDialogProps {
  mapControllerRef: React.RefObject<MapEngine | null>;
  // Renders a raster tool output (a Cloud Optimized GeoTIFF, from the WASM
  // runner) as a new map layer. Wired by the desktop shell, which owns the
  // raster control / app API. `options.signal` aborts when another project
  // opens before the import finishes; pass it on so nothing lands there.
  onAddRaster?: WhiteboxToolboxControllerOptions["onAddRaster"];
  // Renders a LiDAR tool output (LAS/LAZ/COPC bytes from the WASM runner) as a
  // new point cloud layer. Resolves false when the LiDAR control could not be
  // mounted, so the dialog falls back to downloading the file. Honors
  // `options.signal` like `onAddRaster`.
  onAddLidar?: WhiteboxToolboxControllerOptions["onAddLidar"];
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
                {selectedTool.locked_reason || t("processing.whitebox.lockedFallback")}
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
