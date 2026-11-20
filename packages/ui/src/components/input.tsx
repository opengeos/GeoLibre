import * as React from "react";
import { cn } from "../lib/utils";

/**
 * Release focus from a number input the mouse wheel is turning.
 *
 * Chromium (and so the desktop's WebView2) steps a focused
 * `<input type="number">` by one `step` per wheel notch. In a scrolling panel
 * that silently edits the field under the pointer instead of scrolling: after
 * typing a fill opacity, scrolling down the Style panel lowers it notch by
 * notch. Blurring before the browser's default action stops the step and lets
 * the wheel scroll the panel as the user meant. Unfocused inputs are left
 * alone, since the browser only steps the focused one.
 *
 * @param target The input the wheel event was dispatched to.
 * @param activeElement The document's focused element.
 * @returns Whether the input was blurred.
 */
export function releaseNumberInputOnWheel(
  target: Pick<HTMLInputElement, "type" | "blur">,
  activeElement: unknown,
): boolean {
  if (target.type !== "number" || activeElement !== target) return false;
  target.blur();
  return true;
}

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type, onWheel, ...props }, ref) => (
  <input
    type={type}
    className={cn(
      "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:border-2 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    ref={ref}
    onWheel={(event) => {
      onWheel?.(event);
      releaseNumberInputOnWheel(
        event.currentTarget,
        event.currentTarget.ownerDocument.activeElement,
      );
    }}
    {...props}
  />
));
Input.displayName = "Input";
