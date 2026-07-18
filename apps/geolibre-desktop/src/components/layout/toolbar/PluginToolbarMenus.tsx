import type { GeoLibreToolbarMenu, GeoLibreToolbarMenuItem } from "@geolibre/plugins";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@geolibre/ui";
import { Puzzle } from "lucide-react";
import { useToolbarMenus } from "../../../hooks/usePluginUiSurfaces";
import { isExternalPluginId } from "../../../lib/external-plugins";
import { isImageSource } from "../../../lib/icon-source";
import type { ToolbarChrome } from "./constants";

interface PluginToolbarMenusProps {
  chrome: ToolbarChrome;
  /**
   * Which menus to render by their owning plugin's origin: `"builtin"` renders
   * menus from built-in plugins (and any untagged menu) beside the built-in
   * menus; `"external"` renders menus from externally loaded plugins, placed
   * after the Help menu. The toolbar renders one instance of each.
   */
  placement: "builtin" | "external";
}

function MenuIcon({ icon, className }: { icon?: string; className: string }) {
  if (icon && isImageSource(icon)) {
    return <img src={icon} alt="" className={className} />;
  }
  return null;
}

// Cap submenu nesting so a malformed or circular (object-aliased) menu tree
// from a plugin cannot blow the stack; deeper levels are dropped.
const MAX_MENU_DEPTH = 8;

/** Render a plugin menu item tree (actions, submenus, separators) recursively. */
function renderItems(items: GeoLibreToolbarMenuItem[], menuId: string, depth = 0): React.ReactNode {
  if (depth > MAX_MENU_DEPTH) {
    console.warn(
      `Toolbar menu "${menuId}" exceeds the maximum submenu depth (${MAX_MENU_DEPTH}); deeper items are not rendered.`,
    );
    return null;
  }
  return items.map((item, index) => {
    if (item.type === "separator") {
      return <DropdownMenuSeparator key={item.id ?? `sep-${menuId}-${index}`} />;
    }
    if (item.type === "submenu") {
      return (
        <DropdownMenuSub key={item.id}>
          <DropdownMenuSubTrigger>
            {/* No me-2: DropdownMenuSubTrigger already spaces its leading icon
                (matches the built-in menus' submenu triggers). */}
            <MenuIcon icon={item.icon} className="h-4 w-4 shrink-0 object-contain" />
            {item.label}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {renderItems(item.items, `${menuId}.${item.id}`, depth + 1)}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      );
    }
    // Action item (the default when `type` is omitted).
    return (
      <DropdownMenuItem
        key={item.id}
        disabled={item.disabled}
        onSelect={() => {
          try {
            item.onSelect();
          } catch (error) {
            console.error(`Toolbar menu "${menuId}" item "${item.id}" onSelect threw.`, error);
          }
        }}
      >
        <MenuIcon icon={item.icon} className="me-2 h-4 w-4 shrink-0 object-contain" />
        {item.label}
      </DropdownMenuItem>
    );
  });
}

function PluginToolbarMenu({ menu, chrome }: { menu: GeoLibreToolbarMenu; chrome: ToolbarChrome }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className={chrome.secondaryButtonClass}
          variant="ghost"
          size={chrome.buttonSize}
          aria-label={menu.label}
        >
          {menu.icon && isImageSource(menu.icon) ? (
            <img src={menu.icon} alt="" className={chrome.iconClassName} />
          ) : (
            <Puzzle className={chrome.iconClassName} />
          )}
          {chrome.renderLabel(menu.label)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52">
        {renderItems(menu.items, menu.id)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Renders the top-level toolbar menus registered by plugins via
 * `app.registerToolbarMenu()`, one dropdown button per menu. Built-in plugin
 * menus render beside the built-in menus; external plugin menus render after
 * the Help menu (selected by `placement`). Renders nothing when no menu in the
 * requested group has any items.
 */
export function PluginToolbarMenus({ chrome, placement }: PluginToolbarMenusProps) {
  const { entries } = useToolbarMenus();
  // Skip menus with no items so a plugin never shows a button that opens to a
  // blank dropdown, and keep only the menus that belong in this placement. A
  // menu is "external" when its owning plugin was loaded from an external
  // source; menus with no owner (or an unknown one) fall in with the built-ins.
  const visible = entries.filter((entry) => {
    if (entry.menu.items.length === 0) return false;
    // ownerPluginId by itself doesn't encode "external", so re-check the live
    // source map. The two stay in sync because unregister always deactivates a
    // plugin (which removes its menu, re-rendering this list) before dropping
    // its source map entry, so a menu is never seen with a now-stale owner.
    const external = Boolean(entry.ownerPluginId && isExternalPluginId(entry.ownerPluginId));
    return placement === "external" ? external : !external;
  });
  if (visible.length === 0) return null;
  return (
    <>
      {visible.map((entry) => (
        <PluginToolbarMenu key={entry.menu.id} menu={entry.menu} chrome={chrome} />
      ))}
    </>
  );
}
