import { redo, undo, useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
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
import {
  FilePlus2,
  Locate,
  Pencil,
  Redo2,
  Shuffle,
  SquareDashed,
  SquareFunction,
  Undo2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { useDesktopSettingsStore } from "../../../hooks/useDesktopSettings";
import {
  clearFeatureSelection,
  exportSelectionAsLayer,
  invertLayerSelection,
  zoomToSelection,
} from "../../../lib/selection-actions";
import { isMenuItemVisible } from "../../../lib/ui-profile";
import type { ToolbarChrome } from "./constants";

interface EditMenuProps {
  chrome: ToolbarChrome;
  mapControllerRef: React.RefObject<MapController | null>;
}

/**
 * The Edit menu: undo/redo backed by the store's temporal middleware, plus
 * the feature-selection tools (#1314) — the two Select dialogs and actions on
 * the live selection, which always belongs to the active layer.
 */
export function EditMenu({ chrome, mapControllerRef }: EditMenuProps) {
  const { t } = useTranslation();
  const canUndo = useStore(useAppStore.temporal, (s) => s.pastStates.length > 0);
  const canRedo = useStore(useAppStore.temporal, (s) => s.futureStates.length > 0);
  const setSelectByExpressionOpen = useAppStore((s) => s.setSelectByExpressionOpen);
  const setSelectByLocationOpen = useAppStore((s) => s.setSelectByLocationOpen);
  // Narrow boolean/number selectors so the menu re-renders only when the
  // relevant facts change, not on every store write.
  const hasSelectableLayer = useAppStore((s) =>
    s.layers.some((layer) => (layer.geojson?.features?.length ?? 0) > 0),
  );
  // Select by Location needs a second layer to compare against, so it stays
  // disabled until two selectable layers exist (its dialog would otherwise
  // open straight to the "needs two vector layers" dead end).
  const hasTwoSelectableLayers = useAppStore(
    (s) => s.layers.filter((layer) => (layer.geojson?.features?.length ?? 0) > 0).length >= 2,
  );
  const activeLayerSelectable = useAppStore((s) => {
    const layer = s.layers.find((l) => l.id === s.selectedLayerId);
    return (layer?.geojson?.features?.length ?? 0) > 0;
  });
  const selectionCount = useAppStore((s) => s.selectedFeatureIds.length);
  const hasSelection = activeLayerSelectable && selectionCount > 0;
  const uiProfile = useDesktopSettingsStore((s) => s.desktopSettings.uiProfile);
  const show = (id: string) => isMenuItemVisible(uiProfile, id);

  const handleExportSelection = () => {
    const layer = useAppStore
      .getState()
      .layers.find((l) => l.id === useAppStore.getState().selectedLayerId);
    if (!layer) return;
    exportSelectionAsLayer(t("selection.exportedLayerName", { name: layer.name }));
  };

  const iconClass = "me-2 h-3.5 w-3.5 shrink-0";
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
        {show("edit.undo") && (
          <DropdownMenuItem disabled={!canUndo} onSelect={undo}>
            <Undo2 className={iconClass} />
            <span className="whitespace-nowrap">{t("toolbar.item.undo")}</span>
            <DropdownMenuShortcut>Ctrl/Cmd+Z</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
        {show("edit.redo") && (
          <DropdownMenuItem disabled={!canRedo} onSelect={redo}>
            <Redo2 className={iconClass} />
            <span className="whitespace-nowrap">{t("toolbar.item.redo")}</span>
            <DropdownMenuShortcut>Ctrl/Cmd+Shift+Z / Ctrl+Y</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
        {(show("edit.selectByExpression") || show("edit.selectByLocation")) && (
          <DropdownMenuSeparator />
        )}
        {show("edit.selectByExpression") && (
          <DropdownMenuItem
            disabled={!hasSelectableLayer}
            onSelect={() => setSelectByExpressionOpen(true)}
          >
            <SquareFunction className={iconClass} />
            <span className="whitespace-nowrap">
              {t("toolbar.item.selectByExpressionEllipsis")}
            </span>
          </DropdownMenuItem>
        )}
        {show("edit.selectByLocation") && (
          <DropdownMenuItem
            disabled={!hasTwoSelectableLayers}
            onSelect={() => setSelectByLocationOpen(true)}
          >
            <Locate className={iconClass} />
            <span className="whitespace-nowrap">{t("toolbar.item.selectByLocationEllipsis")}</span>
          </DropdownMenuItem>
        )}
        {show("edit.zoomToSelection") && (
          <DropdownMenuItem
            disabled={!hasSelection}
            onSelect={() => zoomToSelection(mapControllerRef.current)}
          >
            <SquareDashed className={iconClass} />
            <span className="whitespace-nowrap">{t("toolbar.item.zoomToSelection")}</span>
          </DropdownMenuItem>
        )}
        {show("edit.invertSelection") && (
          <DropdownMenuItem disabled={!activeLayerSelectable} onSelect={invertLayerSelection}>
            <Shuffle className={iconClass} />
            <span className="whitespace-nowrap">{t("toolbar.item.invertSelection")}</span>
          </DropdownMenuItem>
        )}
        {show("edit.clearSelection") && (
          <DropdownMenuItem disabled={!hasSelection} onSelect={clearFeatureSelection}>
            <X className={iconClass} />
            <span className="whitespace-nowrap">{t("toolbar.item.clearSelection")}</span>
          </DropdownMenuItem>
        )}
        {show("edit.exportSelection") && (
          <DropdownMenuItem disabled={!hasSelection} onSelect={handleExportSelection}>
            <FilePlus2 className={iconClass} />
            <span className="whitespace-nowrap">{t("toolbar.item.exportSelection")}</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
