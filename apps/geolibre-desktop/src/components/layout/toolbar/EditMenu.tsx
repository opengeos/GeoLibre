import { redo, undo, useAppStore } from "@geolibre/core";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@geolibre/ui";
import { Pencil, Redo2, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { ToolbarChrome } from "./constants";

interface EditMenuProps {
  chrome: ToolbarChrome;
}

/** The Edit menu: undo/redo backed by the store's temporal middleware. */
export function EditMenu({ chrome }: EditMenuProps) {
  const { t } = useTranslation();
  const canUndo = useStore(
    useAppStore.temporal,
    (s) => s.pastStates.length > 0,
  );
  const canRedo = useStore(
    useAppStore.temporal,
    (s) => s.futureStates.length > 0,
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className={chrome.secondaryButtonClass}
          variant="ghost"
          size={chrome.buttonSize}
          aria-label={t("toolbar.menu.edit")}
        >
          <Pencil className={chrome.iconClassName} />
          {chrome.renderLabel(t("toolbar.menu.edit"))}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuLabel>{t("toolbar.menu.edit")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!canUndo} onSelect={undo}>
          <Undo2 className="mr-2 h-3.5 w-3.5 shrink-0" />
          <span className="whitespace-nowrap">{t("toolbar.item.undo")}</span>
          <DropdownMenuShortcut>Ctrl/Cmd+Z</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canRedo} onSelect={redo}>
          <Redo2 className="mr-2 h-3.5 w-3.5 shrink-0" />
          <span className="whitespace-nowrap">{t("toolbar.item.redo")}</span>
          <DropdownMenuShortcut>Ctrl/Cmd+Shift+Z / Ctrl+Y</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
