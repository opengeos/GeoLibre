import assert from "node:assert/strict";
import { it } from "node:test";
import type { ArcgisEngine } from "../packages/map/src/arcgis-engine";
import { ArcgisDeckOverlay } from "../packages/plugins/src/plugins/arcgis-deck/overlay";

type View = NonNullable<ReturnType<ArcgisEngine["getView"]>>;
function fixture(type = "2d", viewingMode = "local") {
  const added: object[] = [];
  const removed: object[] = [];
  const instances: { destroyed: boolean }[] = [];
  const module = {
    default: {
      createSubclass(definition: object) {
        class Native {
          destroyed = false;
          constructor(props: object) {
            Object.assign(this, props);
            instances.push(this);
          }
          destroy() {
            this.destroyed = true;
          }
        }
        Object.assign(Native.prototype, definition);
        return Native;
      },
    },
  };
  const view = {
    type,
    viewingMode,
    map: {
      add: (layer: object) => added.push(layer),
      remove: (layer: object) => removed.push(layer),
    },
  } as unknown as View;
  return { view, module, added, removed, instances };
}

it("cancels an ArcGIS overlay removed while CDN modules are loading", async () => {
  const f = fixture();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const overlay = new ArcgisDeckOverlay(f.view, {}, async () => {
    await wait;
    return f.module;
  });
  const first = overlay.mount();
  assert.equal(overlay.mount(), first, "concurrent producers share the same mount");
  overlay.finalize();
  release();
  await first;
  assert.equal(f.added.length, 0);
});

it("mounts one native 2D layer and can dispose after the old view loses its map", async () => {
  const f = fixture();
  const overlay = new ArcgisDeckOverlay(f.view, {}, async () => f.module);
  await Promise.all([overlay.mount(), overlay.mount()]);
  assert.equal(f.added.length, 1);
  Object.assign(f.view, { map: null });
  overlay.finalize();
  overlay.finalize();
  assert.deepEqual(f.removed, f.added);
  assert.equal(f.instances[0].destroyed, true);
});

it("destroys a local scene RenderNode and does not mount in a global scene", async () => {
  const local = fixture("3d", "local");
  const overlay = new ArcgisDeckOverlay(local.view, {}, async () => local.module);
  await overlay.mount();
  assert.equal(local.added.length, 0, "RenderNode registers with the view, not map.layers");
  assert.equal(local.instances.length, 1);
  overlay.finalize();
  assert.equal(local.instances[0].destroyed, true);
  const global = fixture("3d", "global");
  let imports = 0;
  const globeOverlay = new ArcgisDeckOverlay(global.view, {}, async () => {
    imports++;
    return global.module;
  });
  await globeOverlay.mount();
  assert.equal(imports, 0);
});

it("retries a failed CDN mount on the same view", async () => {
  const f = fixture();
  let unavailable = true;
  const overlay = new ArcgisDeckOverlay(f.view, {}, async () => {
    if (unavailable) throw new Error("CDN unavailable");
    return f.module;
  });
  await assert.rejects(overlay.mount(), /CDN unavailable/);
  unavailable = false;
  await overlay.mount();
  assert.equal(f.added.length, 1);
  overlay.finalize();
});

