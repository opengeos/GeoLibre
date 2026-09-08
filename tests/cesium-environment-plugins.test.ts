import assert from "node:assert/strict";
import { Cartesian3, Color, JulianDate, Math as CesiumMath, SunLight } from "@cesium/engine";
import { afterEach, describe, it } from "node:test";
import type { CesiumSceneHandle } from "../packages/map/src/cesium-engine";
import {
  closeFlightSimulatorPanel,
  getFlightHudSnapshot,
  isFlying,
  openFlightSimulatorPanel,
  reattachFlightSimulator,
  restoreFlightSimulator,
  startFlying,
  stopFlying,
} from "../packages/plugins/src/plugins/flight-simulator";
import {
  DEFAULT_EFFECTS_SETTINGS,
  cesiumAtmosphereShifts,
  maplibreEffectsPlugin,
  restoreEffects,
  setEffectsSettings,
} from "../packages/plugins/src/plugins/maplibre-effects";
import {
  DEFAULT_SUN_SETTINGS,
  SUN_SHADE_MAX,
  cesiumNightFloor,
  closeSunPanel,
  maplibreSunPlugin,
  openSunPanel,
  reattachSun,
  setSunSettings,
} from "../packages/plugins/src/plugins/maplibre-sun";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

// The Cesium branches of the environment plugins (issue #2287). The Cesium
// *maths* is real — JulianDate, Color, Cartesian3 come from the engine — and
// only the scene/widget, which need a GPU, are faked. Each test drives the
// plugin through its public open/close/restore surface with an app whose
// `getMap` is null and whose `getCesiumScene` is the fake, exactly the shape
// the host hands a plugin when the primary map is the globe.

/** A fake widget: the scene knobs the plugins write, plus a camera log. */
function makeGlobe(overrides: { primary?: boolean } = {}) {
  let destroyed = false;
  const scene = {
    light: { kind: "previous-light" } as unknown,
    backgroundColor: Color.fromCssColorString("#0c1b33"),
    verticalExaggeration: 1,
    globe: {
      enableLighting: false,
      dynamicAtmosphereLighting: true,
      dynamicAtmosphereLightingFromSun: false,
      vertexShadowDarkness: 0.3,
      getHeight: () => 1000,
    },
    skyBox: { show: true },
    skyAtmosphere: { show: true, hueShift: 0, saturationShift: 0, brightnessShift: 0 },
    screenSpaceCameraController: { enableInputs: true },
    requestRender: () => {},
  };
  const clock = {
    currentTime: JulianDate.fromDate(new Date(Date.UTC(2000, 0, 1))),
    shouldAnimate: true,
  };
  const views: Array<Record<string, unknown>> = [];
  const camera = {
    heading: 0,
    pitch: CesiumMath.toRadians(-60),
    roll: 0,
    setView: (options: Record<string, unknown>) => {
      views.push(options);
      const orientation = options.orientation as
        | { heading: number; pitch: number; roll: number }
        | undefined;
      if (orientation) {
        camera.heading = orientation.heading;
        camera.pitch = orientation.pitch;
        camera.roll = orientation.roll;
      }
    },
  };
  const canvas = { clientHeight: 648, height: 648 } as unknown as HTMLCanvasElement;
  const viewer = {
    scene,
    camera,
    clock,
    canvas,
    isDestroyed: () => destroyed,
  };
  const handle = {
    Cesium: { Cartesian3, Color, JulianDate, Math: CesiumMath, SunLight },
    viewer,
    scene,
    camera,
    clock,
    canvas,
    primary: overrides.primary ?? true,
    requestRender: () => {},
    readView: () => ({
      center: [-121.76, 46.85] as [number, number],
      zoom: 14,
      bearing: 30,
      pitch: 0,
    }),
  } as unknown as CesiumSceneHandle;
  return {
    handle,
    scene,
    clock,
    camera,
    views,
    viewer,
    destroy: () => {
      destroyed = true;
    },
  };
}

function globeApp(
  globe: ReturnType<typeof makeGlobe>,
  extra: Partial<GeoLibreAppAPI> = {},
): GeoLibreAppAPI {
  return {
    getMap: () => null,
    getCesiumScene: () => globe.handle,
    ...extra,
  } as unknown as GeoLibreAppAPI;
}

/** A `window` with just the frame scheduling and key listeners the engines use. */
function withStubWindow<T>(run: () => T): T {
  const original = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  try {
    return run();
  } finally {
    (globalThis as { window?: unknown }).window = original;
  }
}

describe("cesiumNightFloor", () => {
  it("maps no shading to a fully lit night side and the deepest shade to a dim floor", () => {
    assert.equal(cesiumNightFloor(0), 1);
    assert.ok(cesiumNightFloor(SUN_SHADE_MAX) < 0.2);
    // Never fully black: a floor of 0 renders the night hemisphere as a hole.
    assert.ok(cesiumNightFloor(5) >= 0.05);
  });

  it("is monotonic in the shade opacity", () => {
    assert.ok(cesiumNightFloor(0.2) > cesiumNightFloor(0.5));
    assert.ok(cesiumNightFloor(0.5) > cesiumNightFloor(0.8));
  });
});

