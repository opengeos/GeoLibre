import {
  closeRightPanel,
  collapseRightPanel,
  getRightPanel,
  moveActiveRightPanelDock,
  openRightPanel,
  type RightPanelDock,
  setActiveRightPanelDock,
} from "@geolibre/plugins";
import { Button } from "@geolibre/ui";
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  Columns2,
  Combine,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
} from "react";
import { useTranslation } from "react-i18next";
import { useRightPanelState } from "../../hooks/useRightPanels";
import { clamp } from "../../lib/clamp";
import { isImageSource } from "../../lib/icon-source";

export const PLUGIN_PANEL_DEFAULT_WIDTH = 320;
const MIN_WIDTH = 240;
const MAX_WIDTH = 640;

/** Clamp a plugin-panel width to the allowed range. Shared with the shell. */
export function clampPluginPanelWidth(width: number): number {
  return clamp(width, MIN_WIDTH, MAX_WIDTH);
}

interface PluginRightPanelProps {
  /** Which dock position this instance renders. */
  dock: RightPanelDock;
  /**
   * The active panel's content host element, created and rendered into once by
   * the shell. The matched slot adopts it via `appendChild`, so moving the panel
   * between docks relocates the same DOM (preserving the plugin's state) instead
   * of tearing it down and re-rendering.
   */
  contentEl: HTMLElement;
  /**
   * The active panel's width in px. Owned by the shell and shared between the
   * dock-slot instances so a user's resize survives moving the panel between
   * positions. Lifting it to the shell (rather than a module-level global) keeps
   * it per-app-instance, which matters for the multi-instance Jupyter embed.
   */
  width: number;
  /** Update the shared panel width (clamped by this component). */
  onWidthChange: (width: number) => void;
}

/**
 * Renders the active plugin-owned dockable panel when it is docked at this
 * instance's `dock` position.
 *
 * One instance is mounted per dock position (`left-of-layers`, `right-of-layers`,
 * `left-of-style`, `right-of-style`); each renders only when the active panel is
 * docked there, so a user can step the panel between positions with the header's
 * move buttons (issue #712). The built-in panel on the docked side (Layers or
 * Style) collapses while the plugin panel is expanded next to it (the shell
 * handles that). The panel content is owned by the plugin via `render(container)`
 * (plain DOM); the host provides the dock chrome (header, collapse rail, resize
 * handle, move/collapse/close buttons). Renders nothing when no plugin panel is
 * docked here.
 *
 * @param props.dock - The dock position this instance renders.
 * @returns The plugin panel aside, or null when no panel is docked here.
 */
