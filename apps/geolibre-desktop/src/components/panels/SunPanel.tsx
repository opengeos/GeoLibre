import {
  closeSunPanel,
  getSunSettingsSnapshot,
  isSunPanelVisible,
  localDayStart,
  setSunSettings,
  SUN_SHADE_MAX,
  SUN_SHADE_MIN,
  SUN_SPEED_MAX,
  SUN_SPEED_MIN,
  subscribeSunPanel,
  subscribeSunSettings,
} from "@geolibre/plugins";
import { Button, Slider } from "@geolibre/ui";
import { Clock3, Pause, Play, Repeat, SkipBack, SkipForward, Sun, X } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { clamp } from "../../lib/clamp";

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_DAY = 1440;
const PANEL_WIDTH = 380;
const EDGE_MARGIN = 12;
const QUICK_TIMES = [
  { label: "00:00", minutes: 0 },
  { label: "06:00", minutes: 6 * 60 },
  { label: "12:00", minutes: 12 * 60 },
  { label: "18:00", minutes: 18 * 60 },
];

// DST: known limitation. The slider position and the displayed clock both use
// device-local time and assume a 24h day, so on the two DST-transition days a
// year (23h/25h days) the thumb and the digital clock can disagree by up to an
// hour. Acceptable given how narrow the window is.
function minutesOfLocalDay(dateMs: number): number {
  return clamp(
    Math.round((dateMs - localDayStart(dateMs)) / MS_PER_MINUTE),
    0,
    MINUTES_PER_DAY - 1,
  );
}

function withMinutesOfLocalDay(dateMs: number, minutes: number): number {
  return localDayStart(dateMs) + clamp(minutes, 0, MINUTES_PER_DAY - 1) * MS_PER_MINUTE;
}

