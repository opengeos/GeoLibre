import { useAppStore } from "@geolibre/core";
import type { GeoLibreMenuContributionTarget } from "@geolibre/plugins";
import {
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@geolibre/ui";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { useMenuContributions } from "../../../hooks/usePluginUiSurfaces";
import { groupMenuContributions } from "../../../lib/menu-contributions";
import { pluginDisplayName, sortPluginsByDisplayName } from "../../../lib/plugin-display-name";
import { renderItems } from "./PluginToolbarMenus";

/**
 * The items plugins added to a built-in toolbar menu with
 * `app.registerMenuContribution()` (GeoLibre#2850). Rendered at the end of the
 * menu's content: a separator, then one submenu per plugin, named after the
 * plugin and sorted alphabetically. Renders nothing when no plugin contributed
 * to this menu, or when the deployment does not allow plugins (the same
 * `plugins:install` gate as plugin-registered toolbar menus).
 */
export function PluginMenuContributions({ target }: { target: GeoLibreMenuContributionTarget }) {
  const { entries } = useMenuContributions();
  // Also re-renders on language changes, so label getters and translated plugin
  // names follow the app language.
  const { t, i18n } = useTranslation();
  const pluginsAllowed = useAppStore((state) =>
    state.deploymentCapabilities.has("plugins:install"),
  );
  if (!pluginsAllowed) return null;
  const groups = sortPluginsByDisplayName(
    t,
    groupMenuContributions(entries, target),
    i18n.language,
  );
  if (groups.length === 0) return null;
  return (
    <>
      <DropdownMenuSeparator />
      {groups.map((group) => (
        <DropdownMenuSub key={group.key}>
          <DropdownMenuSubTrigger>{pluginDisplayName(t, group)}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {group.sections.map((section, index) => (
              <Fragment key={section.id}>
                {index > 0 ? <DropdownMenuSeparator /> : null}
                {renderItems(section.items, `${target}.${section.id}`)}
              </Fragment>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ))}
    </>
  );
}