describe("Sun simulation on the globe", () => {
  afterEach(() => {
    withStubWindow(() => closeSunPanel());
    setSunSettings(DEFAULT_SUN_SETTINGS);
  });

  it("declares both engines", () => {
    assert.deepEqual(maplibreSunPlugin.engines, ["maplibre", "cesium"]);
  });

  it("lights the globe from a SunLight at the simulated instant", () => {
    withStubWindow(() => {
      const globe = makeGlobe();
      openSunPanel(globeApp(globe));
      assert.ok(globe.scene.light instanceof SunLight, "scene.light must be a SunLight");
      assert.equal(globe.scene.globe.enableLighting, true);
      assert.equal(globe.scene.globe.dynamicAtmosphereLightingFromSun, true);
      // The simulation owns the instant: the widget clock must not tick on its own.
      assert.equal(globe.clock.shouldAnimate, false);
      const expected = JulianDate.fromDate(new Date(DEFAULT_SUN_SETTINGS.dateMs));
      assert.equal(JulianDate.equals(globe.clock.currentTime, expected), true);
      assert.equal(
        globe.scene.globe.vertexShadowDarkness,
        cesiumNightFloor(DEFAULT_SUN_SETTINGS.shadeOpacity),
      );
    });
  });

  it("follows the clock and shading depth as settings change", () => {
    withStubWindow(() => {
      const globe = makeGlobe();
      openSunPanel(globeApp(globe));
      const noon = Date.UTC(2024, 11, 21, 12, 0, 0);
      setSunSettings({ dateMs: noon, shadeOpacity: 0.8 });
      assert.equal(
        JulianDate.equals(globe.clock.currentTime, JulianDate.fromDate(new Date(noon))),
        true,
      );
      assert.equal(globe.scene.globe.vertexShadowDarkness, cesiumNightFloor(0.8));
    });
  });

  it("restores the scene it found when the panel closes", () => {
    withStubWindow(() => {
      const globe = makeGlobe();
      const before = JulianDate.clone(globe.clock.currentTime);
      openSunPanel(globeApp(globe));
      closeSunPanel();
      assert.deepEqual(globe.scene.light, { kind: "previous-light" });
      assert.equal(globe.scene.globe.enableLighting, false);
      assert.equal(globe.scene.globe.dynamicAtmosphereLightingFromSun, false);
      assert.equal(globe.scene.globe.vertexShadowDarkness, 0.3);
      assert.equal(globe.clock.shouldAnimate, true);
      assert.equal(JulianDate.equals(globe.clock.currentTime, before), true);
    });
  });

  it("does not bind to a grid pane's globe", () => {
    withStubWindow(() => {
      const pane = makeGlobe({ primary: false });
      openSunPanel(globeApp(pane));
      assert.equal(pane.scene.globe.enableLighting, false);
    });
  });

  it("rebinds to a rebuilt globe on reattach and keeps an unchanged one", () => {
    withStubWindow(() => {
      const first = makeGlobe();
      openSunPanel(globeApp(first));
      reattachSun(globeApp(first));
      assert.equal(first.scene.globe.enableLighting, true);
      // A renderer swap destroys the widget and mounts a new one.
      first.destroy();
      const second = makeGlobe();
      reattachSun(globeApp(second));
      assert.equal(second.scene.globe.enableLighting, true);
      assert.ok(second.scene.light instanceof SunLight);
    });
  });
});

describe("cesiumAtmosphereShifts", () => {
  it("is Cesium's stock atmosphere for the default settings", () => {
    const shifts = cesiumAtmosphereShifts(DEFAULT_EFFECTS_SETTINGS);
    assert.equal(shifts.show, true);
    assert.equal(shifts.hueShift, 0);
    assert.equal(shifts.saturationShift, 0);
    assert.equal(shifts.brightnessShift, 0);
  });

  it("hides the atmosphere at zero opacity and dims it in between", () => {
    assert.equal(
      cesiumAtmosphereShifts({ ...DEFAULT_EFFECTS_SETTINGS, haloOpacity: 0 }).show,
      false,
    );
    const half = cesiumAtmosphereShifts({ ...DEFAULT_EFFECTS_SETTINGS, haloOpacity: 0.5 });
    assert.equal(half.show, true);
    assert.equal(half.brightnessShift, -0.5);
  });

  it("shifts the hue the shortest way round the wheel", () => {
    // Default halo blue sits near 208°; red is 0°, so the short way is +152°.
    const red = cesiumAtmosphereShifts({ ...DEFAULT_EFFECTS_SETTINGS, haloColor: "#ff0000" });
    assert.ok(red.hueShift > 0.4 && red.hueShift <= 0.5, `hueShift ${red.hueShift}`);
    const grey = cesiumAtmosphereShifts({ ...DEFAULT_EFFECTS_SETTINGS, haloColor: "#808080" });
    assert.equal(grey.hueShift, 0);
    assert.ok(grey.saturationShift < 0, "a grey halo desaturates the atmosphere");
  });
});

