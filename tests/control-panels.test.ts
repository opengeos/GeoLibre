import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  closeControlPanel,
  isControlPanelVisible,
  openControlPanel,
} from "../packages/plugins/src/control-panels";
import {
  __setComponentsModuleLoaderForTests,
  getComponentsConstructors,
  type ComponentsModules,
} from "../packages/plugins/src/plugins/components/constructors";
import { subscribeMeasurePanel } from "../packages/plugins/src/plugins/components/measure";
import {
  openMinimapPanel,
  subscribeMinimapPanel,
} from "../packages/plugins/src/plugins/components/minimap";
import type { GeoLibreAppAPI, GeoLibreControlPanelId } from "../packages/plugins/src/types";
import { teardownPrintControl } from "../packages/plugins/src/plugins/components/print";
import { teardownSearchControl } from "../packages/plugins/src/plugins/components/search";

class Panel {
  on() {
    return this;
  }
  show() {
    return this;
  }
  hide() {
    return this;
  }
  expand() {
    return this;
  }
}

class Overview {
  collapsed: boolean;
  constructor(readonly options: Record<string, unknown>) {
    this.collapsed = options.collapsed === true;
    created.push(this);
  }
  show() {
    return this;
  }
  expand() {
    this.collapsed = false;
    return this;
  }
  collapse() {
    this.collapsed = true;
    return this;
  }
  getState() {
    return { visible: true, collapsed: this.collapsed };
  }
}

// Records the options and collapsed state the Measure panel is driven with,
// and the expand listeners it leaves on the control.
class Ruler {
  collapsed: boolean;
  listeners = new Map<string, Set<() => void>>();
  constructor(readonly options: Record<string, unknown>) {
    this.collapsed = options.collapsed === true;
    rulers.push(this);
  }
  on(event: string, handler: () => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
    return this;
  }
  off(event: string, handler: () => void) {
    this.listeners.get(event)?.delete(handler);
    return this;
  }
  show() {
    return this;
  }
  expand() {
    if (!this.collapsed) return this;
    this.collapsed = false;
    for (const handler of [...(this.listeners.get("expand") ?? [])]) handler();
    return this;
  }
  collapse() {
    this.collapsed = true;
    return this;
  }
  setRadius() {
    return this;
  }
  getState() {
    return { collapsed: this.collapsed, isDrawing: !this.collapsed };
  }
}

const rulers: Ruler[] = [];
const created: Overview[] = [];
const mounted = new Set<unknown>();
let basemap = "https://example.com/initial.json";
let onBasemapChange: (() => void) | undefined;
let canMount = true;
const app = {
  getActiveBasemap: () => basemap,
  addMapControl: (control: unknown) => {
    if (!canMount) return false;
    mounted.add(control);
    return true;
  },
  removeMapControl: (control: unknown) => mounted.delete(control),
  onBasemapChange: (callback: () => void) => {
    onBasemapChange = callback;
    return () => {
      onBasemapChange = undefined;
    };
  },
} as unknown as GeoLibreAppAPI;

