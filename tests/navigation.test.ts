import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  bearing,
  bearingDifference,
  cumulativeDistances,
  haversine,
  pointAlong,
  projectOntoPolyline,
  sliceAlong,
  type LngLat,
} from "../apps/geolibre-desktop/src/lib/navigation/geometry";
import {
  buildNavRouteRequest,
  navRouteToFeatureCollection,
  parseNavRoutes,
  type NavRoute,
} from "../apps/geolibre-desktop/src/lib/navigation/route";
import {
  followZoom,
  initialNavState,
  offRouteCorridor,
  remainingDuration,
  simulatedFix,
  stepAt,
  updateNavigation,
  type NavEvent,
  type NavFix,
  type NavState,
} from "../apps/geolibre-desktop/src/lib/navigation/engine";
import {
  formatArrivalTime,
  formatNavDistance,
  formatNavDuration,
} from "../apps/geolibre-desktop/src/lib/navigation/format";
import {
  activeBanner,
  boundsOf,
  DEFAULT_NAV_SETTINGS,
  fixFromPosition,
  loadNavSettings,
  NARROW_BOTTOM_CLEARANCE,
  NAV_SETTINGS_KEY,
  PLAN_PANEL_CLEARANCE,
  planPadding,
  saveNavSettings,
  parseTypedCoordinates,
  upcomingStops,
} from "../apps/geolibre-desktop/src/lib/navigation/session";

// A real Valhalla OSRM-format response (Knoxville, TN; origin, one stop, and a
// destination), trimmed to one intersection per step.
const fixture: unknown = JSON.parse(
  readFileSync(new URL("./fixtures/valhalla-navigation-route.json", import.meta.url), "utf8"),
);

function loadRoute(): NavRoute {
  const routes = parseNavRoutes(fixture, "auto");
  assert.equal(routes.length, 1);
  return routes[0];
}

/** Drive a route by feeding fixes, collecting every event. */
function drive(route: NavRoute, fixes: NavFix[], start: NavState = initialNavState()) {
  let state = start;
  const events: NavEvent[] = [];
  for (const fix of fixes) {
    const next = updateNavigation(route, state, fix);
    state = next.state;
    events.push(...next.events);
  }
  return { state, events };
}

/** Fixes every `stepMeters` along the route, as a simulated drive. */
function simulatedDrive(route: NavRoute, stepMeters = 10, until = route.distance): NavFix[] {
  const fixes: NavFix[] = [];
  for (let along = 0, t = 0; along <= until; along += stepMeters, t += 1000) {
    fixes.push(simulatedFix(route, along, t));
  }
  fixes.push(simulatedFix(route, until, fixes.length * 1000));
  return fixes;
}

/** Move a point sideways (east) by a number of metres. */
function offsetEast([lng, lat]: LngLat, meters: number): LngLat {
  return [lng + meters / (111_320 * Math.cos((lat * Math.PI) / 180)), lat];
}

describe("navigation geometry", () => {
  it("measures distances and bearings", () => {
    const a: LngLat = [0, 0];
    const b: LngLat = [0, 1];
    assert.ok(Math.abs(haversine(a, b) - 111_195) < 10);
    assert.ok(Math.abs(bearing(a, b) - 0) < 1e-9);
    assert.ok(Math.abs(bearing(a, [1, 0]) - 90) < 1e-6);
    assert.equal(bearingDifference(350, 10), 20);
    assert.equal(bearingDifference(90, 270), 180);
  });

  it("projects a point onto a polyline and interpolates along it", () => {
    const line: LngLat[] = [
      [0, 0],
      [0.01, 0],
      [0.01, 0.01],
    ];
    const cumulative = cumulativeDistances(line);
    const projection = projectOntoPolyline(line, cumulative, [0.005, 0.0001]);
    assert.ok(projection);
    assert.equal(projection.segmentIndex, 0);
    assert.ok(Math.abs(projection.offset - 11.1) < 0.5);
    assert.ok(Math.abs(projection.along - cumulative[1] / 2) < 1);
    const mid = pointAlong(line, cumulative, cumulative[1]);
    assert.deepEqual(mid, [0.01, 0]);
    // A window that excludes the first segment forces the match onto the second.
    const windowed = projectOntoPolyline(
      line,
      cumulative,
      [0.005, 0.0001],
      [cumulative[1] + 1, cumulative[2]],
    );
    assert.equal(windowed?.segmentIndex, 1);
    const slice = sliceAlong(line, cumulative, 100, cumulative[1] + 100);
    assert.equal(slice.length, 3);
    assert.deepEqual(slice[1], [0.01, 0]);
  });
});

