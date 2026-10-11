import {
  getRoutingConfig,
  requestNavigationRoute,
  resolveGeocoderConfig,
  RoutingRequestError,
  useAppStore,
} from "@geolibre/core";
import { rendererCapabilities, type MapEngine } from "@geolibre/map";
import type * as maplibregl from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentPosition } from "../../lib/geolocation";
import { formatNavDistance, formatNavDuration } from "../../lib/navigation/format";
import type { LngLat } from "../../lib/navigation/geometry";
import { logNavigation } from "../../lib/navigation/log";
import {
  createNavigationOverlay,
  NAV_ALTERNATE_LAYER,
  navigationOverlayCollection,
  type NavigationOverlay,
} from "../../lib/navigation/overlay";
import {
  buildNavRouteRequest,
  navRouteToFeatureCollection,
  parseNavRoutes,
  type NavRoute,
} from "../../lib/navigation/route";
import {
  boundsOf,
  loadNavSettings,
  NARROW_MAP_WIDTH,
  planPadding,
  saveNavSettings,
  type NavPoint,
  type NavRouteStatus,
  type NavSettings,
} from "../../lib/navigation/session";
import { useNavigationTool } from "../../lib/navigation/store";
import { hasRoutingConsent, recordRoutingConsent } from "../../lib/routing-consent";
import { RoutingConsentDialog } from "../layout/RoutingConsentDialog";
import { SilentErrorBoundary } from "../common/error-boundaries";
import { DriveView } from "./DriveView";
import { PlanView } from "./PlanView";
import { useNarrowMap } from "./useNarrowMap";
import { useNavigationDrive } from "./useNavigationDrive";
import { useRouteRequest } from "./useRouteRequest";

/** Zoom shown around the device's location, close enough to pick a street. */
const MY_LOCATION_ZOOM = 15;

/**
 * The turn-by-turn navigation tool: plan a route between points picked on the
 * map (or the device's location), compare alternates, then drive it with a
 * following camera, a maneuver banner with lane guidance, and spoken
 * announcements, rerouting when the drive leaves the route. A simulated drive
 * replays the route without a GPS, for a desktop or a demo.
 *
 * Routes come from Valhalla (the same server as the Network analysis tools),
 * so the tool shares their one-time privacy notice. It draws MapLibre style
 * layers, so it renders only where the primary map exposes a MapLibre map.
 *
 * @param mapControllerRef - Ref to the live primary map engine.
 * @param mapReadyGeneration - Bumped when the engine (re)initialises.
 */
export function NavigationPanel({
  mapControllerRef,
  mapReadyGeneration,
}: {
  mapControllerRef: RefObject<MapEngine | null>;
  mapReadyGeneration: number;
}) {
  const open = useNavigationTool((s) => s.open);
  const close = useNavigationTool((s) => s.closeNavigation);
  const primaryRenderer = useAppStore((s) => s.primaryRenderer);
  const supported = rendererCapabilities(primaryRenderer).nativeMapInstance;
  const [consented, setConsented] = useState(hasRoutingConsent);
  const { t } = useTranslation();

  // A renderer swap to one without a MapLibre map ends the session.
  useEffect(() => {
    if (open && !supported) close();
  }, [open, supported, close]);

  if (!open || !supported) return null;
  if (!consented) {
    return (
      <RoutingConsentDialog
        open
        title={t("navigation.consentTitle")}
        description={t("navigation.consentDesc")}
        onCancel={close}
        onConfirm={() => {
          recordRoutingConsent();
          setConsented(true);
        }}
      />
    );
  }
  // Its own boundary: the drive's banner sits over the map, and a fault in it
  // must not take the map down.
  return (
    <SilentErrorBoundary label="Navigation">
      <NavigationTool
        mapControllerRef={mapControllerRef}
        mapReadyGeneration={mapReadyGeneration}
        onClose={close}
      />
    </SilentErrorBoundary>
  );
}

