import { DropdownMenuItem } from "@geolibre/ui";
import { useTranslation } from "react-i18next";

/** Props for {@link PlanetaryComputerMenuItem}. */
export interface PlanetaryComputerMenuItemProps {
  /** Opens the Planetary Computer panel. */
  onSelect: () => void;
  /** Whether the deployment grants adding remote layers. */
  allowed: boolean;
  /** Id of the notice explaining a denied capability, for `aria-describedby`. */
  deniedBy: string | undefined;
  /** Whether the active renderer has a MapLibre map for the panel to draw on. */
  nativeMap: boolean;
}

/**
 * The Processing menu's Planetary Computer entry.
 *
 * The panel's control draws its layers through the MapLibre style API, so the
 * entry is disabled on the renderers that have no MapLibre map. A disabled menu
 * item ignores the pointer by default, which would also hide the `title` that
 * explains why, so pointer events are kept; Radix still refuses to select it.
 *
 * @param props - Handler and gating state.
 * @returns The menu item.
 */
export function PlanetaryComputerMenuItem({
  onSelect,
  allowed,
  deniedBy,
  nativeMap,
}: PlanetaryComputerMenuItemProps) {
  const { t } = useTranslation();
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      disabled={!allowed || !nativeMap}
      title={nativeMap ? undefined : t("renderer.pluginUnsupported")}
      className={nativeMap ? undefined : "data-[disabled]:pointer-events-auto"}
      aria-describedby={deniedBy}
    >
      {t("toolbar.command.planetaryComputer")}
    </DropdownMenuItem>
  );
}