const modules = [
  {
    MinimapControl: Overview,
    BookmarkControl: Panel,
    SearchControl: Panel,
    MeasureControl: Ruler,
    PrintControl: Panel,
  },
  null,
] as unknown as ComponentsModules;
// Flush the lazy import and the control's deferred show/expand callback.
async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("built-in control panel API", () => {
  beforeEach(() => {
    created.length = 0;
    rulers.length = 0;
    mounted.clear();
    canMount = true;
    basemap = "https://example.com/initial.json";
    __setComponentsModuleLoaderForTests(() => Promise.resolve(modules));
  });
  afterEach(() => {
    for (const id of ["bookmark", "search", "measure", "minimap", "print"] as const)
      closeControlPanel(app, id);
    teardownPrintControl(app);
    teardownSearchControl(app);
    __setComponentsModuleLoaderForTests(null);
  });

  it("uses the menu's visibility store and creates only one overview on repeated opens", async () => {
    let changes = 0;
    const unsubscribe = subscribeMinimapPanel(() => changes++);
    try {
      assert.equal(isControlPanelVisible("minimap"), false);
      openControlPanel(app, "minimap", { zoomOffset: -6, width: 320, height: 220 });
      openControlPanel(app, "minimap");
      await settle();
      openControlPanel(app, "minimap");
      await settle();
      assert.equal(created.length, 1);
      assert.equal(mounted.size, 1);
      assert.equal(isControlPanelVisible("minimap"), true);
      assert.equal(changes, 1);
      assert.equal(created[0].options.zoomOffset, -6);
      assert.equal(created[0].options.width, 320);
      assert.equal(created[0].options.height, 220);
      closeControlPanel(app, "minimap");
      closeControlPanel(app, "minimap");
      assert.equal(mounted.size, 0);
      assert.equal(isControlPanelVisible("minimap"), false);
      assert.equal(changes, 2);
    } finally {
      unsubscribe();
    }
  });

  it("updates an open overview and keeps its options and collapsed state across basemap changes", async () => {
    openControlPanel(app, "minimap", { zoomOffset: -6, width: 320 });
    await settle();
    created[0].collapsed = true;
    const visibilityChanges: boolean[] = [];
    const unsubscribe = subscribeMinimapPanel(() =>
      visibilityChanges.push(isControlPanelVisible("minimap")),
    );
    try {
      openControlPanel(app, "minimap", { height: 240 });
      await settle();
      assert.equal(mounted.size, 1);
      assert.equal(created.length, 2);
      assert.equal(created[1].collapsed, true);
      assert.deepEqual(visibilityChanges, []);
    } finally {
      unsubscribe();
    }
    basemap = "https://example.com/next.json";
    onBasemapChange?.();
    await settle();
    assert.equal(created.length, 3);
    assert.equal(mounted.size, 1);
    const latest = created[2];
    assert.equal(latest.options.style, basemap);
    assert.equal(latest.options.zoomOffset, -6);
    assert.equal(latest.options.width, 320);
    assert.equal(latest.options.height, 240);
    assert.equal(latest.collapsed, true);
  });

  it("keeps a collapsed overview collapsed on a repeated direct menu open", async () => {
    openMinimapPanel(app);
    openMinimapPanel(app);
    await settle();
    created[0].collapsed = true;
    openMinimapPanel(app);
    await settle();
    assert.equal(created.length, 1);
    assert.equal(created[0].collapsed, true);
  });

  it("resets options after close so a later menu open uses the defaults", async () => {
    openControlPanel(app, "minimap", { zoomOffset: -6, width: 320, height: 220 });
    await settle();
    closeControlPanel(app, "minimap");
    assert.equal(onBasemapChange, undefined);
    openControlPanel(app, "minimap");
    await settle();
    assert.equal(created[1].options.zoomOffset, -4);
    assert.equal(created[1].options.width, 250);
    assert.equal(created[1].options.height, 180);
  });

  it("does not reopen after close while constructors are loading", async () => {
    let resolve!: (value: ComponentsModules) => void;
    __setComponentsModuleLoaderForTests(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    openControlPanel(app, "minimap");
    closeControlPanel(app, "minimap");
    resolve(modules);
    await settle();
    assert.equal(created.length, 0);
    assert.equal(mounted.size, 0);
    assert.equal(isControlPanelVisible("minimap"), false);
  });

  for (const id of ["bookmark", "search", "measure", "print"] as const) {
    it(`cancels ${id} when closed before its constructors load`, async () => {
      let resolve!: (value: ComponentsModules) => void;
      __setComponentsModuleLoaderForTests(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      openControlPanel(app, id);
      closeControlPanel(app, id);
      resolve(modules);
      await settle();
      assert.equal(mounted.size, 0);
      assert.equal(isControlPanelVisible(id), false);
    });

    it(`does not show ${id} after close between mounting and its deferred show`, async () => {
      openControlPanel(app, id);
      await getComponentsConstructors();
      assert.equal(mounted.size, 1);
      closeControlPanel(app, id);
      await settle();
      assert.equal(isControlPanelVisible(id), false);
    });
  }

  it("lets the latest configuration win during concurrent opens", async () => {
    openControlPanel(app, "minimap", { zoomOffset: -5 });
    openControlPanel(app, "minimap", { zoomOffset: -7 });
    await settle();
    assert.equal(created.length, 1);
    assert.equal(created[0].options.zoomOffset, -7);
    assert.equal(mounted.size, 1);
  });

  it("keeps visibility false when the renderer cannot mount the control", async () => {
    canMount = false;
    openControlPanel(app, "minimap");
    await settle();
    assert.equal(mounted.size, 0);
    assert.equal(isControlPanelVisible("minimap"), false);
    assert.equal(onBasemapChange, undefined);
  });

  it("rejects invalid dimensions and non-finite offsets before changing an open control", async () => {
    openControlPanel(app, "minimap");
    await settle();
    for (const options of [
      { width: 0 },
      { height: -1 },
      { width: NaN },
      { zoomOffset: Infinity },
    ]) {
      assert.throws(() => openControlPanel(app, "minimap", options), /must be a finite/);
    }
    assert.equal(mounted.size, 1);
    assert.equal(created.length, 1);
    assert.equal(isControlPanelVisible("minimap"), true);
  });

  it("opens Measure collapsed with the project's units (GeoLibre#3241)", async () => {
    openControlPanel(app, "measure", {
      collapsed: true,
      distanceUnit: "feet",
      areaUnit: "acres",
    });
    await settle();
    assert.equal(rulers.length, 1);
    const [ruler] = rulers;
    assert.equal(ruler.options.collapsed, true);
    assert.equal(ruler.options.distanceUnit, "feet");
    assert.equal(ruler.options.areaUnit, "acres");
    assert.equal(ruler.collapsed, true);
    assert.equal(isControlPanelVisible("measure"), true);
    // The panel is built on first expand, so its add-ons wait for that.
    assert.equal(ruler.listeners.get("expand")?.size, 1);
    // Expanding the same instance later consumes the wait.
    openControlPanel(app, "measure", { collapsed: false });
    await settle();
    assert.equal(rulers.length, 1);
    assert.equal(ruler.collapsed, false);
    assert.equal(ruler.listeners.get("expand")?.size, 0);
  });

  it("opens Measure expanded in kilometers from the menu", async () => {
    openControlPanel(app, "measure");
    await settle();
    assert.equal(rulers.length, 1);
    assert.equal(rulers[0].collapsed, false);
    assert.equal(rulers[0].options.distanceUnit, "kilometers");
    assert.equal(rulers[0].options.areaUnit, "square-kilometers");
  });

  it("rebuilds an open Measure control for new units and resets them on close", async () => {
    openControlPanel(app, "measure");
    await settle();
    const visibilityChanges: boolean[] = [];
    const unsubscribe = subscribeMeasurePanel(() =>
      visibilityChanges.push(isControlPanelVisible("measure")),
    );
    try {
      openControlPanel(app, "measure", { distanceUnit: "miles" });
      await settle();
      assert.equal(rulers.length, 2);
      assert.equal(mounted.size, 1);
      assert.ok(mounted.has(rulers[1]));
      assert.equal(rulers[1].options.distanceUnit, "miles");
      assert.deepEqual(visibilityChanges, []);
      // Same units again: no rebuild.
      openControlPanel(app, "measure", { distanceUnit: "miles" });
      await settle();
      assert.equal(rulers.length, 2);
    } finally {
      unsubscribe();
    }
    closeControlPanel(app, "measure");
    assert.equal(rulers[1].listeners.get("expand")?.size ?? 0, 0);
    openControlPanel(app, "measure");
    await settle();
    assert.equal(rulers[2].options.distanceUnit, "kilometers");
  });

  it("keeps a folded ruler folded when only its units change or nothing does", async () => {
    openControlPanel(app, "measure", { collapsed: true });
    await settle();
    openControlPanel(app, "measure", {});
    await settle();
    assert.equal(rulers.length, 1);
    assert.equal(rulers[0].collapsed, true);
    openControlPanel(app, "measure", { distanceUnit: "feet" });
    await settle();
    assert.equal(rulers.length, 2);
    assert.equal(rulers[1].collapsed, true);
  });

  it("rejects invalid Measure options before touching an open panel", async () => {
    openControlPanel(app, "measure");
    await settle();
    assert.throws(
      () => openControlPanel(app, "measure", { distanceUnit: "furlongs" as "feet" }),
      /distanceUnit must be one of/,
    );
    assert.throws(
      () => openControlPanel(app, "measure", { areaUnit: "feet" as "acres" }),
      /areaUnit must be one of/,
    );
    assert.throws(
      () => openControlPanel(app, "measure", { collapsed: "yes" as unknown as boolean }),
      /collapsed must be a boolean/,
    );
    assert.equal(rulers.length, 1);
    assert.equal(mounted.size, 1);
    assert.throws(
      () => openControlPanel(app, "search", { collapsed: true }),
      /only supported for minimap and measure/,
    );
  });

  it("opens the overview collapsed on request and folds an open one in place", async () => {
    openControlPanel(app, "minimap", { collapsed: true });
    await settle();
    assert.equal(created.length, 1);
    assert.equal(created[0].options.collapsed, true);
    assert.equal(created[0].collapsed, true);
    openControlPanel(app, "minimap", { collapsed: false });
    await settle();
    assert.equal(created.length, 1);
    assert.equal(created[0].collapsed, false);
    openControlPanel(app, "minimap", { collapsed: true });
    await settle();
    assert.equal(created.length, 1);
    assert.equal(created[0].collapsed, true);
  });

  it("rejects unknown panel ids, including object prototype members", () => {
    for (const id of ["unknown", "toString", "__proto__"]) {
      const invalid = id as GeoLibreControlPanelId;
      assert.throws(() => openControlPanel(app, invalid), /Unknown control panel/);
      assert.throws(() => closeControlPanel(app, invalid), /Unknown control panel/);
      assert.throws(() => isControlPanelVisible(invalid), /Unknown control panel/);
    }
  });
});