describe("navigation route request", () => {
  it("asks Valhalla for OSRM-format turn-by-turn output", () => {
    const body = buildNavRouteRequest({
      waypoints: [
        { lng: -83.92, lat: 35.96 },
        { lng: -83.94, lat: 35.95 },
      ],
      mode: "auto",
      language: "de",
      imperial: false,
      alternates: 2,
    });
    assert.equal(body.format, "osrm");
    assert.equal(body.voice_instructions, true);
    assert.equal(body.banner_instructions, true);
    assert.equal(body.language, "de");
    assert.equal(body.units, "kilometers");
    assert.equal(body.alternates, 2);
    assert.equal(body.costing_options, undefined);
    assert.deepEqual(body.locations, [
      { lon: -83.92, lat: 35.96 },
      { lon: -83.94, lat: 35.95 },
    ]);
  });

  it("adds the start heading, avoids, and miles, and drops alternates with stops", () => {
    const body = buildNavRouteRequest({
      waypoints: [
        { lng: 1, lat: 2 },
        { lng: 3, lat: 4 },
        { lng: 5, lat: 6 },
      ],
      mode: "auto",
      language: "en",
      imperial: true,
      heading: -90,
      alternates: 2,
      avoid: { tolls: true, highways: false, ferries: true },
    });
    const locations = body.locations as Record<string, unknown>[];
    assert.equal(locations[0].heading, 270);
    assert.equal(locations[0].heading_tolerance, 60);
    assert.equal(locations[1].heading, undefined);
    assert.equal(body.units, "miles");
    assert.equal(body.alternates, undefined);
    assert.deepEqual(body.costing_options, { auto: { use_tolls: 0, use_ferry: 0 } });
  });

  it("ignores avoids for walking and cycling", () => {
    const body = buildNavRouteRequest({
      waypoints: [
        { lng: 1, lat: 2 },
        { lng: 3, lat: 4 },
      ],
      mode: "pedestrian",
      language: "en",
      imperial: false,
      avoid: { tolls: true, highways: true, ferries: true },
    });
    assert.equal(body.costing_options, undefined);
  });
});

describe("navigation route parsing", () => {
  it("flattens legs into one line with every step placed on it", () => {
    const route = loadRoute();
    assert.equal(route.mode, "auto");
    assert.equal(route.voiceLocale, "en-US");
    assert.equal(route.legEnds.length, 2);
    assert.equal(route.steps.length, 6);
    assert.deepEqual(
      route.steps.map((s) => s.type),
      ["depart", "turn", "arrive", "depart", "turn", "arrive"],
    );
    // The rebuilt geometry measures about what the router reported.
    assert.ok(Math.abs(route.distance - 2189) < 25, `distance ${route.distance}`);
    // Steps tile the line without gaps.
    for (let i = 1; i < route.steps.length; i += 1) {
      assert.equal(route.steps[i].startDistance, route.steps[i - 1].endDistance);
    }
    assert.equal(route.steps.at(-1)?.endDistance, route.distance);
    assert.equal(route.legEnds.at(-1), route.distance);
    // Announcements are sorted farthest first.
    const voice = route.steps[1].voice;
    assert.equal(voice.length, 3);
    assert.ok(voice[0].distanceBefore > voice[1].distanceBefore);
    assert.match(voice[2].text, /destination/i);
    assert.equal(route.steps[0].banners[0].text, "Cumberland Avenue");
    assert.equal(route.steps[0].banners[0].modifier, "left");
    assert.equal(
      route.summary,
      "US 441, Cumberland Avenue · Cumberland Avenue, Tyson McGhee Park Street Southwest",
    );
  });

  it("returns no routes for an error body", () => {
    assert.deepEqual(parseNavRoutes({ error: "No path could be found" }, "auto"), []);
    assert.deepEqual(parseNavRoutes(null, "auto"), []);
  });

  it("saves the route and its maneuvers as GeoJSON", () => {
    const route = loadRoute();
    const collection = navRouteToFeatureCollection(route);
    assert.equal(collection.features.length, 1 + route.steps.length);
    assert.equal(collection.features[0].geometry.type, "LineString");
    assert.equal(collection.features[1].properties?.instruction, route.steps[0].instruction);
  });
});

