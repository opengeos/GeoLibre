import { DEFAULT_LAYER_STYLE } from "@geolibre/core";

// Shared shell classes for every expanded StylePanel return branch. On phones
// (max-md) it overlays the map as a bottom sheet instead of squeezing it. The
// sheet needs a definite height so the Radix ScrollArea viewport can resolve
// its percentage height and scroll instead of growing to the content height.
export const STYLE_PANEL_ASIDE_CLASS =
  "relative flex h-[min(24rem,42vh)] supports-[height:1dvh]:h-[min(24rem,42dvh)] w-full shrink-0 flex-col border-t bg-card max-md:absolute max-md:inset-x-0 max-md:bottom-0 max-md:z-30 max-md:shadow-xl md:h-auto md:w-[var(--style-panel-width)] md:border-s md:border-t-0";

// The scroll area inside that shell. Radix wraps the viewport content in
// `display: table; min-width: 100%`, which sizes it to the widest row and
// defeats every `truncate` below it: one long field name in Quick filters
// pushed that filter's type picker, its Remove button and the value counts
// past the panel edge. A block wrapper takes the panel width, so text truncates
// again (the block-only form ProcessingDialog uses). It sets no width, so a
// control that really is wider than the panel still overflows the wrapper and
// scrolls sideways. The child selector keeps the override on this viewport,
// not on any ScrollArea nested inside a section.
export const STYLE_PANEL_SCROLL_CLASS =
  "flex-1 [&>[data-radix-scroll-area-viewport]>div]:block!";

export const MIN_LAYER_ZOOM = DEFAULT_LAYER_STYLE.minZoom;
export const MAX_LAYER_ZOOM = DEFAULT_LAYER_STYLE.maxZoom;
