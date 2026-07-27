import {
  FEET_PER_METER,
  FLIGHT_MAX_SPEED_MAX,
  FLIGHT_MAX_SPEED_MIN,
  FLIGHT_MIN_AGL_MAX,
  FLIGHT_MIN_AGL_MIN,
  KNOTS_PER_MPS,
  closeFlightSimulatorPanel,
  compassPoint,
  getFlightHudSnapshot,
  getFlightSimulatorSnapshot,
  isFlightSimulatorPanelVisible,
  setFlightSimulatorSettings,
  subscribeFlightHud,
  subscribeFlightSimulatorPanel,
  toggleFlying,
} from "@geolibre/plugins";
import { Button, Select, Slider } from "@geolibre/ui";
import { ChevronDown, ChevronUp, Pause, Plane, Play, TriangleAlert, X } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { clamp } from "../../lib/clamp";

const PANEL_WIDTH = 320;
const EDGE_MARGIN = 12;

/**
 * Flight Simulator control panel and heads-up display (Controls → Flight
 * Simulator).
 *
 * The plugin engine owns every piece of map work — the animation loop, the
 * keyboard, and the camera — so this component only renders its published HUD
 * state and writes settings back. It subscribes to two separate stores because
 * they change at very different rates: the instrument readout refreshes ten
 * times a second while flying, the settings only when the user edits them.
 */
export function FlightSimulatorPanel() {
  const visible = useSyncExternalStore(
    subscribeFlightSimulatorPanel,
    isFlightSimulatorPanelVisible,
    isFlightSimulatorPanelVisible,
  );
  if (!visible) return null;
  return <FlightSimulatorCard />;
}

