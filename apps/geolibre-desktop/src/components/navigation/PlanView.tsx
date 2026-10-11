import type { GeocoderConfig } from "@geolibre/core";
import { Button, cn } from "@geolibre/ui";
import {
  ArrowUpDown,
  Bike,
  Car,
  ChevronDown,
  ChevronUp,
  Footprints,
  Layers,
  Loader2,
  LocateFixed,
  Navigation2,
  Play,
  Plus,
  Signpost,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { nativeGeolocationAvailable } from "../../lib/geolocation";
import {
  NAV_DESTINATION_COLOR,
  NAV_ORIGIN_COLOR,
  NAV_STOP_COLOR,
} from "../../lib/navigation/overlay";
import type { NavMode, NavRoute, NavStep } from "../../lib/navigation/route";
import type { NavPoint, NavRouteStatus, NavSettings } from "../../lib/navigation/session";
import { maneuverIcon } from "./maneuver-icon";
import { StepList } from "./StepList";
import { WaypointField } from "./WaypointField";

const MODES: { mode: NavMode; icon: typeof Car; labelKey: string }[] = [
  { mode: "auto", icon: Car, labelKey: "navigation.mode.auto" },
  { mode: "bicycle", icon: Bike, labelKey: "navigation.mode.bicycle" },
  { mode: "pedestrian", icon: Footprints, labelKey: "navigation.mode.pedestrian" },
];

/**
 * The planning card: travel mode, waypoints, avoid options, the candidate
 * routes, the step list, and the buttons that start a drive or a simulation.
 *
 * @param props - The planner's state and callbacks.
 * @returns The card.
 */
export function PlanView({
  waypoints,
  pickIndex,
  onPick,
  routes,
  selected,
  onSelect,
  status,
  locating,
  locateError,
  settings,
  onSettings,
  onUseMyLocation,
  onSwap,
  onAddStop,
  onRemoveStop,
  onStart,
  onSimulate,
  onSave,
  saved,
  showSteps,
  onToggleSteps,
  onStepClick,
  onClose,
  formatDistance,
  formatDuration,
  narrow,
  minimized,
  onMinimizedChange,
  geocoder,
  onWaypointChange,
}: {
  waypoints: (NavPoint | null)[];
  pickIndex: number | null;
  onPick: (index: number | null) => void;
  routes: NavRoute[];
  selected: number;
  onSelect: (index: number) => void;
  status: NavRouteStatus;
  locating: boolean;
  locateError: string | null;
  settings: NavSettings;
  onSettings: (patch: Partial<NavSettings>) => void;
  onUseMyLocation: () => void;
  onSwap: () => void;
  onAddStop: () => void;
  onRemoveStop: (index: number) => void;
  onStart: () => void;
  onSimulate: () => void;
  onSave: () => void;
  saved: boolean;
  showSteps: boolean;
  onToggleSteps: () => void;
  onStepClick: (step: NavStep) => void;
  onClose: () => void;
  formatDistance: (meters: number) => string;
  formatDuration: (seconds: number) => string;
  /** The map is phone-sized: the card spans its width and folds while picking. */
  narrow: boolean;
  minimized: boolean;
  onMinimizedChange: (minimized: boolean) => void;
  /** The geocoder chosen in Settings → Geocoding, for typed addresses. */
  geocoder: GeocoderConfig;
  /** A point placed by a typed address or coordinates. */
  onWaypointChange: (index: number, point: NavPoint) => void;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const route = routes[selected] ?? null;
  const last = waypoints.length - 1;
  const geolocationAvailable =
    nativeGeolocationAvailable() ||
    (typeof navigator !== "undefined" && "geolocation" in navigator);
  const coordinate = useMemo(
    () => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 5 }),
    [i18n.language],
  );
  // A typed address keeps its name; a map pick shows the road the router
  // matched it to once a route is in, and its coordinates until then.
  const labelFor = (index: number): string => {
    const point = waypoints[index];
    if (!point) return "";
    if (point.label) return point.label;
    if (point.mine) return t("navigation.myLocation");
    const matched = routes[0]?.waypointNames[index];
    if (matched) return matched;
    return `${coordinate.format(point.lat)}, ${coordinate.format(point.lng)}`;
  };
  const placeholderFor = (index: number): string =>
    index === 0
      ? t("navigation.choose.origin")
      : index === last
        ? t("navigation.choose.destination")
        : t("navigation.choose.stop");

  let hint: string;
  if (locating) hint = t("navigation.locating");
  else if (locateError) hint = locateError;
  else if (pickIndex !== null) {
    hint =
      pickIndex === 0
        ? t("navigation.pickOrigin")
        : pickIndex === last
          ? t("navigation.pickDestination")
          : t("navigation.pickStop");
  } else if (status === "loading") hint = t("navigation.routing");
  else if (status === "noRoute") hint = t("navigation.noRoute");
  else if (status === "error") hint = t("navigation.routeError");
  else if (routes.length > 1) hint = t("navigation.pickRoute");
  else hint = route ? t("navigation.ready") : t("navigation.pickOrigin");

  // On a phone the card would cover most of the map, so it folds to one line
  // while a point is being placed and unfolds when the route is ready.
  const picking = pickIndex !== null;
  const collapsed = minimized || (narrow && picking);
  const toggleCollapsed = () => {
    if (collapsed) {
      onMinimizedChange(false);
      if (narrow && picking) onPick(null);
    } else onMinimizedChange(true);
  };
  const routeSummary = route
    ? `${formatDuration(route.duration)} · ${formatDistance(route.distance)}`
    : null;

  return (
    <section
      aria-label={t("navigation.title")}
      className={cn(
        "pointer-events-auto absolute bottom-12 z-20 flex flex-col overflow-hidden rounded-lg border bg-background shadow-xl",
        narrow
          ? "inset-x-2 max-h-[60%]"
          : "start-2 max-h-[calc(100%-7.5rem)] w-[min(23rem,calc(100vw-1.5rem))]",
      )}
      data-testid="navigation-panel"
      data-collapsed={collapsed}
    >
      <header className={cn("flex items-center gap-2 px-3 py-2", !collapsed && "border-b")}>
        <Signpost className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h2 className="flex-1 text-sm font-semibold">{t("navigation.title")}</h2>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("navigation.expand") : t("navigation.minimize")}
          title={collapsed ? t("navigation.expand") : t("navigation.minimize")}
          onClick={toggleCollapsed}
          data-testid="navigation-panel-toggle"
        >
          {collapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          aria-label={t("navigation.close")}
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </header>
      {collapsed ? (
        <div className="flex flex-col gap-2 px-3 pb-2 text-sm">
          <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
            {(locating || (status === "loading" && !picking)) && (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            )}
            {routeSummary && !picking ? routeSummary : hint}
          </p>
          {pickIndex !== null && (
            <div className="flex items-start gap-1">
              <WaypointField
                label={labelFor(pickIndex)}
                placeholder={placeholderFor(pickIndex)}
                roleLabel={t(
                  `navigation.role.${pickIndex === 0 ? "origin" : pickIndex === last ? "destination" : "stop"}` as "navigation.role.origin",
                )}
                picking
                geocoder={geocoder}
                onPickToggle={() => onPick(null)}
                onChange={(next) => onWaypointChange(pickIndex, next)}
                testId="navigation-compact-field"
              />
              {pickIndex === 0 && geolocationAvailable && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 shrink-0"
                  aria-label={t("navigation.useMyLocation")}
                  title={t("navigation.useMyLocation")}
                  disabled={locating}
                  onClick={onUseMyLocation}
                >
                  {locating ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <LocateFixed className="h-4 w-4" />
                  )}
                </Button>
              )}
            </div>
          )}
          {route && !picking && (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={onStart} disabled={!geolocationAvailable}>
                <Navigation2 className="me-1 h-3.5 w-3.5" />
                {t("navigation.start")}
              </Button>
              <Button size="sm" variant="outline" onClick={onSimulate}>
                <Play className="me-1 h-3.5 w-3.5" />
                {t("navigation.simulate")}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-3 text-sm">
          <div
            role="group"
            aria-label={t("navigation.modeLabel")}
            className="grid grid-cols-3 gap-1"
          >
            {MODES.map(({ mode, icon: Icon, labelKey }) => (
              <Button
                key={mode}
                size="sm"
                variant={settings.mode === mode ? "default" : "outline"}
                aria-pressed={settings.mode === mode}
                onClick={() => onSettings({ mode })}
                className="gap-1"
              >
                <Icon className="h-3.5 w-3.5" />
                {t(labelKey as "navigation.mode.auto")}
              </Button>
            ))}
          </div>

          <ol className="flex flex-col gap-1" aria-label={t("navigation.waypoints")}>
            {waypoints.map((point, index) => {
              const role = index === 0 ? "origin" : index === last ? "destination" : "stop";
              const color =
                role === "origin"
                  ? NAV_ORIGIN_COLOR
                  : role === "destination"
                    ? NAV_DESTINATION_COLOR
                    : NAV_STOP_COLOR;
              const roleLabel = t(`navigation.role.${role}` as "navigation.role.origin");
              return (
                <li key={index} className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="inline-block h-3 w-3 shrink-0 rounded-full border-2 border-white shadow"
                    style={{ background: color }}
                  />
                  <WaypointField
                    label={labelFor(index)}
                    placeholder={placeholderFor(index)}
                    roleLabel={roleLabel}
                    picking={pickIndex === index}
                    geocoder={geocoder}
                    onPickToggle={() => onPick(pickIndex === index ? null : index)}
                    onChange={(next) => onWaypointChange(index, next)}
                    testId={`navigation-waypoint-${index}`}
                  />
                  {index === 0 && geolocationAvailable && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label={t("navigation.useMyLocation")}
                      title={t("navigation.useMyLocation")}
                      disabled={locating}
                      onClick={onUseMyLocation}
                    >
                      {locating ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <LocateFixed className="h-4 w-4" />
                      )}
                    </Button>
                  )}
                  {role === "stop" && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label={t("navigation.removeStop")}
                      title={t("navigation.removeStop")}
                      onClick={() => onRemoveStop(index)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                  {index === last && waypoints.length === 2 && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label={t("navigation.swap")}
                      title={t("navigation.swap")}
                      onClick={onSwap}
                    >
                      <ArrowUpDown className="h-4 w-4" />
                    </Button>
                  )}
                </li>
              );
            })}
          </ol>
          <div className="flex items-center justify-between gap-2">
            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onAddStop}>
              <Plus className="me-1 h-3.5 w-3.5" />
              {t("navigation.addStop")}
            </Button>
          </div>

          {settings.mode === "auto" && (
            <fieldset className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
              <legend className="mb-1 text-muted-foreground">{t("navigation.avoid")}</legend>
              {(["tolls", "highways", "ferries"] as const).map((key) => (
                <label key={key} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={settings.avoid[key]}
                    onChange={(event) =>
                      onSettings({ avoid: { ...settings.avoid, [key]: event.target.checked } })
                    }
                  />
                  {t(`navigation.avoidOption.${key}` as "navigation.avoidOption.tolls")}
                </label>
              ))}
            </fieldset>
          )}

          <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
            {status === "loading" && pickIndex === null && (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            )}
            {hint}
          </p>

          {routes.length > 0 && (
            <ul className="flex flex-col gap-1" aria-label={t("navigation.routes")}>
              {routes.map((candidate, index) => (
                <li key={index}>
                  <button
                    type="button"
                    aria-pressed={index === selected}
                    onClick={() => onSelect(index)}
                    className={cn(
                      "flex w-full flex-col rounded-md border px-2 py-1.5 text-start",
                      index === selected ? "border-primary bg-primary/10" : "hover:bg-muted",
                    )}
                    data-testid={`navigation-route-${index}`}
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="font-semibold tabular-nums">
                        {formatDuration(candidate.duration)}
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {formatDistance(candidate.distance)}
                      </span>
                      {index === 0 && routes.length > 1 && (
                        <span className="ms-auto rounded bg-primary/15 px-1.5 text-[10px] font-medium text-primary">
                          {t("navigation.best")}
                        </span>
                      )}
                    </span>
                    {candidate.summary && (
                      <span className="truncate text-xs text-muted-foreground">
                        {t("navigation.via", { roads: candidate.summary })}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {route && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  onClick={onStart}
                  disabled={!geolocationAvailable}
                  title={geolocationAvailable ? t("navigation.startHint") : t("navigation.noGps")}
                  data-testid="navigation-start"
                >
                  <Navigation2 className="me-1 h-3.5 w-3.5" />
                  {t("navigation.start")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onSimulate}
                  title={t("navigation.simulateHint")}
                  data-testid="navigation-simulate"
                >
                  <Play className="me-1 h-3.5 w-3.5" />
                  {t("navigation.simulate")}
                </Button>
                <Button size="sm" variant="ghost" onClick={onSave} disabled={saved}>
                  <Layers className="me-1 h-3.5 w-3.5" />
                  {saved ? t("navigation.saved") : t("navigation.saveLayer")}
                </Button>
              </div>
              <button
                type="button"
                className="self-start text-xs text-primary underline-offset-2 hover:underline"
                aria-expanded={showSteps}
                onClick={onToggleSteps}
              >
                {showSteps
                  ? t("navigation.hideSteps")
                  : t("navigation.showSteps", { count: route.steps.length })}
              </button>
              {showSteps && (
                <StepList route={route} onStepClick={onStepClick} formatDistance={formatDistance} />
              )}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">{t("navigation.attribution")}</p>
        </div>
      )}
    </section>
  );
}
