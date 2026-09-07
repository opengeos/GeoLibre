import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { useAppStore } from "../packages/core/src/store";
import type { MapViewState } from "../packages/core/src/types";
import {
  CesiumEngine,
  CESIUM_CAPABILITIES,
  resetPrimaryCesiumBuiltInControlState,
} from "../packages/map/src/cesium-engine";
import {
  setPrimaryCesiumControlHost,
  type CesiumControlHost,
} from "../packages/map/src/cesium-control-host";

// The globe's camera state machine, which moved out of CesiumCanvas's mount
// effect and into CesiumEngine (issue #2260). It had no coverage while it lived
// in the component — a React effect full of refs — and it is the part that has
// to stay exactly right: it decides which camera moves reach the store, which
// of them mark the project dirty, and when a terrain load may reposition the
// camera. All three are invisible when they break.
//
// The real Cesium engine never loads here (its import in the module under test
// is type-only), so the namespace and widget are faked. The camera *maths* is
// real: readMapViewFromCamera and applyMapViewToCamera run against these fakes,
// so an echo is suppressed by the same tolerance the app uses.

/** A minimal Cesium namespace: just what the camera path touches. */
function makeCesium() {
  class Cartesian2 {
    constructor(
      public x: number,
      public y: number,
    ) {}
  }
  class Cartesian3 {
    constructor(
      public x: number,
      public y: number,
      public z: number,
    ) {}
    static fromDegrees(lng: number, lat: number, height = 0) {
      // Not a real geodetic conversion — just an invertible encoding, so
      // fromDegrees → fromCartesian round-trips through the fake.
      return new Cartesian3(lng, lat, height);
    }
    static distance(a: { z?: number }, b: { z?: number }) {
      return Math.abs((a.z ?? 0) - (b.z ?? 0));
    }
  }
  class Cartographic {
    constructor(
      public longitude: number,
      public latitude: number,
      public height: number,
    ) {}
    static fromDegrees(lng: number, lat: number, height = 0) {
      return new Cartographic(toRad(lng), toRad(lat), height);
    }
    static fromCartesian(c: { x: number; y: number; z: number }) {
      return new Cartographic(toRad(c.x), toRad(c.y), c.z);
    }
  }
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  class HeadingPitchRange {
    constructor(
      public heading: number,
      public pitch: number,
      public range: number,
    ) {}
  }
  class BoundingSphere {
    constructor(
      public center: unknown,
      public radius: number,
    ) {}
  }
  return {
    Cartesian2,
    Cartesian3,
    Cartographic,
    HeadingPitchRange,
    BoundingSphere,
    Ellipsoid: { WGS84: { name: "wgs84" } },
    Matrix4: { IDENTITY: "identity" },
    Rectangle: {
      fromDegrees: (w: number, s: number, e: number, n: number) => ({ w, s, e, n }),
    },
    EllipsoidTerrainProvider: class {
      readonly kind = "ellipsoid";
    },
    // Cesium's own numbering, which the engine compares `scene.mode` against.
    SceneMode: { MORPHING: 0, COLUMBUS_VIEW: 1, SCENE2D: 2, SCENE3D: 3 },
    Math: {
      toRadians: toRad,
      // Cesium's own `Math.toDegrees` throws `DeveloperError` on a missing
      // value rather than returning NaN, which is what turns an unguarded
      // mid-morph camera read into a thrown error instead of a bad number.
      toDegrees: (rad: number) => {
        if (typeof rad !== "number") throw new Error("DeveloperError: radians is required.");
        return (rad * 180) / Math.PI;
      },
    },
    createWorldTerrainAsync: () => Promise.resolve({ kind: "world-terrain" }),
  } as unknown as typeof import("@cesium/engine");
}

/** A tiny stand-in for Cesium's Event (addEventListener/removeEventListener). */
function makeEvent() {
  const listeners = new Set<(...args: never[]) => void>();
  return {
    addEventListener: (fn: (...args: never[]) => void) => listeners.add(fn),
    removeEventListener: (fn: (...args: never[]) => void) => listeners.delete(fn),
    emit: (...args: unknown[]) => {
      for (const fn of [...listeners]) (fn as (...a: unknown[]) => void)(...args);
    },
    get size() {
      return listeners.size;
    },
  };
}

/**
 * A fake CesiumWidget whose camera can be moved directly. `nudge` is how a test
 * says "the camera is somewhere else now", standing in for whatever Cesium's own
 * navigation would have done, and `fireCanvas` stands in for the raw pointer,
 * wheel, and touch input the engine listens for.
 */