describe("navigation engine", () => {
  it("widens the off-route corridor with the fix's accuracy", () => {
    assert.deepEqual(offRouteCorridor("auto", 5), { corridor: 28, far: 56 });
    assert.deepEqual(offRouteCorridor("auto", null), { corridor: 42, far: 84 });
    assert.deepEqual(offRouteCorridor("auto", 30), { corridor: 70, far: 110 });
    assert.ok(offRouteCorridor("pedestrian", 5).corridor < offRouteCorridor("auto", 5).corridor);
  });

  it("drives a simulated trip end to end", () => {
    const route = loadRoute();
    const { state, events } = drive(route, simulatedDrive(route));
    assert.equal(state.arrived, true);
    assert.equal(state.offRoute, false);
    assert.ok(!events.some((e) => e.type === "offRoute"), "never off route");
    assert.equal(events.filter((e) => e.type === "arrive").length, 1);
    assert.equal(events.filter((e) => e.type === "stop").length, 1);
    const spoken = events.flatMap((e) => (e.type === "speak" ? [e.text] : []));
    // Every announcement of every step is spoken once, in order, on a drive
    // with fixes every 10 m (none is closer than that to the next).
    const expected = route.steps.flatMap((s) => s.voice.map((v) => v.text));
    assert.deepEqual(spoken, expected);
    assert.ok(state.progress && state.progress.distanceRemaining <= 20);
  });

  it("speaks only the closest announcement when several fall due at once", () => {
    const route = loadRoute();
    const step = route.steps[1];
    // Start right before the turn at the end of step 1: the "continue" and
    // "in 300 m" lines are stale, only the last one is spoken.
    const along = step.endDistance - 50;
    const { events } = drive(route, [simulatedFix(route, along, 0)]);
    const spoken = events.flatMap((e) => (e.type === "speak" ? [e.text] : []));
    assert.deepEqual(spoken, [step.voice[step.voice.length - 1].text]);
  });

  it("reports progress, the next maneuver, and the time left", () => {
    const route = loadRoute();
    const along = route.steps[1].startDistance + 100;
    const { state } = drive(route, [simulatedFix(route, along, 0)]);
    const progress = state.progress;
    assert.ok(progress);
    assert.equal(progress.stepIndex, 1);
    assert.ok(Math.abs(progress.along - along) < 1);
    assert.ok(Math.abs(progress.distanceToManeuver - (route.steps[1].endDistance - along)) < 1);
    assert.ok(Math.abs(progress.distanceToNextStop - (route.legEnds[0] - along)) < 1);
    assert.ok(progress.durationRemaining > 0 && progress.durationRemaining < route.duration);
    assert.equal(stepAt(route, along), 1);
    assert.ok(remainingDuration(route, 0, 0) <= route.duration + 1);
  });

  it("goes off route after three fixes well away from the line, then reroutes once", () => {
    const route = loadRoute();
    const along = route.steps[1].startDistance + 200;
    const onRoute = drive(route, [simulatedFix(route, along, 0)]);
    const away = offsetEast(pointAlong(route.coordinates, route.cumulative, along + 20), 150);
    const fixes: NavFix[] = [1, 2, 3, 4].map((i) => ({
      lng: away[0],
      lat: away[1] + i * 0.0001,
      accuracy: 5,
      speed: 10,
      heading: null,
      timestamp: i * 1000,
    }));
    const { state, events } = drive(route, fixes, onRoute.state);
    assert.equal(state.offRoute, true);
    assert.equal(events.filter((e) => e.type === "offRoute").length, 1);
    // No announcements are made while off route.
    assert.ok(!events.some((e) => e.type === "speak"));
    // Progress did not jump while off the line.
    assert.ok(state.progress && Math.abs(state.progress.along - along) < 1);
  });

  it("never goes off route while stationary near the line", () => {
    const route = loadRoute();
    const along = route.steps[1].startDistance + 200;
    const start = drive(route, [simulatedFix(route, along, 0)]);
    // 50 m off (outside a 28 m corridor, inside the 56 m far distance), stopped.
    const near = offsetEast(pointAlong(route.coordinates, route.cumulative, along), 50);
    const fixes: NavFix[] = Array.from({ length: 10 }, (_, i) => ({
      lng: near[0],
      lat: near[1],
      accuracy: 5,
      speed: 0,
      timestamp: (i + 1) * 1000,
    }));
    const { state } = drive(route, fixes, start.state);
    assert.equal(state.offRoute, false);
  });

  it("counts driving against the route as off route even inside the corridor", () => {
    const route = loadRoute();
    const along = route.steps[1].startDistance + 300;
    const start = drive(route, [simulatedFix(route, along, 0)]);
    const fixes: NavFix[] = [1, 2, 3].map((i) => {
      const fix = simulatedFix(route, along - i * 10, i * 1000);
      return { ...fix, heading: ((fix.heading ?? 0) + 180) % 360 };
    });
    const { state } = drive(route, fixes, start.state);
    assert.equal(state.offRoute, true);
  });

  it("returns to the route after two fixes back on it", () => {
    const route = loadRoute();
    const offState: NavState = { ...initialNavState(), offRoute: true };
    const along = route.steps[1].startDistance + 100;
    const { state, events } = drive(
      route,
      [simulatedFix(route, along, 0), simulatedFix(route, along + 10, 1000)],
      offState,
    );
    assert.equal(state.offRoute, false);
    assert.ok(events.some((e) => e.type === "backOnRoute"));
  });

  it("zooms out on fast roads", () => {
    assert.ok(followZoom(30, "auto") < followZoom(5, "auto"));
    assert.equal(followZoom(1, "pedestrian"), 18);
  });
});

