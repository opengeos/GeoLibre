import { Button } from "@geolibre/ui";
import { Map, Menu, Moon, Plus, Search, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ThemeMode } from "../../../hooks/useThemeMode";

export interface MobileTopBarProps {
  /** Displayed title (project name when set, otherwise resolved app title). */
  title: string;
  /** Whether the user can add data (respects viewer / profile / capability gates). */
  canAddData: boolean;
  /** Whether the Add Data handler is ready for the active renderer. */
  addDataReady: boolean;
  /** Active color theme mode. */
  themeMode: ThemeMode;
  /** Whether the More menu sheet is currently open. */
  menuOpen: boolean;
  /** Open or toggle the mobile More menu sheet. */
  onToggleMenu: () => void;
  /** Open the searchable command palette. */
  onOpenSearch: () => void;
  /** Open the mobile Add Data quick sheet. */
  onOpenAdd: () => void;
  /** Toggle between light and dark theme modes. */
  onToggleThemeMode: () => void;
}

/**
 * Compact single-row mobile header replacing the horizontally scrolling desktop
 * menubar when the phone touch shell is active (GeoLibre#3537).
 *
 * Every action button uses a 44×44px hit target (`h-11 w-11`) and logical
 * spacing utilities so the layout mirrors cleanly in RTL locales.
 */
export function MobileTopBar({
  title,
  canAddData,
  addDataReady,
  themeMode,
  menuOpen,
  onToggleMenu,
  onOpenSearch,
  onOpenAdd,
  onToggleThemeMode,
}: MobileTopBarProps) {
  const { t } = useTranslation();

  return (
    <header
      data-testid="mobile-top-bar"
      aria-label={t("mobileShell.topBarLabel")}
      className="flex h-12 min-w-0 shrink-0 items-center gap-1 border-b bg-card px-1.5"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-11 w-11 shrink-0"
        aria-label={t("mobileShell.openMenu")}
        aria-pressed={menuOpen}
        onClick={onToggleMenu}
      >
        <Menu className="h-5 w-5" />
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1">
        <Map className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="truncate text-sm font-semibold text-foreground">{title}</span>
      </div>
      <div className="ms-auto flex shrink-0 items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-11 w-11 shrink-0"
          aria-label={t("mobileShell.searchCommands")}
          onClick={onOpenSearch}
        >
          <Search className="h-5 w-5" />
        </Button>
        {canAddData ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-11 w-11 shrink-0"
            disabled={!addDataReady}
            aria-label={t("mobileShell.addData")}
            onClick={onOpenAdd}
          >
            <Plus className="h-5 w-5" />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-11 w-11 shrink-0"
          aria-label={
            themeMode === "dark"
              ? t("toolbar.command.switchToLight")
              : t("toolbar.command.switchToDark")
          }
          onClick={onToggleThemeMode}
        >
          {themeMode === "dark" ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
        </Button>
      </div>
    </header>
  );
}