function makeViewer(groundHeight = 0) {
  // Mutable so a test can make terrain *arrive* — a fixed height means the
  // correction's own guard exits before re-applying and the assertion passes
  // whether or not it ran.
  let height = groundHeight;
  let groundPick = true;
  let ellipsoidPick = true;
  const moveEnd = makeEvent();
  const tileLoadProgressEvent = makeEvent();
  const morphComplete = makeEvent();
  const canvasListeners = new Map<string, Set<(event: unknown) => void>>();
  const canvas = {
    clientWidth: 800,
    clientHeight: 600,
    width: 800,
    height: 600,
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      if (!canvasListeners.has(type)) canvasListeners.set(type, new Set());
      canvasListeners.get(type)?.add(fn);
    },
    removeEventListener: (type: string, fn: (event: unknown) => void) => {
      canvasListeners.get(type)?.delete(fn);
    },
  };
  const state = { lng: 0, lat: 0, range: 1000, heading: 0, pitch: -Math.PI / 2 };
  const lookAtCount = { n: 0 };
  const viewer = {
    isDestroyed: () => false,
    canvas,
    terrainProvider: { kind: "initial" } as unknown,
    camera: {
      get positionWC() {
        return { x: state.lng, y: state.lat, z: state.range };
      },
      get positionCartographic() {
        return { longitude: 0, latitude: 0, height: state.range };
      },
      get heading() {
        return state.heading;
      },
      get pitch() {
        return state.pitch;
      },
      frustum: { fovy: Math.PI / 3 },
      moveEnd,
      moveStart: makeEvent(),
      // applyMapViewToCamera drives these; the fake records the resulting view.
      lookAt: (target: { x: number; y: number; z: number }, hpr: HprLike) => {
        lookAtCount.n++;
        state.lng = target.x;
        state.lat = target.y;
        state.range = hpr.range;
        state.heading = hpr.heading;
        state.pitch = hpr.pitch;
      },
      lookAtTransform: () => {},
      flyTo: (options: { destination?: unknown; duration?: number }) => {
        flights.push(options);
      },
      flyToBoundingSphere: (sphere: { center: CenterLike }, options: FlightOptions) => {
        flights.push({ sphere, ...options });
        // Cesium lands the camera at the requested pose; the fake does it
        // instantly so a following moveEnd reads the destination back.
        state.lng = sphere.center.x;
        state.lat = sphere.center.y;
        state.range = options.offset.range;
        state.heading = options.offset.heading;
        state.pitch = options.offset.pitch;
      },
      getPickRay: () => ({ ray: true }),
      pickEllipsoid: () => (ellipsoidPick ? { x: state.lng, y: state.lat, z: 0 } : undefined),
    },
    scene: {
      canvas,
      // SCENE3D, matching the fake namespace above. Mutable so a test can put
      // the scene mid-morph (or in 2D) the way the scene-mode picker does.
      mode: 3,
      morphComplete,
      verticalExaggeration: 1,
      screenSpaceCameraController: {
        minimumZoomDistance: 0,
        maximumZoomDistance: Infinity,
      },
      globe: {
        ellipsoid: {
          name: "wgs84",
          cartesianToCartographic: makeCesium().Cartographic.fromCartesian,
        },
        tileLoadProgressEvent,
        getHeight: () => height,
        pick: () => (groundPick ? { x: state.lng, y: state.lat, z: height } : undefined),
      },
    },
  };
  const flights: unknown[] = [];
  interface HprLike {
    heading: number;
    pitch: number;
    range: number;
  }
  interface CenterLike {
    x: number;
    y: number;
    z: number;
  }
  interface FlightOptions {
    offset: HprLike;
    duration?: number;
  }
  return {
    viewer: viewer as never,
    setPickHits(ground: boolean, ellipsoid: boolean) {
      groundPick = ground;
      ellipsoidPick = ellipsoid;
    },
    moveEnd,
    tileLoadProgressEvent,
    morphComplete,
    /** Put the scene in a scene mode, as the scene-mode picker's morph does. */
    setSceneMode(mode: number) {
      viewer.scene.mode = mode;
    },
    /**
     * Make the camera report what Cesium reports mid-morph: `heading` and
     * `pitch` become `undefined`, and `Math.toDegrees` throws on them. Without
     * this the fake would keep answering with numbers and a missing morph guard
     * would pass the test it is supposed to fail.
     */
    breakCameraForMorph() {
      state.heading = undefined as unknown as number;
      state.pitch = undefined as unknown as number;
    },
    flights,
    canvasListeners,
    /** Nudge the camera as if the user had navigated there. */
    nudge(deltaLng: number) {
      state.lng += deltaLng;
    },
    fireCanvas(type: string, event: unknown = {}) {
      for (const fn of canvasListeners.get(type) ?? []) fn(event);
    },
    /** Simulate terrain tiles arriving and raising the ground. */
    setGroundHeight(next: number) {
      height = next;
    },
    /** How many times the camera has been placed by applyMapViewToCamera. */
    get placements() {
      return lookAtCount.n;
    },
  };
}

const VIEW: MapViewState = { center: [0, 0], zoom: 4, bearing: 0, pitch: 0 };

describe("CesiumEngine capabilities", () => {
  it("declares the globe's real surface, and freezes it", () => {
    assert.equal(CESIUM_CAPABILITIES.terrain, true);
    assert.equal(CESIUM_CAPABILITIES.styleSpec, false);
    assert.equal(CESIUM_CAPABILITIES.nativeMapInstance, false);
    assert.ok(Object.isFrozen(CESIUM_CAPABILITIES));
  });

  it("does not let a grid pane mount controls on the primary globe's host", () => {
    // The control host is a singleton owned by the primary map area, so
    // delegating from a pane would mount its control onto a different viewer —
    // or onto nothing when the primary renderer is MapLibre (#2266 review).
    //
    // A registered host is what makes this test mean anything: without one an
    // unguarded addControl would answer `false` too, and the assertion would
    // pass whether or not the guard exists.
    const calls = { added: 0, removed: 0 };
    const host = {
      addControl: () => {
        calls.added++;
        return true;
      },
      removeControl: () => {
        calls.removed++;
      },
    } as unknown as CesiumControlHost;
    setPrimaryCesiumControlHost(host);
    try {
      const fakes = makeViewer();
      const pane = new CesiumEngine(makeCesium(), fakes.viewer, { viewId: "pane-1" });
      assert.equal(pane.addControl({} as never), false);
      pane.removeControl({} as never);
      assert.equal(calls.added, 0, "a pane must not reach the primary host");
      assert.equal(calls.removed, 0, "nor unmount a control it never added");
      // ...and the capability says so, rather than advertising one it refuses.
      assert.equal(pane.capabilities.domControls, false);
      pane.destroy();

      // The primary globe, by contrast, does delegate to the host.
      const primaryFakes = makeViewer();
      const primary = new CesiumEngine(makeCesium(), primaryFakes.viewer);
      assert.equal(primary.addControl({} as never), true);
      assert.equal(calls.added, 1);
      assert.equal(primary.capabilities.domControls, true);
      primary.destroy();
    } finally {
      setPrimaryCesiumControlHost(null);
      resetPrimaryCesiumBuiltInControlState();
    }
    assert.equal(CESIUM_CAPABILITIES.domControls, true, "the primary globe still hosts controls");
  });

  it("reports no MapLibre map and refuses controls, rather than pretending", () => {
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    assert.equal(engine.getMap(), null);
    // No control host registered in this test, so there is nowhere to mount:
    // `false` is what callers already read as "not available".
    assert.equal(engine.addControl({} as never), false);
    assert.equal(engine.kind, "cesium");
    engine.destroy();
  });
});