describe("navigation session helpers", () => {
  const memoryStorage = () => {
    const data = new Map<string, string>();
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    };
  };

  it("round-trips settings and drops invalid values", () => {
    const storage = memoryStorage();
    assert.deepEqual(loadNavSettings(storage), DEFAULT_NAV_SETTINGS);
    saveNavSettings(
      {
        mode: "bicycle",
        avoid: { tolls: true, highways: false, ferries: true },
        voice: false,
        simSpeed: 4,
      },
      storage,
    );
    assert.deepEqual(loadNavSettings(storage), {
      mode: "bicycle",
      avoid: { tolls: true, highways: false, ferries: true },
      voice: false,
      simSpeed: 4,
    });
    storage.setItem(NAV_SETTINGS_KEY, JSON.stringify({ mode: "plane", simSpeed: 3, avoid: "x" }));
    const cleaned = loadNavSettings(storage);
    assert.equal(cleaned.mode, "auto");
    assert.equal(cleaned.simSpeed, DEFAULT_NAV_SETTINGS.simSpeed);
    assert.deepEqual(cleaned.avoid, { tolls: false, highways: false, ferries: false });
    storage.setItem(NAV_SETTINGS_KEY, "{not json");
    assert.deepEqual(loadNavSettings(storage), DEFAULT_NAV_SETTINGS);
    assert.deepEqual(loadNavSettings(null), DEFAULT_NAV_SETTINGS);
  });

  it("turns a browser position into a fix, nulling NaN heading and speed", () => {
    const fix = fixFromPosition({
      coords: { longitude: 1, latitude: 2, accuracy: 8, heading: Number.NaN, speed: null },
      timestamp: 42,
    } as unknown as GeolocationPosition);
    assert.deepEqual(fix, {
      lng: 1,
      lat: 2,
      accuracy: 8,
      heading: null,
      speed: null,
      timestamp: 42,
    });
  });

  it("computes bounds and padding that clears the planner", () => {
    assert.equal(boundsOf([]), null);
    assert.deepEqual(
      boundsOf([
        [1, 5],
        [-2, 3],
        [4, -1],
      ]),
      [
        [-2, -1],
        [4, 5],
      ],
    );
    assert.equal(planPadding(1000, false).left, PLAN_PANEL_CLEARANCE);
    assert.equal(planPadding(1000, true).right, PLAN_PANEL_CLEARANCE);
    assert.equal(planPadding(700, false).left, 60);
    assert.equal(planPadding(400, false).bottom, NARROW_BOTTOM_CLEARANCE);
  });

  it("shows the closest banner now due", () => {
    const route = loadRoute();
    const step = route.steps[1];
    assert.equal(activeBanner(undefined, 0), null);
    const far = activeBanner(step, step.distance + 1000);
    assert.equal(far, step.banners[0]);
    assert.equal(activeBanner(step, 0), step.banners[step.banners.length - 1]);
  });
});

