import { geojsonHasZCoordinates, styleValue, useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  ROUTE_ANIM_SPEED_MAX,
  ROUTE_ANIM_SPEED_MIN,
  ROUTE_FOLLOW_PITCH_MAX,
  ROUTE_FOLLOW_PITCH_MIN,
  ROUTE_FOLLOW_ZOOM_MAX,
  ROUTE_FOLLOW_ZOOM_MIN,
  ROUTE_MARKER_STYLES,
  RouteVideoUnsupportedError,
  type RouteMarkerStyle,
  closeRouteAnimationPanel,
  flattenToLine,
  flattenToRoute,
  getRouteAnimationDurationSeconds,
  getRouteAnimationSnapshot,
  isRouteAnimationPanelVisible,
  isRouteVideoSupported,
  pickRouteVideoMimeType,
  recordRouteAnimation,
  setRouteAnimationElevation,
  setRouteAnimationProgress,
  setRouteAnimationRoute,
  setRouteAnimationSettings,
  subscribeRouteAnimation,
  subscribeRouteAnimationPanel,
  toggleRouteAnimationPlaying,
  videoExtensionForMime,
} from "@geolibre/plugins";
import { Button, Select, Slider } from "@geolibre/ui";
import {
  ChevronDown,
  ChevronUp,
  Circle,
  Compass,
  Film,
  Mountain,
  Navigation,
  Pause,
  Play,
  Repeat,
  Search,
  Spline,
  Video,
  X,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { clamp } from "../../lib/clamp";
import { saveBinaryFileWithFallback } from "../../lib/tauri-io";
import { resolveLayerGeojson } from "../../lib/vector-export";

// Video-recording capability is a static browser feature, so probe it once at
// module load rather than re-running the MediaRecorder checks on every render.
const VIDEO_SUPPORTED = isRouteVideoSupported();
const VIDEO_MIME = pickRouteVideoMimeType();
// Which container the browser will actually produce, so the button can honestly
// say "MP4" or fall back to "WebM" (Firefox can't encode MP4 via MediaRecorder).
const VIDEO_EXTENSION = VIDEO_MIME ? videoExtensionForMime(VIDEO_MIME) : "mp4";

/** Recording lifecycle: idle, capturing the canvas, or writing the file. */
type RecordStatus = "idle" | "recording" | "saving";

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
export function RouteAnimationPanel({ mapControllerRef }: RouteAnimationPanelProps) {
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
  // A stable key that only changes when geojson layers are added/removed/reordered
  // — NOT on unrelated per-layer edits (opacity/visibility/style rebuild the whole
  // `layers` array). Keying the effects below on this instead of the array avoids
  // re-resolving geometry (and resetting playback) on every unrelated layer tweak.
  const geojsonLayerKey = useAppStore((s) =>
    s.layers
      .filter((layer) => layer.type === "geojson")
      .map((layer) => layer.id)
      .join(","),
  );
  const [lineLayers, setLineLayers] = useState<LineLayerOption[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [position, setPosition] = useState(() => ({
    x: EDGE_MARGIN,
    y: EDGE_MARGIN,
  }));
  // Video-export state: the recording lifecycle, capture progress, the last
  // save/record outcome, and an abort controller to stop an in-flight capture.
  const [recordStatus, setRecordStatus] = useState<RecordStatus>("idle");
  const [recordPercent, setRecordPercent] = useState(0);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [savedVideoName, setSavedVideoName] = useState<string | null>(null);
  const recordAbortRef = useRef<AbortController | null>(null);
  // True while capturing or writing the file: playback-driving controls are
  // frozen (the recorder owns playback) and the panel can't be closed/collapsed
  // out from under the running capture.
  const busy = recordStatus !== "idle";

  // Whether the selected layer is drawn elevated ("3D (Z values)") and how, kept
  // in a store-derived key so tweaking the exaggeration/offset in the Style
  // panel re-pushes the transform without re-resolving the geometry. Empty when
  // no layer is selected.
  const elevation3dKey = useAppStore((s) => {
    const layer = s.layers.find((l) => l.id === settings.layerId);
    if (!layer) return "";
    return [
      styleValue(layer.style, "elevation3dEnabled") === true ? 1 : 0,
      styleValue(layer.style, "elevation3dVerticalScale"),
      styleValue(layer.style, "elevation3dOffset"),
    ].join("|");
  });
  // Whether the resolved route carries real Z values, tagged with the layer it
  // was resolved for. Mirrors the map-side gate (`isElevation3dLayer`) so the
  // marker only lifts when the layer actually renders in 3D. Tagging by layer
  // id means a pending resolution for a newly-selected layer never lets the
  // previous layer's Z verdict leak into the elevation push below.
  const [routeZ, setRouteZ] = useState<{
    layerId: string;
    hasZ: boolean;
  } | null>(null);

  const {
    layerId,
    playing,
    speedMps,
    loop,
    progress,
    followCamera,
    followPitch,
    followZoom,
    followRotate,
    markerStyle,
    showTrail,
    color,
  } = settings;

  // Discover which geojson layers contain line geometry. Resolution is async for
  // Add Vector Layer geojson-mode layers (features live in a map source), so this
  // runs in an effect and guards against overlapping runs. Candidates resolve
  // concurrently. Fresh layers are read via `getState()` so this depends only on
  // the geojson-layer key, not the churning `layers` array.
  useEffect(() => {
    let cancelled = false;
    const map = mapControllerRef.current?.getMap() ?? undefined;
    const candidates = useAppStore.getState().layers.filter((layer) => layer.type === "geojson");
    (async () => {
      const resolved = await Promise.all(
        candidates.map(async (layer) => {
          const fc = await resolveLayerGeojson(layer, map).catch(() => null);
          return fc && flattenToLine(fc).length >= 2 ? { id: layer.id, name: layer.name } : null;
        }),
      );
      if (!cancelled) {
        setLineLayers(resolved.filter((m): m is LineLayerOption => m !== null));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [geojsonLayerKey, mapControllerRef]);

  // Resolve the selected layer's geometry and hand it to the engine. Re-runs on
  // selection change or when the set of geojson layers changes (not on unrelated
  // per-layer edits). `setRouteAnimationRoute` no-ops when the geometry is
  // unchanged, so playback is never reset by this.
  useEffect(() => {
    let cancelled = false;
    if (!layerId) {
      setRouteAnimationRoute([]);
      setRouteZ(null);
      return;
    }
    const layer = useAppStore.getState().layers.find((l) => l.id === layerId);
    if (!layer) {
      // The selected layer was removed from the project: clear the route and the
      // stale selection so the dropdown falls back to the placeholder and a save
      // doesn't persist a layerId that no longer exists.
      setRouteAnimationRoute([]);
      setRouteZ(null);
      setRouteAnimationSettings({ layerId: null });
      return;
    }
    const map = mapControllerRef.current?.getMap() ?? undefined;
    (async () => {
      const fc = await resolveLayerGeojson(layer, map).catch(() => null);
      if (cancelled) return;
      const { coords, elevations } = flattenToRoute(fc);
      setRouteAnimationRoute(coords, elevations);
      // Mirror the map-side gate: the layer only renders 3D when its data has
      // real Z somewhere, so the marker only lifts in that case. Tag the verdict
      // with the layer id so a later effect never uses a prior layer's value.
      setRouteZ({ layerId, hasZ: geojsonHasZCoordinates(fc) });
    })();
    return () => {
      cancelled = true;
    };
  }, [layerId, geojsonLayerKey, mapControllerRef]);

  // Tell the engine how the selected layer is drawn (flat vs elevated), so the
  // marker/trail ride the visualized 3D line. Re-runs when the layer's 3D style
  // values change or the route's Z availability does.
  useEffect(() => {
    const layer = layerId ? useAppStore.getState().layers.find((l) => l.id === layerId) : undefined;
    if (!layer) {
      setRouteAnimationElevation({ active: false, verticalScale: 1, offset: 0 });
      return;
    }
    // Only trust the Z verdict once it has been resolved for THIS layer; while a
    // freshly-selected layer's geometry is still resolving, treat it as flat so
    // the previous layer's Z verdict can't briefly force a wrong 3D lift.
    const hasZ = routeZ?.layerId === layerId && routeZ.hasZ;
    const enabled = styleValue(layer.style, "elevation3dEnabled") === true;
    const rawScale = styleValue(layer.style, "elevation3dVerticalScale");
    const rawOffset = styleValue(layer.style, "elevation3dOffset");
    setRouteAnimationElevation({
      active: enabled && hasZ,
      verticalScale: Number.isFinite(rawScale) ? rawScale : 1,
      offset: Number.isFinite(rawOffset) ? rawOffset : 0,
    });
  }, [layerId, elevation3dKey, routeZ]);

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
  // Estimated length of one full pass at the current speed, shown next to the
  // export button so the user knows how long the video will be. Recomputed each
  // render (speed and layer changes both re-render this component).
  const estimatedSeconds = hasRoute && VIDEO_SUPPORTED ? getRouteAnimationDurationSeconds() : 0;

  // Record a single pass of the animation to a video file, then save it. The
  // recorder drives playback from the start to the end; on completion the file
  // is written under a user-chosen name (native dialog on Tauri/Chromium, a
  // download elsewhere). An empty clip (stopped immediately) is treated as a
  // cancel rather than saving an unusable file.
  const handleRecord = async () => {
    setVideoError(null);
    setSavedVideoName(null);
    setRecordPercent(0);
    setRecordStatus("recording");
    const controller = new AbortController();
    recordAbortRef.current = controller;
    try {
      const { blob, extension } = await recordRouteAnimation({
        signal: controller.signal,
        onProgress: (fraction) => setRecordPercent(Math.round(fraction * 100)),
      });
      if (blob.size === 0) {
        setRecordStatus("idle");
        return;
      }
      setRecordStatus("saving");
      const isMp4 = extension === "mp4";
      const fileType = isMp4
        ? t("toolbar.routeAnimation.videoFileTypeMp4")
        : t("toolbar.routeAnimation.videoFileTypeWebm");
      // The plain container MIME (without the codecs parameter) for the file
      // picker's accept map. The blob is already typed with this by
      // `recordRouteAnimation`, so no re-typing is needed here.
      const baseMime = isMp4 ? "video/mp4" : "video/webm";
      const name = await saveBinaryFileWithFallback(blob, {
        defaultName: `route-animation.${extension}`,
        filters: [{ name: fileType, extensions: [extension] }],
        browserTypes: [{ description: fileType, accept: { [baseMime]: [`.${extension}`] } }],
        mimeType: baseMime,
      });
      // A cancelled save dialog returns null; leave no "saved" banner in that case.
      if (name) setSavedVideoName(name);
      setRecordStatus("idle");
    } catch (err) {
      // Aborts resolve cleanly above, so this only fires for real failures.
      console.warn("Route animation recording failed", err);
      setVideoError(
        err instanceof RouteVideoUnsupportedError
          ? t("toolbar.routeAnimation.videoUnsupported")
          : t("toolbar.routeAnimation.videoError"),
      );
      setRecordStatus("idle");
    } finally {
      recordAbortRef.current = null;
      setRecordPercent(0);
    }
  };

  const stopRecording = () => recordAbortRef.current?.abort();

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
        <span className="text-sm font-medium">{t("toolbar.routeAnimation.title")}</span>
        {/* When collapsed, keep play/pause reachable so the animation stays
            controllable while the panel body is out of the way. */}
        {collapsed && (
          <Button
            variant="ghost"
            size="icon"
            className="ms-auto h-6 w-6"
            disabled={!hasRoute || busy}
            aria-label={
              playing ? t("toolbar.routeAnimation.pause") : t("toolbar.routeAnimation.play")
            }
            onClick={() => toggleRouteAnimationPlaying()}
          >
            {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className={collapsed ? "h-6 w-6" : "ms-auto h-6 w-6"}
          // Collapsing hides the Stop control, so keep the panel expanded while a
          // capture is running.
          disabled={busy}
          aria-expanded={!collapsed}
          aria-label={
            collapsed ? t("toolbar.routeAnimation.expand") : t("toolbar.routeAnimation.collapse")
          }
          title={
            collapsed ? t("toolbar.routeAnimation.expand") : t("toolbar.routeAnimation.collapse")
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
          // Closing detaches the engine mid-capture, which would strand the
          // recording; block it until the capture finishes.
          disabled={busy}
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
              disabled={busy}
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
              disabled={!hasRoute || busy}
              aria-label={
                playing ? t("toolbar.routeAnimation.pause") : t("toolbar.routeAnimation.play")
              }
              onClick={() => toggleRouteAnimationPlaying()}
            >
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </Button>
            <div className="min-w-0 flex-1">
              <SliderRow
                label={t("toolbar.routeAnimation.progress")}
                min={0}
                max={1}
                step={0.001}
                value={progress}
                disabled={busy}
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={(v) => setRouteAnimationProgress(v)}
              />
            </div>
            <Button
              variant={loop ? "default" : "outline"}
              size="icon"
              className="h-8 w-8"
              disabled={busy}
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
            disabled={busy}
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
                disabled={busy}
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

          <div className="flex flex-wrap items-center gap-1.5">
            <input
              type="color"
              aria-label={t("toolbar.routeAnimation.color")}
              title={t("toolbar.routeAnimation.color")}
              value={color}
              disabled={busy}
              onChange={(e) => setRouteAnimationSettings({ color: e.target.value })}
              className="h-7 w-9 cursor-pointer rounded-md border border-input bg-transparent p-0.5 disabled:cursor-not-allowed disabled:opacity-50"
            />
            <ToggleChip
              active={followCamera}
              icon={<Video className="h-3.5 w-3.5" />}
              label={t("toolbar.routeAnimation.followCamera")}
              disabled={busy}
              onClick={() => setRouteAnimationSettings({ followCamera: !followCamera })}
            />
            <ToggleChip
              active={showTrail}
              icon={<Spline className="h-3.5 w-3.5" />}
              label={t("toolbar.routeAnimation.trail")}
              disabled={busy}
              onClick={() => setRouteAnimationSettings({ showTrail: !showTrail })}
            />
          </div>

          {/* Follow-camera controls: a chase cam that can tilt/zoom/rotate so the
            view tracks an elevated 3D track instead of snapping flat (#1211).
            Only shown while Follow is on. */}
          {followCamera && (
            <div className="space-y-2 rounded-md border border-border bg-muted/30 p-2">
              <SliderRow
                label={t("toolbar.routeAnimation.followPitch")}
                icon={<Mountain className="h-3.5 w-3.5" />}
                min={ROUTE_FOLLOW_PITCH_MIN}
                max={ROUTE_FOLLOW_PITCH_MAX}
                step={1}
                value={followPitch}
                disabled={busy}
                format={(v) => `${Math.round(v)}°`}
                onChange={(v) => setRouteAnimationSettings({ followPitch: v })}
              />
              <SliderRow
                label={t("toolbar.routeAnimation.followZoom")}
                icon={<Search className="h-3.5 w-3.5" />}
                min={ROUTE_FOLLOW_ZOOM_MIN}
                max={ROUTE_FOLLOW_ZOOM_MAX}
                step={0.5}
                value={followZoom}
                disabled={busy}
                format={(v) => v.toFixed(1)}
                onChange={(v) => setRouteAnimationSettings({ followZoom: v })}
              />
              <ToggleChip
                active={followRotate}
                icon={<Compass className="h-3.5 w-3.5" />}
                label={t("toolbar.routeAnimation.followRotate")}
                disabled={busy}
                onClick={() => setRouteAnimationSettings({ followRotate: !followRotate })}
              />
            </div>
          )}

          {/* Video export: record one full pass of the animation to a video file.
            Only shown when the browser can record the canvas. */}
          {VIDEO_SUPPORTED && (
            <div className="space-y-1.5 border-t border-border pt-3">
              {recordStatus === "recording" ? (
                <div role="status" aria-live="polite" className="flex items-center gap-2">
                  <Circle className="h-3 w-3 shrink-0 animate-pulse fill-red-500 text-red-500" />
                  <span className="flex-1 text-xs font-medium tabular-nums">
                    {t("toolbar.routeAnimation.recordingStatus", {
                      percent: recordPercent,
                    })}
                  </span>
                  <Button variant="destructive" size="sm" className="h-7" onClick={stopRecording}>
                    {t("toolbar.routeAnimation.stop")}
                  </Button>
                </div>
              ) : recordStatus === "saving" ? (
                <div role="status" aria-live="polite" className="flex items-center gap-2">
                  <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-muted border-t-foreground" />
                  <span className="text-xs font-medium">
                    {t("toolbar.routeAnimation.savingVideo")}
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 flex-1"
                    disabled={!hasRoute}
                    onClick={handleRecord}
                  >
                    <Film className="me-1.5 h-3.5 w-3.5" />
                    {VIDEO_EXTENSION === "mp4"
                      ? t("toolbar.routeAnimation.saveVideoMp4")
                      : t("toolbar.routeAnimation.saveVideoWebm")}
                  </Button>
                  {estimatedSeconds > 0 && (
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {t("toolbar.routeAnimation.estimatedLength", {
                        seconds: estimatedSeconds.toFixed(1),
                      })}
                    </span>
                  )}
                </div>
              )}
              {savedVideoName && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400">
                  {t("toolbar.routeAnimation.videoSaved", {
                    name: savedVideoName,
                  })}
                </p>
              )}
              {videoError && <p className="text-xs text-destructive">{videoError}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ToggleChipProps {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}

function ToggleChip({ active, icon, label, disabled, onClick }: ToggleChipProps) {
  return (
    <Button
      variant={active ? "default" : "outline"}
      size="sm"
      className="h-7 gap-1.5 px-2 text-xs"
      disabled={disabled}
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
  /** Optional leading icon shown next to the label. */
  icon?: React.ReactNode;
  min: number;
  max: number;
  step: number;
  value: number;
  disabled?: boolean;
  format: (value: number) => string;
  onChange: (value: number) => void;
}

function SliderRow({
  label,
  icon,
  min,
  max,
  step,
  value,
  disabled,
  format,
  onChange,
}: SliderRowProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          {icon}
          {label}
        </span>
        <span className="tabular-nums text-foreground">{format(value)}</span>
      </div>
      <Slider
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={[value]}
        disabled={disabled}
        onValueChange={([v]: number[]) => onChange(v ?? value)}
      />
    </div>
  );
}
