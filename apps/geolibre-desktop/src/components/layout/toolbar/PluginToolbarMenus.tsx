import type {
  GeoLibreToolbarMenu,
  GeoLibreToolbarMenuItem,
} from "@geolibre/plugins";
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
import type { ToolbarChrome } from "./constants";

interface PluginToolbarMenusProps {
  chrome: ToolbarChrome;
}

function isImageSource(icon: string): boolean {
  return /^(https?:|data:|blob:|\/)/.test(icon);
}

function MenuIcon({ icon, className }: { icon?: string; className: string }) {
  if (icon && isImageSource(icon)) {
    return <img src={icon} alt="" className={className} />;
  }
  return null;
}

/** Render a plugin menu item tree (actions, submenus, separators) recursively. */
function renderItems(
  items: GeoLibreToolbarMenuItem[],
  menuId: string,
): React.ReactNode {
  return items.map((item, index) => {
    if (item.type === "separator") {
      return <DropdownMenuSeparator key={item.id ?? `sep-${menuId}-${index}`} />;
    }
    if (item.type === "submenu") {
      return (
        <DropdownMenuSub key={item.id}>
          <DropdownMenuSubTrigger>
            <MenuIcon icon={item.icon} className="mr-2 h-4 w-4 object-contain" />
            {item.label}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {renderItems(item.items, `${menuId}.${item.id}`)}
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
            console.error(
              `Toolbar menu "${menuId}" item "${item.id}" onSelect threw.`,
              error,
            );
          }
        }}
      >
        <MenuIcon icon={item.icon} className="mr-2 h-4 w-4 object-contain" />
        {item.label}
      </DropdownMenuItem>
    );
  });
}

function PluginToolbarMenu({
  menu,
  chrome,
}: {
  menu: GeoLibreToolbarMenu;
  chrome: ToolbarChrome;
}) {
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
 * `app.registerToolbarMenu()`, one dropdown button per menu, beside the
 * built-in toolbar menus. Renders nothing when no plugin has registered a menu.
 */
export function PluginToolbarMenus({ chrome }: PluginToolbarMenusProps) {
  const { menus } = useToolbarMenus();
  if (menus.length === 0) return null;
  return (
    <>
      {menus.map((menu) => (
        <PluginToolbarMenu key={menu.id} menu={menu} chrome={chrome} />
      ))}
    </>
  );
}
