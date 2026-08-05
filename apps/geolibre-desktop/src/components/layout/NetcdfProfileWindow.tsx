import { Button } from "@geolibre/ui";
import { GripVertical, LineChart, X } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useFloatingPanelRect } from "../../hooks/useFloatingPanelRect";
import {
  clearNetcdfProfileSamples,
  getNetcdfProfileSamples,
  isNetcdfProfilePoppedOut,
  setNetcdfProfilePoppedOut,
  subscribeNetcdfProfile,
} from "../../lib/netcdf-profile-store";
import { NetcdfProfileChart } from "../panels/NetcdfProfileChart";

/** Panel geometry (px). The window opens in the top-left corner, inset by
 * {@link PANEL_MARGIN}, and can then be dragged and resized anywhere on the map.
 * Top-left because the only resize grip is the bottom-right one: opening on the
 * right would put that grip against the Style panel with nowhere to grow. The
 * CSS default below and {@link FALLBACK_RECT} describe the same corner, so a
 * drag that starts from the untouched default does not jump. */
const PANEL_MIN_W = 360;
const PANEL_MIN_H = 260;
const PANEL_MARGIN = 12;
const FALLBACK_RECT = { x: PANEL_MARGIN, y: PANEL_MARGIN, w: 520, h: 420 };

/**
 * The spectral profile detached from the Style panel into a movable, resizable
 * window over the map.
 *
 * The Style panel is narrow and scrolls, which is a poor home for a chart the
 * user wants to read closely; floating it gives the chart room and lets it sit
 * beside the pixels it was sampled from. The store holds one layer's samples at
 * a time, so the window charts "the current samples" without tracking a layer.
 *
 * Mounted in the map area so it is positioned against the map, not the shell.
 *
 * @returns The window, or null while the chart is docked or has nothing to show.
 */
export function NetcdfProfileWindow() {
  const { t } = useTranslation();
  const samples = useSyncExternalStore(
    subscribeNetcdfProfile,
    getNetcdfProfileSamples,
    getNetcdfProfileSamples,
  );
  const poppedOut = useSyncExternalStore(
    subscribeNetcdfProfile,
    isNetcdfProfilePoppedOut,
    isNetcdfProfilePoppedOut,
  );
  const { panelRef, rect, handleDragStart, handleResizeStart } = useFloatingPanelRect({
    minWidth: PANEL_MIN_W,
    minHeight: PANEL_MIN_H,
    margin: PANEL_MARGIN,
    fallback: FALLBACK_RECT,
  });

  if (!poppedOut || samples.length === 0) return null;

  return (
    <div
      ref={panelRef}
      className={
        rect
          ? "pointer-events-auto absolute z-20 flex flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
          : "pointer-events-auto absolute start-3 top-3 z-20 flex h-[26rem] max-h-[calc(100%-6rem)] w-[min(32rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
      }
      style={rect ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h } : undefined}
      role="region"
      aria-label={t("netcdfProfile.heading")}
      data-testid="netcdf-profile-window"
    >
      <div
        className="flex cursor-move touch-none select-none items-center justify-between gap-2 border-b px-3 py-2"
        onPointerDown={handleDragStart}
      >
        <div className="flex items-center gap-2 text-sm font-semibold">
          <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <LineChart className="h-4 w-4 text-primary" aria-hidden="true" />
          {t("netcdfProfile.heading")}
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={clearNetcdfProfileSamples}>
            {t("netcdfProfile.clear")}
          </Button>
          <button
            type="button"
            className="rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
            onClick={() => setNetcdfProfilePoppedOut(false)}
            aria-label={t("netcdfProfile.dock")}
            title={t("netcdfProfile.dock")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-auto p-3">
        {/* `flex-1` rather than a fixed height: the chart scales with the
            window, which is the point of resizing it. */}
        <NetcdfProfileChart samples={samples} chartClassName="flex-1" />
      </div>

      {/* Resize grip (bottom-right). The diagonal lines hint the affordance.
          Mouse/touch-only, so it is presentational — there is no keyboard
          resize to expose to assistive tech. */}
      <div
        className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize touch-none"
        onPointerDown={handleResizeStart}
        role="presentation"
      >
        <svg viewBox="0 0 10 10" className="h-full w-full text-muted-foreground" aria-hidden="true">
          <path d="M9 1 L1 9 M9 5 L5 9" stroke="currentColor" strokeWidth={1} fill="none" />
        </svg>
      </div>
    </div>
  );
}
