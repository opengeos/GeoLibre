import {
  getRoutingConfig,
  requestNavigationRoute,
  RoutingRequestError,
  useAppStore,
} from "@geolibre/core";
import { rendererCapabilities, type MapEngine } from "@geolibre/map";
import { Button, Select, cn } from "@geolibre/ui";
import {
  ArrowUpDown,
  Bike,
  Car,
  Flag,
  Footprints,
  Layers,
  Loader2,
  LocateFixed,
  Maximize,
  Navigation2,
  Play,
  Plus,
  Signpost,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import * as maplibregl from "maplibre-gl";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import {
  getCurrentPosition,
  nativeGeolocationAvailable,
  watchPosition,
} from "../../lib/geolocation";
import { appendDiagnostic, formatUnknown } from "../../lib/diagnostics";
import {
  followZoom,
  initialNavState,
  simulatedFix,
  simulatedSpeed,
  updateNavigation,
  type NavEvent,
  type NavFix,
  type NavProgress,
  type NavState,
} from "../../lib/navigation/engine";
import {
  formatArrivalTime,
  formatNavDistance,
  formatNavDuration,
} from "../../lib/navigation/format";
import { sliceAlong, type LngLat } from "../../lib/navigation/geometry";
import {
  createNavigationOverlay,
  NAV_ALTERNATE_LAYER,
  NAV_DESTINATION_COLOR,
  NAV_ORIGIN_COLOR,
  NAV_STOP_COLOR,
  navigationOverlayCollection,
  type NavigationOverlay,
} from "../../lib/navigation/overlay";
import {
  buildNavRouteRequest,
  navRouteToFeatureCollection,
  NO_AVOID,
  parseNavRoutes,
  type NavAvoid,
  type NavBanner,
  type NavMode,
  type NavRoute,
  type NavStep,
} from "../../lib/navigation/route";
import { useNavigationTool } from "../../lib/navigation/store";
import { speak, speechSupported, stopSpeaking } from "../../lib/navigation/voice";
import { hasRoutingConsent, recordRoutingConsent } from "../../lib/routing-consent";
import { RoutingConsentDialog } from "../layout/RoutingConsentDialog";
import { maneuverIcon, modifierIcon } from "./maneuver-icon";

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
  return (
    <NavigationTool
      mapControllerRef={mapControllerRef}
      mapReadyGeneration={mapReadyGeneration}
      onClose={close}
    />
  );
}

/** A placed waypoint; `mine` marks the device's location. */
interface NavPoint {
  lng: number;
  lat: number;
  mine?: boolean;
}

type Phase = "plan" | "navigate" | "arrived";
type RouteStatus = "idle" | "loading" | "noRoute" | "error";

interface NavSettings {
  mode: NavMode;
  avoid: NavAvoid;
  voice: boolean;
  simSpeed: number;
}

const SETTINGS_KEY = "geolibre.navigation.settings";
const DEFAULT_SETTINGS: NavSettings = { mode: "auto", avoid: NO_AVOID, voice: true, simSpeed: 2 };
const MODES: { mode: NavMode; icon: typeof Car; labelKey: string }[] = [
  { mode: "auto", icon: Car, labelKey: "navigation.mode.auto" },
  { mode: "bicycle", icon: Bike, labelKey: "navigation.mode.bicycle" },
  { mode: "pedestrian", icon: Footprints, labelKey: "navigation.mode.pedestrian" },
];
const SIM_SPEEDS = [1, 2, 4, 8];
/** Simulation tick, in milliseconds. */
const SIM_TICK_MS = 500;
/** A reroute is abandoned after this long, in milliseconds. */
const REROUTE_TIMEOUT_MS = 20_000;
/** Minimum gap after an adopted reroute, so a parallel road cannot cause a storm. */
const REROUTE_COOLDOWN_MS = 10_000;
/** "Rerouting" is spoken at most this often. */
const REROUTE_SPEAK_MIN_MS = 30_000;
/** No fix for this long shows "Searching for GPS". */
const GPS_LOST_MS = 12_000;
/** A following maneuver this close is shown under the banner as "Then …". */
const THEN_DISTANCE_M = 200;

