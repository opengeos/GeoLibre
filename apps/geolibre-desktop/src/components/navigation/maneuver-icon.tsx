import {
  ArrowDownLeft,
  ArrowDownRight,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  CornerUpLeft,
  CornerUpRight,
  Flag,
  Merge,
  Navigation2,
  Redo2,
  RotateCcw,
  RotateCw,
  Undo2,
  type LucideIcon,
} from "lucide-react";

/**
 * The arrow for an OSRM maneuver modifier or lane indication
 * (`left`, `slight right`, `uturn`, …).
 *
 * The arrows are geographic, so they are never mirrored for a right-to-left
 * interface: a left turn points left in every language.
 *
 * @param modifier - The modifier or lane indication.
 * @param drivingSide - Which side traffic drives on, for the U-turn's direction.
 * @returns The icon.
 */
export function modifierIcon(modifier: string | undefined, drivingSide = "right"): LucideIcon {
  switch (modifier) {
    case "uturn":
      return drivingSide === "left" ? Redo2 : Undo2;
    case "sharp right":
      return ArrowDownRight;
    case "right":
      return CornerUpRight;
    case "slight right":
      return ArrowUpRight;
    case "slight left":
      return ArrowUpLeft;
    case "left":
      return CornerUpLeft;
    case "sharp left":
      return ArrowDownLeft;
    default:
      return ArrowUp;
  }
}

/**
 * The icon for an OSRM maneuver.
 *
 * @param type - The maneuver type (`turn`, `roundabout`, `arrive`, …).
 * @param modifier - The maneuver modifier.
 * @param drivingSide - Which side traffic drives on.
 * @returns The icon.
 */
export function maneuverIcon(
  type: string | undefined,
  modifier: string | undefined,
  drivingSide = "right",
): LucideIcon {
  switch (type) {
    case "arrive":
      return Flag;
    case "depart":
      return Navigation2;
    case "roundabout":
    case "rotary":
    case "roundabout turn":
    case "exit roundabout":
    case "exit rotary":
      // Right-hand traffic circles counter-clockwise.
      return drivingSide === "left" ? RotateCw : RotateCcw;
    case "merge":
      return modifier && modifier !== "straight" ? modifierIcon(modifier, drivingSide) : Merge;
    default:
      return modifierIcon(modifier, drivingSide);
  }
}
