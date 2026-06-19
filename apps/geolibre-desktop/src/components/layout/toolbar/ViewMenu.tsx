import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@geolibre/ui";
import { ArrowLeft, ArrowRight, Eye } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useDesktopSettingsStore } from "../../../hooks/useDesktopSettings";
import type { ViewportHistory } from "../../../hooks/useViewportHistory";
import { isMenuItemVisible } from "../../../lib/ui-profile";
import type { ToolbarChrome } from "./constants";

interface ViewMenuProps {
  chrome: ToolbarChrome;
  history: ViewportHistory;
}

/**
 * The View menu: step backward/forward through the map's viewport history, the
 * way a browser's back/forward buttons walk page history. Hidden on narrow
 * screens (via `chrome.secondaryButtonClass`) so the menu bar stays one row.
 */
export function ViewMenu({ chrome, history }: ViewMenuProps) {
  const { t } = useTranslation();
  const uiProfile = useDesktopSettingsStore((s) => s.desktopSettings.uiProfile);
  const show = (id: string) => isMenuItemVisible(uiProfile, id);

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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
