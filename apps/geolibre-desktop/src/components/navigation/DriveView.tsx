import { Button, Select, cn } from "@geolibre/ui";
import {
  Flag,
  ListOrdered,
  Loader2,
  Maximize,
  Navigation2,
  Play,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { NavProgress } from "../../lib/navigation/engine";
import { formatArrivalTime } from "../../lib/navigation/format";
import type { NavBanner, NavRoute, NavStep } from "../../lib/navigation/route";
import {
  activeBanner,
  SIM_SPEEDS,
  THEN_DISTANCE_M,
  upcomingStops,
  type NavPhase,
  type NavSettings,
} from "../../lib/navigation/session";
import { speechSupported, stopSpeaking } from "../../lib/navigation/voice";
import { NAV_DESTINATION_COLOR, NAV_STOP_COLOR } from "../../lib/navigation/overlay";
import { maneuverIcon, modifierIcon } from "./maneuver-icon";
import { StepList } from "./StepList";

function LaneRow({ banner }: { banner: NavBanner }) {
  const { t } = useTranslation();
  if (!banner.lanes) return null;
  return (
    <div
      className="flex justify-center gap-1 border-t border-white/20 px-3 py-1.5"
      aria-label={t("navigation.lanes")}
      role="img"
      // Lanes are drawn left to right as on the road, whatever the UI direction.
      dir="ltr"
    >
      {banner.lanes.map((lane, index) => {
        const indication = lane.active
          ? (lane.activeIndication ?? lane.indications[0])
          : lane.indications[0];
        const Icon = modifierIcon(indication === "none" ? "straight" : indication);
        return (
          <span
            key={index}
            className={cn(
              "flex h-8 w-7 items-center justify-center rounded",
              lane.active ? "bg-white text-blue-800" : "text-white/45",
            )}
          >
            <Icon className="h-5 w-5" />
          </span>
        );
      })}
    </div>
  );
}

/**
 * The driving view: the maneuver banner with lane guidance at the top, the
 * trip status bar at the bottom, and the arrival card at the end.
 *
 * @param props - The drive's state and controls.
 * @returns The view.
 */
export function DriveView({
  route,
  phase,
  progress,
  currentStep,
  offRoute,
  rerouting,
  gpsLost,
  follow,
  simulating,
  driveError,
  settings,
  onSettings,
  onRecenter,
  onOverview,
  onEnd,
  formatDistance,
  formatDuration,
  language,
  narrow,
  onFocus,
}: {
  route: NavRoute;
  phase: NavPhase;
  progress: NavProgress | null;
  currentStep: NavStep | undefined;
  offRoute: boolean;
  rerouting: boolean;
  gpsLost: boolean;
  follow: boolean;
  simulating: boolean;
  driveError: string | null;
  settings: NavSettings;
  onSettings: (patch: Partial<NavSettings>) => void;
  onRecenter: () => void;
  onOverview: () => void;
  onEnd: () => void;
  formatDistance: (meters: number) => string;
  formatDuration: (seconds: number) => string;
  language: string;
  /** The map is phone-sized: overlays span its width and buttons drop labels. */
  narrow: boolean;
  /** Look at a point (a step, a stop) without ending the drive. */
  onFocus: (point: [number, number]) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [listOpen, setListOpen] = useState(false);
  const stepIndex = progress?.stepIndex ?? 0;
  const step = currentStep ?? route.steps[0];
  const next = route.steps[stepIndex + 1];
  const distanceToManeuver = progress?.distanceToManeuver ?? step.distance;
  const banner = activeBanner(step, distanceToManeuver);
  const BannerIcon = maneuverIcon(banner?.type ?? next?.type, banner?.modifier ?? next?.modifier);
  const bannerText = banner?.text ?? next?.instruction ?? step.instruction;
  const after = route.steps[stepIndex + 2];
  const showThen = next && after && next.distance > 0 && next.distance <= THEN_DISTANCE_M;
  const ThenIcon = after ? maneuverIcon(after.type, after.modifier) : null;
  const remaining = progress?.durationRemaining ?? route.duration;
  const voiceAvailable = speechSupported();
  const stops = useMemo(() => upcomingStops(route, progress?.along ?? 0), [route, progress]);
  // On a phone the sheet would cover the point it just flew to.
  const focusFromList = (point: [number, number]) => {
    if (narrow) setListOpen(false);
    onFocus(point);
  };

  // The map controls sit in a column at the map's top-right corner in every
  // language (the map chrome is pinned left-to-right), so on a narrow map the
  // banner stops short of them; these offsets are physical on purpose.
  const topBox = narrow ? "left-2 right-14" : "inset-x-0 mx-auto w-[min(26rem,calc(100%-1.5rem))]";
  const bottomBox = narrow ? "inset-x-2" : "inset-x-0 mx-auto w-[min(26rem,calc(100%-1.5rem))]";

  if (phase === "arrived") {
    return (
      <section
        aria-label={t("navigation.title")}
        className={cn(
          "pointer-events-auto absolute bottom-12 z-20 flex items-center gap-3 rounded-lg border bg-background p-3 shadow-xl",
          bottomBox,
        )}
        data-testid="navigation-arrived"
      >
        <Flag className="h-6 w-6 shrink-0 text-primary" />
        <p className="flex-1 font-semibold" aria-live="assertive">
          {t("navigation.arrived")}
        </p>
        <Button size="sm" onClick={onEnd}>
          {t("navigation.done")}
        </Button>
      </section>
    );
  }

  return (
    <>
      <div
        className={cn(
          "pointer-events-none absolute top-3 z-20 flex flex-col items-center gap-2",
          topBox,
        )}
      >
        <section
          aria-label={t("navigation.nextManeuver")}
          className="pointer-events-auto w-full overflow-hidden rounded-lg bg-blue-800 text-white shadow-xl"
          data-testid="navigation-banner"
        >
          {offRoute ? (
            <div className="flex items-center gap-3 px-3 py-3" aria-live="polite">
              {rerouting && <Loader2 className="h-6 w-6 shrink-0 animate-spin" />}
              <p className="text-lg font-semibold">
                {rerouting ? t("navigation.rerouting") : t("navigation.offRoute")}
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 px-3 py-2.5">
                <BannerIcon
                  className={cn("shrink-0", narrow ? "h-8 w-8" : "h-10 w-10")}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "font-bold tabular-nums leading-tight",
                      narrow ? "text-xl" : "text-2xl",
                    )}
                  >
                    {formatDistance(distanceToManeuver)}
                  </p>
                  <p className="truncate text-base font-medium leading-snug" title={bannerText}>
                    {bannerText}
                  </p>
                  {banner?.secondary && (
                    <p className="truncate text-xs text-white/80">{banner.secondary}</p>
                  )}
                </div>
              </div>
              {banner && <LaneRow banner={banner} />}
              {showThen && ThenIcon && (
                <div className="flex items-center gap-2 bg-blue-950/60 px-3 py-1 text-xs">
                  {t("navigation.then")}
                  <ThenIcon className="h-4 w-4" aria-hidden />
                </div>
              )}
            </>
          )}
        </section>

        {(gpsLost || driveError || simulating) && (
          <div className="pointer-events-auto flex max-w-full items-center gap-2 rounded-full border bg-background px-3 py-1 text-xs shadow">
            {driveError ? (
              <span className="text-destructive">{driveError}</span>
            ) : gpsLost ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("navigation.searchingGps")}
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5" />
                {t("navigation.simulated")}
                <Select
                  aria-label={t("navigation.simSpeed")}
                  className="h-6 w-16 py-0 text-xs"
                  value={String(settings.simSpeed)}
                  onChange={(event) => onSettings({ simSpeed: Number(event.target.value) })}
                >
                  {SIM_SPEEDS.map((speed) => (
                    <option key={speed} value={speed}>
                      {`×${speed}`}
                    </option>
                  ))}
                </Select>
              </>
            )}
          </div>
        )}
      </div>

      <div className={cn("absolute bottom-12 z-20 flex flex-col gap-2", bottomBox)}>
        {listOpen && (
          <section
            aria-label={t("navigation.stepsAndStops")}
            className="pointer-events-auto flex max-h-[min(24rem,45vh)] flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
            data-testid="navigation-trip-list"
          >
            <header className="flex items-center gap-2 border-b px-3 py-1.5">
              <h2 className="flex-1 text-sm font-semibold">{t("navigation.stepsAndStops")}</h2>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                aria-label={t("navigation.closeList")}
                onClick={() => setListOpen(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </header>
            <div className="flex flex-col gap-2 overflow-y-auto p-2 text-sm">
              <ol className="flex flex-col gap-1" aria-label={t("navigation.stops")}>
                {stops.map((stop, index) => {
                  const at = route.steps.find(
                    (s) => s.type === "arrive" && s.legIndex === stop.legIndex,
                  )?.location;
                  const label = stop.destination
                    ? t("navigation.destination")
                    : t("navigation.stopNumber", { number: stop.legIndex + 1 });
                  return (
                    <li key={stop.legIndex}>
                      <button
                        type="button"
                        disabled={!at}
                        onClick={() => at && focusFromList(at)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-start hover:bg-muted",
                          index === 0 && "border-primary",
                        )}
                        data-testid={`navigation-stop-${stop.legIndex}`}
                      >
                        <span
                          aria-hidden
                          className="inline-block h-3 w-3 shrink-0 rounded-full border-2 border-white shadow"
                          style={{
                            background: stop.destination ? NAV_DESTINATION_COLOR : NAV_STOP_COLOR,
                          }}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-xs font-medium">{label}</span>
                          {stop.name && (
                            <span className="block truncate text-xs text-muted-foreground">
                              {stop.name}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-end text-xs tabular-nums text-muted-foreground">
                          {t("navigation.remaining", {
                            duration: formatDuration(stop.duration),
                            distance: formatDistance(stop.distance),
                          })}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
              <StepList
                route={route}
                // The maneuver the banner shows: the end of the stretch being driven.
                activeIndex={Math.min(stepIndex + 1, route.steps.length - 1)}
                onStepClick={(s) => focusFromList(s.location)}
                formatDistance={formatDistance}
              />
            </div>
          </section>
        )}

        <section
          aria-label={t("navigation.tripStatus")}
          className="pointer-events-auto flex items-center gap-1 rounded-lg border bg-background p-2 shadow-xl"
          data-testid="navigation-status"
        >
          <div className="min-w-0 flex-1 ps-1">
            <p className="text-lg font-semibold tabular-nums text-green-700 dark:text-green-400">
              {formatArrivalTime(remaining, language)}
            </p>
            <p className="truncate text-xs text-muted-foreground tabular-nums">
              {t("navigation.remaining", {
                duration: formatDuration(remaining),
                distance: formatDistance(progress?.distanceRemaining ?? route.distance),
              })}
            </p>
          </div>
          {voiceAvailable && (
            <Button
              size="icon"
              variant="ghost"
              className="h-9 w-9"
              aria-pressed={!settings.voice}
              aria-label={settings.voice ? t("navigation.mute") : t("navigation.unmute")}
              title={settings.voice ? t("navigation.mute") : t("navigation.unmute")}
              onClick={() => {
                if (settings.voice) stopSpeaking();
                onSettings({ voice: !settings.voice });
              }}
            >
              {settings.voice ? <Volume2 className="h-5 w-5" /> : <VolumeX className="h-5 w-5" />}
            </Button>
          )}
          <Button
            size="icon"
            variant={listOpen ? "secondary" : "ghost"}
            className="h-9 w-9"
            aria-expanded={listOpen}
            aria-label={t("navigation.stepsAndStops")}
            title={t("navigation.stepsAndStops")}
            onClick={() => setListOpen((open) => !open)}
            data-testid="navigation-list-toggle"
          >
            <ListOrdered className="h-5 w-5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-9 w-9"
            aria-label={t("navigation.overview")}
            title={t("navigation.overview")}
            onClick={onOverview}
          >
            <Maximize className="h-5 w-5" />
          </Button>
          {!follow && (
            <Button
              size={narrow ? "icon" : "sm"}
              variant="outline"
              className={narrow ? "h-9 w-9" : undefined}
              aria-label={t("navigation.recenter")}
              title={t("navigation.recenter")}
              onClick={onRecenter}
              data-testid="navigation-recenter"
            >
              <Navigation2 className={narrow ? "h-5 w-5" : "me-1 h-3.5 w-3.5"} />
              {!narrow && t("navigation.recenter")}
            </Button>
          )}
          <Button size="sm" variant="destructive" onClick={onEnd} data-testid="navigation-end">
            {t("navigation.end")}
          </Button>
        </section>
      </div>
    </>
  );
}
