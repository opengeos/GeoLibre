import { useAppStore } from "@geolibre/core";
import { rendererCapabilities, type MapEngine } from "@geolibre/map";
import {
  computeLineOfSight,
  DEFAULT_LOS_OBSERVER_HEIGHT_METERS,
  DEFAULT_LOS_TARGET_HEIGHT_METERS,
  fetchLineOfSightProfile,
  greatCircleDistance,
  MAX_LINE_OF_SIGHT_METERS,
  MIN_LINE_OF_SIGHT_METERS,
  type LineOfSightPoint,
  type LineOfSightProfile,
  type LineOfSightResult,
} from "@geolibre/processing";
import { Button, Input, Label } from "@geolibre/ui";
import { Eye, Layers, Loader2, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  createLineOfSightOverlay,
  LOS_HIDDEN_COLOR,
  LOS_VISIBLE_COLOR,
  lineOfSightLayerCollection,
  lineOfSightOverlayCollection,
  type LineOfSightOverlay,
} from "../../lib/line-of-sight-layer";
import {
  MAX_HEIGHT_METERS,
  parseHeight,
  unitFormatter,
  type UnitFormatter,
} from "../../lib/line-of-sight-chart";
import { useLineOfSightTool } from "../../lib/line-of-sight-store";
import { LineOfSightChart } from "./LineOfSightChart";

/**
 * The interactive Line of Sight tool (issue #2858): click an observer and a
 * target, and the line between them is drawn split into visible (green) and
 * obstructed (red) stretches, with a result card and an elevation profile.
 *
 * Mounted once by the shell; opened through {@link useLineOfSightTool} from the
 * map's right-click menu or the command palette. It draws MapLibre style
 * layers, so it renders only where the primary map exposes a MapLibre instance
 * (`nativeMapInstance`), and closes itself when the renderer changes to one
 * that does not.
 *
 * @param mapControllerRef - Ref to the live primary map engine.
 * @param mapReadyGeneration - Bumped when the engine (re)initialises.
 */
export function LineOfSightPanel({
  mapControllerRef,
  mapReadyGeneration,
}: {
  mapControllerRef: RefObject<MapEngine | null>;
  mapReadyGeneration: number;
}) {
  const open = useLineOfSightTool((s) => s.open);
  const close = useLineOfSightTool((s) => s.closeLineOfSight);
  const primaryRenderer = useAppStore((s) => s.primaryRenderer);
  const supported = rendererCapabilities(primaryRenderer).nativeMapInstance;

  // A renderer swap to one without a MapLibre map ends the session rather than
  // leaving an armed tool whose clicks never land.
  useEffect(() => {
    if (open && !supported) close();
  }, [open, supported, close]);

  if (!open || !supported) return null;
  return (
    <LineOfSightTool
      mapControllerRef={mapControllerRef}
      mapReadyGeneration={mapReadyGeneration}
      onClose={close}
    />
  );
}

type Status = "idle" | "loading" | "noTerrain" | "tooLong";