/** Format epoch ms as date/time input values in device local time. */
function localDateParts(dateMs: number): { date: string; time: string } {
  const d = new Date(dateMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

function fromLocalDateTimeParts(date: string, time: string): number | null {
  const ms = new Date(`${date}T${time}`).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function formatClock(dateMs: number): string {
  return new Date(dateMs).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Floating time-slider panel driving the sun-position simulation (Controls →
 * Sun). Renders only while the panel is open; subscribes to the sun store so the
 * slider tracks the animation as it plays. All map work lives in the plugin's
 * engine — this component only reads and writes the shared settings.
 */
export function SunPanel() {
  const visible = useSyncExternalStore(subscribeSunPanel, isSunPanelVisible, isSunPanelVisible);
  if (!visible) return null;
  return <SunPanelCard />;
}

function SunPanelCard() {
  const { t } = useTranslation();
  const settings = useSyncExternalStore(
    subscribeSunSettings,
    getSunSettingsSnapshot,
    getSunSettingsSnapshot,
  );
  const [position, setPosition] = useState(() => ({
    x: EDGE_MARGIN,
    y: EDGE_MARGIN,
  }));

  const { dateMs, playing, speed, loop, shadeOpacity } = settings;
  const minutes = minutesOfLocalDay(dateMs);
  const { date, time } = localDateParts(dateMs);

  const dateLabel = new Date(dateMs).toLocaleDateString(undefined, {
    dateStyle: "medium",
  });
  const clockLabel = formatClock(dateMs);

  const handleDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button,input")) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = position;
    const handleMove = (move: PointerEvent) => {
      const card = handle.parentElement;
      const bounds = card?.parentElement?.getBoundingClientRect();
      // Measure the card's real height instead of guessing, so it can't be
      // dragged until only its header stays on-screen.
      const cardHeight = card?.getBoundingClientRect().height ?? 80;
      const maxX = Math.max(
        EDGE_MARGIN,
        (bounds?.width ?? window.innerWidth) - PANEL_WIDTH - EDGE_MARGIN,
      );
      const maxY = Math.max(
        EDGE_MARGIN,
        (bounds?.height ?? window.innerHeight) - cardHeight - EDGE_MARGIN,
      );
      setPosition({
        x: clamp(origin.x + (move.clientX - startX), EDGE_MARGIN, maxX),
        y: clamp(origin.y + (move.clientY - startY), EDGE_MARGIN, maxY),
      });
    };
    const handleUp = () => {
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener("pointermove", handleMove);
      handle.removeEventListener("pointerup", handleUp);
      // Also clean up if the gesture is interrupted (e.g. pointercancel), so
      // the move listener and pointer capture don't leak.
      handle.removeEventListener("pointercancel", handleUp);
    };
    handle.addEventListener("pointermove", handleMove);
    handle.addEventListener("pointerup", handleUp);
    handle.addEventListener("pointercancel", handleUp);
  };

  const stepHour = (deltaHours: number) => {
    setSunSettings({
      dateMs: dateMs + deltaHours * 60 * MS_PER_MINUTE,
      playing: false,
    });
  };

  const setDatePart = (nextDate: string) => {
    const next = fromLocalDateTimeParts(nextDate, time);
    if (next !== null) setSunSettings({ dateMs: next, playing: false });
  };

  const setTimePart = (nextTime: string) => {
    const next = fromLocalDateTimeParts(date, nextTime);
    if (next !== null) setSunSettings({ dateMs: next, playing: false });
  };

  const scrubToMinute = (nextMinute: number, pause = true) => {
    setSunSettings({
      dateMs: withMinutesOfLocalDay(dateMs, nextMinute),
      ...(pause ? { playing: false } : {}),
    });
  };

  return (
    <div
      className="absolute z-30 rounded-lg border border-border bg-background/95 shadow-lg backdrop-blur"
      style={{ left: position.x, top: position.y, width: PANEL_WIDTH }}
      role="dialog"
      aria-label={t("toolbar.sun.title")}
    >
      <div
        className="flex cursor-grab items-center gap-2 rounded-t-lg border-b border-border bg-muted/40 px-3 py-2 active:cursor-grabbing"
        onPointerDown={handleDragStart}
      >
        <Sun className="h-4 w-4 text-amber-500" />
        <span className="text-sm font-medium">{t("toolbar.sun.title")}</span>
        <span className="ms-1 truncate text-xs text-muted-foreground">{dateLabel}</span>
        <Button
          variant="ghost"
          size="icon"
          className="ms-auto h-6 w-6"
          aria-label={t("toolbar.sun.close")}
          onClick={() => closeSunPanel()}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="space-y-3 p-3">
        <div className="flex items-end gap-2">
          <label className="min-w-0 flex-1 space-y-1">
            <span className="block text-xs text-muted-foreground">{t("toolbar.sun.date")}</span>
            <input
              type="date"
              className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
              value={date}
              onChange={(e) => setDatePart(e.target.value)}
            />
          </label>
          <label className="w-[7.5rem] space-y-1">
            <span className="block text-xs text-muted-foreground">{t("toolbar.sun.time")}</span>
            <input
              type="time"
              className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm tabular-nums"
              value={time}
              onChange={(e) => setTimePart(e.target.value)}
            />
          </label>
        </div>

        <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Clock3 className="h-4 w-4 text-muted-foreground" />
              <span className="text-lg font-semibold tabular-nums">{clockLabel}</span>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              onClick={() => setSunSettings({ dateMs: Date.now(), playing: false })}
            >
              {t("toolbar.sun.now")}
            </Button>
          </div>
          <SunTimeline
            value={minutes}
            label={t("toolbar.sun.timeOfDay")}
            onChange={(v) => scrubToMinute(v)}
          />
          <div className="mt-2 grid grid-cols-4 gap-1">
            {QUICK_TIMES.map((item) => (
              <Button
                key={item.label}
                variant="ghost"
                size="sm"
                className="h-7 px-1 text-xs tabular-nums"
                onClick={() => scrubToMinute(item.minutes)}
              >
                {item.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label={t("toolbar.sun.stepBack")}
            onClick={() => stepHour(-1)}
          >
            <SkipBack className="h-4 w-4" />
          </Button>
          <Button
            variant="secondary"
            size="icon"
            className="h-9 w-9"
            aria-label={playing ? t("toolbar.sun.pause") : t("toolbar.sun.play")}
            onClick={() => setSunSettings({ playing: !playing })}
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label={t("toolbar.sun.stepForward")}
            onClick={() => stepHour(1)}
          >
            <SkipForward className="h-4 w-4" />
          </Button>
          <span className="min-w-0 flex-1 px-2 text-xs text-muted-foreground">
            {t("toolbar.sun.localTimeNote")}
          </span>
          <Button
            variant={loop ? "secondary" : "ghost"}
            size="icon"
            className="h-8 w-8"
            aria-pressed={loop}
            aria-label={t("toolbar.sun.loop")}
            title={t("toolbar.sun.loop")}
            onClick={() => setSunSettings({ loop: !loop })}
          >
            <Repeat className="h-4 w-4" />
          </Button>
        </div>

        <SliderRow
          label={t("toolbar.sun.speed")}
          min={SUN_SPEED_MIN}
          max={SUN_SPEED_MAX}
          step={5}
          value={speed}
          format={(v) => `${Math.round(v)} min/s`}
          onChange={(v) => setSunSettings({ speed: v })}
        />
        <SliderRow
          label={t("toolbar.sun.shade")}
          min={SUN_SHADE_MIN}
          max={SUN_SHADE_MAX}
          step={0.05}
          value={shadeOpacity}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => setSunSettings({ shadeOpacity: v })}
        />
      </div>
    </div>
  );
}

interface SunTimelineProps {
  value: number;
  label: string;
  onChange: (value: number) => void;
}

function SunTimeline({ value, label, onChange }: SunTimelineProps) {
  // React's onChange already fires continuously while dragging a range input and
  // on keyboard steps, so a single handler covers both without the redundant
  // double-fire of also binding onInput.
  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    onChange(Number(event.currentTarget.value));
  };

  return (
    <div className="space-y-1.5">
      <input
        aria-label={label}
        type="range"
        min={0}
        max={MINUTES_PER_DAY - 1}
        step={1}
        value={value}
        onChange={handleChange}
        className="h-5 w-full cursor-ew-resize appearance-none bg-transparent accent-amber-500 [&::-moz-range-progress]:h-2 [&::-moz-range-progress]:rounded-full [&::-moz-range-progress]:bg-amber-500 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border [&::-moz-range-thumb]:border-amber-600 [&::-moz-range-thumb]:bg-background [&::-moz-range-thumb]:shadow [&::-moz-range-track]:h-2 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-[linear-gradient(90deg,#111827_0%,#334155_20%,#f59e0b_28%,#f8fafc_50%,#f59e0b_72%,#334155_80%,#111827_100%)] [&::-webkit-slider-runnable-track]:h-2 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-[linear-gradient(90deg,#111827_0%,#334155_20%,#f59e0b_28%,#f8fafc_50%,#f59e0b_72%,#334155_80%,#111827_100%)] [&::-webkit-slider-thumb]:mt-[-4px] [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-amber-600 [&::-webkit-slider-thumb]:bg-background [&::-webkit-slider-thumb]:shadow"
      />
      <div className="grid grid-cols-5 text-[10px] tabular-nums text-muted-foreground">
        <span>00</span>
        <span className="text-center">06</span>
        <span className="text-center">12</span>
        <span className="text-center">18</span>
        <span className="text-end">24</span>
      </div>
    </div>
  );
}

interface SliderRowProps {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}

function SliderRow({ label, min, max, step, value, format, onChange }: SliderRowProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums text-foreground">{format(value)}</span>
      </div>
      <Slider
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([v]: number[]) => onChange(v ?? value)}
      />
    </div>
  );
}
