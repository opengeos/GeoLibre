import { geoEditorSnapTolerancePx, registerMapClickClaim, useAppStore } from "@geolibre/core";
import { rendererCapabilities, type MapEngine } from "@geolibre/map";
import { addFeatureToGeoEditor, isGeoEditorAvailableForImport } from "@geolibre/plugins";
import { Button, Input, Label, Select } from "@geolibre/ui";
import type { Geometry, Position } from "geojson";
import { Compass, Crosshair, Layers, PenLine, RotateCcw, Route, Undo2, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { createAppAPI, getPluginManager } from "../../hooks/usePlugins";
import {
  COGO_DISTANCE_UNITS,
  type CogoDistanceUnit,
  azimuthBetween,
  cogoPreviewCollection,
  constructedFeature,
  destinationPoint,
  distanceMeters,
  formatQuadrantBearing,
  geometryPaths,
  parseBearing,
  snapToGeometries,
  tracePath,
  type SnapResult,
} from "../../lib/cogo";
import { createCogoOverlay, type CogoOverlay } from "../../lib/cogo-overlay";
import { useCogoTool } from "../../lib/cogo-store";

/**
 * COGO and trace digitizing (#3530): build a line or polygon vertex by vertex
 * from typed bearings and distances, from snapped map clicks, and by tracing
 * an existing feature's boundary between two snapped points. The result goes
 * into the Geo Editor as a new sketch (where it stays editable) or straight to
 * a new layer.
 *
 * Mounted once by the shell; opened through {@link useCogoTool} from the
 * command palette or the map's right-click menu. It draws a transient MapLibre
 * preview, so it renders only where the primary map exposes a MapLibre
 * instance. Map picks snap to visible vector layers within the project's
 * snapping tolerance (Settings, Geo editor), the same value the editor's
 * drawing tools use.
 *
 * @param mapControllerRef - Ref to the live primary map engine.
 * @param mapReadyGeneration - Bumped when the engine (re)initialises.
 */
export function CogoTracePanel({
  mapControllerRef,
  mapReadyGeneration,
}: {
  mapControllerRef: RefObject<MapEngine | null>;
  mapReadyGeneration: number;
}) {
  const open = useCogoTool((s) => s.open);
  const close = useCogoTool((s) => s.closeCogo);
  const primaryRenderer = useAppStore((s) => s.primaryRenderer);
  const supported = rendererCapabilities(primaryRenderer).nativeMapInstance;

  useEffect(() => {
    if (open && !supported) close();
  }, [open, supported, close]);

  if (!open || !supported) return null;
  return (
    <CogoTraceTool
      mapControllerRef={mapControllerRef}
      mapReadyGeneration={mapReadyGeneration}
      onClose={close}
    />
  );
}

/** What the next map click does. */
type PickMode = "idle" | "start" | "point" | "traceFrom" | "traceTo";

interface TraceStart {
  snap: SnapResult;
  /** The snapped geometry, compared by identity with the second pick. */
  geometry: Geometry;
}

type Status = { key: StatusKey; kind: "info" | "error" } | null;

type StatusKey =
  | "needStart"
  | "badBearing"
  | "badDistance"
  | "nothingToTrace"
  | "sameBoundary"
  | "tooFewVertices"
  | "editorUnavailable"
  | "addedToEditor"
  | "savedLayer";

const UNITS = Object.keys(COGO_DISTANCE_UNITS) as CogoDistanceUnit[];
const snapBounds = new WeakMap<object, WeakMap<Geometry, [number, number, number, number]>>();

/** Visible vector features near a screen point, for snapping. */
function snapCandidates(
  map: ReturnType<MapEngine["getMap"]>,
  click: { x: number; y: number },
  tolerance: number,
): Geometry[] {
  if (!map) return [];
  const corners = [
    map.unproject([click.x - tolerance, click.y - tolerance]),
    map.unproject([click.x + tolerance, click.y - tolerance]),
    map.unproject([click.x - tolerance, click.y + tolerance]),
    map.unproject([click.x + tolerance, click.y + tolerance]),
  ];
  const west = Math.min(...corners.map((p) => p.lng));
  const east = Math.max(...corners.map((p) => p.lng));
  const south = Math.min(...corners.map((p) => p.lat));
  const north = Math.max(...corners.map((p) => p.lat));
  const near = (geometry: Geometry, cache: WeakMap<Geometry, [number, number, number, number]>) => {
    let box = cache.get(geometry);
    if (!box) {
      box = [Infinity, Infinity, -Infinity, -Infinity];
      for (const path of geometryPaths(geometry))
        for (const [x, y] of path) {
          box[0] = Math.min(box[0], x);
          box[1] = Math.min(box[1], y);
          box[2] = Math.max(box[2], x);
          box[3] = Math.max(box[3], y);
        }
      cache.set(geometry, box);
    }
    return box[0] <= east && box[2] >= west && box[1] <= north && box[3] >= south;
  };
  const geometries: Geometry[] = [];
  for (const layer of useAppStore.getState().layers) {
    if (!layer.visible || !layer.geojson?.features?.length) continue;
    let cache = snapBounds.get(layer.geojson);
    if (!cache) {
      cache = new WeakMap<Geometry, [number, number, number, number]>();
      snapBounds.set(layer.geojson, cache);
    }
    for (const feature of layer.geojson.features) {
      if (feature.geometry && near(feature.geometry, cache)) geometries.push(feature.geometry);
    }
  }
  return geometries;
}

function CogoTraceTool({
  mapControllerRef,
  mapReadyGeneration,
  onClose,
}: {
  mapControllerRef: RefObject<MapEngine | null>;
  mapReadyGeneration: number;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const ids = useId();
  const seed = useCogoTool((s) => s.seed);
  const request = useCogoTool((s) => s.request);
  const tolerance = useAppStore((s) => geoEditorSnapTolerancePx(s.preferences.map.geoEditor));

  // Each action (a pick, a leg, a trace) adds one step, so Undo removes a
  // whole trace rather than one of its many vertices.
  const draftRevision = useRef(0);
  const [steps, setStepsState] = useState<Position[][]>(() =>
    seed ? [[[seed.lng, seed.lat]]] : [],
  );
  const setSteps = useCallback((next: SetStateAction<Position[][]>) => {
    draftRevision.current += 1;
    setStepsState(next);
  }, []);
  const [kind, setKind] = useState<"line" | "polygon">("polygon");
  const [mode, setMode] = useState<PickMode>(seed ? "idle" : "start");
  const [traceStart, setTraceStart] = useState<TraceStart | null>(null);
  const [longWay, setLongWay] = useState(false);
  const [bearing, setBearing] = useState("");
  const [distance, setDistance] = useState("");
  const [unit, setUnit] = useState<CogoDistanceUnit>("meters");
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);

  const vertices = useMemo(() => {
    const out: Position[] = [];
    for (const p of steps.flat()) {
      const last = out[out.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
    }
    return out;
  }, [steps]);

  // A fresh "Start a COGO traverse here" restarts from the new point.
  const lastRequest = useRef(request);
  useEffect(() => {
    if (lastRequest.current === request) return;
    lastRequest.current = request;
    setSteps(seed ? [[[seed.lng, seed.lat]]] : []);
    setMode(seed ? "idle" : "start");
    setTraceStart(null);
    setStatus(null);
  }, [request, seed, setSteps]);

  const number = useMemo(
    () => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 }),
    [i18n.language],
  );

  // Map clicks: place the start, add a snapped vertex, or pick trace points.
  const stateRef = useRef({ mode, traceStart, longWay, tolerance });
  stateRef.current = { mode, traceStart, longWay, tolerance };
  useEffect(() => {
    const map = mapControllerRef.current?.getMap();
    if (!map) return;
    const releaseClaim = registerMapClickClaim(() => stateRef.current.mode !== "idle");
    const onClick = (event: {
      point: { x: number; y: number };
      lngLat: { lng: number; lat: number };
    }) => {
      const current = stateRef.current;
      if (current.mode === "idle") return;
      const candidates =
        current.mode === "traceTo" && current.traceStart
          ? [current.traceStart.geometry]
          : snapCandidates(map, event.point, current.tolerance).filter(
              (geometry) =>
                current.mode !== "traceFrom" ||
                (geometry.type !== "Point" && geometry.type !== "MultiPoint"),
            );
      const snap = snapToGeometries(
        event.point,
        candidates,
        (p) => map.project([p[0], p[1]]),
        current.tolerance,
        current.tolerance,
      );
      const clicked: Position = snap?.position ?? [event.lngLat.lng, event.lngLat.lat];
      if (current.mode === "start") {
        setSteps([[clicked]]);
        setMode("point");
        setStatus(null);
        return;
      }
      if (current.mode === "point") {
        setSteps((previous) => [...previous, [clicked]]);
        setStatus(null);
        return;
      }
      if (current.mode === "traceFrom") {
        const geometry = snap ? candidates[snap.feature] : undefined;
        const path = snap && geometry ? geometryPaths(geometry)[snap.location.path] : undefined;
        if (!snap || !geometry || !path || path.length < 2) {
          setStatus({ key: "nothingToTrace", kind: "error" });
          return;
        }
        setTraceStart({ snap, geometry });
        setMode("traceTo");
        setStatus(null);
        return;
      }
      // traceTo: the second point must be on the same boundary as the first.
      const start = current.traceStart;
      const geometry = snap ? candidates[snap.feature] : undefined;
      if (
        !start ||
        !snap ||
        geometry !== start.geometry ||
        snap.location.path !== start.snap.location.path
      ) {
        setStatus({ key: "sameBoundary", kind: "error" });
        return;
      }
      const path = geometryPaths(geometry)[snap.location.path];
      const traced = tracePath(path, start.snap.location, snap.location, current.longWay);
      setSteps((previous) => [...previous, traced]);
      setTraceStart(null);
      setMode("idle");
      setStatus(null);
    };
    const canvas = map.getCanvas();
    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
      releaseClaim();
      canvas.style.cursor = "";
    };
  }, [mapControllerRef, mapReadyGeneration, setSteps]);

  // Crosshair while a click is expected.
  useEffect(() => {
    const canvas = mapControllerRef.current?.getMap()?.getCanvas();
    if (canvas) canvas.style.cursor = mode === "idle" ? "" : "crosshair";
  }, [mode, mapControllerRef, mapReadyGeneration]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      // First Escape stops picking; a second closes the panel.
      if (stateRef.current.mode !== "idle") {
        setMode("idle");
        setTraceStart(null);
      } else {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const overlayRef = useRef<CogoOverlay | null>(null);
  useEffect(() => {
    const map = mapControllerRef.current?.getMap();
    if (!map) return;
    const overlay = createCogoOverlay(map);
    overlayRef.current = overlay;
    return () => {
      overlay.remove();
      if (overlayRef.current === overlay) overlayRef.current = null;
    };
  }, [mapControllerRef, mapReadyGeneration]);

  useEffect(() => {
    overlayRef.current?.setData(
      cogoPreviewCollection(vertices, kind, traceStart?.snap.position ?? null),
    );
  }, [vertices, kind, traceStart, mapReadyGeneration]);

  const addLeg = useCallback(() => {
    const last = vertices[vertices.length - 1];
    if (!last) {
      setStatus({ key: "needStart", kind: "error" });
      return;
    }
    const azimuth = parseBearing(bearing);
    if (azimuth === null) {
      setStatus({ key: "badBearing", kind: "error" });
      return;
    }
    const length = Number(distance);
    if (!Number.isFinite(length) || length <= 0) {
      setStatus({ key: "badDistance", kind: "error" });
      return;
    }
    const next = destinationPoint(last, azimuth, length * COGO_DISTANCE_UNITS[unit]);
    setSteps((previous) => [...previous, [next]]);
    setDistance("");
    setStatus(null);
  }, [vertices, bearing, distance, unit, setSteps]);

  const finish = useCallback(
    async (target: "editor" | "layer") => {
      const feature = constructedFeature(vertices, kind);
      if (!feature) {
        setStatus({ key: "tooFewVertices", kind: "error" });
        return;
      }
      if (target === "layer") {
        useAppStore.getState().addGeoJsonLayer(t("cogo.layerName"), {
          type: "FeatureCollection",
          features: [feature],
        });
        setSteps([]);
        setMode("start");
        setStatus({ key: "savedLayer", kind: "info" });
        return;
      }
      const submittedRevision = draftRevision.current;
      setBusy(true);
      try {
        if (!isGeoEditorAvailableForImport()) {
          await getPluginManager().activate(
            "maplibre-gl-geo-editor",
            createAppAPI(mapControllerRef),
          );
        }
        if (!(await addFeatureToGeoEditor(feature))) {
          setStatus({ key: "editorUnavailable", kind: "error" });
          return;
        }
        if (draftRevision.current === submittedRevision) {
          setSteps([]);
          setMode("start");
          setStatus({ key: "addedToEditor", kind: "info" });
        }
      } catch (error) {
        console.warn("COGO: adding the feature to the editor failed", error);
        setStatus({ key: "editorUnavailable", kind: "error" });
      } finally {
        setBusy(false);
      }
    },
    [vertices, kind, t, mapControllerRef, setSteps],
  );

  const undo = useCallback(() => {
    setSteps((previous) => previous.slice(0, -1));
    setStatus(null);
  }, [setSteps]);

  const clear = useCallback(() => {
    setSteps([]);
    setTraceStart(null);
    setMode("start");
    setStatus(null);
  }, [setSteps]);

  let hint: string;
  if (mode === "start") hint = t("cogo.hint.start");
  else if (mode === "point") hint = t("cogo.hint.point");
  else if (mode === "traceFrom") hint = t("cogo.hint.traceFrom");
  else if (mode === "traceTo") hint = t("cogo.hint.traceTo");
  else hint = t("cogo.hint.idle");

  const length = useMemo(() => {
    let total = 0;
    for (let i = 0; i + 1 < vertices.length; i++)
      total += distanceMeters(vertices[i], vertices[i + 1]);
    return total;
  }, [vertices]);
  const lastLeg =
    vertices.length >= 2
      ? {
          bearing: formatQuadrantBearing(
            azimuthBetween(vertices[vertices.length - 2], vertices[vertices.length - 1]),
          ),
          distance: distanceMeters(vertices[vertices.length - 2], vertices[vertices.length - 1]),
        }
      : null;
  const closing =
    kind === "polygon" && vertices.length >= 3
      ? distanceMeters(vertices[vertices.length - 1], vertices[0])
      : null;

  const toggleMode = (next: PickMode) => {
    setTraceStart(null);
    setStatus(null);
    setMode((current) => (current === next ? "idle" : next));
  };

  return (
    <section
      aria-label={t("cogo.title")}
      className="pointer-events-auto absolute bottom-12 end-2 z-20 flex max-h-[calc(100%-7.5rem)] w-[min(22rem,calc(100vw-1.5rem))] flex-col overflow-y-auto rounded-lg border bg-background shadow-xl"
      data-testid="cogo-panel"
    >
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Compass className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h2 className="flex-1 text-sm font-semibold">{t("cogo.title")}</h2>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          aria-label={t("cogo.undo")}
          disabled={steps.length === 0}
          onClick={undo}
        >
          <Undo2 className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          aria-label={t("cogo.clear")}
          disabled={steps.length === 0}
          onClick={clear}
        >
          <RotateCcw className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          aria-label={t("cogo.close")}
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </header>
      <div className="flex flex-col gap-3 p-3 text-sm">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {hint} {t("cogo.tolerance", { pixels: tolerance })}
        </p>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${ids}-kind`} className="text-xs">
            {t("cogo.geometry")}
          </Label>
          <Select
            id={`${ids}-kind`}
            value={kind}
            onChange={(event) => {
              draftRevision.current += 1;
              setKind(event.target.value as "line" | "polygon");
            }}
            className="h-8"
          >
            <option value="polygon">{t("cogo.polygon")}</option>
            <option value="line">{t("cogo.line")}</option>
          </Select>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={mode === "start" ? "default" : "outline"}
            aria-pressed={mode === "start"}
            onClick={() => toggleMode("start")}
          >
            <Crosshair className="me-1 h-3.5 w-3.5" />
            {t("cogo.pickStart")}
          </Button>
          <Button
            size="sm"
            variant={mode === "point" ? "default" : "outline"}
            aria-pressed={mode === "point"}
            disabled={vertices.length === 0}
            onClick={() => toggleMode("point")}
          >
            <PenLine className="me-1 h-3.5 w-3.5" />
            {t("cogo.pickPoint")}
          </Button>
          <Button
            size="sm"
            variant={mode === "traceFrom" || mode === "traceTo" ? "default" : "outline"}
            aria-pressed={mode === "traceFrom" || mode === "traceTo"}
            onClick={() => toggleMode("traceFrom")}
          >
            <Route className="me-1 h-3.5 w-3.5" />
            {t("cogo.trace")}
          </Button>
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={longWay}
            onChange={(event) => setLongWay(event.target.checked)}
          />
          {t("cogo.longWay")}
        </label>
        <form
          className="grid grid-cols-[1fr_5rem_6rem] items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            addLeg();
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${ids}-bearing`} className="text-xs">
              {t("cogo.bearing")}
            </Label>
            <Input
              id={`${ids}-bearing`}
              value={bearing}
              placeholder={t("cogo.bearingPlaceholder")}
              onChange={(event) => setBearing(event.target.value)}
              className="h-8"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${ids}-distance`} className="text-xs">
              {t("cogo.distance")}
            </Label>
            <Input
              id={`${ids}-distance`}
              type="number"
              min={0}
              step="any"
              value={distance}
              onChange={(event) => setDistance(event.target.value)}
              className="h-8"
            />
          </div>
          <Select
            aria-label={t("cogo.unit")}
            value={unit}
            onChange={(event) => setUnit(event.target.value as CogoDistanceUnit)}
            className="h-8"
          >
            {UNITS.map((value) => (
              <option key={value} value={value}>
                {t(`cogo.units.${value}`)}
              </option>
            ))}
          </Select>
          <Button type="submit" size="sm" className="col-span-3" disabled={!bearing || !distance}>
            {t("cogo.addLeg")}
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">{t("cogo.bearingHelp")}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <dt className="text-muted-foreground">{t("cogo.vertices")}</dt>
          <dd className="text-end tabular-nums">{number.format(vertices.length)}</dd>
          <dt className="text-muted-foreground">{t("cogo.length")}</dt>
          <dd className="text-end tabular-nums">
            {t("cogo.meters", { value: number.format(length) })}
          </dd>
          {lastLeg ? (
            <>
              <dt className="text-muted-foreground">{t("cogo.lastLeg")}</dt>
              <dd className="text-end tabular-nums">
                {lastLeg.bearing}, {t("cogo.meters", { value: number.format(lastLeg.distance) })}
              </dd>
            </>
          ) : null}
          {closing !== null ? (
            <>
              <dt className="text-muted-foreground">{t("cogo.closing")}</dt>
              <dd className="text-end tabular-nums">
                {t("cogo.meters", { value: number.format(closing) })}
              </dd>
            </>
          ) : null}
        </dl>
        {status ? (
          <p
            role={status.kind === "error" ? "alert" : "status"}
            className={
              status.kind === "error" ? "text-xs text-destructive" : "text-xs text-muted-foreground"
            }
          >
            {t(`cogo.status.${status.key}`)}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy || vertices.length < 2} onClick={() => finish("editor")}>
            <PenLine className="me-1 h-3.5 w-3.5" />
            {t("cogo.addToEditor")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || vertices.length < 2}
            onClick={() => finish("layer")}
          >
            <Layers className="me-1 h-3.5 w-3.5" />
            {t("cogo.saveLayer")}
          </Button>
        </div>
      </div>
    </section>
  );
}
