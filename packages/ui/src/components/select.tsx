import { ChevronDown } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/utils";

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /**
   * A 28px (`h-7`), `text-xs` control for toolbars and dense rows, with a
   * smaller chevron. Use it instead of a raw `<select>`: a native select
   * draws its own disclosure arrow, whose insets and look differ between
   * Chromium and WebKit (the desktop webview on macOS), so it never lines up
   * with the rest of the app's controls.
   */
  compact?: boolean;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, multiple, compact = false, ...props }, ref) => (
    <div className={cn("relative", className)}>
      <select
        ref={ref}
        multiple={multiple}
        className={cn(
          "flex w-full rounded-md border border-input bg-background shadow-xs transition-colors focus-visible:border-2 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50",
          multiple
            ? "h-auto min-h-24 py-2 ps-3 pe-3 text-sm"
            : compact
              ? "h-7 appearance-none py-0 ps-2 pe-7 text-xs"
              : "h-9 appearance-none py-1 ps-3 pe-8 text-sm",
        )}
        {...props}
      >
        {children}
      </select>
      {!multiple ? (
        <ChevronDown
          className={cn(
            "pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground opacity-50",
            compact ? "end-2 h-3.5 w-3.5" : "end-3 h-4 w-4",
          )}
          aria-hidden="true"
        />
      ) : null}
    </div>
  ),
);
Select.displayName = "Select";
