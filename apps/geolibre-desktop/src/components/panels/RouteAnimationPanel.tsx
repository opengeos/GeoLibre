import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  ROUTE_ANIM_SPEED_MAX,
  ROUTE_ANIM_SPEED_MIN,
  ROUTE_MARKER_STYLES,
  type RouteMarkerStyle,
  closeRouteAnimationPanel,
  flattenToLine,
  getRouteAnimationSnapshot,
  isRouteAnimationPanelVisible,
  setRouteAnimationProgress,
  setRouteAnimationRoute,
  setRouteAnimationSettings,
  subscribeRouteAnimation,
  subscribeRouteAnimationPanel,
  toggleRouteAnimationPlaying,
} from "@geolibre/plugins";
import { Button, Select, Slider } from "@geolibre/ui";
import {
  ChevronDown,
  ChevronUp,
  Navigation,
  Pause,
  Play,
  Repeat,
  Spline,
  Video,
  X,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { clamp } from "../../lib/clamp";
import { resolveLayerGeojson } from "../../lib/vector-export";

const PANEL_WIDTH = 340;
const EDGE_MARGIN = 12;

interface LineLayerOption {
  id: string;
  name: string;
}

interface RouteAnimationPanelProps {
  mapControllerRef: RefObject<MapController | null>;
}

/**
 * Floating panel driving the route animation (Controls → Route Animation).
 * Renders only while open. Unlike the sun panel, it needs the map to read a line
 * layer's geometry, so it takes `mapControllerRef`; it resolves the selected
 * layer to coordinates and hands them to the plugin engine, which owns all map
 * work (marker, trail, camera).
 */
export function RouteAnimationPanel({
  mapControllerRef,
}: RouteAnimationPanelProps) {
  const visible = useSyncExternalStore(
    subscribeRouteAnimationPanel,
    isRouteAnimationPanelVisible,
    isRouteAnimationPanelVisible,
  );
  if (!visible) return null;
  return <RouteAnimationCard mapControllerRef={mapControllerRef} />;
}

function RouteAnimationCard({ mapControllerRef }: RouteAnimationPanelProps) {
  const { t } = useTranslation();
  const settings = useSyncExternalStore(
    subscribeRouteAnimation,
    getRouteAnimationSnapshot,
    getRouteAnimationSnapshot,
  );
  const layers = useAppStore((s) => s.layers);
  const [lineLayers, setLineLayers] = useState<LineLayerOption[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [position, setPosition] = useState(() => ({
    x: EDGE_MARGIN,
    y: EDGE_MARGIN,
  }));

  const {
    layerId,
    playing,
    speedMps,
    loop,
    progress,
    followCamera,
    markerStyle,
    showTrail,
  } = settings;

  // Discover which geojson layers contain line geometry. Resolution is async for
  // Add Vector Layer geojson-mode layers (features live in a map source), so this
  // runs in an effect and guards against overlapping runs.
  useEffect(() => {
    let cancelled = false;
    const map = mapControllerRef.current?.getMap() ?? undefined;
    const candidates = layers.filter((layer) => layer.type === "geojson");
    (async () => {
      const matches: LineLayerOption[] = [];
      for (const layer of candidates) {
        const fc = await resolveLayerGeojson(layer, map).catch(() => null);
        if (cancelled) return;
        if (fc && flattenToLine(fc).length >= 2) {
          matches.push({ id: layer.id, name: layer.name });
        }
      }
      if (!cancelled) setLineLayers(matches);
    })();
    return () => {
      cancelled = true;
    };
  }, [layers, mapControllerRef]);

  // Resolve the selected layer's geometry and hand it to the engine. Re-runs when
  // the selection changes or the layer's data updates.
  useEffect(() => {
    let cancelled = false;
    if (!layerId) {
      setRouteAnimationRoute([]);
      return;
    }
    const layer = layers.find((l) => l.id === layerId);
    if (!layer) {
      setRouteAnimationRoute([]);
      return;
    }
    const map = mapControllerRef.current?.getMap() ?? undefined;
    (async () => {
      const fc = await resolveLayerGeojson(layer, map).catch(() => null);
      if (cancelled) return;
      setRouteAnimationRoute(flattenToLine(fc));
    })();
    return () => {
      cancelled = true;
    };
  }, [layerId, layers, mapControllerRef]);

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

  const hasRoute = Boolean(layerId) && lineLayers.some((l) => l.id === layerId);

  return (
    <div
      className="absolute z-30 rounded-lg border border-border bg-background/95 shadow-lg backdrop-blur"
      style={{ left: position.x, top: position.y, width: PANEL_WIDTH }}
      role="dialog"
      aria-label={t("toolbar.routeAnimation.title")}
    >
      <div
        className="flex cursor-grab items-center gap-2 rounded-t-lg border-b border-border bg-muted/40 px-3 py-2 active:cursor-grabbing"
        onPointerDown={handleDragStart}
      >
        <Navigation className="h-4 w-4 text-blue-500" />
        <span className="text-sm font-medium">
          {t("toolbar.routeAnimation.title")}
        </span>
        {/* When collapsed, keep play/pause reachable so the animation stays
            controllable while the panel body is out of the way. */}
        {collapsed && (
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto h-6 w-6"
            disabled={!hasRoute}
            aria-label={
              playing
                ? t("toolbar.routeAnimation.pause")
                : t("toolbar.routeAnimation.play")
            }
            onClick={() => toggleRouteAnimationPlaying()}
          >
            {playing ? (
              <Pause className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className={collapsed ? "h-6 w-6" : "ml-auto h-6 w-6"}
          aria-expanded={!collapsed}
          aria-label={
            collapsed
              ? t("toolbar.routeAnimation.expand")
              : t("toolbar.routeAnimation.collapse")
          }
          title={
            collapsed
              ? t("toolbar.routeAnimation.expand")
              : t("toolbar.routeAnimation.collapse")
          }
          onClick={() => setCollapsed((v) => !v)}
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
          aria-label={t("toolbar.routeAnimation.close")}
          onClick={() => closeRouteAnimationPanel()}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {!collapsed && (
      <div className="space-y-3 p-3">
        <label className="block space-y-1">
          <span className="block text-xs text-muted-foreground">
            {t("toolbar.routeAnimation.layer")}
          </span>
          <Select
            value={layerId ?? ""}
            onChange={(e) =>
              setRouteAnimationSettings({
                layerId: e.target.value || null,
                progress: 0,
                playing: false,
              })
            }
          >
            <option value="">
              {lineLayers.length === 0
                ? t("toolbar.routeAnimation.noLineLayers")
                : t("toolbar.routeAnimation.selectLayer")}
            </option>
            {lineLayers.map((layer) => (
              <option key={layer.id} value={layer.id}>
                {layer.name}
              </option>
            ))}
          </Select>
        </label>

        <div className="flex items-center gap-1.5">
          <Button
            variant="default"
            size="icon"
            className="h-9 w-9"
            disabled={!hasRoute}
            aria-label={
              playing
                ? t("toolbar.routeAnimation.pause")
                : t("toolbar.routeAnimation.play")
            }
            onClick={() => toggleRouteAnimationPlaying()}
          >
            {playing ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
          </Button>
          <div className="min-w-0 flex-1">
            <SliderRow
              label={t("toolbar.routeAnimation.progress")}
              min={0}
              max={1}
              step={0.001}
              value={progress}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => setRouteAnimationProgress(v)}
            />
          </div>
          <Button
            variant={loop ? "default" : "outline"}
            size="icon"
            className="h-8 w-8"
            aria-pressed={loop}
            aria-label={t("toolbar.routeAnimation.loop")}
            title={t("toolbar.routeAnimation.loop")}
            onClick={() => setRouteAnimationSettings({ loop: !loop })}
          >
            <Repeat className="h-4 w-4" />
          </Button>
        </div>

        <SliderRow
          label={t("toolbar.routeAnimation.speed")}
          min={ROUTE_ANIM_SPEED_MIN}
          max={ROUTE_ANIM_SPEED_MAX}
          step={1}
          value={speedMps}
          format={(v) => `${Math.round(v)} m/s`}
          onChange={(v) => setRouteAnimationSettings({ speedMps: v })}
        />

        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {t("toolbar.routeAnimation.marker")}
          </span>
          <div className="min-w-0 flex-1">
            <Select
              aria-label={t("toolbar.routeAnimation.marker")}
              value={markerStyle}
              onChange={(e) =>
                setRouteAnimationSettings({
                  markerStyle: e.target.value as RouteMarkerStyle,
                })
              }
            >
              {ROUTE_MARKER_STYLES.map((style) => (
                <option key={style} value={style}>
                  {t(`toolbar.routeAnimation.markerStyle.${style}`)}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <ToggleChip
            active={followCamera}
            icon={<Video className="h-3.5 w-3.5" />}
            label={t("toolbar.routeAnimation.followCamera")}
            onClick={() =>
              setRouteAnimationSettings({ followCamera: !followCamera })
            }
          />
          <ToggleChip
            active={showTrail}
            icon={<Spline className="h-3.5 w-3.5" />}
            label={t("toolbar.routeAnimation.trail")}
            onClick={() => setRouteAnimationSettings({ showTrail: !showTrail })}
          />
        </div>
      </div>
      )}
    </div>
  );
}

interface ToggleChipProps {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}

function ToggleChip({ active, icon, label, onClick }: ToggleChipProps) {
  return (
    <Button
      variant={active ? "default" : "outline"}
      size="sm"
      className="h-7 gap-1.5 px-2 text-xs"
      aria-pressed={active}
      onClick={onClick}
    >
      {icon}
      {label}
    </Button>
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

function SliderRow({
  label,
  min,
  max,
  step,
  value,
  format,
  onChange,
}: SliderRowProps) {
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
