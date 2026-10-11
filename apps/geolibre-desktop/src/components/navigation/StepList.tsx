import { cn } from "@geolibre/ui";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { NavRoute, NavStep } from "../../lib/navigation/route";
import { maneuverIcon } from "./maneuver-icon";

/**
 * A route's maneuvers as a list: icon, instruction, and the distance to the
 * next one. While driving, the next maneuver is highlighted and kept in view.
 *
 * @param props - The route, the highlighted step, and a click handler.
 * @returns The list.
 */
export function StepList({
  route,
  onStepClick,
  formatDistance,
  activeIndex,
}: {
  route: NavRoute;
  onStepClick: (step: NavStep) => void;
  formatDistance: (meters: number) => string;
  activeIndex?: number;
}) {
  const { t } = useTranslation();
  const activeRef = useRef<HTMLLIElement | null>(null);
  // Keep the step being driven in view as the drive moves through the list.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);
  return (
    <ol className="flex flex-col divide-y rounded-md border" aria-label={t("navigation.steps")}>
      {route.steps.map((step, index) => {
        const Icon = maneuverIcon(step.type, step.modifier);
        return (
          <li key={index} ref={activeIndex === index ? activeRef : undefined}>
            <button
              type="button"
              onClick={() => onStepClick(step)}
              className={cn(
                "flex w-full items-start gap-2 px-2 py-1.5 text-start text-xs hover:bg-muted",
                activeIndex === index && "bg-primary/10",
              )}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span className="flex-1">{step.instruction}</span>
              {step.distance > 0 && (
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {formatDistance(step.distance)}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