describe("navigation formatting", () => {
  it("rounds distances like a navigation banner", () => {
    assert.equal(formatNavDistance(37, false, "en"), "40 m");
    assert.equal(formatNavDistance(260, false, "en"), "250 m");
    assert.equal(formatNavDistance(1234, false, "en"), "1.2 km");
    assert.equal(formatNavDistance(15_600, false, "en"), "16 km");
    assert.equal(formatNavDistance(30, true, "en"), "100 ft");
    assert.equal(formatNavDistance(1609.344 * 2.34, true, "en"), "2.3 mi");
  });

  it("formats durations and arrival times", () => {
    assert.equal(formatNavDuration(30, "en"), "1 min");
    assert.equal(formatNavDuration(12 * 60, "en"), "12 min");
    assert.equal(formatNavDuration(3600, "en"), "1 hr");
    assert.equal(formatNavDuration(3900, "en"), "1 hr 5 min");
    const now = Date.UTC(2026, 0, 1, 12, 0);
    assert.match(formatArrivalTime(600, "en", now), /\d{1,2}:10/);
  });
});

describe("upcoming stops", () => {
  it("lists the stop and the destination with distance and time to each", () => {
    const route = loadRoute();
    const stops = upcomingStops(route, 0);
    assert.equal(stops.length, 2);
    assert.equal(stops[0].destination, false);
    assert.equal(stops[1].destination, true);
    assert.ok(Math.abs(stops[0].distance - route.legEnds[0]) < 1e-6);
    assert.ok(Math.abs(stops[1].distance - route.distance) < 1e-6);
    assert.ok(stops[0].duration > 0 && stops[0].duration < stops[1].duration);
    assert.ok(
      Math.abs(stops[1].duration - route.steps.reduce((sum, s) => sum + s.duration, 0)) < 1,
    );
    assert.equal(stops[0].name, route.waypointNames[1]);
  });

  it("drops a stop once it is passed", () => {
    const route = loadRoute();
    const stops = upcomingStops(route, route.legEnds[0] + 50);
    assert.equal(stops.length, 1);
    assert.equal(stops[0].destination, true);
    assert.ok(Math.abs(stops[0].distance - (route.distance - route.legEnds[0] - 50)) < 1e-6);
  });
});

describe("typed coordinates", () => {
  it("reads lat, lng pairs and rejects anything else", () => {
    assert.deepEqual(parseTypedCoordinates("35.96, -83.92"), { lat: 35.96, lng: -83.92 });
    assert.deepEqual(parseTypedCoordinates(" -12.5 130 "), { lat: -12.5, lng: 130 });
    assert.equal(parseTypedCoordinates("91, 10"), null);
    assert.equal(parseTypedCoordinates("10, 181"), null);
    assert.equal(parseTypedCoordinates("1600 Pennsylvania Ave"), null);
    assert.equal(parseTypedCoordinates("35.96"), null);
  });
});

describe("round trips", () => {
  /** A square loop that starts and ends at the same corner. */
  function loopRoute(): NavRoute {
    const coordinates: LngLat[] = [
      [0, 0],
      [0.01, 0],
      [0.01, 0.01],
      [0, 0.01],
      [0, 0],
    ];
    const cumulative = cumulativeDistances(coordinates);
    const distance = cumulative[cumulative.length - 1];
    return {
      coordinates,
      cumulative,
      distance,
      duration: distance / 10,
      steps: [
        {
          legIndex: 0,
          type: "depart",
          instruction: "Go",
          name: "",
          location: coordinates[0],
          distance,
          duration: distance / 10,
          startDistance: 0,
          endDistance: distance,
          voice: [],
          banners: [],
        },
      ],
      legEnds: [distance],
      voiceLocale: "en-US",
      summary: "",
      waypointNames: [],
      mode: "auto",
    };
  }

  it("does not arrive on the first fix when the start is the destination", () => {
    const route = loopRoute();
    const { state, events } = drive(route, [simulatedFix(route, 0, 0)]);
    assert.equal(state.arrived, false);
    assert.ok(!events.some((e) => e.type === "arrive"));
    assert.ok(state.progress && state.progress.along < 1);
  });

  it("arrives at the end of the loop", () => {
    const route = loopRoute();
    const { state } = drive(route, simulatedDrive(route, 20));
    assert.equal(state.arrived, true);
  });
});
