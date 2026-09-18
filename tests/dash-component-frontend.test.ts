import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// The Dash bundle is a plain IIFE served to the browser (no module system), so
// it is evaluated here against a minimal React/window stand-in rather than
// imported. The harness runs hooks the way React does: refs are attached
// before effects, and effects re-run only when their deps change.
const BUNDLE = readFileSync(
  fileURLToPath(new URL("../python/src/geolibre/static/dash/geolibre.js", import.meta.url)),
  "utf-8",
);

type Hook = { value?: unknown; deps?: unknown[]; cleanup?: (() => void) | void };
type Posted = { message: Record<string, unknown>; origin: string };

const sameDeps = (a: unknown[] | undefined, b: unknown[] | undefined) =>
  a !== undefined && b !== undefined && a.length === b.length && a.every((d, i) => d === b[i]);

function mount(initialProps: Record<string, unknown>) {
  const hooks: Hook[] = [];
  const posted: Posted[] = [];
  const listeners = new Set<(event: unknown) => void>();
  let index = 0;
  let pending: { hook: Hook; fn: () => (() => void) | void; deps?: unknown[] }[] = [];

  const contentWindow = {
    postMessage: (message: Record<string, unknown>, origin: string) =>
      posted.push({ message, origin }),
  };
  const iframe = { contentWindow };

  const slot = (): Hook => (hooks[index] ??= {});
  const React = {
    useRef(initial: unknown) {
      const hook = slot();
      hook.value ??= { current: initial };
      index += 1;
      return hook.value;
    },
    useCallback(fn: () => void, deps: unknown[]) {
      const hook = slot();
      if (!sameDeps(hook.deps, deps)) {
        hook.value = fn;
        hook.deps = deps;
      }
      index += 1;
      return hook.value;
    },
    useEffect(fn: () => (() => void) | void, deps?: unknown[]) {
      pending.push({ hook: slot(), fn, deps });
      index += 1;
    },
    createElement: (type: string, props: Record<string, unknown>) => ({ type, props }),
  };

  const win = {
    React,
    dash_component_api: undefined,
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      if (type === "message") listeners.add(fn);
    },
    removeEventListener: (type: string, fn: (event: unknown) => void) => {
      if (type === "message") listeners.delete(fn);
    },
  } as Record<string, unknown>;
  new Function("window", BUNDLE)(win);
  const DashMap = (
    win.geolibre as { DashMap: (props: unknown) => { props: Record<string, unknown> } }
  ).DashMap;

  const render = (props: Record<string, unknown>) => {
    index = 0;
    pending = [];
    const element = DashMap(props);
    (element.props.ref as { current: unknown }).current = iframe;
    for (const effect of pending) {
      if (effect.deps !== undefined && sameDeps(effect.hook.deps, effect.deps)) continue;
      effect.hook.cleanup?.();
      effect.hook.cleanup = effect.fn();
      effect.hook.deps = effect.deps;
    }
    return element;
  };

  const element = render(initialProps);
  const dispatch = (event: Record<string, unknown>) => {
    for (const listener of [...listeners]) listener(event);
  };
  const ready = () =>
    dispatch({
      source: contentWindow,
      origin: "http://127.0.0.1:8765",
      data: { type: "geolibre:ready" },
    });

  return { element, render, dispatch, ready, posted, contentWindow };
}

const APP_URL = "http://127.0.0.1:8765/";

describe("Dash DashMap component", () => {
  it("sends the project once the iframe reports ready", () => {
    const app = mount({ appUrl: APP_URL, project: { layers: [] } });
    assert.equal(app.posted.length, 0);
    app.ready();
    assert.deepEqual(app.posted, [
      {
        message: {
          type: "geolibre:load-project",
          project: { layers: [] },
          trustedWidget: false,
          seq: 1,
        },
        origin: "http://127.0.0.1:8765",
      },
    ]);
  });

  it("pushes a project changed after ready, without reloading the iframe", () => {
    const first = { layers: [] };
    const second = { layers: [{ id: "a" }] };
    const app = mount({ appUrl: APP_URL, project: first });
    app.ready();
    const before = app.element.props.src as string;

    const rerendered = app.render({ appUrl: APP_URL, project: second });

    assert.equal(rerendered.props.src, before, "src must stay identical (no reload)");
    assert.equal(app.posted.length, 2);
    assert.deepEqual(app.posted[1].message, {
      type: "geolibre:load-project",
      project: second,
      trustedWidget: false,
      seq: 2,
    });
  });

  it("waits for ready before pushing a project change", () => {
    const app = mount({ appUrl: APP_URL, project: { layers: [] } });
    const updated = { layers: [{ id: "a" }] };
    app.render({ appUrl: APP_URL, project: updated });
    assert.equal(app.posted.length, 0, "nothing is sent before the app is ready");
    app.ready();
    assert.equal(app.posted.length, 1);
    assert.deepEqual(app.posted[0].message.project, updated);
  });

  it("ignores messages from another window or origin", () => {
    const app = mount({ appUrl: APP_URL, project: { layers: [] } });
    app.dispatch({ source: {}, origin: "http://127.0.0.1:8765", data: { type: "geolibre:ready" } });
    app.dispatch({
      source: app.contentWindow,
      origin: "https://evil.example",
      data: { type: "geolibre:ready" },
    });
    assert.equal(app.posted.length, 0);
  });

  it("maps a click event onto clickData with an object lngLat", () => {
    const calls: Record<string, unknown>[] = [];
    const app = mount({
      appUrl: APP_URL,
      project: { layers: [] },
      setProps: (update: Record<string, unknown>) => calls.push(update),
    });
    app.dispatch({
      source: app.contentWindow,
      origin: "http://127.0.0.1:8765",
      data: {
        type: "geolibre:event",
        event: "click",
        payload: { lngLat: [-122.4, 37.8], features: [] },
      },
    });
    assert.deepEqual(calls, [{ clickData: { lngLat: { lng: -122.4, lat: 37.8 }, features: [] } }]);
  });
});
