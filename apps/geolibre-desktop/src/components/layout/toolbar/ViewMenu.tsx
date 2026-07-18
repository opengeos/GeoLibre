import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@geolibre/ui";
import { useAppStore } from "@geolibre/core";
import {
  ArrowLeft,
  ArrowRight,
  Compass,
  Crosshair,
  Earth,
  Eye,
  LayoutGrid,
  Link2,
  MapIcon,
  Mountain,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ParseKeys } from "i18next";
import { useDesktopSettingsStore } from "../../../hooks/useDesktopSettings";
import type { ViewportHistory } from "../../../hooks/useViewportHistory";
import { isMenuItemVisible } from "../../../lib/ui-profile";
import type { ToolbarChrome } from "./constants";

/** Selectable map-grid presets offered in the Split View submenu. */
const SPLIT_VIEW_PRESETS: ReadonlyArray<{
  rows: number;
  cols: number;
  labelKey: ParseKeys;
}> = [
  { rows: 1, cols: 1, labelKey: "toolbar.item.splitViewSingle" },
  { rows: 1, cols: 2, labelKey: "toolbar.item.splitViewTwoColumns" },
  { rows: 2, cols: 1, labelKey: "toolbar.item.splitViewTwoRows" },
  { rows: 2, cols: 2, labelKey: "toolbar.item.splitViewGrid2x2" },
  { rows: 2, cols: 3, labelKey: "toolbar.item.splitViewGrid2x3" },
  { rows: 3, cols: 3, labelKey: "toolbar.item.splitViewGrid3x3" },
];

/** A snapshot of the active map's camera, read when the menu opens. */
export interface ViewMenuCamera {
  zoom: number;
  bearing: number;
  pitch: number;
  minZoom: number;
  maxZoom: number;
}

interface ViewMenuProps {
  chrome: ToolbarChrome;
  history: ViewportHistory;
  /**
   * Read the active map's current camera, called each time the menu opens so
   * the zoom/orientation items can disable themselves when already at their
   * limit. Returns null when no map is ready yet (items stay enabled).
   */
  getCamera: () => ViewMenuCamera | null;
  /** Animate the map back to north-up (bearing 0), leaving pitch untouched. */
  onResetNorth: () => void;
  /** Animate the map back to flat (pitch 0), leaving bearing untouched. */
  onResetPitch: () => void;
  /** Animate the map back to north-up and flat (bearing 0, pitch 0). */
  onResetPitchBearing: () => void;
  /** Open the dialog for typing an exact camera (center/zoom/pitch/bearing). */
  onSetView: () => void;
  /** Open the current map view in Google Earth in the system browser. */
  onViewInGoogleEarth: () => void;
  /** Open the current map view in Google Maps in the system browser. */
  onViewInGoogleMaps: () => void;
  /** Animate the map in by one zoom level. */
  onZoomIn: () => void;
  /** Animate the map out by one zoom level. */
  onZoomOut: () => void;
}

/**
 * The View menu: step backward/forward through the map's viewport history (the
 * way a browser's back/forward buttons walk page history) and reset the
 * camera's rotation/tilt. Hidden on narrow screens (via
 * `chrome.secondaryButtonClass`) so the menu bar stays one row.
 */