describe("CesiumEngine camera publishing", () => {
  let writes: Array<{ view: MapViewState; markDirty: boolean }>;

  beforeEach(() => {
    writes = [];
    useAppStore.setState({
      mapView: { center: [0, 0], zoom: 4, bearing: 0, pitch: 0 },
      setMapView: ((view: MapViewState, markDirty = false) => {
        writes.push({ view, markDirty });
      }) as never,
    } as never);
  });

  it("suppresses the echo of its own applyView", () => {
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    engine.applyView(VIEW);
    // Applying a view is what fires Cesium's moveEnd in the real engine.
    fakes.moveEnd.emit();
    assert.equal(writes.length, 0, "an applied view must not be published back");
    engine.destroy();
  });

  it("does not publish the widget's startup camera before the view is seeded", () => {
    // Regression: a fresh CesiumWidget settles onto its own default camera and
    // fires moveEnd before CesiumCanvas applies the project's view. Publishing
    // that overwrites the stored camera with Cesium's default — the project
    // opens somewhere the user never chose, and switching 2D→3D→2D loses the
    // view. Caught by driving the real app, not by the suite.
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    // No applyView yet: this is the window between construction and the seed.
    fakes.nudge(25);
    fakes.moveEnd.emit();
    assert.equal(writes.length, 0, "an unseeded globe must not publish a camera");
    // Once seeded, publishing resumes normally.
    engine.applyView(VIEW);
    fakes.fireCanvas("wheel");
    fakes.nudge(25);
    fakes.moveEnd.emit();
    assert.equal(writes.length, 1);
    engine.destroy();
  });

  it("publishes a user's own navigation and marks the project dirty", () => {
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    engine.applyView(VIEW);
    fakes.fireCanvas("wheel");
    fakes.nudge(25);
    fakes.moveEnd.emit();
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.markDirty, true);
    engine.destroy();
  });

  it("publishes an autonomous settle without dirtying the project", () => {
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    engine.applyView(VIEW);
    // No input event: a container resize or a terrain settle moved the camera.
    fakes.nudge(25);
    fakes.moveEnd.emit();
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.markDirty, false);
    engine.destroy();
  });

  it("ignores a hover, which is not a camera move", () => {
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    engine.applyView(VIEW);
    // buttons === 0: the pointer is moving but nothing is being dragged. Arming
    // the flag here would let a later autonomous settle consume it and dirty the
    // project.
    fakes.fireCanvas("pointermove", { buttons: 0 });
    fakes.nudge(25);
    fakes.moveEnd.emit();
    assert.equal(writes[0]?.markDirty, false);
    engine.destroy();
  });

  it("syncs a menu-driven camera move without dirtying, matching the 2D map", () => {
    // MapController drives MapLibre's own camera API with no `eventData`, so the
    // resulting moveend has no `originalEvent` and MapCanvas publishes it with
    // markDirty=false. The globe has to agree: identical clicks must not behave
    // differently depending on which renderer is drawing (#2265 review).
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    engine.applyView(VIEW);
    engine.zoomIn();
    fakes.moveEnd.emit();
    assert.equal(writes.length, 1, "the camera still syncs");
    assert.equal(writes[0]?.markDirty, false, "but it must not flag unsaved changes");
    engine.destroy();
  });

  it("does not dirty the project for a scripted story camera", () => {
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    engine.applyView(VIEW);
    engine.applyStoryChapterCamera({ center: [30, 10], zoom: 8, bearing: 0, pitch: 0 });
    fakes.moveEnd.emit();
    assert.equal(writes.at(-1)?.markDirty, false);
    engine.destroy();
  });

  it("stops publishing once destroyed", () => {
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    engine.applyView(VIEW);
    engine.destroy();
    assert.equal(fakes.moveEnd.size, 0, "moveEnd listener must be removed");
    fakes.nudge(25);
    fakes.moveEnd.emit();
    assert.equal(writes.length, 0);
  });
});

describe("CesiumEngine pane publishing", () => {
  it("writes a pane's own camera rather than the shared one", () => {
    const paneWrites: Array<{ id: string; markDirty: boolean }> = [];
    useAppStore.setState({
      mapView: { center: [0, 0], zoom: 4, bearing: 0, pitch: 0 },
      mapLayout: { rows: 1, cols: 2, syncView: false },
      secondaryMapViews: [
        { id: "pane-1", view: { center: [0, 0], zoom: 4, bearing: 0, pitch: 0 } },
      ],
      setMapView: (() => assert.fail("an unsynced pane must not write mapView")) as never,
      setSecondaryMapView: ((id: string, _view: MapViewState, markDirty = false) => {
        paneWrites.push({ id, markDirty });
      }) as never,
    } as never);

    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer, { viewId: "pane-1" });
    engine.applyView(VIEW);
    fakes.fireCanvas("wheel");
    fakes.nudge(25);
    fakes.moveEnd.emit();

    assert.equal(paneWrites.length, 1);
    assert.equal(paneWrites[0]?.id, "pane-1");
    assert.equal(paneWrites[0]?.markDirty, true);
    engine.destroy();
  });
});

describe("CesiumEngine terrain correction", () => {
  beforeEach(() => {
    useAppStore.setState({
      mapView: { center: [0, 0], zoom: 4, bearing: 0, pitch: 0 },
      setMapView: (() => {}) as never,
    } as never);
  });

  it("re-applies the placement once terrain settles at a different height", () => {
    // The camera was placed against the ellipsoid because terrain had not
    // loaded; when it does, the same view has to be re-applied against the real
    // ground or the globe renders too close. The ground must actually *change*
    // for this to mean anything — with a fixed height the correction's own guard
    // exits first and the test passes vacuously (#2265 review).
    const fakes = makeViewer(0);
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    engine.applyView({ ...VIEW, center: [10, 20] });
    const placementsAfterSeed = fakes.placements;
    const seeded = engine.getLastAppliedView();
    // Terrain tiles arrive and raise the ground under the view.
    fakes.setGroundHeight(1200);
    fakes.nudge(40);
    // queued === 0: the tile queue has drained.
    fakes.tileLoadProgressEvent.emit(0);
    assert.equal(fakes.placements, placementsAfterSeed + 1, "the camera must be re-placed");
    assert.deepEqual(engine.getLastAppliedView(), seeded, "re-applied as the same view");
    engine.destroy();
  });

  it("leaves the camera alone while tiles are still loading", () => {
    const fakes = makeViewer(0);
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    engine.applyView(VIEW);
    const placements = fakes.placements;
    fakes.setGroundHeight(1200);
    fakes.tileLoadProgressEvent.emit(7);
    assert.equal(fakes.placements, placements, "a non-empty queue must not re-apply");
    engine.destroy();
  });

  it("never yanks a camera the user is driving", () => {
    // A wheel zoom over terrain loads finer tiles mid-gesture. Re-applying the
    // last settled view there would snap the camera back to where the gesture
    // started, and the store would never see the move.
    const fakes = makeViewer(0);
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    engine.applyView(VIEW);
    const placements = fakes.placements;
    fakes.fireCanvas("wheel");
    fakes.setGroundHeight(1200);
    fakes.nudge(40);
    fakes.tileLoadProgressEvent.emit(0);
    assert.equal(fakes.placements, placements, "the user's camera is authoritative");
    engine.destroy();
  });

  it("drops the tile listener on destroy", () => {
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    engine.destroy();
    assert.equal(fakes.tileLoadProgressEvent.size, 0);
  });
});