function NavigationTool({
  mapControllerRef,
  mapReadyGeneration,
  onClose,
}: {
  mapControllerRef: RefObject<MapEngine | null>;
  mapReadyGeneration: number;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const imperial = useAppStore((s) => s.preferences.map.scaleUnit) === "imperial";
  const seedOrigin = useNavigationTool((s) => s.origin);
  const seedDestination = useNavigationTool((s) => s.destination);
  const request = useNavigationTool((s) => s.request);

  const [settings, setSettings] = useState<NavSettings>(() => loadNavSettings());
  const updateSettings = useCallback((patch: Partial<NavSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      saveNavSettings(next);
      return next;
    });
  }, []);

  const initialWaypoints = (): (NavPoint | null)[] => [seedOrigin, seedDestination];
  const [waypoints, setWaypoints] = useState<(NavPoint | null)[]>(initialWaypoints);
  const [pickIndex, setPickIndex] = useState<number | null>(() =>
    seedOrigin && !seedDestination ? 1 : 0,
  );
  const [routes, setRoutes] = useState<NavRoute[]>([]);
  const [selected, setSelected] = useState(0);
  const [status, setStatus] = useState<NavRouteStatus>("idle");
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);
  const [savedRoute, setSavedRoute] = useState<NavRoute | null>(null);
  const [showSteps, setShowSteps] = useState(false);

  const getMap = useCallback(() => mapControllerRef.current?.getMap() ?? null, [mapControllerRef]);
  const [minimized, setMinimized] = useState(false);
  const geocodingPrefs = useAppStore((s) => s.preferences.geocoding);
  const geocoder = useMemo(() => resolveGeocoderConfig(geocodingPrefs), [geocodingPrefs]);
  const narrow = useNarrowMap(getMap, mapReadyGeneration);
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;

  const route = routes[selected] ?? null;
  const onReroute = useCallback((next: NavRoute, remaining: NavPoint[]) => {
    setRoutes([next]);
    setSelected(0);
    setWaypoints(remaining);
  }, []);
  const {
    phase,
    progress,
    offRoute,
    rerouting,
    gpsLost,
    follow,
    simulating,
    driveError,
    startDrive,
    endDrive,
    recenter,
    overview,
    focus,
  } = useNavigationDrive({
    getMap,
    mapReadyGeneration,
    route,
    waypoints,
    settings,
    language,
    imperial,
    onReroute,
  });

  // A fresh "Directions to/from here" restarts planning from the new point.
  const lastRequest = useRef(request);
  useEffect(() => {
    if (lastRequest.current === request) return;
    lastRequest.current = request;
    if (phase !== "plan") return;
    if (seedDestination) {
      setWaypoints((current) => [current[0], seedDestination]);
      setPickIndex((current) => (current === null ? null : 0));
    } else if (seedOrigin) {
      setWaypoints((current) => [seedOrigin, current[current.length - 1]]);
      setPickIndex(1);
    }
  }, [request, seedOrigin, seedDestination, phase]);

  // --- Routing ---------------------------------------------------------------

  // On a phone the full card would hide the route: fold it to the bar that
  // still carries the time, Start, and Simulate.
  const onRoutesFound = useCallback(() => {
    if (narrowRef.current) setMinimized(true);
  }, []);
  useRouteRequest({
    enabled: phase === "plan",
    waypoints,
    settings,
    language,
    imperial,
    getMap,
    setRoutes,
    setSelected,
    setStatus,
    onRoutesFound,
  });

  // --- Map interaction while planning ----------------------------------------

  const planRef = useRef({ pickIndex, waypoints, phase });
  planRef.current = { pickIndex, waypoints, phase };
  useEffect(() => {
    const map = getMap();
    if (!map) return;
    const onClick = (event: maplibregl.MapMouseEvent) => {
      const { pickIndex: pick, waypoints: current, phase: currentPhase } = planRef.current;
      if (currentPhase !== "plan") return;
      if (pick === null) {
        // Not placing a point: a click on an alternate selects it.
        const hit = map.getLayer(NAV_ALTERNATE_LAYER)
          ? map.queryRenderedFeatures(event.point, { layers: [NAV_ALTERNATE_LAYER] })[0]
          : undefined;
        const index = hit?.properties?.index;
        if (typeof index === "number") setSelected(index);
        return;
      }
      const next = current.slice();
      next[pick] = { lng: event.lngLat.lng, lat: event.lngLat.lat };
      setWaypoints(next);
      const empty = next.findIndex((w, i) => w === null && i !== pick);
      setPickIndex(empty === -1 ? null : empty);
    };
    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
    };
  }, [getMap, mapReadyGeneration]);

  // The crosshair shows while a point is being placed.
  useEffect(() => {
    const map = getMap();
    if (!map || phase !== "plan" || pickIndex === null) return;
    const canvas = map.getCanvas();
    const previous = canvas.style.cursor;
    canvas.style.cursor = "crosshair";
    return () => {
      canvas.style.cursor = previous;
    };
  }, [getMap, mapReadyGeneration, phase, pickIndex]);

  // --- Overlay ---------------------------------------------------------------

  const overlayRef = useRef<NavigationOverlay | null>(null);
  useEffect(() => {
    const map = getMap();
    if (!map) return;
    const overlay = createNavigationOverlay(map);
    overlayRef.current = overlay;
    return () => {
      overlay.remove();
      if (overlayRef.current === overlay) overlayRef.current = null;
    };
  }, [getMap, mapReadyGeneration]);

  const currentStep = route && progress ? route.steps[progress.stepIndex] : undefined;
  const nextManeuver = route && progress ? route.steps[progress.stepIndex + 1] : undefined;
  useEffect(() => {
    overlayRef.current?.setData(
      navigationOverlayCollection({
        routes,
        selectedIndex: selected,
        waypoints: waypoints.map((w) => (w ? ([w.lng, w.lat] as LngLat) : null)),
        traveledAlong: phase === "plan" ? null : (progress?.along ?? null),
        maneuver: phase === "navigate" && nextManeuver ? nextManeuver.location : null,
        navigating: phase !== "plan",
      }),
    );
  }, [routes, selected, waypoints, phase, progress, nextManeuver, mapReadyGeneration]);

  // --- Waypoint editing ------------------------------------------------------

  const useMyLocation = useCallback(() => {
    setLocating(true);
    setLocateError(null);
    getCurrentPosition({ enableHighAccuracy: true, timeout: 15_000, maximumAge: 10_000 })
      .then((position) => {
        const { waypoints: current, pickIndex: pick } = planRef.current;
        const next = current.slice();
        next[0] = { lng: position.coords.longitude, lat: position.coords.latitude, mine: true };
        setWaypoints(next);
        const empty = next.findIndex((w) => w === null);
        if (pick === 0 || pick === null) setPickIndex(empty === -1 ? null : empty);
        // Show where you are, so the next point can be picked around it. With
        // every point placed the route fit frames the trip instead.
        const map = getMap();
        if (map && empty !== -1) {
          map.flyTo({
            center: [position.coords.longitude, position.coords.latitude],
            zoom: Math.max(map.getZoom(), MY_LOCATION_ZOOM),
            duration: 800,
          });
        }
      })
      .catch((error: unknown) => {
        logNavigation("Could not read the device location for navigation.", error);
        setLocateError(t("navigation.locationError"));
      })
      .finally(() => setLocating(false));
  }, [getMap, t]);

  // A point placed from a typed address: fill the slot, then move on to the
  // next empty one, as a map pick does.
  const placeWaypoint = useCallback(
    (index: number, point: NavPoint) => {
      const next = planRef.current.waypoints.slice();
      next[index] = point;
      setWaypoints(next);
      const empty = next.findIndex((w) => w === null);
      setPickIndex(empty === -1 ? null : empty);
      getMap()?.easeTo({ center: [point.lng, point.lat], duration: 600 });
    },
    [getMap],
  );

  const swapEnds = useCallback(() => {
    setWaypoints((current) => current.slice().reverse());
    setPickIndex(null);
  }, []);

  const addStop = useCallback(() => {
    const next = planRef.current.waypoints.slice();
    next.splice(next.length - 1, 0, null);
    setWaypoints(next);
    setPickIndex(next.length - 2);
  }, []);

  const removeStop = useCallback((index: number) => {
    setWaypoints((current) => current.filter((_, i) => i !== index));
    setPickIndex(null);
  }, []);

  const saveAsLayer = useCallback(() => {
    if (!route) return;
    useAppStore.getState().addGeoJsonLayer(
      t("navigation.layerName", {
        distance: formatNavDistance(route.distance, imperial, language),
      }),
      navRouteToFeatureCollection(route),
    );
    setSavedRoute(route);
  }, [route, t, imperial, language]);

  // Escape closes the planner, like the other on-map tools -- but never ends a
  // drive, and not while a field has focus.
  useEffect(() => {
    if (phase !== "plan") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, phase]);

  const formatDistance = useCallback(
    (meters: number) => formatNavDistance(meters, imperial, language),
    [imperial, language],
  );
  const formatDuration = useCallback(
    (seconds: number) => formatNavDuration(seconds, language),
    [language],
  );

  if (phase !== "plan" && route) {
    return (
      <DriveView
        route={route}
        phase={phase}
        progress={progress}
        currentStep={currentStep}
        offRoute={offRoute}
        rerouting={rerouting}
        gpsLost={gpsLost}
        follow={follow}
        simulating={simulating}
        driveError={driveError}
        settings={settings}
        onSettings={updateSettings}
        onRecenter={recenter}
        onOverview={overview}
        onEnd={endDrive}
        formatDistance={formatDistance}
        formatDuration={formatDuration}
        language={language}
        narrow={narrow}
        onFocus={focus}
      />
    );
  }

  return (
    <PlanView
      waypoints={waypoints}
      pickIndex={pickIndex}
      onPick={setPickIndex}
      routes={routes}
      selected={selected}
      onSelect={setSelected}
      status={status}
      locating={locating}
      locateError={locateError}
      settings={settings}
      onSettings={updateSettings}
      onUseMyLocation={useMyLocation}
      onSwap={swapEnds}
      onAddStop={addStop}
      onRemoveStop={removeStop}
      onStart={() => {
        setPickIndex(null);
        void startDrive(false);
      }}
      onSimulate={() => {
        setPickIndex(null);
        void startDrive(true);
      }}
      onSave={saveAsLayer}
      saved={savedRoute !== null && savedRoute === route}
      showSteps={showSteps}
      onToggleSteps={() => setShowSteps((v) => !v)}
      onStepClick={(step) => getMap()?.flyTo({ center: step.location, zoom: 17, duration: 800 })}
      onClose={onClose}
      formatDistance={formatDistance}
      formatDuration={formatDuration}
      narrow={narrow}
      minimized={minimized}
      onMinimizedChange={setMinimized}
      geocoder={geocoder}
      onWaypointChange={placeWaypoint}
    />
  );
}