function LineOfSightTool({
  mapControllerRef,
  mapReadyGeneration,
  onClose,
}: {
  mapControllerRef: RefObject<MapEngine | null>;
  mapReadyGeneration: number;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const seed = useLineOfSightTool((s) => s.seed);
  const request = useLineOfSightTool((s) => s.request);
  const scaleUnit = useAppStore((s) => s.preferences.map.scaleUnit);
  const units = useMemo(
    () => unitFormatter(scaleUnit === "imperial", i18n.language, t),
    [scaleUnit, i18n.language, t],
  );

  const [observer, setObserver] = useState<LineOfSightPoint | null>(seed);
  const [target, setTarget] = useState<LineOfSightPoint | null>(null);
  const [profile, setProfile] = useState<LineOfSightProfile | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [observerHeight, setObserverHeight] = useState(String(DEFAULT_LOS_OBSERVER_HEIGHT_METERS));
  const [targetHeight, setTargetHeight] = useState(String(DEFAULT_LOS_TARGET_HEIGHT_METERS));
  const [curvature, setCurvature] = useState(true);
  const [savedResult, setSavedResult] = useState<LineOfSightResult | null>(null);
  const ids = useId();

  // A fresh "Line of sight from here" restarts from the new point, even while
  // the tool is already open.
  const lastRequest = useRef(request);
  useEffect(() => {
    if (lastRequest.current === request) return;
    lastRequest.current = request;
    setObserver(seed);
    setTarget(null);
    setProfile(null);
    setStatus("idle");
  }, [request, seed]);

  const settings = useMemo(
    () => ({
      observerHeightMeters: parseHeight(observerHeight, DEFAULT_LOS_OBSERVER_HEIGHT_METERS),
      targetHeightMeters: parseHeight(targetHeight, DEFAULT_LOS_TARGET_HEIGHT_METERS),
      curvature,
    }),
    [observerHeight, targetHeight, curvature],
  );

  // The terrain is fetched once per pair of points; the heights and the
  // curvature switch only re-run the walk over the cached profile, so editing
  // a height updates the line instantly.
  const result = useMemo<LineOfSightResult | null>(() => {
    if (!profile) return null;
    try {
      return computeLineOfSight(profile.samples, settings);
    } catch {
      return null;
    }
  }, [profile, settings]);

  // Fetch the terrain once both points are placed.
  useEffect(() => {
    if (!observer || !target) return;
    if (greatCircleDistance(observer, target) > MAX_LINE_OF_SIGHT_METERS) {
      setStatus("tooLong");
      return;
    }
    const controller = new AbortController();
    setStatus("loading");
    void fetchLineOfSightProfile({ from: observer, to: target, signal: controller.signal })
      .then((next) => {
        if (controller.signal.aborted) return;
        setProfile(next);
        setStatus(next ? "idle" : "noTerrain");
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus("noTerrain");
      });
    return () => controller.abort();
  }, [observer, target]);

  // Map clicks place the observer, then the target; a third click starts a new
  // line from the clicked point.
  const placementRef = useRef({ observer, target });
  placementRef.current = { observer, target };
  useEffect(() => {
    const map = mapControllerRef.current?.getMap();
    if (!map) return;
    const canvas = map.getCanvas();
    const previousCursor = canvas.style.cursor;
    canvas.style.cursor = "crosshair";
    const onClick = (event: { lngLat: { lng: number; lat: number } }) => {
      const point = { lng: event.lngLat.lng, lat: event.lngLat.lat };
      const current = placementRef.current;
      if (current.observer && !current.target) {
        // A second click on (nearly) the observer is a slip, not a target: a
        // line under a metre has no profile to read.
        if (greatCircleDistance(current.observer, point) < MIN_LINE_OF_SIGHT_METERS) return;
        setTarget(point);
      } else {
        setObserver(point);
        setTarget(null);
      }
      setProfile(null);
      setStatus("idle");
    };
    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
      canvas.style.cursor = previousCursor;
    };
  }, [mapControllerRef, mapReadyGeneration]);

  // Escape ends the session, like the other on-map tools -- but not while a
  // field has focus, where Escape means "leave this field", and closing would
  // throw away the fetched profile and the settings.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // The transient drawing: created per map, removed with the tool.
  const overlayRef = useRef<LineOfSightOverlay | null>(null);
  useEffect(() => {
    const map = mapControllerRef.current?.getMap();
    if (!map) return;
    const overlay = createLineOfSightOverlay(map);
    overlayRef.current = overlay;
    return () => {
      overlay.remove();
      if (overlayRef.current === overlay) overlayRef.current = null;
    };
  }, [mapControllerRef, mapReadyGeneration]);

  useEffect(() => {
    overlayRef.current?.setData(lineOfSightOverlayCollection({ observer, target, result }));
  }, [observer, target, result, mapReadyGeneration]);

  const reset = useCallback(() => {
    setObserver(null);
    setTarget(null);
    setProfile(null);
    setStatus("idle");
  }, []);

  const saveAsLayer = useCallback(() => {
    if (!result) return;
    useAppStore
      .getState()
      .addGeoJsonLayer(
        t("lineOfSight.layerName", { distance: units.distance(result.totalDistance) }),
        lineOfSightLayerCollection(result, settings),
      );
    setSavedResult(result);
  }, [result, settings, t, units]);

  let hint: string;
  if (status === "loading") hint = t("lineOfSight.loading");
  else if (status === "noTerrain") hint = t("lineOfSight.noTerrain");
  else if (status === "tooLong")
    hint = t("lineOfSight.tooLong", { max: units.distance(MAX_LINE_OF_SIGHT_METERS) });
  else if (!observer) hint = t("lineOfSight.pickObserver");
  else if (!target) hint = t("lineOfSight.pickTarget");
  else hint = t("lineOfSight.pickAgain");

  return (
    <section
      aria-label={t("lineOfSight.title")}
      className="pointer-events-auto absolute bottom-12 start-2 z-20 flex max-h-[calc(100%-7.5rem)] w-[min(22rem,calc(100vw-1.5rem))] flex-col overflow-y-auto rounded-lg border bg-background shadow-xl"
      data-testid="line-of-sight-panel"
    >
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Eye className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h2 className="flex-1 text-sm font-semibold">{t("lineOfSight.title")}</h2>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          aria-label={t("lineOfSight.close")}
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </header>
      <div className="flex flex-col gap-3 p-3 text-sm">
        <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
          {status === "loading" && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />}
          {hint}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${ids}-observer`} className="text-xs">
              {t("lineOfSight.observerHeight")}
            </Label>
            <Input
              id={`${ids}-observer`}
              type="number"
              min={0}
              max={MAX_HEIGHT_METERS}
              step={0.1}
              value={observerHeight}
              onChange={(event) => setObserverHeight(event.target.value)}
              className="h-8"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${ids}-target`} className="text-xs">
              {t("lineOfSight.targetHeight")}
            </Label>
            <Input
              id={`${ids}-target`}
              type="number"
              min={0}
              max={MAX_HEIGHT_METERS}
              step={0.1}
              value={targetHeight}
              onChange={(event) => setTargetHeight(event.target.value)}
              className="h-8"
            />
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={curvature}
            onChange={(event) => setCurvature(event.target.checked)}
          />
          {t("lineOfSight.curvature")}
        </label>
        {result && (
          <LineOfSightSummary
            result={result}
            units={units}
            resolution={profile?.resolutionMeters}
          />
        )}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!result || savedResult === result}
            onClick={saveAsLayer}
          >
            <Layers className="me-1 h-3.5 w-3.5" />
            {savedResult === result && result ? t("lineOfSight.saved") : t("lineOfSight.saveLayer")}
          </Button>
          <Button size="sm" variant="ghost" disabled={!observer} onClick={reset}>
            <RotateCcw className="me-1 h-3.5 w-3.5" />
            {t("lineOfSight.clear")}
          </Button>
        </div>
      </div>
    </section>
  );
}