describe("CesiumEngine terrain", () => {
  it("routes the Terrain menu and project restore through the terrain engine", async () => {
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    assert.equal(engine.setBuiltInControlVisible("terrain", true), true);
    await Promise.resolve();
    assert.equal(engine.isTerrainEnabled(), true);
    assert.deepEqual(fakes.viewer.terrainProvider, { kind: "world-terrain" });
    assert.equal(engine.setBuiltInControlVisible("terrain", false), true);
    assert.equal(engine.isTerrainEnabled(), false);
    assert.notDeepEqual(fakes.viewer.terrainProvider, { kind: "world-terrain" });
    engine.destroy();
  });

  it("does not enable world terrain without the canvas's credentials", async () => {
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer, { worldTerrainAvailable: false });
    assert.equal(engine.setBuiltInControlVisible("terrain", true), false);
    await engine.enableWorldTerrain();
    assert.equal(engine.isTerrainEnabled(), false);
    assert.deepEqual(fakes.viewer.terrainProvider, { kind: "initial" });
    engine.destroy();
  });

  it("retries terrain after a failed load", async () => {
    const fakes = makeViewer();
    const cesium = makeCesium();
    let attempts = 0;
    cesium.createWorldTerrainAsync = async () => {
      if (++attempts === 1) throw new Error("temporary network failure");
      return { kind: "world-terrain" } as never;
    };
    const engine = new CesiumEngine(cesium, fakes.viewer);
    await engine.enableWorldTerrain();
    assert.equal(engine.isTerrainEnabled(), false);
    assert.equal(engine.setTerrainEnabled(true), true);
    await Promise.resolve();
    assert.equal(attempts, 2);
    assert.equal(engine.isTerrainEnabled(), true);
    assert.deepEqual(fakes.viewer.terrainProvider, { kind: "world-terrain" });
    engine.destroy();
  });

  it("ignores an old failure after a newer terrain request succeeds", async () => {
    const fakes = makeViewer();
    const cesium = makeCesium();
    let rejectFirst!: (error: Error) => void;
    cesium.createWorldTerrainAsync = () =>
      new Promise((_, reject) => {
        rejectFirst = reject;
      });
    const engine = new CesiumEngine(cesium, fakes.viewer);
    const first = engine.enableWorldTerrain();
    engine.setTerrainEnabled(false);
    cesium.createWorldTerrainAsync = async () => ({ kind: "world-terrain" }) as never;
    await engine.enableWorldTerrain();
    rejectFirst(new Error("stale failure"));
    await first;
    assert.equal(engine.isTerrainEnabled(), true);
    assert.deepEqual(fakes.viewer.terrainProvider, { kind: "world-terrain" });
    engine.destroy();
  });

  it("swaps in world terrain and reports it enabled", async () => {
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    assert.equal(engine.isTerrainEnabled(), false);
    await engine.enableWorldTerrain();
    assert.equal(engine.isTerrainEnabled(), true);
    assert.deepEqual(fakes.viewer.terrainProvider, { kind: "world-terrain" });
    engine.destroy();
  });

  it("does not resurrect terrain the user turned off mid-load", async () => {
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    const pending = engine.enableWorldTerrain();
    engine.setTerrainEnabled(false);
    await pending;
    assert.equal(engine.isTerrainEnabled(), false);
    assert.equal(
      (fakes.viewer.terrainProvider as { kind?: string }).kind,
      "ellipsoid",
      "the disable must win over the in-flight load",
    );
    engine.destroy();
  });

  it("applies vertical exaggeration to the scene", () => {
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    engine.setTerrainExaggeration(2.5);
    assert.equal(engine.getTerrainExaggeration(), 2.5);
    assert.equal(fakes.viewer.scene.verticalExaggeration, 2.5);
    engine.destroy();
  });
});

describe("CesiumEngine zoom bounds", () => {
  beforeEach(() => {
    useAppStore.setState({
      mapView: { center: [0, 0], zoom: 4, bearing: 0, pitch: 0 },
      setMapView: (() => {}) as never,
    } as never);
  });

  const prefs = (minZoom: number, maxZoom: number) =>
    ({ minZoom, maxZoom, maxPitch: 85, renderWorldCopies: true }) as never;

  it("does not zoom past the project's maxZoom", () => {
    // MapLibre gets this for free: setMaxZoom clamps its whole camera API, so
    // MapController.zoomIn() cannot walk past the preference. Cesium's
    // screenSpaceCameraController limits govern interactive navigation only, so
    // the engine has to clamp the target itself or the same click behaves
    // differently per renderer (#2265 review).
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    engine.applyMapPreferences(prefs(0, 6));
    engine.applyView({ ...VIEW, zoom: 6 });
    engine.zoomIn();
    assert.ok(engine.readView().zoom <= 6.001, `zoom ran past maxZoom: ${engine.readView().zoom}`);
    engine.destroy();
  });

  it("does not zoom below the project's minZoom", () => {
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    engine.applyMapPreferences(prefs(3, 24));
    engine.applyView({ ...VIEW, zoom: 3 });
    engine.zoomOut();
    assert.ok(
      engine.readView().zoom >= 2.999,
      `zoom fell below minZoom: ${engine.readView().zoom}`,
    );
    engine.destroy();
  });

  it("keeps MapLibre's full range until preferences arrive", () => {
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    engine.applyView({ ...VIEW, zoom: 4 });
    engine.zoomIn();
    assert.ok(engine.readView().zoom > 4.5, "an unconfigured project must still zoom");
    engine.destroy();
  });
});