function loadSettings(): NavSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<NavSettings>;
    if (!raw || typeof raw !== "object") return DEFAULT_SETTINGS;
    return {
      mode: MODES.some((m) => m.mode === raw.mode) ? (raw.mode as NavMode) : DEFAULT_SETTINGS.mode,
      avoid: { ...NO_AVOID, ...(raw.avoid ?? {}) },
      voice: raw.voice !== false,
      simSpeed: SIM_SPEEDS.includes(raw.simSpeed as number)
        ? (raw.simSpeed as number)
        : DEFAULT_SETTINGS.simSpeed,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: NavSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Settings simply do not persist (private mode).
  }
}

function fixFromPosition(position: GeolocationPosition): NavFix {
  const { coords } = position;
  const finite = (value: number | null) => (value != null && Number.isFinite(value) ? value : null);
  return {
    lng: coords.longitude,
    lat: coords.latitude,
    accuracy: finite(coords.accuracy),
    heading: finite(coords.heading),
    speed: finite(coords.speed),
    timestamp: position.timestamp,
  };
}

function logNavigation(message: string, error: unknown): void {
  appendDiagnostic({
    category: "runtime",
    level: "warning",
    message,
    detail: formatUnknown(error),
    source: "navigation",
  });
}

/** The navigation arrow drawn at the drive's position. */
function createPuckElement(): HTMLElement {
  const el = document.createElement("div");
  el.dataset.testid = "navigation-puck";
  el.innerHTML =
    '<svg viewBox="0 0 44 44" width="44" height="44" aria-hidden="true">' +
    '<circle cx="22" cy="22" r="19" fill="#2563eb" fill-opacity="0.18"/>' +
    '<path d="M22 7 L33 34 L22 27.5 L11 34 Z" fill="#2563eb" stroke="#fff" ' +
    'stroke-width="2.5" stroke-linejoin="round"/></svg>';
  return el;
}

function boundsOf(coordinates: LngLat[]): maplibregl.LngLatBounds | null {
  if (coordinates.length === 0) return null;
  const bounds = new maplibregl.LngLatBounds(coordinates[0], coordinates[0]);
  for (const c of coordinates) bounds.extend(c);
  return bounds;
}

/** Panel width plus a margin, in pixels, kept clear when fitting a route. */
const PLAN_PANEL_CLEARANCE = 400;

/**
 * Fit padding that keeps a route clear of the planning panel, which sits at
 * the map's inline start; a map too narrow to spare the room gets plain padding.
 */
function planPadding(map: maplibregl.Map): maplibregl.PaddingOptions {
  const base = { top: 60, bottom: 60, left: 60, right: 60 };
  if (map.getContainer().clientWidth < PLAN_PANEL_CLEARANCE * 2) return base;
  const rtl = getComputedStyle(map.getContainer()).direction === "rtl";
  return rtl ? { ...base, right: PLAN_PANEL_CLEARANCE } : { ...base, left: PLAN_PANEL_CLEARANCE };
}

/** The banner for the stretch being driven: the closest one now due. */
function activeBanner(step: NavStep | undefined, distanceToManeuver: number): NavBanner | null {
  if (!step || step.banners.length === 0) return null;
  let banner = step.banners[0];
  for (const candidate of step.banners) {
    if (candidate.distanceBefore >= distanceToManeuver) banner = candidate;
  }
  return banner;
}

/** Mutable drive state, read by the GPS and simulation callbacks. */
interface DriveRefs {
  route: NavRoute | null;
  state: NavState;
  /** The points still to visit after the origin: stops, then the destination. */
  targets: NavPoint[];
  simulate: boolean;
  stopTracking: (() => void) | null;
  reroute: AbortController | null;
  lastRerouteAt: number;
  lastRerouteSpokenAt: number;
  lastFixAt: number;
  lastFix: NavFix | null;
  marker: maplibregl.Marker | null;
  wakeLock: { release: () => Promise<void> } | null;
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

