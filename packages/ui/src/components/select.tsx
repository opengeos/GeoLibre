import { ChevronDown } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/utils";

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, multiple, ...props }, ref) => (
  <div className={cn("relative", className)}>
    <select
      ref={ref}
      multiple={multiple}
      className={cn(
        "flex w-full rounded-md border border-input bg-background ps-3 text-sm shadow-xs transition-colors focus-visible:border-2 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50",
        multiple ? "h-auto min-h-24 py-2 pe-3" : "h-9 appearance-none py-1 pe-8",
      )}
      {...props}
    >
      {children}
    </select>
    {!multiple ? (
      <ChevronDown
        className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground opacity-50"
        aria-hidden="true"
      />
    ) : null}
  </div>
));
Select.displayName = "Select";
