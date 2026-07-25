import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@geolibre/ui";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  type Command,
  type Shortcut,
  PALETTE_SHORTCUT,
  SHORTCUTS_HELP_SHORTCUT,
  formatShortcut,
  isMacPlatform,
} from "../../lib/commands";

interface KeyboardShortcutsDialogProps {
  open: boolean;
  commands: Command[];
  onOpenChange: (open: boolean) => void;
}

interface ShortcutRow {
  id: string;
  label: string;
  /** A command-style shortcut, formatted per platform. */
  shortcut?: Shortcut;
  /** A pre-rendered key label, for keys handled natively by MapLibre. */
  display?: string;
}

/**
 * Map navigation keys handled by MapLibre's own keyboard interaction (not the
 * command registry), listed for discoverability. These mirror Google Earth's
 * navigation keys and only work while the map canvas has focus.
 */
const MAP_NAVIGATION_KEYS = [
  { id: "nav.zoom-in", label: "shortcuts.nav.zoomIn", display: "+" },
  { id: "nav.zoom-out", label: "shortcuts.nav.zoomOut", display: "−" },
  { id: "nav.pan", label: "shortcuts.nav.pan", display: "← ↑ ↓ →" },
  { id: "nav.rotate", label: "shortcuts.nav.rotate", display: "⇧ ← / →" },
  { id: "nav.tilt", label: "shortcuts.nav.tilt", display: "⇧ ↑ / ↓" },
] as const;

/**
 * A cheat sheet (opened with `?`) listing every global keyboard shortcut,
 * grouped the same way as the command palette.
 */
export function KeyboardShortcutsDialog({
  open,
  commands,
  onOpenChange,
}: KeyboardShortcutsDialogProps) {
  const { t } = useTranslation();
  const isMac = useMemo(() => isMacPlatform(), []);

  const groups = useMemo(() => {
    const ordered: Array<{ group: string; rows: ShortcutRow[] }> = [];
    const indexByGroup = new Map<string, number>();
    const pushRow = (group: string, row: ShortcutRow) => {
      let position = indexByGroup.get(group);
      if (position === undefined) {
        position = ordered.length;
        indexByGroup.set(group, position);
        ordered.push({ group, rows: [] });
      }
      ordered[position].rows.push(row);
    };

    // The palette and cheat-sheet shortcuts are not commands, so list them
    // first under a "General" group.
    pushRow(t("shortcuts.groupGeneral"), {
      id: "general.open-command-palette",
      label: t("shortcuts.openCommandPalette"),
      shortcut: PALETTE_SHORTCUT,
    });
    pushRow(t("shortcuts.groupGeneral"), {
      id: "general.show-keyboard-shortcuts",
      label: t("shortcuts.showKeyboardShortcuts"),
      shortcut: SHORTCUTS_HELP_SHORTCUT,
    });

    for (const command of commands) {
      if (command.shortcut) {
        // Command titles arrive already translated from the command registry.
        pushRow(command.group, {
          id: command.id,
          label: command.title,
          shortcut: command.shortcut,
        });
      }
    }

    // Append the MapLibre-native navigation keys as a final, display-only group.
    for (const row of MAP_NAVIGATION_KEYS) {
      pushRow(t("shortcuts.groupMapNavigation"), {
        id: row.id,
        label: t(row.label),
        display: row.display,
      });
    }
    return ordered;
  }, [commands, t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("shortcuts.title")}</DialogTitle>
          <DialogDescription>
            {t("shortcuts.description", { shortcut: formatShortcut(PALETTE_SHORTCUT, isMac) })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {groups.map(({ group, rows }) => (
            <div key={group} className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">{group}</p>
              <ul className="space-y-1">
                {rows.map((row) => (
                  <li key={row.id} className="flex items-center justify-between gap-4 text-sm">
                    <span className="min-w-0 truncate">{row.label}</span>
                    <kbd className="shrink-0 rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {row.shortcut ? formatShortcut(row.shortcut, isMac) : row.display}
                    </kbd>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