  const [settings, setSettings] = useState<NavSettings>(loadSettings);
  const updateSettings = useCallback((patch: Partial<NavSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      saveSettings(next);
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
  const [status, setStatus] = useState<RouteStatus>("idle");
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);
  const [savedRoute, setSavedRoute] = useState<NavRoute | null>(null);
  const [showSteps, setShowSteps] = useState(false);

  const [phase, setPhase] = useState<Phase>("plan");
  const [progress, setProgress] = useState<NavProgress | null>(null);
  const [offRoute, setOffRoute] = useState(false);
  const [rerouting, setRerouting] = useState(false);
  const [gpsLost, setGpsLost] = useState(false);
  const [follow, setFollow] = useState(true);
  const [simulating, setSimulating] = useState(false);
  const [driveError, setDriveError] = useState<string | null>(null);

  const getMap = useCallback(() => mapControllerRef.current?.getMap() ?? null, [mapControllerRef]);

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

  const complete = waypoints.every((w): w is NavPoint => w !== null);
  const waypointKey = waypoints.map((w) => (w ? `${w.lng},${w.lat}` : "-")).join(";");
  const avoidKey = `${settings.avoid.tolls}${settings.avoid.highways}${settings.avoid.ferries}`;
  const routeRequestRef = useRef(0);
  useEffect(() => {
    if (phase !== "plan") return;
    if (!complete) {
      setRoutes([]);
      setStatus("idle");
      return;
    }
    const points = waypoints as NavPoint[];
    const controller = new AbortController();
    const token = ++routeRequestRef.current;
    setStatus("loading");
    const timer = setTimeout(() => {
      const body = buildNavRouteRequest({
        waypoints: points,
        mode: settings.mode,
        language,
        imperial,
        avoid: settings.avoid,
        alternates: 2,
      });
      requestNavigationRoute(getRoutingConfig().endpoint, body, controller.signal)
        .then((response) => {
          if (controller.signal.aborted || token !== routeRequestRef.current) return;
          const parsed = parseNavRoutes(response, settings.mode);
          setRoutes(parsed);
          setSelected(0);
          setStatus(parsed.length > 0 ? "idle" : "noRoute");
          const bounds = boundsOf(parsed.flatMap((r) => r.coordinates));
          const map = getMap();
          if (bounds && map)
            map.fitBounds(bounds, { padding: planPadding(map), maxZoom: 16, duration: 600 });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || token !== routeRequestRef.current) return;
          setRoutes([]);
          // Valhalla answers 400 when it finds no path between the points.
          if (error instanceof RoutingRequestError && error.status === 400) setStatus("noRoute");
          else {
            logNavigation("Navigation route request failed.", error);
            setStatus("error");
          }
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // waypointKey and avoidKey stand in for the arrays they are built from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, complete, waypointKey, settings.mode, avoidKey, language, imperial, getMap]);

  const route = routes[selected] ?? null;

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
        if (pick === 0 || pick === null) {
          const empty = next.findIndex((w) => w === null);
          setPickIndex(empty === -1 ? null : empty);
        }
      })
      .catch((error: unknown) => {
        logNavigation("Could not read the device location for navigation.", error);
        setLocateError(t("navigation.locationError"));
      })
      .finally(() => setLocating(false));
  }, [t]);

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

  // --- The drive -------------------------------------------------------------

  const drive = useRef<DriveRefs>({
    route: null,
    state: initialNavState(),
    targets: [],
    simulate: false,
    stopTracking: null,
    reroute: null,
    lastRerouteAt: 0,
    lastRerouteSpokenAt: 0,
    lastFixAt: 0,
    lastFix: null,
    marker: null,
    wakeLock: null,
  });
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const followRef = useRef(follow);
  followRef.current = follow;
  const langRef = useRef({ language, imperial, t });
  langRef.current = { language, imperial, t };

  const say = useCallback((text: string, lang: string) => {
    if (settingsRef.current.voice) speak(text, lang);
  }, []);

  const moveCamera = useCallback(
    (fix: NavFix, at: NavProgress, instant = false) => {
      const map = getMap();
      if (!map) return;
      const mode = drive.current.route?.mode ?? "auto";
      const height = map.getContainer().clientHeight;
      map.easeTo({
        center: at.snapped,
        bearing: at.routeBearing,
        pitch: mode === "pedestrian" ? 30 : 55,
        zoom: followZoom(fix.speed, mode),
        // Put the arrow in the lower part of the view, so the road ahead shows.
        offset: [0, Math.round(height * 0.2)],
        duration: instant ? 0 : drive.current.simulate ? SIM_TICK_MS : 900,
        easing: (x) => x,
        essential: true,
      });
    },
    [getMap],
  );

  const releaseWakeLock = useCallback(() => {
    const lock = drive.current.wakeLock;
    drive.current.wakeLock = null;
    void lock?.release().catch(() => undefined);
  }, []);

  const stopTracking = useCallback(() => {
    const d = drive.current;
    d.stopTracking?.();
    d.stopTracking = null;
    d.reroute?.abort();
    d.reroute = null;
    releaseWakeLock();
    stopSpeaking();
  }, [releaseWakeLock]);

  // Declared before handleFix so the reroute can call back into it.
  const handleFixRef = useRef<(fix: NavFix) => void>(() => undefined);

  const reroute = useCallback(
    (fix: NavFix) => {
      const d = drive.current;
      const current = d.route;
      if (!current || d.simulate || d.reroute) return;
      const now = Date.now();
      // Inside the cooldown, or with nothing left to route to: drop the request
      // but clear the off-route latch, so the next off-route fixes ask again.
      const clearLatch = () => {
        d.state = { ...d.state, offRoute: false, offRouteHits: 0, onRouteStreak: 0 };
      };
      if (now - d.lastRerouteAt < REROUTE_COOLDOWN_MS) {
        clearLatch();
        return;
      }
      const targets = d.targets.slice(d.state.stopsPassed);
      if (targets.length === 0) return;
      const { language: lang, imperial: imp, t: tr } = langRef.current;
      if (now - d.lastRerouteSpokenAt > REROUTE_SPEAK_MIN_MS) {
        d.lastRerouteSpokenAt = now;
        say(tr("navigation.voice.rerouting"), lang);
      }
      setRerouting(true);
      const controller = new AbortController();
      d.reroute = controller;
      const timeout = setTimeout(() => controller.abort(), REROUTE_TIMEOUT_MS);
      const moving = fix.speed != null && fix.speed >= 2;
      const body = buildNavRouteRequest({
        waypoints: [{ lng: fix.lng, lat: fix.lat }, ...targets],
        mode: current.mode,
        language: lang,
        imperial: imp,
        avoid: settingsRef.current.avoid,
        heading: moving ? fix.heading : null,
      });
      requestNavigationRoute(getRoutingConfig().endpoint, body, controller.signal)
        .then((response) => {
          if (controller.signal.aborted || d.reroute !== controller) return;
          const next = parseNavRoutes(response, current.mode)[0];
          if (!next) throw new Error("Reroute returned no route.");
          d.route = next;
          d.targets = targets;
          d.state = initialNavState();
          d.lastRerouteAt = Date.now();
          setRoutes([next]);
          setSelected(0);
          setWaypoints([{ lng: fix.lng, lat: fix.lat, mine: true }, ...targets]);
          setOffRoute(false);
          // Place the drive on the new route at once.
          if (d.lastFix) handleFixRef.current(d.lastFix);
        })
        .catch((error: unknown) => {
          if (d.reroute !== controller) return;
          if (!controller.signal.aborted) logNavigation("Navigation reroute failed.", error);
          clearLatch();
        })
        .finally(() => {
          clearTimeout(timeout);
          if (d.reroute === controller) d.reroute = null;
          setRerouting(false);
        });
    },
    [say],
  );

  const handleEvents = useCallback(
    (events: NavEvent[], fix: NavFix) => {
      const d = drive.current;
      const lang = d.route?.voiceLocale ?? langRef.current.language;
      for (const event of events) {
        switch (event.type) {
          case "speak":
            say(event.text, lang);
            break;
          case "offRoute":
            setOffRoute(true);
            reroute(fix);
            break;
          case "backOnRoute":
            // Back on the line before the new route landed: keep the old one.
            d.reroute?.abort();
            d.reroute = null;
            setRerouting(false);
            setOffRoute(false);
            break;
          case "arrive":
            stopTracking();
            setPhase("arrived");
            say(langRef.current.t("navigation.voice.arrived"), langRef.current.language);
            break;
          default:
            break;
        }
      }
    },
    [reroute, say, stopTracking],
  );

  const handleFix = useCallback(
    (fix: NavFix) => {
      const d = drive.current;
      const current = d.route;
      if (!current) return;
      d.lastFixAt = Date.now();
      d.lastFix = fix;
      setGpsLost(false);
      const result = updateNavigation(current, d.state, fix);
      d.state = result.state;
      const at = result.state.progress;
      if (at) {
        setProgress(at);
        const off = result.state.offRoute;
        const heading =
          fix.heading != null && fix.speed != null && fix.speed >= 1
            ? fix.heading
            : at.routeBearing;
        d.marker
          ?.setLngLat(off ? [fix.lng, fix.lat] : at.snapped)
          .setRotation(off ? heading : at.routeBearing);
        if (followRef.current && !off) moveCamera(fix, at);
        else if (followRef.current) getMap()?.easeTo({ center: [fix.lng, fix.lat], duration: 600 });
      }
      handleEvents(result.events, fix);
    },
    [getMap, handleEvents, moveCamera],
  );
  handleFixRef.current = handleFix;

  const startDrive = useCallback(
    async (simulate: boolean) => {
      const map = getMap();
      if (!route || !map) return;
      const d = drive.current;
      stopTracking();
      d.route = route;
      d.state = initialNavState();
      d.targets = (waypoints.slice(1) as NavPoint[]).filter(Boolean);
      d.simulate = simulate;
      d.lastFixAt = Date.now();
      d.lastFix = null;
      d.lastRerouteAt = 0;
      setProgress(null);
      setOffRoute(false);
      setRerouting(false);
      setGpsLost(false);
      setDriveError(null);
      setFollow(true);
      setSimulating(simulate);
      setPhase("navigate");
      setPickIndex(null);

      d.marker?.remove();
      d.marker = new maplibregl.Marker({
        element: createPuckElement(),
        rotationAlignment: "map",
        pitchAlignment: "map",
      })
        .setLngLat(route.coordinates[0])
        .addTo(map);

      // Keep the screen on while driving, where the platform allows it.
      try {
        const wakeLock = (
          navigator as Navigator & {
            wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
          }
        ).wakeLock;
        if (wakeLock) d.wakeLock = await wakeLock.request("screen");
      } catch {
        // No wake lock (unsupported, or the page is hidden): the drive works without.
      }

      if (simulate) {
        let along = 0;
        handleFix(simulatedFix(route, 0, Date.now()));
        const timer = setInterval(() => {
          const current = d.route;
          if (!current) return;
          along = Math.min(
            current.distance,
            along +
              simulatedSpeed(current, along) * settingsRef.current.simSpeed * (SIM_TICK_MS / 1000),
          );
          const fix = simulatedFix(current, along, Date.now());
          handleFix({ ...fix, speed: (fix.speed ?? 0) * settingsRef.current.simSpeed });
        }, SIM_TICK_MS);
        d.stopTracking = () => clearInterval(timer);
        return;
      }

      try {
        const unsubscribe = await watchPosition(
          (position) => handleFix(fixFromPosition(position)),
          (error) => {
            if (error.permissionDenied) {
              setDriveError(langRef.current.t("navigation.locationDenied"));
            }
          },
          { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
        );
        if (d.route !== route || !d.marker) {
          unsubscribe();
          return;
        }
        d.stopTracking = unsubscribe;
      } catch (error) {
        logNavigation("Could not start following the device location.", error);
        setDriveError(langRef.current.t("navigation.locationError"));
      }
    },
    [getMap, handleFix, route, stopTracking, waypoints],
  );

  const endDrive = useCallback(() => {
    stopTracking();
    const d = drive.current;
    d.marker?.remove();
    d.marker = null;
    d.route = null;
    setPhase("plan");
    setProgress(null);
    setOffRoute(false);
    setRerouting(false);
    setGpsLost(false);
    setSimulating(false);
    getMap()?.easeTo({ pitch: 0, bearing: 0, duration: 600 });
  }, [getMap, stopTracking]);

  // "Searching for GPS" when the fixes stop.
  useEffect(() => {
    if (phase !== "navigate" || simulating) return;
    const timer = setInterval(() => {
      if (Date.now() - drive.current.lastFixAt > GPS_LOST_MS) setGpsLost(true);
    }, 2000);
    return () => clearInterval(timer);
  }, [phase, simulating]);

  // A pan, zoom, or rotate by the user stops the camera following the drive.
  useEffect(() => {
    const map = getMap();
    if (!map || phase !== "navigate") return;
    const onUserMove = (event: { originalEvent?: unknown }) => {
      if (event.originalEvent) setFollow(false);
    };
    map.on("dragstart", onUserMove);
    map.on("zoomstart", onUserMove);
    map.on("rotatestart", onUserMove);
    map.on("pitchstart", onUserMove);
    return () => {
      map.off("dragstart", onUserMove);
      map.off("zoomstart", onUserMove);
      map.off("rotatestart", onUserMove);
      map.off("pitchstart", onUserMove);
    };
  }, [getMap, mapReadyGeneration, phase]);

  // The wake lock is dropped when the page is hidden; take it again on return.
  useEffect(() => {
    if (phase !== "navigate") return;
    const onVisible = () => {
      if (document.visibilityState !== "visible" || drive.current.wakeLock) return;
      const wakeLock = (
        navigator as Navigator & {
          wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
        }
      ).wakeLock;
      void wakeLock
        ?.request("screen")
        .then((lock) => {
          drive.current.wakeLock = lock;
        })
        .catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [phase]);

  // Closing the tool ends the drive and puts the camera back.
  useEffect(
    () => () => {
      const d = drive.current;
      d.stopTracking?.();
      d.stopTracking = null;
      d.reroute?.abort();
      d.marker?.remove();
      d.marker = null;
      void d.wakeLock?.release().catch(() => undefined);
      d.wakeLock = null;
      stopSpeaking();
    },
    [],
  );

  const recenter = useCallback(() => {
    setFollow(true);
    const d = drive.current;
    const at = d.state.progress;
    if (at && d.lastFix) moveCamera(d.lastFix, at);
  }, [moveCamera]);

  const overview = useCallback(() => {
    const d = drive.current;
    const current = d.route;
    const map = getMap();
    if (!current || !map) return;
    setFollow(false);
    const from = d.state.progress?.along ?? 0;
    const bounds = boundsOf(
      sliceAlong(current.coordinates, current.cumulative, from, current.distance),
    );
    if (bounds)
      map.fitBounds(bounds, { padding: 100, pitch: 0, bearing: 0, maxZoom: 17, duration: 800 });
  }, [getMap]);

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
      onStart={() => void startDrive(false)}
      onSimulate={() => void startDrive(true)}
      onSave={saveAsLayer}
      saved={savedRoute !== null && savedRoute === route}
      showSteps={showSteps}
      onToggleSteps={() => setShowSteps((v) => !v)}
      onStepClick={(step) => getMap()?.flyTo({ center: step.location, zoom: 17, duration: 800 })}
      onClose={onClose}
      formatDistance={formatDistance}
      formatDuration={formatDuration}
    />
  );
}

// --- Planning view -----------------------------------------------------------

function PlanView({
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
}: {
  waypoints: (NavPoint | null)[];
  pickIndex: number | null;
  onPick: (index: number | null) => void;
  routes: NavRoute[];
  selected: number;
  onSelect: (index: number) => void;
  status: RouteStatus;
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

  return (
    <section
      aria-label={t("navigation.title")}
      className="pointer-events-auto absolute bottom-12 start-2 z-20 flex max-h-[calc(100%-7.5rem)] w-[min(23rem,calc(100vw-1.5rem))] flex-col overflow-y-auto rounded-lg border bg-background shadow-xl"
      data-testid="navigation-panel"
    >
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Signpost className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h2 className="flex-1 text-sm font-semibold">{t("navigation.title")}</h2>
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
      <div className="flex flex-col gap-3 p-3 text-sm">
        <div role="group" aria-label={t("navigation.modeLabel")} className="grid grid-cols-3 gap-1">
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
            const label = point
              ? point.mine
                ? t("navigation.myLocation")
                : `${coordinate.format(point.lat)}, ${coordinate.format(point.lng)}`
              : role === "origin"
                ? t("navigation.choose.origin")
                : role === "destination"
                  ? t("navigation.choose.destination")
                  : t("navigation.choose.stop");
            const roleLabel = t(`navigation.role.${role}` as "navigation.role.origin");
            return (
              <li key={index} className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="inline-block h-3 w-3 shrink-0 rounded-full border-2 border-white shadow"
                  style={{ background: color }}
                />
                <button
                  type="button"
                  className={cn(
                    "min-w-0 flex-1 truncate rounded-md border px-2 py-1.5 text-start text-xs",
                    pickIndex === index && "border-primary ring-1 ring-primary",
                    !point && "text-muted-foreground",
                  )}
                  aria-pressed={pickIndex === index}
                  aria-label={t("navigation.pickOnMap", { role: roleLabel })}
                  title={t("navigation.pickOnMap", { role: roleLabel })}
                  onClick={() => onPick(pickIndex === index ? null : index)}
                  data-testid={`navigation-waypoint-${index}`}
                >
                  {label}
                </button>
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
    </section>
  );
}

function StepList({
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
  return (
    <ol className="flex flex-col divide-y rounded-md border" aria-label={t("navigation.steps")}>
      {route.steps.map((step, index) => {
        const Icon = maneuverIcon(step.type, step.modifier);
        return (
          <li key={index}>
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

// --- Driving view ------------------------------------------------------------

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

function DriveView({
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
}: {
  route: NavRoute;
  phase: Phase;
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
}): ReactElement {
  const { t } = useTranslation();
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

  if (phase === "arrived") {
    return (
      <section
        aria-label={t("navigation.title")}
        className="pointer-events-auto absolute inset-x-0 bottom-12 z-20 mx-auto flex w-[min(26rem,calc(100%-1.5rem))] items-center gap-3 rounded-lg border bg-background p-3 shadow-xl"
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
      <section
        aria-label={t("navigation.nextManeuver")}
        className="pointer-events-auto absolute inset-x-0 top-3 z-20 mx-auto w-[min(26rem,calc(100%-1.5rem))] overflow-hidden rounded-lg bg-blue-800 text-white shadow-xl"
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
              <BannerIcon className="h-10 w-10 shrink-0" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-2xl font-bold tabular-nums leading-tight">
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
        <div className="pointer-events-auto absolute inset-x-0 top-[calc(0.75rem+7.5rem)] z-20 mx-auto flex w-max max-w-[calc(100%-1.5rem)] items-center gap-2 rounded-full border bg-background px-3 py-1 text-xs shadow">
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

      <section
        aria-label={t("navigation.tripStatus")}
        className="pointer-events-auto absolute inset-x-0 bottom-12 z-20 mx-auto flex w-[min(26rem,calc(100%-1.5rem))] items-center gap-2 rounded-lg border bg-background p-2 shadow-xl"
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
            size="sm"
            variant="outline"
            onClick={onRecenter}
            data-testid="navigation-recenter"
          >
            <Navigation2 className="me-1 h-3.5 w-3.5" />
            {t("navigation.recenter")}
          </Button>
        )}
        <Button size="sm" variant="destructive" onClick={onEnd} data-testid="navigation-end">
          {t("navigation.end")}
        </Button>
      </section>
    </>
  );
}