function LineOfSightSummary({
  result,
  units,
  resolution,
}: {
  result: LineOfSightResult;
  units: UnitFormatter;
  resolution: number | undefined;
}) {
  const { t, i18n } = useTranslation();
  const percent = new Intl.NumberFormat(i18n.language, { style: "percent" }).format(
    result.visibleFraction,
  );
  const rows: [string, string][] = [
    [t("lineOfSight.distance"), units.distance(result.totalDistance)],
  ];
  if (result.firstObstruction) {
    rows.push([
      t("lineOfSight.firstObstruction"),
      t("lineOfSight.obstructionValue", {
        distance: units.distance(result.firstObstruction.distance),
        elevation: units.elevation(result.firstObstruction.elevation),
      }),
    ]);
  }
  rows.push(
    [
      t("lineOfSight.highestPoint"),
      t("lineOfSight.highestValue", {
        elevation: units.elevation(result.highestPoint.elevation),
        distance: units.distance(result.highestPoint.distance),
      }),
    ],
    [t("lineOfSight.groundVisible"), percent],
  );
  if (resolution !== undefined) {
    rows.push([t("lineOfSight.resolution"), units.distance(resolution)]);
  }
  return (
    <div className="flex flex-col gap-2" data-testid="line-of-sight-result">
      <p
        className="flex items-center gap-2 font-medium"
        style={{ color: result.targetVisible ? LOS_VISIBLE_COLOR : LOS_HIDDEN_COLOR }}
      >
        <span
          aria-hidden
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{ background: result.targetVisible ? LOS_VISIBLE_COLOR : LOS_HIDDEN_COLOR }}
        />
        {result.targetVisible ? t("lineOfSight.visible") : t("lineOfSight.notVisible")}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-end tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <LineOfSightChart result={result} units={units} />
    </div>
  );
}
