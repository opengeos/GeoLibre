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
        <DropdownMenuItem onSelect={onOpenCommandPalette}>
          <Search className="mr-2 h-3.5 w-3.5" />
          {t("toolbar.item.commandPalette")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onOpenShortcuts}>
          <Keyboard className="mr-2 h-3.5 w-3.5" />
          {t("toolbar.command.keyboardShortcuts")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onOpenDiagnostics}>
          <Bug className="mr-2 h-3.5 w-3.5" />
          {t("toolbar.command.diagnostics")}
          {diagnosticsErrorCount > 0 ? (
            <span className="ml-2 rounded bg-destructive px-1.5 py-0.5 text-[10px] leading-none text-destructive-foreground">
              {diagnosticsErrorCount}
            </span>
          ) : null}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void openExternalLink(FEEDBACK_URL)}>
          <MessageSquare className="mr-2 h-3.5 w-3.5" />
          {t("toolbar.command.giveFeedback")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onCheckForUpdates}>
          <RefreshCw className="mr-2 h-3.5 w-3.5" />
          {t("toolbar.command.checkForUpdates")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onAbout}>
          <Info className="mr-2 h-3.5 w-3.5" />
          {t("toolbar.command.about")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
