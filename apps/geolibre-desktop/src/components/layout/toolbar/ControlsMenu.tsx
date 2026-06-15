import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@geolibre/ui";
import { ClipboardList, SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ToolbarPanels } from "../../../hooks/useToolbarPanels";
import {
  MAP_CONTROL_ITEMS,
  type ToolbarChrome,
  type ToolbarMapControl,
} from "./constants";

interface ControlsMenuProps {
  chrome: ToolbarChrome;
  controlsVisible: Record<ToolbarMapControl, boolean>;
  panels: ToolbarPanels;
  effectsActive: boolean;
  directionsActive: boolean;
  reverseGeocodeActive: boolean;
  onToggleMapControl: (control: ToolbarMapControl) => void;
  onToggleEffects: () => void;
  onToggleDirections: () => void;
  onToggleReverseGeocode: () => void;
  onOpenFieldCollection: () => void;
}

/** The Controls menu: built-in map controls, atmosphere/routing toggles, and panels. */
export function ControlsMenu({
  chrome,
  controlsVisible,
  panels,
  effectsActive,
  directionsActive,
  reverseGeocodeActive,
  onToggleMapControl,
  onToggleEffects,
  onToggleDirections,
  onToggleReverseGeocode,
  onOpenFieldCollection,
}: ControlsMenuProps) {
  const { t } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className={chrome.buttonClass}
          variant="ghost"
          size={chrome.buttonSize}
          aria-label={t("toolbar.menu.controls")}
        >
          <SlidersHorizontal className={chrome.iconClassName} />
          {chrome.renderLabel(t("toolbar.menu.controls"))}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{t("toolbar.item.mapControls")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {MAP_CONTROL_ITEMS.map((control) => (
          <DropdownMenuItem
            key={control.id}
            onClick={() => onToggleMapControl(control.id)}
          >
            {t(control.labelKey)}
            {controlsVisible[control.id] ? " ✓" : ""}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onClick={onToggleEffects}>
          {t("toolbar.item.atmosphereEffects")}
          {effectsActive ? " ✓" : ""}
        </DropdownMenuItem>
        <DropdownMenuItem
          title={t("toolbar.item.directionsTooltip")}
          onClick={onToggleDirections}
        >
          {t("toolbar.item.directions")}
          {directionsActive ? " ✓" : ""}
        </DropdownMenuItem>
        <DropdownMenuItem
          title={t("toolbar.item.reverseGeocodeTooltip")}
          onClick={onToggleReverseGeocode}
        >
          {t("toolbar.item.reverseGeocode")}
          {reverseGeocodeActive ? " ✓" : ""}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={panels.searchPlaces.toggle}>
          {t("toolbar.item.search")}
          {panels.searchPlaces.visible ? " ✓" : ""}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={panels.colorbar.toggle}>
          {t("toolbar.item.colorbar")}
          {panels.colorbar.visible ? " ✓" : ""}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={panels.legend.toggle}>
          {t("toolbar.item.legend")}
          {panels.legend.visible ? " ✓" : ""}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={panels.html.toggle}>
          {t("toolbar.item.html")}
          {panels.html.visible ? " ✓" : ""}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={panels.measure.toggle}>
          {t("toolbar.item.measure")}
          {panels.measure.visible ? " ✓" : ""}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={panels.bookmark.toggle}>
          {t("toolbar.item.bookmark")}
          {panels.bookmark.visible ? " ✓" : ""}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={panels.minimap.toggle}>
          {t("toolbar.item.minimap")}
          {panels.minimap.visible ? " ✓" : ""}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={panels.viewState.toggle}>
          {t("toolbar.item.viewState")}
          {panels.viewState.visible ? " ✓" : ""}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onOpenFieldCollection}>
          <ClipboardList className="mr-2 h-3.5 w-3.5" />
          {t("toolbar.item.fieldCollection")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