function FlightSimulatorCard() {
  const { t } = useTranslation();
  const settings = useSyncExternalStore(
    subscribeFlightSimulatorPanel,
    getFlightSimulatorSnapshot,
    getFlightSimulatorSnapshot,
  );
  const hud = useSyncExternalStore(subscribeFlightHud, getFlightHudSnapshot, getFlightHudSnapshot);
  const [collapsed, setCollapsed] = useState(false);
  const [position, setPosition] = useState(() => ({ x: EDGE_MARGIN, y: EDGE_MARGIN }));

  const imperial = settings.units === "imperial";
  const speed = imperial ? hud.airspeedMps * KNOTS_PER_MPS : hud.airspeedMps * 3.6;
  const speedUnit = imperial ? t("toolbar.flightSim.knots") : t("toolbar.flightSim.kph");
  const altitude = imperial ? hud.altitudeMeters * FEET_PER_METER : hud.altitudeMeters;
  const agl = imperial ? hud.aglMeters * FEET_PER_METER : hud.aglMeters;
  const altitudeUnit = imperial ? t("toolbar.flightSim.feet") : t("toolbar.flightSim.meters");

  const handleDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button,input,select")) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = position;
    const handleMove = (move: PointerEvent) => {
      const card = handle.parentElement;
      const bounds = card?.parentElement?.getBoundingClientRect();
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
      handle.removeEventListener("pointercancel", handleUp);
    };
    handle.addEventListener("pointermove", handleMove);
    handle.addEventListener("pointerup", handleUp);
    handle.addEventListener("pointercancel", handleUp);
  };

  return (
    <div
      className="absolute z-30 rounded-lg border border-border bg-background/95 shadow-lg backdrop-blur"
      style={{ left: position.x, top: position.y, width: PANEL_WIDTH }}
      role="dialog"
      aria-label={t("toolbar.flightSim.title")}
    >
      <div
        className="flex cursor-grab items-center gap-2 rounded-t-lg border-b border-border bg-muted/40 px-3 py-2 active:cursor-grabbing"
        onPointerDown={handleDragStart}
      >
        <Plane className="h-4 w-4 text-sky-500" />
        <span className="text-sm font-medium">{t("toolbar.flightSim.title")}</span>
        <Button
          variant={hud.flying ? "default" : "outline"}
          size="icon"
          className="ms-auto h-6 w-6"
          aria-label={hud.flying ? t("toolbar.flightSim.stop") : t("toolbar.flightSim.start")}
          title={hud.flying ? t("toolbar.flightSim.stop") : t("toolbar.flightSim.start")}
          onClick={() => toggleFlying()}
        >
          {hud.flying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("toolbar.flightSim.expand") : t("toolbar.flightSim.collapse")}
          title={collapsed ? t("toolbar.flightSim.expand") : t("toolbar.flightSim.collapse")}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronUp className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label={t("toolbar.flightSim.close")}
          onClick={() => closeFlightSimulatorPanel()}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {!collapsed && (
        <div className="space-y-3 p-3">
          {/* Instruments. Values are held at their last reading when stopped so
              the layout does not jump between flights. */}
          <div className="grid grid-cols-3 gap-2">
            <Instrument
              label={t("toolbar.flightSim.speed")}
              value={Math.round(speed).toString()}
              unit={speedUnit}
            />
            <Instrument
              label={t("toolbar.flightSim.altitude")}
              value={Math.round(altitude).toLocaleString()}
              unit={altitudeUnit}
            />
            <Instrument
              label={t("toolbar.flightSim.heading")}
              value={`${Math.round(hud.headingDeg)}°`}
              unit={compassPoint(hud.headingDeg)}
            />
          </div>

          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{t("toolbar.flightSim.agl")}</span>
            <span className="tabular-nums text-foreground">
              {Math.round(agl).toLocaleString()} {altitudeUnit}
            </span>
          </div>

          {/* Artificial horizon: the bar tilts with the bank angle and rises or
              falls with the nose attitude, so attitude is readable at a glance
              without watching the terrain. */}
          <div className="relative h-16 overflow-hidden rounded border border-border bg-gradient-to-b from-sky-400/30 to-emerald-700/30">
            <div
              className="absolute inset-x-[-25%] top-1/2 h-0.5 bg-foreground/70"
              style={{
                transform: `translateY(${clamp(hud.pitchDeg, -45, 45) * 0.6}px) rotate(${-hud.rollDeg}deg)`,
              }}
            />
            <div className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-400 ring-1 ring-background" />
          </div>

          {hud.grounded && hud.flying && (
            <div className="flex items-center gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-600 dark:text-amber-400">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
              {t("toolbar.flightSim.terrainWarning")}
            </div>
          )}

          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{t("toolbar.flightSim.throttle")}</span>
            <span className="tabular-nums text-foreground">{Math.round(hud.throttle * 100)}%</span>
          </div>

          <p className="rounded bg-muted/50 px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
            {t("toolbar.flightSim.help")}
          </p>

          <SliderRow
            label={t("toolbar.flightSim.maxSpeed")}
            min={FLIGHT_MAX_SPEED_MIN}
            max={FLIGHT_MAX_SPEED_MAX}
            step={5}
            value={settings.maxSpeedMps}
            format={(value) =>
              imperial
                ? `${Math.round(value * KNOTS_PER_MPS)} ${speedUnit}`
                : `${Math.round(value * 3.6)} ${speedUnit}`
            }
            onChange={(value) => setFlightSimulatorSettings({ maxSpeedMps: value })}
          />

          <SliderRow
            label={t("toolbar.flightSim.minAgl")}
            min={FLIGHT_MIN_AGL_MIN}
            max={FLIGHT_MIN_AGL_MAX}
            step={5}
            value={settings.minAltitudeAglMeters}
            format={(value) =>
              imperial
                ? `${Math.round(value * FEET_PER_METER)} ${altitudeUnit}`
                : `${Math.round(value)} ${altitudeUnit}`
            }
            onChange={(value) => setFlightSimulatorSettings({ minAltitudeAglMeters: value })}
          />

          <label className="flex items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">{t("toolbar.flightSim.units")}</span>
            <Select
              className="h-7 w-28"
              value={settings.units}
              onChange={(event) =>
                setFlightSimulatorSettings({
                  units: event.target.value === "metric" ? "metric" : "imperial",
                })
              }
            >
              <option value="imperial">{t("toolbar.flightSim.imperial")}</option>
              <option value="metric">{t("toolbar.flightSim.metric")}</option>
            </Select>
          </label>

          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-sky-500"
              checked={settings.bankCamera}
              onChange={(event) => setFlightSimulatorSettings({ bankCamera: event.target.checked })}
            />
            <span className="text-muted-foreground">{t("toolbar.flightSim.bankCamera")}</span>
          </label>

          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-sky-500"
              checked={settings.invertPitch}
              onChange={(event) =>
                setFlightSimulatorSettings({ invertPitch: event.target.checked })
              }
            />
            <span className="text-muted-foreground">{t("toolbar.flightSim.invertPitch")}</span>
          </label>
        </div>
      )}
    </div>
  );
}

interface InstrumentProps {
  label: string;
  value: string;
  unit: string;
}

/** One boxed instrument readout: a big number with its label and unit. */
function Instrument({ label, value, unit }: InstrumentProps) {
  return (
    <div className="rounded border border-border bg-muted/30 px-2 py-1.5">
      <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="truncate text-base font-semibold tabular-nums leading-tight">{value}</div>
      <div className="truncate text-[10px] text-muted-foreground">{unit}</div>
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
        onValueChange={([next]: number[]) => onChange(next ?? value)}
      />
    </div>
  );
}
