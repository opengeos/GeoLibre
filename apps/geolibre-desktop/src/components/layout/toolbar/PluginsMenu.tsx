import {
  DECK_VIZ_PLUGIN_ID,
  DIRECTIONS_PLUGIN_ID,
  type GeoLibreMapControlPosition,
  REVERSE_GEOCODE_PLUGIN_ID,
  EFFECTS_PLUGIN_ID,
  WEB_SERVICE_PLUGIN_IDS,
} from "@geolibre/plugins";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@geolibre/ui";
import { Puzzle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { usePluginRegistry } from "../../../hooks/usePlugins";
import {
  type AppApi,
  PLUGIN_POSITION_ITEMS,
  type ToolbarChrome,
} from "./constants";

type PluginRegistry = ReturnType<typeof usePluginRegistry>;
type RegisteredPlugin = PluginRegistry["plugins"][number];

// Plugins grouped under the "Web Services" submenu of the Plugins menu.
const WEB_SERVICE_PLUGIN_ID_SET = new Set<string>(WEB_SERVICE_PLUGIN_IDS);

interface PluginsMenuProps {
  chrome: ToolbarChrome;
  appApi: AppApi;
  plugins: RegisteredPlugin[];
  isActive: PluginRegistry["isActive"];
  toggle: PluginRegistry["toggle"];
  getMapControlPosition: PluginRegistry["getMapControlPosition"];
  setMapControlPosition: PluginRegistry["setMapControlPosition"];
  /** Plugin ids hidden by the active UI profile (issue #500). */
  hiddenPluginIds: Set<string>;
}

/** The Plugins menu: one toggle per registered plugin, with position submenus. */
export function PluginsMenu({
  chrome,
  appApi,
  plugins,
  isActive,
  toggle,
  getMapControlPosition,
  setMapControlPosition,
  hiddenPluginIds,
}: PluginsMenuProps) {
  const { t } = useTranslation();

  const renderPluginMenuItem = (p: RegisteredPlugin) => {
    const pluginPosition = getMapControlPosition(p.id);
    if (!pluginPosition) {
      return (
        <DropdownMenuItem key={p.id} onClick={() => toggle(p.id, appApi)}>
          {p.name}
          {isActive(p.id) ? " ✓" : ""}
        </DropdownMenuItem>
      );
    }

    return (
      <DropdownMenuSub key={p.id}>
        <DropdownMenuSubTrigger>
          {p.name}
          {isActive(p.id) ? " ✓" : ""}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuItem onClick={() => toggle(p.id, appApi)}>
            {isActive(p.id)
              ? t("toolbar.item.deactivate")
              : t("toolbar.item.activate")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{t("toolbar.item.position")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={pluginPosition}
            onValueChange={(position: string) =>
              setMapControlPosition(
                p.id,
                appApi,
                position as GeoLibreMapControlPosition,
              )
            }
          >
            {PLUGIN_POSITION_ITEMS.map((position) => (
              <DropdownMenuRadioItem
                key={position.value}
                value={position.value}
                onSelect={(event: Event) => event.preventDefault()}
              >
                {t(position.labelKey)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  };

  const webServicePlugins = plugins.filter(
    (p) => WEB_SERVICE_PLUGIN_ID_SET.has(p.id) && !hiddenPluginIds.has(p.id),
  );
  // The web service plugins render as one grouped submenu, placed where the
  // first of them appears in registration order (just above Esri Wayback).
  let webServicesRendered = false;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className={chrome.buttonClass}
          variant="ghost"
          size={chrome.buttonSize}
          aria-label={t("toolbar.menu.plugins")}
        >
          <Puzzle className={chrome.iconClassName} />
          {chrome.renderLabel(t("toolbar.menu.plugins"))}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{t("toolbar.item.activatePlugin")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {plugins.map((p) => {
          // Atmosphere Effects, Directions, and Reverse Geocode are toggled
          // from the Controls menu instead, so they are omitted here to avoid a
          // duplicate toggle. The deck.gl viz overlay is an internal renderer
          // driven by the Add Data → "Deck.gl Layer" dialog, not a user-facing
          // toggle, so it is hidden here too.
          if (
            p.id === EFFECTS_PLUGIN_ID ||
            p.id === DIRECTIONS_PLUGIN_ID ||
            p.id === REVERSE_GEOCODE_PLUGIN_ID ||
            p.id === DECK_VIZ_PLUGIN_ID
          ) {
            return null;
          }
          // Hidden by the active UI profile (issue #500).
          if (hiddenPluginIds.has(p.id)) {
            return null;
          }
          if (!WEB_SERVICE_PLUGIN_ID_SET.has(p.id)) {
            return renderPluginMenuItem(p);
          }
          // Reaching here means `p` is a visible web service plugin, so the
          // submenu has at least one entry. When all web service plugins are
          // hidden no plugin reaches this branch and the submenu simply never
          // renders.
          if (webServicesRendered) return null;
          webServicesRendered = true;
          return (
            <DropdownMenuSub key="web-services">
              <DropdownMenuSubTrigger>
                {t("toolbar.item.webServices")}
                {webServicePlugins.some((plugin) => isActive(plugin.id))
                  ? " ✓"
                  : ""}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {webServicePlugins.map(renderPluginMenuItem)}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