describe("CesiumEngine animation durations", () => {
  beforeEach(() => {
    useAppStore.setState({
      mapView: { center: [0, 0], zoom: 4, bearing: 0, pitch: 0 },
      setMapView: (() => {}) as never,
    } as never);
  });

  const durationOf = (flight: unknown) => (flight as { duration?: number }).duration;

  it("matches the 2D map's 1s orientation resets", () => {
    // MapLibre's resetNorth/resetNorthPitch animate over 1s and
    // MapController.resetPitch sets 1000ms explicitly to match them. A 500ms
    // globe would run the same click at double speed (#2265 review).
    for (const reset of ["resetNorth", "resetNorthPitch", "resetPitch"] as const) {
      const fakes = makeViewer();
      const engine = new CesiumEngine(makeCesium(), fakes.viewer);
      engine[reset]();
      assert.equal(durationOf(fakes.flights[0]), 1, `${reset} must animate over 1s`);
      engine.destroy();
    }
  });

  it("matches MapController.flyTo's 800ms default when no duration is given", () => {
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    engine.flyTo({ center: [10, 20] });
    assert.equal(durationOf(fakes.flights[0]), 0.8);
    engine.destroy();
  });

  it("honours an explicit duration, converting ms to seconds", () => {
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    engine.flyTo({ center: [10, 20], duration: 2500 });
    assert.equal(durationOf(fakes.flights[0]), 2.5);
    engine.destroy();
  });

  it("uses MapLibre's 500ms easeTo default for zoom steps", () => {
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    engine.zoomIn();
    assert.equal(durationOf(fakes.flights[0]), 0.5);
    engine.destroy();
  });
});

describe("CesiumEngine framing", () => {
  beforeEach(() => {
    useAppStore.setState({
      mapView: { center: [0, 0], zoom: 4, bearing: 0, pitch: 0 },
      setMapView: (() => {}) as never,
    } as never);
  });

  it("flies to a rectangle for fitBounds", () => {
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    engine.fitBounds([-10, -5, 10, 5]);
    assert.equal(fakes.flights.length, 1);
    assert.deepEqual((fakes.flights[0] as { destination: unknown }).destination, {
      w: -10,
      s: -5,
      e: 10,
      n: 5,
    });
    engine.destroy();
  });

  it("ignores a non-finite extent instead of flying to NaN", () => {
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    engine.fitBounds([Number.NaN, 0, 10, 5]);
    assert.equal(fakes.flights.length, 0);
    engine.destroy();
  });

  it("flies to the point for a degenerate, point-sized extent", () => {
    // getLayerBounds on a single-point layer returns a zero-area box. Handing
    // that to Cesium as a Rectangle has no "zoom to fit" and yields a
    // nonsensical camera distance, so it takes the point path instead — the same
    // workaround MapController.fitBounds uses (#2265 review).
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    engine.fitBounds([12, 34, 12, 34]);
    assert.equal(fakes.flights.length, 1);
    const flight = fakes.flights[0] as {
      destination?: unknown;
      sphere?: { center: { x: number } };
    };
    assert.equal(flight.destination, undefined, "must not fly to a zero-area rectangle");
    assert.equal(flight.sphere?.center.x, 12, "flies to the point itself");
    engine.destroy();
  });

  it("frames a layer's own extent", () => {
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    engine.fitLayer({
      id: "l1",
      name: "pts",
      type: "geojson",
      visible: true,
      opacity: 1,
      source: {},
      metadata: {},
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: { type: "Point", coordinates: [4, 8] },
          },
        ],
      },
    } as never);
    assert.equal(fakes.flights.length, 1);
    engine.destroy();
  });
});

// --- scene-mode morphs -------------------------------------------------------
// Cesium's scene-mode picker (the globe's 2D/3D/Columbus button, added in
// #2270) does not swap the mode instantly: it runs an animated morph, and for
// its duration the camera is off limits. `Camera.lookAt` and `flyTo` throw
// outright while `scene.mode` is MORPHING, `camera.heading` returns undefined,
// and moveEnd fires repeatedly with intermediate poses. So both halves of the
// camera sync have to stand down until it lands, then publish the native endpoint
// without a second camera move.

const MORPHING = 0;
const SCENE2D = 2;

describe("CesiumEngine scene-mode morphs", () => {
  beforeEach(() => {
    useAppStore.setState({
      mapView: { center: [0, 0], zoom: 4, bearing: 0, pitch: 0 },
      setMapView: (() => {}) as never,
    } as never);
  });

  it("does not place the camera while the scene is morphing", () => {
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    const before = fakes.placements;
    fakes.setSceneMode(MORPHING);
    engine.applyView({ center: [10, 20], zoom: 8, bearing: 0, pitch: 0 });
    assert.equal(fakes.placements, before, "lookAt throws mid-morph; it must not be called");
    engine.destroy();
  });

  it("does not animate the camera while the scene is morphing", () => {
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    fakes.setSceneMode(MORPHING);
    engine.zoomIn();
    assert.equal(fakes.flights.length, 0, "flyTo throws mid-morph; it must not be called");
    engine.destroy();
  });

  it("does not publish the intermediate poses a morph fires", () => {
    // A morph raises moveEnd repeatedly on its way between modes. Publishing
    // those would walk the stored camera through a series of half-projected
    // poses, and each pane following mapView would jump with it.
    const writes: MapViewState[] = [];
    useAppStore.setState({
      setMapView: ((view: MapViewState) => writes.push(view)) as never,
    } as never);
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    engine.applyView(VIEW);
    fakes.setSceneMode(MORPHING);
    fakes.nudge(30);
    fakes.moveEnd.emit();
    assert.deepEqual(writes, []);
    engine.destroy();
  });

  it("publishes the native morph endpoint without snapping back to the stored camera", () => {
    const writes: MapViewState[] = [];
    useAppStore.setState({ setMapView: ((view: MapViewState) => writes.push(view)) as never });
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    engine.applyView(VIEW);
    fakes.setSceneMode(SCENE2D);
    fakes.nudge(45);
    const settled = engine.readView();
    const before = fakes.placements;
    fakes.morphComplete.emit();
    assert.equal(fakes.placements, before, "a native morph must not end with a camera placement");
    assert.deepEqual(writes, [settled], "the project follows Cesium's final view");
    assert.deepEqual(
      engine.getLastAppliedView(),
      settled,
      "store echo must not reapply the camera",
    );
    engine.destroy();
  });

  it("stops publishing morphs once destroyed", () => {
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    engine.destroy();
    const before = fakes.placements;
    fakes.morphComplete.emit();
    assert.equal(fakes.placements, before);
    assert.equal(fakes.morphComplete.size, 0, "the listener must be removed on destroy");
  });
});

