import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight, Circle } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/utils";

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;
export const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
export const DropdownMenuSub = DropdownMenuPrimitive.Sub;
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

export const DropdownMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> & {
    inset?: boolean;
  }
>(({ className, inset, children, ...props }, ref) => (
  <DropdownMenuPrimitive.SubTrigger
    ref={ref}
    className={cn(
      // Grey out when disabled, like DropdownMenuItem, but intentionally NOT
      // `data-[disabled]:pointer-events-none`: pointer events must stay active
      // so a disabled trigger's native `title` tooltip still fires on hover
      // (Radix already blocks the submenu from opening while disabled). Unlike
      // DropdownMenuItem, a disabled SubTrigger therefore still receives pointer
      // events; callers that need clicks suppressed must handle that themselves.
      "flex min-w-0 cursor-default select-none items-center gap-2 overflow-hidden rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent data-[disabled]:opacity-50 data-[state=open]:bg-accent",
      inset && "ps-8",
      className,
    )}
    {...props}
  >
    {children}
    <ChevronRight className="ms-auto h-4 w-4 shrink-0 rtl:rotate-180" />
  </DropdownMenuPrimitive.SubTrigger>
));
DropdownMenuSubTrigger.displayName = DropdownMenuPrimitive.SubTrigger.displayName;

/**
 * Horizontal room a submenu may occupy: the space Radix's `size` middleware
 * measured for the side it settled on, never more than the viewport less an 8px
 * edge buffer, never less than zero.
 *
 * The `max(0px, …)` is not decoration. Floating UI's `availableWidth` goes
 * negative when the floating element cannot fit its clipping context at all,
 * and CSS clamps a math function to a property's allowed range rather than
 * rejecting it, so a raw negative would silently resolve `max-width` to 0 and
 * collapse the menu. Clamping here keeps the value a real length, and lets
 * `minWidth` be derived from the same expression so the floor is provably never
 * above the cap (they meet, at worst, at 0).
 */
const SUB_CONTENT_AVAILABLE_WIDTH =
  "max(0px, min(var(--radix-dropdown-menu-content-available-width, 100vw), calc(100vw - 1rem)))";

export const DropdownMenuSubContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(({ className, style, ...props }, ref) => (
  // Portal to the body so a nested submenu is not a DOM descendant of its parent
  // submenu's scroll box. Without this, the parent's `overflow-y-auto` becomes a
  // clipping ancestor and Radix's collision detection treats the parent's narrow
  // width as the available space, flipping a 3rd-level submenu to the left (over
  // its grandparent) even when there is room on the right.
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.SubContent
      ref={ref}
      className={cn(
        // No min-w-[8rem] here, unlike DropdownMenuContent: the floor is set
        // below so it can yield to the available-width cap on a narrow screen.
        "z-50 max-w-[calc(100vw-1rem)] overflow-x-hidden overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-lg",
        className,
      )}
      style={{
        // Cap to the visible viewport on mobile: dvh tracks the dynamic viewport
        // and subtracting the safe-area insets keeps the menu (and its scrollable
        // overflow) within the area not covered by the system status/navigation
        // bars, so long menus scroll instead of clipping under them. On desktop/web
        // dvh == vh and the insets are 0, so behavior is unchanged.
        maxHeight:
          "min(var(--radix-dropdown-menu-content-available-height, 100dvh), calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 1rem))",
        // The horizontal equivalent, and the only thing keeping a submenu on a
        // narrow screen. Radix configures Floating UI's shift middleware as
        // `shift({ mainAxis: true, crossAxis: false })`, and for a right/left
        // placement the cross axis is the horizontal one — so a submenu that
        // overflows sideways is never pushed back into view. `flip` picks the
        // side with less overflow, but on a phone neither side fits: with a
        // 390px viewport, a 161px parent at x=116 leaves 113px to its right and
        // 116px to its left for a 185px submenu, so Radix flips left and lands
        // at x=-64, a quarter of the menu off-screen (GeoLibre#1904 follow-up).
        // Capping to the space Radix itself measured for the chosen side makes
        // the submenu shrink to fit instead of overflowing; labels wrap. On
        // desktop the available width always exceeds the content, so the cap is
        // inert and nothing changes.
        maxWidth: SUB_CONTENT_AVAILABLE_WIDTH,
        // The usual 8rem floor, but it has to lose to the cap above or it just
        // reintroduces the overflow a few pixels smaller: on a 390px viewport
        // the submenu lands at x=264 with 126px to spare, and a hard 128px floor
        // pushes it 2px past the edge. min() lets the floor collapse exactly as
        // far as the available space demands and no further. Built from the same
        // expression as maxWidth so the floor can never exceed the cap.
        minWidth: `min(8rem, ${SUB_CONTENT_AVAILABLE_WIDTH})`,
        ...style,
      }}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuSubContent.displayName = DropdownMenuPrimitive.SubContent.displayName;

export const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, style, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 max-w-[calc(100vw-1rem)] min-w-[8rem] overflow-x-hidden overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
        className,
      )}
      style={{
        maxHeight:
          "min(var(--radix-dropdown-menu-content-available-height, 100vh), calc(100vh - 1rem))",
        ...style,
      }}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

export const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
    inset?: boolean;
  }
>(({ className, inset, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex min-w-0 cursor-default select-none items-center overflow-hidden rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      inset && "ps-8",
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

export const DropdownMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem> & {
    /** `"check"` (default): bare checkmark when checked. `"box"`: always-visible bordered square that fills on check. */
    indicator?: "check" | "box";
  }
>(({ className, children, checked, indicator = "check", ...props }, ref) => (
  <DropdownMenuPrimitive.CheckboxItem
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center rounded-sm py-1.5 ps-8 pe-2 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground",
      className,
    )}
    checked={checked}
    {...props}
  >
    {indicator === "box" ? (
      <span
        className={cn(
          "absolute start-2 flex h-4 w-4 items-center justify-center rounded-[4px] border transition-colors",
          checked === true
            ? "border-primary bg-primary text-primary-foreground"
            : checked === "indeterminate"
              ? "border-primary bg-primary/40 text-primary-foreground"
              : "border-input",
        )}
      >
        {checked === true ? (
          <Check className="h-3 w-3" />
        ) : checked === "indeterminate" ? (
          <span className="h-0.5 w-2 rounded-full bg-current" />
        ) : null}
      </span>
    ) : (
      <span className="absolute start-2 flex h-3.5 w-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="h-4 w-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
    )}
    {children}
  </DropdownMenuPrimitive.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = DropdownMenuPrimitive.CheckboxItem.displayName;

export const DropdownMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.RadioItem
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center rounded-sm py-1.5 ps-8 pe-2 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground",
      className,
    )}
    {...props}
  >
    <span className="absolute start-2 flex h-3.5 w-3.5 items-center justify-center">
      <DropdownMenuPrimitive.ItemIndicator>
        <Circle className="h-2 w-2 fill-current" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.RadioItem>
));
DropdownMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName;

export const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & {
    inset?: boolean;
  }
>(({ className, inset, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={cn("px-2 py-1.5 text-sm font-semibold", inset && "ps-8", className)}
    {...props}
  />
));
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

export const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-muted", className)}
    {...props}
  />
));
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;

export const DropdownMenuShortcut = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) => (
  <span
    className={cn(
      "ms-auto shrink-0 whitespace-nowrap ps-4 text-xs text-muted-foreground",
      className,
    )}
    {...props}
  />
);
DropdownMenuShortcut.displayName = "DropdownMenuShortcut";
