import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import type maplibregl from "maplibre-gl";
import { TerrainControl } from "../packages/map/src/terrain-control";

// TerrainControl.onAdd builds DOM nodes; node:test has no DOM, so stand up a
// minimal element/document just rich enough for the methods the control calls.
interface FakeElement {
  className: string;
  type: string;
  title: string;
  children: FakeElement[];
  classList: { has: (n: string) => boolean; toggle: (n: string, f?: boolean) => boolean };
  attributes: Record<string, string>;
  setAttribute: (name: string, value: string) => void;
  appendChild: (child: FakeElement) => FakeElement;
  addEventListener: (type: string, handler: () => void) => void;
  remove: () => void;
  emit: (type: string) => void;
}

function makeFakeElement(): FakeElement {
  const classes = new Set<string>();
  const listeners: Record<string, Array<() => void>> = {};
  const el: FakeElement = {
    className: "",
    type: "",
    title: "",
    children: [],
    classList: {
      has: (name) => classes.has(name),
      toggle: (name, force) => {
        const next = force ?? !classes.has(name);
        if (next) classes.add(name);
        else classes.delete(name);
        return next;
      },
    },
    attributes: {},
    setAttribute: (name, value) => {
      el.attributes[name] = value;
    },
    appendChild: (child) => {
      el.children.push(child);
      return child;
    },
    addEventListener: (type, handler) => {
      (listeners[type] ??= []).push(handler);
    },
    remove: () => {},
    emit: (type) => {
      for (const handler of listeners[type] ?? []) handler();
    },
  };
  return el;
}

const TERRAIN_SOURCE = "geolibre-terrain-dem";
// Mirrors the control's private DOUBLE_CLICK_MS: advancing timers by exactly the
// debounce window fires the pending single-click toggle.
const DOUBLE_CLICK_MS = 250;

interface FakeMap {
  map: maplibregl.Map;
  setTerrainCalls: Array<maplibregl.TerrainSpecification | null>;
  clampCalls: boolean[];
  emitTerrain: () => void;
}

function makeFakeMap(): FakeMap {
  let terrain: maplibregl.TerrainSpecification | null = null;
  const handlers: Record<string, Array<() => void>> = {};
  const setTerrainCalls: Array<maplibregl.TerrainSpecification | null> = [];
  const clampCalls: boolean[] = [];
  const map = {
    getTerrain: () => terrain,
    setTerrain: (spec: maplibregl.TerrainSpecification | null) => {
      terrain = spec;
      setTerrainCalls.push(spec);
      for (const handler of handlers.terrain ?? []) handler();
    },
    // The control unclamps the center from the terrain surface while terrain is
    // on to stop MapLibre from snapping the zoom over steep relief.
    setCenterClampedToGround: (value: boolean) => {
      clampCalls.push(value);
    },
    on: (type: string, handler: () => void) => {
      (handlers[type] ??= []).push(handler);
    },
    off: (type: string, handler: () => void) => {
      handlers[type] = (handlers[type] ?? []).filter((h) => h !== handler);
    },
  };
  return {
    map: map as unknown as maplibregl.Map,
    setTerrainCalls,
    clampCalls,
    emitTerrain: () => {
      for (const handler of handlers.terrain ?? []) handler();
    },
  };
}

/**
 * Mount a control on a fresh fake map and return the pieces a test drives: the
 * control, the map spy, and the button whose click events we simulate.
 */
function mount(options?: { onOpenSettings?: () => void; exaggeration?: number }) {
  const created: FakeElement[] = [];
  (globalThis as { document?: unknown }).document = {
    createElement: () => {
      const el = makeFakeElement();
      created.push(el);
      return el;
    },
  };
  const fake = makeFakeMap();
  const control = new TerrainControl({
    source: TERRAIN_SOURCE,
    exaggeration: options?.exaggeration,
    onOpenSettings: options?.onOpenSettings,
  });
  control.onAdd(fake.map);
  // created[0] is the container div, created[1] the button, created[2] the icon.
  const button = created[1];
  return { control, fake, button };
}