// --- built-in controls -------------------------------------------------------
// The globe has no MapLibre map, so none of the built-in controls the Controls
// menu offers exist on it — with one exception. `CesiumCanvas` builds a Cesium
// fullscreen widget and hands it to the engine under the `fullscreen` id
// (#2270), so that one menu row governs something here too. The distinction has
// to be exact: answering `true` for an id the globe cannot honour would move the
// menu's checkmark while nothing on the map changed, which is precisely what the
// `false` return exists to prevent.

describe("CesiumEngine built-in controls", () => {
  /** A control host recording what was mounted and unmounted. */
  function fakeHost() {
    const calls = { added: [] as unknown[], removed: [] as unknown[], positions: [] as string[] };
    const host = {
      addControl: (control: unknown, position: string) => {
        calls.added.push(control);
        calls.positions.push(position);
        return true;
      },
      removeControl: (control: unknown) => {
        calls.removed.push(control);
      },
      setControlPosition: () => true,
    } as unknown as CesiumControlHost;
    return { calls, host };
  }

  it("refuses a built-in control nothing has registered", () => {
    const { calls, host } = fakeHost();
    setPrimaryCesiumControlHost(host);
    try {
      const fakes = makeViewer();
      const engine = new CesiumEngine(makeCesium(), fakes.viewer);
      // Every MapLibre-only control: no globe counterpart, so the menu must be
      // told the toggle did not take.
      assert.equal(engine.setBuiltInControlVisible("navigation", true), false);
      assert.equal(engine.setBuiltInControlVisible("fullscreen", true), false);
      assert.deepEqual(calls.added, []);
      engine.destroy();
    } finally {
      setPrimaryCesiumControlHost(null);
      resetPrimaryCesiumBuiltInControlState();
    }
  });

  it("mounts and unmounts a registered control through the host", () => {
    const { calls, host } = fakeHost();
    setPrimaryCesiumControlHost(host);
    try {
      const fakes = makeViewer();
      const engine = new CesiumEngine(makeCesium(), fakes.viewer);
      const control = { onAdd: () => document.createElement("div"), onRemove: () => {} };
      engine.registerBuiltInControl("fullscreen", control as never);
      // Registration mounts, so the canvas never has to add the control itself.
      assert.deepEqual(calls.added, [control]);

      assert.equal(engine.setBuiltInControlVisible("fullscreen", false), true);
      assert.deepEqual(calls.removed, [control]);
      assert.equal(engine.setBuiltInControlVisible("fullscreen", true), true);
      assert.deepEqual(calls.added, [control, control]);
      // Registering one control must not make the engine claim the others.
      assert.equal(engine.setBuiltInControlVisible("compass", true), false);
      engine.destroy();
    } finally {
      setPrimaryCesiumControlHost(null);
      resetPrimaryCesiumBuiltInControlState();
    }
  });

  it("keeps a grid pane away from the primary globe's controls", () => {
    const { calls, host } = fakeHost();
    setPrimaryCesiumControlHost(host);
    try {
      const fakes = makeViewer();
      const pane = new CesiumEngine(makeCesium(), fakes.viewer, { viewId: "pane-1" });
      const control = { onAdd: () => document.createElement("div"), onRemove: () => {} };
      pane.registerBuiltInControl("fullscreen", control as never);
      // Same guard as `addControl`: the host belongs to the primary map area,
      // so a pane acting on it would toggle a control on a different viewer.
      assert.equal(pane.setBuiltInControlVisible("fullscreen", true), false);
      assert.deepEqual(calls.added, []);
      pane.destroy();
    } finally {
      setPrimaryCesiumControlHost(null);
      resetPrimaryCesiumBuiltInControlState();
    }
  });

  it("remounts a control in the state the last globe gave it", () => {
    const { calls, host } = fakeHost();
    setPrimaryCesiumControlHost(host);
    try {
      const control = { onAdd: () => document.createElement("div"), onRemove: () => {} };
      // A renderer swap away from Cesium and back destroys the engine; the
      // Controls menu and a plugin that moved the control keep their state, so
      // the next engine must not mount the hidden control, and must put the
      // moved one back in its corner, before the menu replays anything.
      const first = new CesiumEngine(makeCesium(), makeViewer().viewer);
      first.registerBuiltInControl("fullscreen", control as never);
      first.registerBuiltInControl("compass", control as never);
      assert.equal(first.setBuiltInControlVisible("fullscreen", false), true);
      assert.equal(first.setBuiltInControlPosition("compass", "bottom-left"), true);
      first.destroy();
      calls.added.length = 0;
      calls.positions.length = 0;

      const second = new CesiumEngine(makeCesium(), makeViewer().viewer);
      second.registerBuiltInControl("fullscreen", control as never);
      assert.deepEqual(calls.added, []);
      second.registerBuiltInControl("compass", control as never);
      assert.deepEqual(calls.added, [control]);
      assert.deepEqual(calls.positions, ["bottom-left"]);
      assert.equal(second.getBuiltInControlPosition("compass"), "bottom-left");
      // The menu's replay is what un-hides it, and that goes through the same path.
      assert.equal(second.setBuiltInControlVisible("fullscreen", true), true);
      assert.deepEqual(calls.added, [control, control]);
      second.destroy();
    } finally {
      setPrimaryCesiumControlHost(null);
      resetPrimaryCesiumBuiltInControlState();
    }
  });

  it("forgets its registrations on destroy", () => {
    const { calls, host } = fakeHost();
    setPrimaryCesiumControlHost(host);
    try {
      const fakes = makeViewer();
      const engine = new CesiumEngine(makeCesium(), fakes.viewer);
      const control = { onAdd: () => document.createElement("div"), onRemove: () => {} };
      engine.registerBuiltInControl("fullscreen", control as never);
      engine.destroy();
      // A late toggle (the app replays control visibility on project load) must
      // not re-mount a control onto a globe that is already gone.
      assert.equal(engine.setBuiltInControlVisible("fullscreen", true), false);
      assert.deepEqual(calls.added, [control]);
    } finally {
      setPrimaryCesiumControlHost(null);
      resetPrimaryCesiumBuiltInControlState();
    }
  });
});

