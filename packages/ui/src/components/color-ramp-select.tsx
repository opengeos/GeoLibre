import { ChevronDown } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";

/** A named color ramp: a stable `value`, a display `label`, and its anchor `colors`. */
export interface ColorRampOption {
  value: string;
  label: string;
  colors: readonly string[];
}

export interface ColorRampSelectProps {
  /** The selected ramp `value`. */
  value: string;
  /** Called with the newly selected ramp `value`. */
  onValueChange: (value: string) => void;
  /** The ramps to offer. */
  ramps: readonly ColorRampOption[];
  /** When true, the colors of each ramp render reversed (matching a reverse toggle). */
  reversed?: boolean;
  id?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

function rampGradient(colors: readonly string[], reversed: boolean): string {
  // An empty ramp would otherwise emit `linear-gradient(90deg, )` (invalid CSS).
  if (colors.length === 0) return "transparent";
  const ordered = reversed ? [...colors].reverse() : colors;
  // A single stop produces no visible gradient, so duplicate it into both ends.
  const stops = ordered.length >= 2 ? ordered : [...ordered, ...ordered];
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

/**
 * A dropdown for picking a color ramp that shows each ramp's color gradient
 * inline, both on the trigger and beside every option, so the colors are visible
 * while choosing (native `<option>` elements cannot render a gradient). Drop-in
 * replacement for the plain colormap `<Select>` in the symbology panels.
 *
 * @param props - {@link ColorRampSelectProps}.
 * @returns The color ramp picker element.
 */
export function ColorRampSelect({
  value,
  onValueChange,
  ramps,
  reversed = false,
  id,
  disabled,
  className,
  "aria-label": ariaLabel,
}: ColorRampSelectProps) {
  // No ramps[0] fallback: an unknown value (e.g. a stale project referencing a
  // removed colormap) leaves `selected` undefined so the trigger shows the raw
  // value with no swatch, rather than masquerading as a different ramp.
  const selected = ramps.find((ramp) => ramp.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        id={id}
        disabled={disabled}
        // aria-label overrides the button's child text, so fold the selected
        // ramp name in or a screen reader would never announce the selection.
        aria-label={ariaLabel ? `${ariaLabel}: ${selected?.label ?? value}` : undefined}
        className={cn(
          "flex h-9 w-full items-center gap-2 rounded-md border border-input bg-background py-1 ps-3 pe-3 text-sm shadow-xs transition-colors focus-visible:border-2 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
      >
        <span
          aria-hidden="true"
          className="h-3.5 w-12 shrink-0 rounded-sm border"
          style={{
            background: selected ? rampGradient(selected.colors, reversed) : undefined,
          }}
        />
        <span className="min-w-0 flex-1 truncate text-start">{selected?.label ?? value}</span>
        <ChevronDown
          className="h-4 w-4 shrink-0 text-muted-foreground opacity-50"
          aria-hidden="true"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-72 w-[var(--radix-dropdown-menu-trigger-width)] min-w-56"
      >
        <DropdownMenuRadioGroup value={value} onValueChange={onValueChange}>
          {ramps.map((ramp) => (
            // The built-in radio indicator (a dot in the reserved left gutter)
            // marks the selected ramp; the swatch + label follow it.
            <DropdownMenuRadioItem key={ramp.value} value={ramp.value} className="gap-2">
              <span
                aria-hidden="true"
                className="h-3.5 w-12 shrink-0 rounded-sm border"
                style={{ background: rampGradient(ramp.colors, reversed) }}
              />
              <span className="min-w-0 flex-1 truncate">{ramp.label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
ColorRampSelect.displayName = "ColorRampSelect";