export function ViewMenu({
  chrome,
  history,
  getCamera,
  onResetNorth,
  onResetPitch,
  onResetPitchBearing,
  onSetView,
  onViewInGoogleEarth,
  onViewInGoogleMaps,
  onZoomIn,
  onZoomOut,
}: ViewMenuProps) {
  const { t } = useTranslation();
  const uiProfile = useDesktopSettingsStore((s) => s.desktopSettings.uiProfile);
  const mapLayout = useAppStore((s) => s.mapLayout);
  const setMapGrid = useAppStore((s) => s.setMapGrid);
  const setSyncView = useAppStore((s) => s.setSyncView);
  // Camera snapshot taken when the menu opens. The dropdown blocks map
  // interaction while open, so a single read on open stays accurate for the
  // life of the menu and lets items grey out at their limit (#708, #710).
  const [camera, setCamera] = useState<ViewMenuCamera | null>(null);
  // Tolerances absorb the float drift left by easeTo so an item that just did
  // its job (e.g. bearing animated to ~0) reads as "already there".
  const atMinZoom = camera != null && camera.zoom <= camera.minZoom + 1e-3;
  const atMaxZoom = camera != null && camera.zoom >= camera.maxZoom - 1e-3;
  const bearingIsNorth = camera != null && Math.abs(camera.bearing) < 1e-2;
  const pitchIsFlat = camera != null && Math.abs(camera.pitch) < 1e-2;
  const show = (id: string) => isMenuItemVisible(uiProfile, id);
  const showZoom = show("view.zoomIn") || show("view.zoomOut");
  const showNavigation = show("view.previousView") || show("view.nextView");
  const showResetPitch = show("view.resetPitch");
  const showResetBearing = show("view.resetNorth");
  const showResetPitchBearing = show("view.resetPitchBearing");
  const showReset = showResetPitch || showResetBearing || showResetPitchBearing;
  // The submenu is a dead end when every item it would show is already at its
  // baseline, so disable the trigger then rather than open it to all-greyed
  // items (#720 review). A hidden item can't block, so it counts as "disabled".
  const allResetDisabled =
    (!showResetPitch || pitchIsFlat) &&
    (!showResetBearing || bearingIsNorth) &&
    (!showResetPitchBearing || (bearingIsNorth && pitchIsFlat));
  const showSetView = show("view.setView");
  const showSplitView = show("view.splitView");
  const showGoogleMaps = show("view.googleMaps");
  const showGoogleEarth = show("view.googleEarth");
  const showExternal = showGoogleMaps || showGoogleEarth;
  const paneCount = mapLayout.rows * mapLayout.cols;
  const gridKey = `${mapLayout.rows}x${mapLayout.cols}`;
  // A custom profile could hide every item; render nothing rather than a menu
  // whose dropdown is an empty shell. (TopToolbar's isMenuVisible guard normally
  // hides the menu first, but don't rely on that invariant here.)
  if (!showZoom && !showNavigation && !showReset && !showSetView && !showSplitView && !showExternal)
    return null;

  return (
    <DropdownMenu
      onOpenChange={(open: boolean) => {
        if (open) setCamera(getCamera());
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          className={chrome.secondaryButtonClass}
          variant="ghost"
          size={chrome.buttonSize}
          aria-label={t("toolbar.menu.view")}
        >
          <Eye className={chrome.iconClassName} />
          {chrome.renderLabel(t("toolbar.menu.view"))}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuLabel>{t("toolbar.menu.view")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {show("view.zoomIn") && (
          <DropdownMenuItem disabled={atMaxZoom} onSelect={onZoomIn}>
            <ZoomIn className="me-2 h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-nowrap">{t("toolbar.item.zoomIn")}</span>
          </DropdownMenuItem>
        )}
        {show("view.zoomOut") && (
          <DropdownMenuItem disabled={atMinZoom} onSelect={onZoomOut}>
            <ZoomOut className="me-2 h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-nowrap">{t("toolbar.item.zoomOut")}</span>
          </DropdownMenuItem>
        )}
        {showZoom && showNavigation && <DropdownMenuSeparator />}
        {show("view.previousView") && (
          <DropdownMenuItem disabled={!history.canGoBack} onSelect={history.goBack}>
            <ArrowLeft className="me-2 h-3.5 w-3.5 shrink-0 rtl:rotate-180" />
            <span className="whitespace-nowrap">{t("toolbar.item.previousView")}</span>
          </DropdownMenuItem>
        )}
        {show("view.nextView") && (
          <DropdownMenuItem disabled={!history.canGoForward} onSelect={history.goForward}>
            <ArrowRight className="me-2 h-3.5 w-3.5 shrink-0 rtl:rotate-180" />
            <span className="whitespace-nowrap">{t("toolbar.item.nextView")}</span>
          </DropdownMenuItem>
        )}
        {(showZoom || showNavigation) && showReset && <DropdownMenuSeparator />}
        {showReset && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              disabled={allResetDisabled}
              className="data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
            >
              <RotateCcw className="h-3.5 w-3.5 shrink-0" />
              <span className="whitespace-nowrap">{t("toolbar.item.resetOrientation")}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-48">
              {showResetPitch && (
                <DropdownMenuItem disabled={pitchIsFlat} onSelect={onResetPitch}>
                  <Mountain className="me-2 h-3.5 w-3.5 shrink-0" />
                  <span className="whitespace-nowrap">{t("toolbar.item.resetPitch")}</span>
                </DropdownMenuItem>
              )}
              {showResetBearing && (
                <DropdownMenuItem disabled={bearingIsNorth} onSelect={onResetNorth}>
                  <Compass className="me-2 h-3.5 w-3.5 shrink-0" />
                  <span className="whitespace-nowrap">{t("toolbar.item.resetBearing")}</span>
                </DropdownMenuItem>
              )}
              {showResetPitchBearing && (
                <DropdownMenuItem
                  disabled={bearingIsNorth && pitchIsFlat}
                  onSelect={onResetPitchBearing}
                >
                  <RotateCcw className="me-2 h-3.5 w-3.5 shrink-0" />
                  <span className="whitespace-nowrap">{t("toolbar.item.resetPitchBearing")}</span>
                </DropdownMenuItem>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {(showZoom || showNavigation || showReset) && showSetView && <DropdownMenuSeparator />}
        {showSetView && (
          <DropdownMenuItem onSelect={onSetView}>
            <Crosshair className="me-2 h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-nowrap">{t("toolbar.item.setView")}</span>
          </DropdownMenuItem>
        )}
        {(showZoom || showNavigation || showReset || showSetView) && showSplitView && (
          <DropdownMenuSeparator />
        )}
        {showSplitView && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <LayoutGrid className="h-3.5 w-3.5 shrink-0" />
              <span className="whitespace-nowrap">{t("toolbar.item.splitView")}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-48">
              <DropdownMenuRadioGroup
                value={gridKey}
                onValueChange={(value: string) => {
                  const [rows, cols] = value.split("x").map(Number);
                  setMapGrid(rows, cols);
                }}
              >
                {SPLIT_VIEW_PRESETS.map((preset) => (
                  <DropdownMenuRadioItem
                    key={`${preset.rows}x${preset.cols}`}
                    value={`${preset.rows}x${preset.cols}`}
                  >
                    <span className="whitespace-nowrap">{t(preset.labelKey)}</span>
                  </DropdownMenuRadioItem>
                ))}
                {/* A grid loaded from a hand-edited project file (e.g. 4x4) may
                    not match any preset; surface it so the radio group still
                    shows the active layout as selected rather than blank. */}
                {!SPLIT_VIEW_PRESETS.some(
                  (preset) => `${preset.rows}x${preset.cols}` === gridKey,
                ) && (
                  <DropdownMenuRadioItem value={gridKey}>
                    <span className="whitespace-nowrap">
                      {`${mapLayout.rows} × ${mapLayout.cols}`}
                    </span>
                  </DropdownMenuRadioItem>
                )}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={mapLayout.syncView}
                disabled={paneCount <= 1}
                onCheckedChange={(checked: boolean) => setSyncView(Boolean(checked))}
                // Radix closes the menu on item select by default; keep it open
                // so toggling sync doesn't dismiss the submenu mid-comparison.
                onSelect={(event: Event) => event.preventDefault()}
              >
                <Link2 className="me-2 h-3.5 w-3.5 shrink-0" />
                <span className="whitespace-nowrap">{t("toolbar.item.splitViewSync")}</span>
              </DropdownMenuCheckboxItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {(showZoom || showNavigation || showReset || showSetView || showSplitView) &&
          showExternal && <DropdownMenuSeparator />}
        {showGoogleMaps && (
          <DropdownMenuItem onSelect={onViewInGoogleMaps}>
            <MapIcon className="me-2 h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-nowrap">{t("toolbar.item.viewInGoogleMaps")}</span>
          </DropdownMenuItem>
        )}
        {showGoogleEarth && (
          <DropdownMenuItem onSelect={onViewInGoogleEarth}>
            <Earth className="me-2 h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-nowrap">{t("toolbar.item.viewInGoogleEarth")}</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