describe("CesiumEngine camera reads during a morph", () => {
  beforeEach(() => {
    useAppStore.setState({
      mapView: { center: [0, 0], zoom: 4, bearing: 0, pitch: 0 },
      setMapView: (() => {}) as never,
    } as never);
  });

  it("reports the last applied view instead of reading a half-morphed camera", () => {
    // Not a nicety. `camera.heading` is `undefined` while the scene is
    // MORPHING, and Cesium's `Math.toDegrees` throws on that rather than
    // returning NaN — so an unguarded read takes its caller down. The callers
    // are ordinary background work: the autosave snapshot, the View menu's
    // zoom-limit check, the status bar.
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    engine.applyView(VIEW);
    fakes.setSceneMode(MORPHING);
    fakes.breakCameraForMorph();
    assert.deepEqual(engine.readView(), VIEW);
    assert.equal(engine.readCameraAltitude(), null);
    engine.destroy();
  });

  it("falls back to the store when a morph starts before any view is applied", () => {
    const fakes = makeViewer();
    const engine = new CesiumEngine(makeCesium(), fakes.viewer);
    fakes.setSceneMode(MORPHING);
    fakes.breakCameraForMorph();
    assert.deepEqual(engine.readView(), useAppStore.getState().mapView);
    engine.destroy();
  });
});

describe("Cesium feature picking", () => {
  async function setup() {
    // Real Cesium entities/properties exercise cloning and material restoration.
    // Only loading and the GPU pick pass are replaced.
    const C = await import("@cesium/engine");
    const f = makeViewer();
    const sources: import("@cesium/engine").CustomDataSource[] = [];
    let picks: unknown[] = [];
    let projected: { x: number; y: number } | undefined = { x: 400, y: 300 };
    Object.assign(f.viewer, {
      clock: { currentTime: C.JulianDate.now() },
      dataSources: {
        add: async (ds: import("@cesium/engine").CustomDataSource) => {
          sources.push(ds);
          return ds;
        },
        remove: (ds: import("@cesium/engine").CustomDataSource) => {
          sources.splice(sources.indexOf(ds), 1);
        },
      },
    });
    Object.assign((f.viewer as import("@cesium/engine").CesiumWidget).scene, {
      drillPick: () => picks,
      requestRender: () => {},
    });
    const ns = {
      ...makeCesium(),
      Cartesian3: Object.assign(makeCesium().Cartesian3, {
        subtract: C.Cartesian3.subtract,
        magnitude: C.Cartesian3.magnitude,
      }),
      Ray: C.Ray,
      IntersectionTests: { rayEllipsoid: () => undefined },
      Color: C.Color,
      ColorMaterialProperty: C.ColorMaterialProperty,
      ConstantProperty: C.ConstantProperty,
      SceneTransforms: { worldToWindowCoordinates: () => projected },
      GeoJsonDataSource: {
        load: async (data: import("geojson").FeatureCollection) => {
          const ds = new C.CustomDataSource();
          for (const feature of data.features) {
            // Two render entities per feature models a multipart geometry.
            for (let part = 0; part < 2; part++)
              ds.entities.add(
                new C.Entity({
                  id: `${feature.id}-${part}`,
                  properties: feature.properties ?? {},
                  polygon: { material: C.Color.BLUE },
                }),
              );
          }
          return ds;
        },
      },
    };
    const engine = new CesiumEngine(ns as never, f.viewer);
    const layer: import("../packages/core/src/types").GeoLibreLayer = {
      id: "cities",
      name: "Cities",
      type: "geojson",
      source: {},
      metadata: {},
      visible: true,
      opacity: 1,
      style: {},
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            id: 0,
            properties: { name: "Zero", __geolibre_cesium_feature_index: "user value" },
            geometry: {
              type: "MultiPoint",
              coordinates: [
                [0, 0],
                [1, 1],
              ],
            },
          },
          {
            type: "Feature",
            properties: { name: "No id" },
            geometry: { type: "Point", coordinates: [2, 2] },
          },
        ],
      },
    };
    engine.syncLayers([layer]);
    await new Promise((resolve) => setImmediate(resolve));
    return {
      engine,
      layer,
      sources,
      C,
      f,
      pick: (value: unknown[]) => {
        picks = value;
      },
      project: (value: typeof projected) => {
        projected = value;
      },
    };
  }

  it("returns original geometry and properties, deduplicates multipart picks and preserves zero/index ids", async () => {
    const { engine, sources, layer, pick, project } = await setup();
    const entities = sources[0].entities.values;
    pick([
      { id: entities[0] },
      { id: entities[1] },
      { primitive: { id: entities[2] } },
      { id: {} },
    ]);
    const hits = engine.identifyFeatures([0, 0]);
    assert.deepEqual(
      hits.map((hit) => hit.featureId),
      ["0", "1"],
    );
    assert.equal(hits[0].geometry, layer.geojson!.features[0].geometry);
    assert.equal(hits[0].properties.__geolibre_cesium_feature_index, "user value");
    assert.deepEqual(engine.identifyFeatures([0, 0], "other"), []);
    project(undefined);
    assert.deepEqual(engine.identifyFeatures([0, 0]), []);
    assert.deepEqual(engine.identifyAtScreen({ x: -1, y: 1 } as never), []);
    engine.destroy();
    assert.deepEqual(engine.identifyFeatures([0, 0]), []);
  });

  it("rejects hidden, removed and replaced entities", async () => {
    const { engine, layer, sources, pick } = await setup();
    pick([{ id: sources[0].entities.values[0] }]);
    engine.syncLayers([{ ...layer, visible: false }]);
    assert.deepEqual(engine.identifyFeatures([0, 0]), []);
    engine.syncLayers([
      { ...layer, geojson: { ...layer.geojson!, features: [...layer.geojson!.features] } },
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(engine.identifyFeatures([0, 0]), []);
    engine.syncLayers([]);
    assert.deepEqual(engine.identifyFeatures([0, 0]), []);
    engine.destroy();
  });

  it("restores exact styles, keeps selection through opacity changes and fits selected features", async () => {
    const { engine, layer, sources, C, f } = await setup();
    const entity = sources[0].entities.values[0];
    const original = entity.polygon;
    engine.highlightFeature(layer, ["0"], { fit: true });
    assert.notEqual(entity.polygon, original);
    assert.equal(f.flights.length, 1);
    engine.clearFeatureHighlight();
    assert.equal(entity.polygon, original);
    engine.highlightFeature(layer, "0");
    engine.syncLayers([{ ...layer, opacity: 0.25 }]);
    engine.clearFeatureHighlight();
    const material = entity.polygon!.material as import("@cesium/engine").ColorMaterialProperty;
    assert.equal(material.color!.getValue(C.JulianDate.now()).alpha, 0.6 * 0.25);
    engine.destroy();
  });
});

