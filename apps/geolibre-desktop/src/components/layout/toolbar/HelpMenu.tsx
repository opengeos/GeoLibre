import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@geolibre/ui";
import {
  Bug,
  CircleHelp,
  Info,
  Keyboard,
  MessageSquare,
  RefreshCw,
  Search,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useDesktopSettingsStore } from "../../../hooks/useDesktopSettings";
import { isMenuItemVisible } from "../../../lib/ui-profile";
import { FEEDBACK_URL, openExternalLink, type ToolbarChrome } from "./constants";

interface HelpMenuProps {
  chrome: ToolbarChrome;
  diagnosticsErrorCount: number;
  onOpenCommandPalette: () => void;
  onOpenShortcuts: () => void;
  onOpenDiagnostics: () => void;
  onCheckForUpdates: () => void;
  onAbout: () => void;
}

/** The Help menu: command palette, shortcuts, diagnostics, feedback, updates, about. */
export function HelpMenu({
  chrome,
  diagnosticsErrorCount,
  onOpenCommandPalette,
  onOpenShortcuts,
  onOpenDiagnostics,
  onCheckForUpdates,
  onAbout,
}: HelpMenuProps) {
  const { t } = useTranslation();
  const uiProfile = useDesktopSettingsStore((s) => s.desktopSettings.uiProfile);
  const show = (id: string) => isMenuItemVisible(uiProfile, id);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className={chrome.buttonClass}
          variant="ghost"
          size={chrome.buttonSize}
          aria-label={t("toolbar.menu.help")}
        >
          <CircleHelp className={chrome.iconClassName} />
          {chrome.renderLabel(t("toolbar.menu.help"))}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{t("toolbar.menu.help")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {show("help.commandPalette") && (
          <DropdownMenuItem onSelect={onOpenCommandPalette}>
            <Search className="mr-2 h-3.5 w-3.5" />
            {t("toolbar.item.commandPalette")}
          </DropdownMenuItem>
        )}
        {show("help.keyboardShortcuts") && (
          <DropdownMenuItem onSelect={onOpenShortcuts}>
            <Keyboard className="mr-2 h-3.5 w-3.5" />
            {t("toolbar.command.keyboardShortcuts")}
          </DropdownMenuItem>
        )}
        {(show("help.commandPalette") || show("help.keyboardShortcuts")) && (
          <DropdownMenuSeparator />
        )}
        {show("help.diagnostics") && (
          <DropdownMenuItem onSelect={onOpenDiagnostics}>
            <Bug className="mr-2 h-3.5 w-3.5" />
            {t("toolbar.command.diagnostics")}
            {diagnosticsErrorCount > 0 ? (
              <span className="ml-2 rounded bg-destructive px-1.5 py-0.5 text-[10px] leading-none text-destructive-foreground">
                {diagnosticsErrorCount}
              </span>
            ) : null}
          </DropdownMenuItem>
        )}
        {show("help.feedback") && (
          <DropdownMenuItem onSelect={() => void openExternalLink(FEEDBACK_URL)}>
            <MessageSquare className="mr-2 h-3.5 w-3.5" />
            {t("toolbar.command.giveFeedback")}
          </DropdownMenuItem>
        )}
        {show("help.checkForUpdates") && (
          <DropdownMenuItem onSelect={onCheckForUpdates}>
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
            {t("toolbar.command.checkForUpdates")}
          </DropdownMenuItem>
        )}
        {show("help.about") && (
          <DropdownMenuItem onSelect={onAbout}>
            <Info className="mr-2 h-3.5 w-3.5" />
            {t("toolbar.command.about")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
