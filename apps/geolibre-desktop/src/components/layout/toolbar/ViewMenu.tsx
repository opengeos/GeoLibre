import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@geolibre/ui";
import { ArrowLeft, ArrowRight, Compass, Eye, Mountain } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useDesktopSettingsStore } from "../../../hooks/useDesktopSettings";
import type { ViewportHistory } from "../../../hooks/useViewportHistory";
import { isMenuItemVisible } from "../../../lib/ui-profile";
import type { ToolbarChrome } from "./constants";

interface ViewMenuProps {
  chrome: ToolbarChrome;
  history: ViewportHistory;
  /** Animate the map back to north-up (bearing 0). */
  onResetNorth: () => void;
  /** Animate the map back to north-up and flat (bearing 0, pitch 0). */
  onResetPitchBearing: () => void;
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
}: ViewMenuProps) {
  const { t } = useTranslation();
  const uiProfile = useDesktopSettingsStore((s) => s.desktopSettings.uiProfile);
  const show = (id: string) => isMenuItemVisible(uiProfile, id);
  const showNavigation =
    show("view.previousView") || show("view.nextView");
  const showReset = show("view.resetNorth") || show("view.resetPitchBearing");

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
        {showNavigation && showReset && <DropdownMenuSeparator />}
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
