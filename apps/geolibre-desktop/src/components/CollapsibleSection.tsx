import { cn } from "@geolibre/ui";
import { ChevronRight } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

interface CollapsibleSectionProps {
  /** Heading text shown on the toggle row. */
  title: string;
  /** Whether the body starts expanded (default: collapsed). */
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * A picker section whose body collapses behind its heading, to keep a long list
 * from stretching the panel. The heading acts as the toggle and rotates a
 * chevron; the body is unmounted while collapsed. Styled to match the plain
 * section headings it sits alongside.
 */
export function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  return (
    <div className="space-y-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          aria-hidden
          className={cn("h-3.5 w-3.5 transition-transform", open ? "rotate-90" : "rtl:rotate-180")}
        />
        {title}
      </button>
      {/* Wrapper is always present so aria-controls resolves; children mount
          only when expanded. */}
      <div id={contentId}>{open ? children : null}</div>
    </div>
  );
}
