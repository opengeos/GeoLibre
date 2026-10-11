import { getRoutingConfig, requestNavigationRoute } from "@geolibre/core";
import * as maplibregl from "maplibre-gl";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { watchPosition } from "../../lib/geolocation";
import {
  followZoom,
  initialNavState,
  updateNavigation,
  type NavEvent,
  type NavFix,
  type NavProgress,
  type NavState,
} from "../../lib/navigation/engine";
import {
  createPuckElement,
  requestScreenWakeLock,
  startSimulation,
  type ScreenWakeLock,
} from "../../lib/navigation/device";
import { sliceAlong } from "../../lib/navigation/geometry";
import { logNavigation } from "../../lib/navigation/log";
import { buildNavRouteRequest, parseNavRoutes, type NavRoute } from "../../lib/navigation/route";
import {
  boundsOf,
  fixFromPosition,
  GPS_LOST_MS,
  REROUTE_COOLDOWN_MS,
  REROUTE_SPEAK_MIN_MS,
  REROUTE_TIMEOUT_MS,
  SIM_TICK_MS,
  type NavPhase,
  type NavPoint,
  type NavSettings,
} from "../../lib/navigation/session";
import { speak, stopSpeaking } from "../../lib/navigation/voice";

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
  wakeLock: ScreenWakeLock | null;
  /** Bumped by every start and end, so a start superseded mid-await bails out. */
  startId: number;
}

/** What the drive needs from the planner. */
export interface NavigationDriveOptions {
  getMap: () => maplibregl.Map | null;
  mapReadyGeneration: number;
  /** The route to drive (the planner's selection). */
  route: NavRoute | null;
  /** The planner's waypoints: origin, stops, destination. */
  waypoints: (NavPoint | null)[];
  settings: NavSettings;
  language: string;
  imperial: boolean;
  /** Called with the new route after a reroute, to show it in the planner too. */
  onReroute: (route: NavRoute, waypoints: NavPoint[]) => void;
}

/**
 * The drive: follows the device location (or a simulation) along the route,
 * feeds each fix to the navigation engine, speaks its announcements, moves the
 * arrow and the camera, and reroutes when the drive leaves the route.
 *
 * @param options - The route, waypoints, settings, and map.
 * @returns The drive's state for the banner and status bar, and its controls.
 */
export function useNavigationDrive({
  getMap,
  mapReadyGeneration,
  route,
  waypoints,
  settings,
  language,
  imperial,
  onReroute,
}: NavigationDriveOptions) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<NavPhase>("plan");
  const [progress, setProgress] = useState<NavProgress | null>(null);
  const [offRoute, setOffRoute] = useState(false);
  const [rerouting, setRerouting] = useState(false);
  const [gpsLost, setGpsLost] = useState(false);
  const [follow, setFollow] = useState(true);
  const [simulating, setSimulating] = useState(false);
  const [driveError, setDriveError] = useState<string | null>(null);
  const onRerouteRef = useRef(onReroute);
  onRerouteRef.current = onReroute;

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
    startId: 0,
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
        // The engine no longer counts the drive as off route, so it will not
        // send backOnRoute; clear the banner here or it stays on "Off route".
        setOffRoute(false);
      };
      if (now - d.lastRerouteAt < REROUTE_COOLDOWN_MS) {
        clearLatch();
        return;
      }
      const targets = d.targets.slice(d.state.stopsPassed);
      if (targets.length === 0) {
        clearLatch();
        return;
      }
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
          onRerouteRef.current(next, [{ lng: fix.lng, lat: fix.lat, mine: true }, ...targets]);
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
      const startId = ++d.startId;
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

      d.marker?.remove();
      d.marker = new maplibregl.Marker({
        element: createPuckElement(),
        rotationAlignment: "map",
        pitchAlignment: "map",
      })
        .setLngLat(route.coordinates[0])
        .addTo(map);

      // Keep the screen on while driving, where the platform allows it.
      const lock = await requestScreenWakeLock();
      // The drive may have ended (or the tool closed) during the await.
      if (d.startId !== startId) {
        void lock?.release().catch(() => undefined);
        return;
      }
      d.wakeLock = lock;

      if (simulate) {
        const stop = startSimulation(route, () => settingsRef.current.simSpeed, handleFix);
        // The first fix runs synchronously and can already arrive (a tiny
        // route), when stopTracking found nothing to stop yet.
        if (d.startId !== startId || d.state.arrived) stop();
        else d.stopTracking = stop;
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
        if (d.startId !== startId || !d.marker) {
          unsubscribe();
          return;
        }
        d.stopTracking = unsubscribe;
      } catch (error) {
        if (d.startId !== startId) return;
        logNavigation("Could not start following the device location.", error);
        setDriveError(langRef.current.t("navigation.locationError"));
      }
    },
    [getMap, handleFix, route, stopTracking, waypoints],
  );

  const endDrive = useCallback(() => {
    stopTracking();
    const d = drive.current;
    d.startId += 1;
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
      void requestScreenWakeLock().then((lock) => {
        // Granted after the drive ended: give it straight back.
        if (!drive.current.route || drive.current.wakeLock) {
          void lock?.release().catch(() => undefined);
          return;
        }
        drive.current.wakeLock = lock;
      });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [phase]);

  // Closing the tool ends the drive: tracking, reroute, wake lock, voice, arrow.
  useEffect(
    () => () => {
      stopTracking();
      // A wake lock still being requested sees the drive gone and releases it.
      drive.current.route = null;
      drive.current.startId += 1;
      drive.current.marker?.remove();
      drive.current.marker = null;
    },
    [stopTracking],
  );

  const recenter = useCallback(() => {
    setFollow(true);
    const d = drive.current;
    const at = d.state.progress;
    if (at && d.lastFix) moveCamera(d.lastFix, at);
  }, [moveCamera]);

  /** Look at a point on the route (a step, a stop) without ending the drive. */
  const focus = useCallback(
    (center: [number, number]) => {
      setFollow(false);
      getMap()?.flyTo({ center, zoom: 17, pitch: 0, duration: 800 });
    },
    [getMap],
  );

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

  return {
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
  };
}
