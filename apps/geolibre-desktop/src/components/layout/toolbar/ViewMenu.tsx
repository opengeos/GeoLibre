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
  Eye,
  LayoutGrid,
  Link2,
  Mountain,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
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

interface ViewMenuProps {
  chrome: ToolbarChrome;
  history: ViewportHistory;
  /** Animate the map back to north-up (bearing 0). */
  onResetNorth: () => void;
  /** Animate the map back to north-up and flat (bearing 0, pitch 0). */
  onResetPitchBearing: () => void;
  /** Open the dialog for typing an exact camera (center/zoom/pitch/bearing). */
  onSetView: () => void;
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
  onResetNorth,
  onResetPitchBearing,
  onSetView,
  onZoomIn,
  onZoomOut,
}: ViewMenuProps) {
  const { t } = useTranslation();
  const uiProfile = useDesktopSettingsStore((s) => s.desktopSettings.uiProfile);
  const mapLayout = useAppStore((s) => s.mapLayout);
  const setMapGrid = useAppStore((s) => s.setMapGrid);
  const setSyncView = useAppStore((s) => s.setSyncView);
  const show = (id: string) => isMenuItemVisible(uiProfile, id);
  const showZoom = show("view.zoomIn") || show("view.zoomOut");
  const showNavigation =
    show("view.previousView") || show("view.nextView");
  const showReset = show("view.resetNorth") || show("view.resetPitchBearing");
  const showSetView = show("view.setView");
  const showSplitView = show("view.splitView");
  const paneCount = mapLayout.rows * mapLayout.cols;
  const gridKey = `${mapLayout.rows}x${mapLayout.cols}`;
  // A custom profile could hide every item; render nothing rather than a menu
  // whose dropdown is an empty shell. (TopToolbar's isMenuVisible guard normally
  // hides the menu first, but don't rely on that invariant here.)
  if (
    !showZoom &&
    !showNavigation &&
    !showReset &&
    !showSetView &&
    !showSplitView
  )
    return null;

  return (
    <DropdownMenu>
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
          <DropdownMenuItem onSelect={onZoomIn}>
            <ZoomIn className="mr-2 h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-nowrap">
              {t("toolbar.item.zoomIn")}
            </span>
          </DropdownMenuItem>
        )}
        {show("view.zoomOut") && (
          <DropdownMenuItem onSelect={onZoomOut}>
            <ZoomOut className="mr-2 h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-nowrap">
              {t("toolbar.item.zoomOut")}
            </span>
          </DropdownMenuItem>
        )}
        {showZoom && showNavigation && <DropdownMenuSeparator />}
        {show("view.previousView") && (
          <DropdownMenuItem
            disabled={!history.canGoBack}
            onSelect={history.goBack}
          >
            <ArrowLeft className="mr-2 h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-nowrap">
              {t("toolbar.item.previousView")}
            </span>
          </DropdownMenuItem>
        )}
        {show("view.nextView") && (
          <DropdownMenuItem
            disabled={!history.canGoForward}
            onSelect={history.goForward}
          >
            <ArrowRight className="mr-2 h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-nowrap">
              {t("toolbar.item.nextView")}
            </span>
          </DropdownMenuItem>
        )}
        {(showZoom || showNavigation) && showReset && (
          <DropdownMenuSeparator />
        )}
        {show("view.resetNorth") && (
          <DropdownMenuItem onSelect={onResetNorth}>
            <Compass className="mr-2 h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-nowrap">
              {t("toolbar.item.resetNorth")}
            </span>
          </DropdownMenuItem>
        )}
        {show("view.resetPitchBearing") && (
          <DropdownMenuItem onSelect={onResetPitchBearing}>
            <Mountain className="mr-2 h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-nowrap">
              {t("toolbar.item.resetPitchBearing")}
            </span>
          </DropdownMenuItem>
        )}
        {(showZoom || showNavigation || showReset) && showSetView && (
          <DropdownMenuSeparator />
        )}
        {showSetView && (
          <DropdownMenuItem onSelect={onSetView}>
            <Crosshair className="mr-2 h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-nowrap">
              {t("toolbar.item.setView")}
            </span>
          </DropdownMenuItem>
        )}
        {(showZoom || showNavigation || showReset || showSetView) &&
          showSplitView && <DropdownMenuSeparator />}
        {showSplitView && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <LayoutGrid className="mr-2 h-3.5 w-3.5 shrink-0" />
              <span className="whitespace-nowrap">
                {t("toolbar.item.splitView")}
              </span>
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
                    <span className="whitespace-nowrap">
                      {t(preset.labelKey)}
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={mapLayout.syncView}
                disabled={paneCount <= 1}
                onCheckedChange={(checked: boolean) =>
                  setSyncView(Boolean(checked))
                }
                // Radix closes the menu on item select by default; keep it open
                // so toggling sync doesn't dismiss the submenu mid-comparison.
                onSelect={(event: Event) => event.preventDefault()}
              >
                <Link2 className="mr-2 h-3.5 w-3.5 shrink-0" />
                <span className="whitespace-nowrap">
                  {t("toolbar.item.splitViewSync")}
                </span>
              </DropdownMenuCheckboxItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