describe("TerrainControl", () => {
  afterEach(() => {
    mock.timers.reset();
    delete (globalThis as { document?: unknown }).document;
  });

  it("toggles terrain on after a lone click settles", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { control, fake, button } = mount();

    assert.equal(control.isEnabled(), false);
    button.emit("click");
    // Still pending until the double-click window elapses.
    assert.equal(fake.setTerrainCalls.length, 0);
    t.mock.timers.tick(DOUBLE_CLICK_MS);
    assert.equal(control.isEnabled(), true);
    assert.deepEqual(fake.setTerrainCalls.at(-1), {
      source: TERRAIN_SOURCE,
      exaggeration: 1,
    });

    // A second lone click toggles it back off.
    button.emit("click");
    t.mock.timers.tick(DOUBLE_CLICK_MS);
    assert.equal(control.isEnabled(), false);
    assert.equal(fake.setTerrainCalls.at(-1), null);
  });

  it("opens settings on a double click without flickering terrain", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const onOpenSettings = mock.fn();
    const { control, fake, button } = mount({ onOpenSettings });

    button.emit("click");
    button.emit("click");
    // The second click cancels the pending toggle, so terrain is only ever
    // enabled once (for the dialog) — never toggled on then back off.
    assert.equal(onOpenSettings.mock.callCount(), 1);
    assert.equal(control.isEnabled(), true);
    assert.equal(fake.setTerrainCalls.length, 1);

    // The cancelled single-click toggle must not fire late.
    t.mock.timers.tick(DOUBLE_CLICK_MS);
    assert.equal(fake.setTerrainCalls.length, 1);
  });

  it("ignores a 3rd rapid click so terrain stays on under the open dialog", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const onOpenSettings = mock.fn();
    const { control, fake, button } = mount({ onOpenSettings });

    button.emit("click"); // arms the single-click toggle
    button.emit("click"); // double-click → opens settings, enables terrain
    button.emit("click"); // 3rd rapid click must be swallowed, not re-armed
    assert.equal(control.isEnabled(), true);
    const callsAfterOpen = fake.setTerrainCalls.length;

    // The suppression window elapses without any late toggle firing.
    t.mock.timers.tick(DOUBLE_CLICK_MS);
    assert.equal(control.isEnabled(), true);
    assert.equal(fake.setTerrainCalls.length, callsAfterOpen);

    // Once suppression lifts, a fresh click toggles normally again.
    button.emit("click");
    t.mock.timers.tick(DOUBLE_CLICK_MS);
    assert.equal(control.isEnabled(), false);
  });

  it("applies a new exaggeration live only while terrain is enabled", () => {
    const { control, fake } = mount();

    // No-op (and no setTerrain) while terrain is off, but the value is retained.
    control.setExaggeration(2.5);
    assert.equal(fake.setTerrainCalls.length, 0);
    assert.equal(control.getExaggeration(), 2.5);

    control.setEnabled(true);
    assert.deepEqual(fake.setTerrainCalls.at(-1), {
      source: TERRAIN_SOURCE,
      exaggeration: 2.5,
    });

    // Now live: changing it re-applies terrain immediately.
    control.setExaggeration(4);
    assert.deepEqual(fake.setTerrainCalls.at(-1), {
      source: TERRAIN_SOURCE,
      exaggeration: 4,
    });
  });

  it("clamps invalid exaggeration values defensively", () => {
    const { control, fake } = mount();
    control.setEnabled(true);
    const enabledCall = fake.setTerrainCalls.length;

    // Negatives clamp to 0 (flat); non-finite values are ignored entirely.
    control.setExaggeration(-3);
    assert.equal(control.getExaggeration(), 0);
    assert.deepEqual(fake.setTerrainCalls.at(-1), {
      source: TERRAIN_SOURCE,
      exaggeration: 0,
    });

    control.setExaggeration(Number.NaN);
    assert.equal(control.getExaggeration(), 0);
    control.setExaggeration(Number.POSITIVE_INFINITY);
    assert.equal(control.getExaggeration(), 0);
    // NaN/Infinity did not re-apply terrain (only the -3 clamp call did).
    assert.equal(fake.setTerrainCalls.length, enabledCall + 1);
  });

  it("clamps an invalid exaggeration passed to the constructor", () => {
    assert.equal(mount({ exaggeration: -2 }).control.getExaggeration(), 0);
    assert.equal(mount({ exaggeration: Number.NaN }).control.getExaggeration(), 1);
  });

  it("unclamps the center while terrain is on and re-clamps when off", () => {
    const { control, fake } = mount();

    // Enabling terrain unclamps the center (false) BEFORE applying terrain, so
    // the first frame is already free of the constant-altitude zoom recompute.
    control.setEnabled(true);
    assert.deepEqual(fake.clampCalls, [false]);
    assert.equal(fake.setTerrainCalls.at(-1)?.source, TERRAIN_SOURCE);

    // Disabling terrain restores MapLibre's default center clamping (true).
    control.setEnabled(false);
    assert.deepEqual(fake.clampCalls, [false, true]);
    assert.equal(fake.setTerrainCalls.at(-1), null);

    // Redundant calls (already in the requested state) don't touch clamping.
    control.setEnabled(false);
    assert.deepEqual(fake.clampCalls, [false, true]);
  });

  it("reflects the enabled state on the button class and aria-pressed", () => {
    const { control, button } = mount();
    assert.equal(button.classList.has("maplibregl-ctrl-terrain-enabled"), false);
    assert.equal(button.attributes["aria-pressed"], "false");
    control.setEnabled(true);
    assert.equal(button.classList.has("maplibregl-ctrl-terrain-enabled"), true);
    assert.equal(button.attributes["aria-pressed"], "true");
    control.setEnabled(false);
    assert.equal(button.classList.has("maplibregl-ctrl-terrain-enabled"), false);
    assert.equal(button.attributes["aria-pressed"], "false");
  });
});