it("rejects far-side coordinates before GPU picking, including below-sea-level terrain", async () => {
  const C = await import("@cesium/engine");
  const f = makeViewer();
  const viewer = f.viewer as import("@cesium/engine").CesiumWidget;
  let picks = 0;
  Object.defineProperty(viewer.camera, "positionWC", {
    get: () => C.Cartesian3.fromDegrees(0, 0, 1000000),
  });
  viewer.scene.globe.ellipsoid = C.Ellipsoid.WGS84;
  Object.assign(viewer.scene, {
    drillPick: () => {
      picks++;
      return [];
    },
  });
  const engine = new CesiumEngine(
    {
      ...makeCesium(),
      Cartesian3: C.Cartesian3,
      Ray: C.Ray,
      IntersectionTests: C.IntersectionTests,
      SceneTransforms: { worldToWindowCoordinates: () => new C.Cartesian2(400, 300) },
    } as never,
    f.viewer,
  );
  for (const height of [0, -400]) {
    f.setGroundHeight(height);
    const before = picks;
    engine.identifyFeatures([180, 0]);
    assert.equal(picks, before, "far side must never query the visible features");
    engine.identifyFeatures([0, 0]);
    assert.equal(picks, before + 1, "near side remains pickable");
  }
  f.setSceneMode(C.SceneMode.SCENE2D);
  engine.identifyFeatures([180, 0]);
  assert.equal(picks, 3, "flat views must not use 3D occlusion");
  engine.destroy();
});

describe("Cesium cursor ground picking", () => {
  it("keeps signed terrain elevation, falls back to the ellipsoid, and clears sky/morph hits", () => {
    const C = makeCesium();
    const f = makeViewer(-42);
    const engine = new CesiumEngine(C, f.viewer);
    const point = new C.Cartesian2(400, 300);
    assert.deepEqual(engine.readPointerAtScreen(point), { coordinates: [0, 0], elevation: -42 });
    f.setPickHits(false, true);
    assert.deepEqual(engine.readPointerAtScreen(point), { coordinates: [0, 0], elevation: null });
    f.setPickHits(false, false);
    assert.equal(engine.readPointerAtScreen(point), null);
    f.setPickHits(true, true);
    f.setSceneMode(C.SceneMode.MORPHING);
    assert.equal(engine.readPointerAtScreen(point), null);
    f.setSceneMode(C.SceneMode.SCENE3D);
    assert.equal(engine.readPointerAtScreen(new C.Cartesian2(NaN, 0)), null);
    engine.destroy();
    assert.equal(engine.readPointerAtScreen(point), null);
  });
});

it("reports the projected scene modes and the 3D globe", () => {
  const C = makeCesium();
  const f = makeViewer();
  const engine = new CesiumEngine(C, f.viewer);
  for (const mode of [C.SceneMode.SCENE2D, C.SceneMode.COLUMBUS_VIEW]) {
    f.setSceneMode(mode);
    assert.equal(engine.readProjection(), "mercator");
  }
  f.setSceneMode(C.SceneMode.SCENE3D);
  assert.equal(engine.readProjection(), "globe");
  engine.destroy();
});

it("remembers a hidden control's corner and refuses unregistered/pane controls", () => {
  const positions: string[] = [];
  setPrimaryCesiumControlHost({
    setControlPosition: (_control: unknown, position: string) => {
      positions.push(position);
      return true;
    },
    addControl: (_control: unknown, position: string) => {
      positions.push(position);
      return true;
    },
    removeControl: () => {},
  } as unknown as CesiumControlHost);
  const engine = new CesiumEngine(makeCesium(), makeViewer().viewer);
  const pane = new CesiumEngine(makeCesium(), makeViewer().viewer, { viewId: "pane" });
  try {
    const control = {} as never;
    engine.registerBuiltInControl("fullscreen", control);
    pane.registerBuiltInControl("fullscreen", control);
    assert.equal(engine.setBuiltInControlPosition("compass", "top-left"), false);
    assert.equal(pane.setBuiltInControlPosition("fullscreen", "top-left"), false);
    engine.setBuiltInControlVisible("fullscreen", false);
    assert.equal(engine.setBuiltInControlPosition("fullscreen", "bottom-left"), true);
    assert.equal(engine.getBuiltInControlPosition("fullscreen"), "bottom-left");
    engine.setBuiltInControlVisible("fullscreen", true);
    // Registration mounted it top-right; hiding it then moving it recorded the
    // corner, and un-hiding mounted it there.
    assert.deepEqual(positions, ["top-right", "bottom-left", "bottom-left"]);
  } finally {
    engine.destroy();
    pane.destroy();
    setPrimaryCesiumControlHost(null);
    resetPrimaryCesiumBuiltInControlState();
  }
});
