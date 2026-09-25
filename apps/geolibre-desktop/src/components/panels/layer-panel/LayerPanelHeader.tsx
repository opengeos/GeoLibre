import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { IDENTIFY_ALL_LAYERS_ID, PLANET_SWITCHER_OPTIONS, useAppStore } from "@geolibre/core";
import type { EllipsoidId } from "@geolibre/core";
import { BASEMAP_CONTROL_PLUGIN_ID, GEO_EDITOR_PLUGIN_ID } from "@geolibre/plugins";
import type { MapEngine } from "@geolibre/map";
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  cn,
} from "@geolibre/ui";
import {
  Eye,
  EyeOff,
  FolderPlus,
  Map as MapIcon,
  MousePointerClick,
  Orbit,
  PanelLeftClose,
  PenTool,
} from "lucide-react";
import { createAppAPI, usePluginRegistry } from "../../../hooks/usePlugins";
import { PLANET_SWITCHER_LABEL_KEYS } from "../../../lib/planet-labels";

type PluginRegistry = ReturnType<typeof usePluginRegistry>;

interface LayerPanelHeaderProps {
  mapControllerRef: RefObject<MapEngine | null>;
  /** The celestial body the active basemap belongs to, if any. */
  selectedPlanet: EllipsoidId | undefined;
  togglePlanet: (body: EllipsoidId, selected: boolean) => void;
  isPluginActive: PluginRegistry["isActive"];
  togglePlugin: PluginRegistry["toggle"];
  onCreateGroup: () => void;
  allLayersVisible: boolean;
  onToggleAllLayers: () => void;
  /** Id of the layer in a geometry-edit session, which disables Identify. */
  geometryEditLayerId: string | null;
  identifyLayerId: string | null;
  onCollapse: () => void;
}

/** The Layers panel title bar and its toolbar buttons. */
export function LayerPanelHeader({
  mapControllerRef,
  selectedPlanet,
  togglePlanet,
  isPluginActive,
  togglePlugin,
  onCreateGroup,
  allLayersVisible,
  onToggleAllLayers,
  geometryEditLayerId,
  identifyLayerId,
  onCollapse,
}: LayerPanelHeaderProps) {
  const { t } = useTranslation();
  const setIdentifyLayer = useAppStore((s) => s.setIdentifyLayer);
  return (
    <div className="flex items-center justify-between border-b px-3 py-1.5">
      <span className="text-sm font-semibold">{t("sharedRail.layers")}</span>
      <div className="flex items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title={t("planetSwitcher.label")}
              aria-label={t("planetSwitcher.label")}
            >
              <Orbit
                className={cn(
                  "h-4 w-4",
                  selectedPlanet && selectedPlanet !== "earth" && "text-primary",
                )}
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t("planetSwitcher.label")}</DropdownMenuLabel>
            {PLANET_SWITCHER_OPTIONS.map((option) => (
              <DropdownMenuCheckboxItem
                key={option.ellipsoidId}
                checked={selectedPlanet === option.ellipsoidId}
                onCheckedChange={(checked) => togglePlanet(option.ellipsoidId, checked)}
              >
                {t(PLANET_SWITCHER_LABEL_KEYS[option.ellipsoidId])}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title={t("layers.basemaps")}
          aria-label={t("layers.basemaps")}
          aria-pressed={isPluginActive(BASEMAP_CONTROL_PLUGIN_ID)}
          onClick={() => togglePlugin(BASEMAP_CONTROL_PLUGIN_ID, createAppAPI(mapControllerRef))}
        >
          <MapIcon
            className={cn("h-4 w-4", isPluginActive(BASEMAP_CONTROL_PLUGIN_ID) && "text-primary")}
          />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title={t("layers.geoEditor")}
          aria-label={t("layers.geoEditor")}
          aria-pressed={isPluginActive(GEO_EDITOR_PLUGIN_ID)}
          onClick={() => togglePlugin(GEO_EDITOR_PLUGIN_ID, createAppAPI(mapControllerRef))}
        >
          <PenTool
            className={cn("h-4 w-4", isPluginActive(GEO_EDITOR_PLUGIN_ID) && "text-primary")}
          />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title={t("layers.newGroup")}
          aria-label={t("layers.newGroup")}
          onClick={onCreateGroup}
        >
          <FolderPlus className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title={allLayersVisible ? t("layers.hideAllLayers") : t("layers.showAllLayers")}
          aria-label={allLayersVisible ? t("layers.hideAllLayers") : t("layers.showAllLayers")}
          onClick={onToggleAllLayers}
        >
          {allLayersVisible ? (
            <Eye className="h-4 w-4" />
          ) : (
            <EyeOff className="h-4 w-4 text-muted-foreground" />
          )}
        </Button>
        {/* A geometry edit session owns map clicks, which is why the
            per-layer Identify button is disabled while its layer is edited;
            the all-layer handler has to stand down for the same reason. */}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title={t("layers.identifyVisibleLayersHint")}
          aria-label={t("layers.identifyVisibleLayers")}
          aria-pressed={identifyLayerId === IDENTIFY_ALL_LAYERS_ID}
          disabled={geometryEditLayerId !== null}
          onClick={() =>
            setIdentifyLayer(
              identifyLayerId === IDENTIFY_ALL_LAYERS_ID ? null : IDENTIFY_ALL_LAYERS_ID,
            )
          }
        >
          <MousePointerClick
            className={cn("h-4 w-4", identifyLayerId === IDENTIFY_ALL_LAYERS_ID && "text-primary")}
          />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title={t("layers.collapse")}
          aria-label={t("layers.collapse")}
          onClick={onCollapse}
        >
          <PanelLeftClose className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