export function PluginRightPanel({ dock, contentEl, width, onWidthChange }: PluginRightPanelProps) {
  const { t } = useTranslation();
  const { activeId, collapsed, dock: activeDock } = useRightPanelState();
  const contentRef = useRef<HTMLDivElement | null>(null);

  const panel = activeId ? getRightPanel(activeId) : undefined;
  const matched = activeId !== null && panel != null && activeDock === dock;
  // Layers-side docks sit to the left: their border and resize handle face right
  // (toward the map). Style-side docks face left (toward the map). The
  // `replace-layers` shared-rail mode is a layers-side dock too.
  const isLayersSide =
    dock === "left-of-layers" || dock === "right-of-layers" || dock === "replace-layers";
  // The shared-rail modes: the panel shares the Style (replace-style) or Layers
  // (replace-layers) rail (rendered by the host's SharedSidebar), so it has no
  // move buttons and no rail of its own; its collapsed entry lives in that single
  // shared rail instead.
  const isSharedRail = dock === "replace-style" || dock === "replace-layers";

  // Adopt the shared content host (rendered once by the shell) into this slot
  // while it owns the panel. appendChild moves the element, so stepping the
  // panel between docks relocates the same DOM and preserves the plugin's state
  // rather than re-rendering it. `collapsed` is a dependency because the
  // shared-rail mode unmounts the content wrapper while collapsed (it renders
  // nothing), so the host must be re-adopted into the fresh wrapper when the
  // panel expands again; for the positional docks the wrapper merely hides, so
  // re-adopting the already-attached host is a harmless no-op.
  useEffect(() => {
    if (!matched) return;
    const wrapper = contentRef.current;
    if (!wrapper) return;
    wrapper.appendChild(contentEl);
  }, [matched, contentEl, collapsed]);

  if (!matched || !panel) return null;
  // When collapsed in shared-rail mode the host's single shared rail shows this
  // panel's entry, so render nothing here (no second rail beside Style).
  if (isSharedRail && collapsed) return null;

  const handleResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    // Attach the move/end listeners to the handle element (not window) so they
    // are discarded with it if the panel unmounts mid-drag, and capture the
    // pointer so a drag past the viewport edge keeps tracking. pointercancel is
    // handled alongside pointerup so an interrupted drag still cleans up.
    const el = event.currentTarget;
    el.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = width;
    const dirSign = getComputedStyle(el).direction === "rtl" ? -1 : 1;
    const handleMove = (move: PointerEvent) => {
      // The resizable edge faces away from the dock side: dragging it widens the
      // panel.
      const delta = dirSign * (isLayersSide ? move.clientX - startX : startX - move.clientX);
      onWidthChange(clamp(startWidth + delta, MIN_WIDTH, MAX_WIDTH));
    };
    const handleEnd = () => {
      if (el.hasPointerCapture(event.pointerId)) {
        el.releasePointerCapture(event.pointerId);
      }
      el.removeEventListener("pointermove", handleMove);
      el.removeEventListener("pointerup", handleEnd);
      el.removeEventListener("pointercancel", handleEnd);
    };
    el.addEventListener("pointermove", handleMove);
    el.addEventListener("pointerup", handleEnd);
    el.addEventListener("pointercancel", handleEnd);
  };

  const railIcon =
    panel.icon && isImageSource(panel.icon) ? (
      <img src={panel.icon} alt="" className="h-4 w-4 object-contain" />
    ) : isLayersSide ? (
      <PanelLeft className="h-4 w-4" />
    ) : (
      <PanelRight className="h-4 w-4" />
    );

  const borderSide = isLayersSide ? "md:border-e" : "md:border-s";
  // Dock names describe the LTR arrangement, so the visual move-left/right
  // actions and their guards swap in a right-to-left layout.
  const isRtl = document.documentElement.dir === "rtl";
  const canMoveLeft = activeDock !== (isRtl ? "right-of-style" : "left-of-layers");
  const canMoveRight = activeDock !== (isRtl ? "left-of-layers" : "right-of-style");

  return (
    <aside
      aria-label={collapsed ? t("pluginPanel.collapsedLabel", { title: panel.title }) : panel.title}
      style={{ "--plugin-right-panel-width": `${width}px` } as CSSProperties}
      className={
        collapsed
          ? `flex h-11 w-full shrink-0 items-center gap-2 border-t bg-card px-2 md:h-auto md:w-11 md:flex-col md:border-t-0 md:py-2 ${borderSide}`
          : `relative flex max-h-[min(24rem,42vh)] supports-[max-height:1dvh]:max-h-[min(24rem,42dvh)] w-full shrink-0 flex-col border-t bg-card max-md:absolute max-md:inset-x-0 max-md:bottom-0 max-md:z-30 max-md:shadow-xl md:max-h-none md:w-[var(--plugin-right-panel-width)] md:border-t-0 ${borderSide}`
      }
    >
      {!collapsed ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("pluginPanel.resize")}
          className={`absolute ${isLayersSide ? "-end-1 border-e" : "-start-1 border-s"} top-0 z-20 hidden h-full w-2 cursor-col-resize touch-none select-none border-transparent hover:border-primary md:block`}
          onPointerDown={handleResizeStart}
        />
      ) : null}
      {collapsed ? (
        <>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title={t("pluginPanel.expand")}
            aria-label={t("pluginPanel.expand")}
            onClick={() => openRightPanel(activeId)}
          >
            {isLayersSide ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelRightOpen className="h-4 w-4" />
            )}
          </Button>
          <div className="flex items-center gap-2 text-muted-foreground md:mt-3 md:flex-col">
            {railIcon}
            <span className="text-[10px] font-semibold uppercase tracking-wide md:[writing-mode:vertical-rl] md:rotate-180">
              {panel.title}
            </span>
          </div>
        </>
      ) : (
        <div className="flex items-center justify-between border-b px-3 py-1.5">
          <span className="truncate text-sm font-semibold">{panel.title}</span>
          <div className="flex items-center gap-1">
            {!isSharedRail ? (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title={t("pluginPanel.moveLeft")}
                  aria-label={t("pluginPanel.moveLeft")}
                  disabled={!canMoveLeft}
                  onClick={() => moveActiveRightPanelDock(isRtl ? "right" : "left")}
                >
                  <ArrowLeftToLine className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title={t("pluginPanel.moveRight")}
                  aria-label={t("pluginPanel.moveRight")}
                  disabled={!canMoveRight}
                  onClick={() => moveActiveRightPanelDock(isRtl ? "left" : "right")}
                >
                  <ArrowRightToLine className="h-4 w-4" />
                </Button>
              </>
            ) : null}
            {isSharedRail ? (
              // Pop the panel out of the shared rail back to a movable positional
              // panel on the same side (where the move buttons return).
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title={t("pluginPanel.detach")}
                aria-label={t("pluginPanel.detach")}
                onClick={() =>
                  setActiveRightPanelDock(isLayersSide ? "right-of-layers" : "right-of-style")
                }
              >
                <Columns2 className="h-4 w-4" />
              </Button>
            ) : (
              // Merge the movable panel into the shared rail on its current side:
              // a layers-side panel joins the Layers rail, a style-side panel the
              // Style rail.
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title={
                  isLayersSide
                    ? t("pluginPanel.mergeIntoLayersRail")
                    : t("pluginPanel.mergeIntoStyleRail")
                }
                aria-label={
                  isLayersSide
                    ? t("pluginPanel.mergeIntoLayersRail")
                    : t("pluginPanel.mergeIntoStyleRail")
                }
                onClick={() =>
                  setActiveRightPanelDock(isLayersSide ? "replace-layers" : "replace-style")
                }
              >
                <Combine className="h-4 w-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title={t("pluginPanel.collapse")}
              aria-label={t("pluginPanel.collapse")}
              onClick={() => collapseRightPanel(activeId)}
            >
              {isLayersSide ? (
                <PanelLeftClose className="h-4 w-4" />
              ) : (
                <PanelRightClose className="h-4 w-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title={t("pluginPanel.close")}
              aria-label={t("pluginPanel.close")}
              onClick={() => closeRightPanel(activeId)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
      <div ref={contentRef} className={collapsed ? "hidden" : "min-h-0 flex-1 overflow-auto"} />
    </aside>
  );
}