it("coalesces hover picks per frame and cancels queued work on disposal", async () => {
  const f = fixture();
  const handlers = new Map<string, (event: { x: number; y: number }) => void>();
  Object.assign(f.view, {
    on: (type: string, handler: (event: { x: number; y: number }) => void) => {
      handlers.set(type, handler);
      return { remove: () => handlers.delete(type) };
    },
  });
  const oldRequest = globalThis.requestAnimationFrame;
  const oldCancel = globalThis.cancelAnimationFrame;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  globalThis.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };
  const hoverStates: boolean[] = [];
  const layer = {
    props: { onHover: (info: { picked: boolean }) => hoverStates.push(info.picked) },
  };
  const clickStates: boolean[] = [];
  const overlay = new ArcgisDeckOverlay(
    f.view,
    { onClick: (info) => clickStates.push(info.picked) },
    async () => f.module,
  );
  const picks: { x: number; y: number }[] = [];
  overlay.getDeck = () =>
    ({
      pickObject: (point: { x: number; y: number }) => {
        picks.push(point);
        return point.x === 99 ? { picked: true, object: {}, index: 0, layer } : null;
      },
    }) as unknown as ReturnType<typeof overlay.getDeck>;
  try {
    await overlay.mount();
    for (let x = 0; x < 100; x++) handlers.get("pointer-move")!({ x, y: 2 });
    assert.equal(picks.length, 0);
    assert.equal(frames.size, 1);
    handlers.get("click")!({ x: 7, y: 8 });
    assert.deepEqual(picks, [{ x: 7, y: 8 }]);
    assert.deepEqual(clickStates, [false]);
    const frame = [...frames.values()][0];
    frames.clear();
    frame(0);
    assert.deepEqual(picks[1], { x: 99, y: 2 });
    assert.deepEqual(hoverStates, [true]);
    handlers.get("pointer-move")!({ x: 100, y: 2 });
    const leaveFrame = [...frames.values()][0];
    frames.clear();
    leaveFrame(0);
    assert.deepEqual(hoverStates, [true, false]);
    handlers.get("pointer-move")!({ x: 101, y: 2 });
    overlay.finalize();
    assert.equal(frames.size, 0);
    assert.equal(handlers.size, 0);
  } finally {
    overlay.finalize();
    globalThis.requestAnimationFrame = oldRequest;
    globalThis.cancelAnimationFrame = oldCancel;
  }
});
it("measures scene camera distance relative to the focal elevation", async () => {
  const { getCameraDistance } =
    await import("../packages/plugins/src/plugins/arcgis-deck/deck-renderer.js");
  const camera = { latitude: 45, longitude: 10, z: 1500 };
  const focal = { latitude: 45, longitude: 10, z: 1000 };
  assert.equal(getCameraDistance(camera, focal), 500);
  assert.equal(getCameraDistance({ ...camera, z: 500 }, { ...focal, z: 0 }), 500);
  assert.equal(getCameraDistance(camera, { latitude: 45, longitude: 10 }), 1500);
});

function resourceFixture() {
  let finalized = 0;
  let props: unknown;
  const resources = {
    deck: {
      setProps: (value: unknown) => {
        props = value;
      },
      finalize: () => finalized++,
    },
    model: { device: {}, destroy() {} },
    fbo: { destroy() {} },
    texture: { destroy() {} },
  } as unknown as import("../packages/plugins/src/plugins/arcgis-deck/commons.js").RenderResources;
  return {
    resources,
    get finalized() {
      return finalized;
    },
    get props() {
      return props;
    },
  };
}

type TestLayerView = {
  attach(): Promise<void>;
  detach(): void;
  requestRender(): void;
};
async function mountLayerView(overlay: ArcgisDeckOverlay, f: ReturnType<typeof fixture>) {
  await overlay.mount();
  const layer = f.added[0] as { createLayerView(view: View): TestLayerView };
  const view = layer.createLayerView(f.view);
  let renders = 0;
  view.requestRender = () => {
    renders++;
  };
  return {
    view,
    get renders() {
      return renders;
    },
  };
}

it("recovers resource initialization on the current layer view and applies latest props", async () => {
  const f = fixture();
  const r = resourceFixture();
  let attempts = 0;
  const errors: Error[] = [];
  const overlay = new ArcgisDeckOverlay(
    f.view,
    { onError: (e) => errors.push(e) },
    async () => f.module,
    async () => {
      if (++attempts === 1) throw new Error("temporary device failure");
      return r.resources;
    },
  );
  const mounted = await mountLayerView(overlay, f);
  const attaching = mounted.view.attach();
  overlay.setProps({ pickingRadius: 7 });
  await attaching;
  assert.equal(attempts, 2);
  assert.equal((r.props as { pickingRadius: number }).pickingRadius, 7);
  assert.ok(mounted.renders > 0);
  assert.deepEqual(errors, []);
  overlay.finalize();
  assert.equal(r.finalized, 1);
});

it("bounds resource retries and reports only the exhausted failure", async () => {
  const f = fixture();
  let attempts = 0;
  const errors: Error[] = [];
  const overlay = new ArcgisDeckOverlay(
    f.view,
    { onError: (e) => errors.push(e) },
    async () => f.module,
    async () => {
      attempts++;
      throw new Error("device unavailable");
    },
  );
  const mounted = await mountLayerView(overlay, f);
  await mounted.view.attach();
  assert.equal(attempts, 3);
  assert.equal(errors.length, 1);
  overlay.finalize();
});

for (const action of ["detach", "dispose"] as const) {
  it(`stops resource retries after ${action}`, async () => {
    const f = fixture();
    let attempts = 0;
    const overlay = new ArcgisDeckOverlay(
      f.view,
      {},
      async () => f.module,
      async () => {
        attempts++;
        throw new Error("temporary device failure");
      },
    );
    const mounted = await mountLayerView(overlay, f);
    const attaching = mounted.view.attach();
    await Promise.resolve();
    if (action === "detach") mounted.view.detach();
    else overlay.finalize();
    await attaching;
    assert.equal(attempts, 1);
    overlay.finalize();
  });
}
