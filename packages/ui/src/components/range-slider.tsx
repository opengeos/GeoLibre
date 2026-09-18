import * as SliderPrimitive from "@radix-ui/react-slider";
import * as React from "react";
import { cn } from "../lib/utils";

export interface RangeSliderProps extends Omit<
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>,
  "aria-label"
> {
  /** Accessible name for the lower thumb. */
  minLabel: string;
  /** Accessible name for the upper thumb. */
  maxLabel: string;
}

/**
 * Two-thumb slider for choosing a closed interval.
 *
 * Radix puts `role="slider"` on each Thumb, so each thumb carries its own
 * accessible name rather than the Root carrying one for both — otherwise a
 * screen reader announces the same label twice and the two ends are
 * indistinguishable. For a single value use {@link Slider} instead.
 */
export const RangeSlider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  RangeSliderProps
>(({ className, minLabel, maxLabel, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn("relative flex w-full touch-none select-none items-center", className)}
    minStepsBetweenThumbs={0}
    {...props}
  >
    <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-primary/20">
      <SliderPrimitive.Range className="absolute h-full bg-primary" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb
      aria-label={minLabel}
      className="block h-4 w-4 rounded-full border border-primary/50 bg-background shadow transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
    <SliderPrimitive.Thumb
      aria-label={maxLabel}
      className="block h-4 w-4 rounded-full border border-primary/50 bg-background shadow transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  </SliderPrimitive.Root>
));
RangeSlider.displayName = "RangeSlider";
