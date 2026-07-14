import { ChevronDown } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/utils";

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <div className={cn("relative", className)}>
    <select
      ref={ref}
      className="flex h-9 w-full appearance-none rounded-md border border-input bg-background py-1 ps-3 pe-8 text-sm shadow-xs transition-colors focus-visible:border-2 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50"
      {...props}
    >
      {children}
    </select>
    <ChevronDown
      className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground opacity-50"
      aria-hidden="true"
    />
  </div>
));
Select.displayName = "Select";