describe("Atmospheric Effects on the globe", () => {
  afterEach(() => {
    setEffectsSettings(DEFAULT_EFFECTS_SETTINGS);
  });

  it("declares both engines", () => {
    assert.deepEqual(maplibreEffectsPlugin.engines, ["maplibre", "cesium"]);
  });

  it("drives the sky box, atmosphere, and space colour while active", () => {
    const globe = makeGlobe();
    restoreEffects(globeApp(globe), true, { haloColor: "#ff0000", spaceColor: "#000000" });
    assert.equal(globe.scene.skyBox.show, true);
    assert.equal(globe.scene.skyAtmosphere.show, true);
    assert.ok(globe.scene.skyAtmosphere.hueShift > 0.4);
    assert.equal(Color.equals(globe.scene.backgroundColor, Color.BLACK), true);
    setEffectsSettings({ haloOpacity: 0 });
    assert.equal(globe.scene.skyAtmosphere.show, false);
    maplibreEffectsPlugin.deactivate(globeApp(globe));
  });

  it("switches the stock stars and atmosphere off while inactive", () => {
    const globe = makeGlobe();
    restoreEffects(globeApp(globe), false, undefined);
    assert.equal(globe.scene.skyBox.show, false);
    assert.equal(globe.scene.skyAtmosphere.show, false);
    const off = Color.fromCssColorString(DEFAULT_EFFECTS_SETTINGS.spaceColor);
    assert.equal(Color.equals(globe.scene.backgroundColor, off), true);
  });

  it("toggling off after on lands in the same off state", () => {
    const globe = makeGlobe();
    const app = globeApp(globe);
    maplibreEffectsPlugin.activate(app);
    assert.equal(globe.scene.skyBox.show, true);
    maplibreEffectsPlugin.deactivate(app);
    assert.equal(globe.scene.skyBox.show, false);
    assert.equal(globe.scene.skyAtmosphere.show, false);
  });
});

describe("Flight Simulator on the globe", () => {
  afterEach(() => {
    withStubWindow(() => restoreFlightSimulator(globeApp(makeGlobe()), undefined));
  });

  it("takes the camera over from the aircraft's position and hands it back", () => {
    withStubWindow(() => {
      const globe = makeGlobe();
      const terrain = { enabled: false };
      const app = globeApp(globe, {
        setTerrainEnabled: (enabled: boolean) => {
          terrain.enabled = enabled;
          return true;
        },
        isTerrainEnabled: () => terrain.enabled,
      });
      openFlightSimulatorPanel(app);
      assert.equal(startFlying(), true);
      assert.equal(isFlying(), true);
      assert.equal(globe.scene.screenSpaceCameraController.enableInputs, false);
      assert.equal(terrain.enabled, true, "flight enables terrain");
      const hud = getFlightHudSnapshot();
      assert.equal(hud.flying, true);
      // Seeded from the globe's view, over the 1000 m plateau the fake reports.
      assert.ok(Math.abs(hud.lng - -121.76) < 1e-9);
      assert.ok(hud.altitudeMeters > 1000);
      assert.ok(hud.aglMeters > 0);
      assert.equal(globe.views.length, 1);
      const view = globe.views[0];
      assert.ok(view.destination instanceof Cartesian3);
      const orientation = view.orientation as { heading: number; pitch: number; roll: number };
      // Level flight looks slightly below the horizon: Cesium pitch just under 0.
      assert.ok(orientation.pitch < 0 && orientation.pitch > CesiumMath.toRadians(-30));
      assert.ok(Math.abs(orientation.heading - CesiumMath.toRadians(30)) < 1e-9);

      stopFlying();
      assert.equal(isFlying(), false);
      assert.equal(globe.scene.screenSpaceCameraController.enableInputs, true);
      assert.equal(terrain.enabled, false, "terrain restored to what it was");
      assert.equal(globe.camera.roll, 0, "wings levelled on exit");
      closeFlightSimulatorPanel(app);
    });
  });

  it("keeps an unchanged globe on reattach and rebinds a rebuilt one", () => {
    withStubWindow(() => {
      const first = makeGlobe();
      openFlightSimulatorPanel(globeApp(first));
      startFlying();
      reattachFlightSimulator(globeApp(first));
      assert.equal(isFlying(), true, "same globe: the flight continues");
      first.destroy();
      const second = makeGlobe();
      reattachFlightSimulator(globeApp(second));
      assert.equal(isFlying(), false, "a new globe ends the flight");
      assert.equal(startFlying(), true, "and the engine is bound to it");
      assert.equal(second.scene.screenSpaceCameraController.enableInputs, false);
      stopFlying();
    });
  });

  it("does not bind to a grid pane's globe", () => {
    withStubWindow(() => {
      const pane = makeGlobe({ primary: false });
      openFlightSimulatorPanel(globeApp(pane));
      assert.equal(startFlying(), false);
    });
  });
});
