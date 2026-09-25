/**
 * Component-test harness: render real React panels under `node --test`.
 *
 * Import this module FIRST in a component test file, then load the component
 * under test with a dynamic `import()`:
 *
 * ```ts
 * import { render, screen, fireEvent, useAppStore } from "./helpers/dom";
 * const { LayerPanel } = await import("../apps/geolibre-desktop/src/components/panels/LayerPanel");
 * ```
 *
 * Evaluating this module:
 * - registers `vite-hooks.ts` and the `define` constants, so the component's
 *   JSX, CSS/asset imports, `virtual:` modules and `import.meta.env` reads
 *   work as they do under Vite. The hooks only affect modules loaded *after*
 *   registration, which is why components must be imported dynamically
 *   rather than with a static import (static imports are all resolved before
 *   any module body runs);
 * - installs a happy-dom window as the global DOM (see {@link installDom});
 * - initializes the app's own i18next instance (`src/i18n`), so components
 *   render real English strings from `en.json`;
 * - makes `fetch` reject (see {@link mockFetch});
 * - registers `afterEach` / `after` hooks on the importing file: each test
 *   ends with React Testing Library's `cleanup()`, a store reset
 *   ({@link resetStores}), a cleared `localStorage` and the default `fetch`
 *   and layout restored; the window is closed after the last test so no
 *   happy-dom timer keeps the process alive.
 *
 * Keep assertions on plain values (`textContent`, `.checked`, store state)
 * rather than on DOM nodes: `assert.equal` on a node makes Node's assertion
 * error formatter walk the whole happy-dom tree when it fails, which reads as
 * a hang.
 *
 * Why happy-dom and not linkedom (which `panel-dom.test.ts` and other
 * hand-built-DOM tests use): React DOM, Radix and Testing Library need more
 * of a browser than linkedom provides. linkedom has no `getComputedStyle`
 * (Testing Library's accessible-name queries), no `KeyboardEvent` or
 * `PointerEvent` (Radix menus open on pointer events), no `ResizeObserver`,
 * `matchMedia`, `requestAnimationFrame` or `localStorage`, and clicking a
 * checkbox does not check it.
 */
import { registerHooks } from "node:module";
import { after, afterEach } from "node:test";
import { GlobalWindow, PropertySymbol } from "happy-dom";
import { createElement, type ReactElement, type ReactNode } from "react";
import type { RenderOptions, RenderResult } from "@testing-library/react";
import * as viteHooks from "./vite-hooks";

registerHooks(viteHooks);

/**
 * Build-time constants the app's `vite.config.ts` injects with `define`,
 * set to the values of a plain web build.
 */
Object.assign(globalThis, {
  __GEOLIBRE_VERSION__: "0.0.0-test",
  __GEOLIBRE_STORE_BUILD__: false,
  __GEOLIBRE_MAS_BUILD__: false,
  __GEOLIBRE_EMBED_BUILD__: false,
  __NO_EXTERNAL_CDN__: false,
  __PGLITE_CDN_URL__: "",
  __PGLITE_POSTGIS_CDN_URL__: "",
  __CEREUS_WASM_CDN_URL__: "",
  __GDAL3_CDN_PATHS__: null,
  __GEOLIBRE_BUILD_ENV__: {},
});

/**
 * Node globals that stay Node's own even though happy-dom's window defines a
 * same-named property. Timers must stay Node's so `node --test` and React's
 * scheduler keep working after the window closes; networking and encoding
 * primitives stay Node's so code under test behaves as it does in other tests.
 */
const KEEP_NODE_GLOBALS = new Set([
  "undefined",
  "NaN",
  "global",
  "globalThis",
  "constructor",
  "console",
  "process",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "setImmediate",
  "clearImmediate",
  "queueMicrotask",
  "structuredClone",
  "performance",
  "crypto",
  "fetch",
  "Request",
  "Response",
  "Headers",
  "URL",
  "URLSearchParams",
  "AbortController",
  "AbortSignal",
  "TextEncoder",
  "TextDecoder",
  "Blob",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
]);

/**
 * Install a happy-dom window as the global DOM, the way happy-dom's own
 * `GlobalRegistrator` does (that package is not a dependency here), minus the
 * Node primitives listed in {@link KEEP_NODE_GLOBALS}.
 *
 * The globals are deliberately left in place at teardown: React's scheduler
 * can still run a queued task (in a `setImmediate`) after the last test, and
 * it reads `window.event` there. Removing `window` first turns that into an
 * uncaught `ReferenceError` that `node --test` pins on the first test. Each
 * test file runs in its own process, so nothing else ever sees them.
 *
 * @returns A function that closes the window, cancelling its timers,
 *   animation frames and observers so none of them keeps the process alive.
 */
export function installDom(): () => Promise<void> {
  const window = new GlobalWindow({
    url: "http://localhost:5173/",
    width: 1280,
    height: 800,
    console: globalThis.console,
  });
  const descriptors = Object.getOwnPropertyDescriptors(window);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (KEEP_NODE_GLOBALS.has(key)) continue;
    const existing = Object.getOwnPropertyDescriptor(globalThis, key);
    if (existing && "value" in existing && existing.value === descriptor.value) continue;
    // `window.window`, `window.self` and friends point back at the global
    // object, so `window.foo = x` and a bare `foo` stay the same binding.
    const value = descriptor.value === window ? globalThis : descriptor.value;
    Object.defineProperty(globalThis, key, {
      ...descriptor,
      ...("value" in descriptor ? { value } : {}),
      configurable: true,
    });
  }
  (window.document as unknown as Record<symbol, unknown>)[PropertySymbol.defaultView] = globalThis;

  return () => window.happyDOM.close();
}

const closeDom = installDom();

// Loaded after the DOM exists: Testing Library binds `screen` to
// `document.body` when it is first evaluated.
const rtl = await import("@testing-library/react");
const i18nModule = await import("../../apps/geolibre-desktop/src/i18n");
await i18nModule.i18nReady;
const { useAppStore, clearHistory } = await import("@geolibre/core");
const { DirectionProvider, TooltipProvider } = await import("@geolibre/ui");
const { I18nextProvider } = await import("react-i18next");
const { useDesktopSettingsStore } =
  await import("../../apps/geolibre-desktop/src/hooks/useDesktopSettings");

/** The app's i18next instance, initialized with the English catalog. */
export const i18n = i18nModule.default;

export const { screen, fireEvent, within, waitFor, act, cleanup } = rtl;
export { useAppStore, useDesktopSettingsStore };

/**
 * The context providers `main.tsx` and `App.tsx` wrap the whole app in, so a
 * panel rendered on its own finds the same i18n, tooltip and text-direction
 * contexts it has in the real shell.
 */
function AppProviders({ children }: { children?: ReactNode }): ReactElement {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(DirectionProvider, {
      dir: "ltr",
      children: createElement(TooltipProvider, { delayDuration: 0, children }),
    }),
  );
}

/**
 * Testing Library's `render`, wrapped in {@link AppProviders}.
 *
 * @param ui - The element to render.
 * @param options - Extra Testing Library render options.
 * @returns Testing Library's render result.
 */
export function render(
  ui: ReactElement,
  options: Omit<RenderOptions, "wrapper"> = {},
): RenderResult {
  return rtl.render(ui, { ...options, wrapper: AppProviders });
}

/**
 * Freeze every plain object and array reachable from `value`, leaving
 * functions (store actions) alone. `resetStores` hands the same initial state
 * object to every test, so an in-place mutation of it would leak between
 * tests; frozen, such a mutation throws (ES modules run in strict mode)
 * instead of silently poisoning the baseline.
 *
 * @param value The state to freeze.
 * @returns The same value, frozen.
 */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const initialAppState = deepFreeze(useAppStore.getInitialState());
const initialDesktopSettings = deepFreeze(useDesktopSettingsStore.getInitialState());

/**
 * Restore the app store and the desktop-settings store to their initial state
 * and drop the undo history, so one test's layers, selection, dialog flags or
 * settings never leak into the next.
 */
export function resetStores(): void {
  useAppStore.setState(initialAppState, true);
  clearHistory();
  useDesktopSettingsStore.setState(initialDesktopSettings, true);
}

/**
 * Component tests never touch the network. The default `fetch` rejects the
 * way an unreachable host does, so a panel that probes a service on mount
 * (the Vector tools dialog asks the sidecar for its status) takes its offline
 * path instead of opening a real socket that could keep the process alive.
 * Replace it per test with {@link mockFetch}.
 */
const offlineFetch: typeof fetch = (input) =>
  Promise.reject(new TypeError(`fetch is disabled in component tests: ${String(input)}`));
const nodeFetch = globalThis.fetch;
globalThis.fetch = offlineFetch;

/**
 * Serve `fetch` from `handler` for the rest of the current test.
 *
 * @param handler - Stand-in `fetch` implementation.
 */
export function mockFetch(handler: typeof fetch): void {
  globalThis.fetch = handler;
}

let restoreLayout: (() => void) | null = null;

/**
 * Give every element a fixed layout box for the rest of the current test.
 * happy-dom does no layout, so `offsetWidth`/`offsetHeight` are 0 and a
 * virtualized list (the attribute table uses TanStack Virtual) renders no
 * rows at all.
 *
 * @param width - Width in CSS pixels reported by every element.
 * @param height - Height in CSS pixels reported by every element.
 */
export function stubLayout(width = 1024, height = 768): void {
  restoreLayout?.();
  const proto = HTMLElement.prototype;
  const keys = ["offsetWidth", "offsetHeight", "clientWidth", "clientHeight"] as const;
  const saved = keys.map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const);
  for (const key of keys) {
    Object.defineProperty(proto, key, {
      configurable: true,
      get: () => (key.endsWith("Width") ? width : height),
    });
  }
  restoreLayout = () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(proto, key, descriptor);
      else delete (proto as unknown as Record<string, unknown>)[key];
    }
    restoreLayout = null;
  };
}

afterEach(() => {
  rtl.cleanup();
  resetStores();
  restoreLayout?.();
  globalThis.fetch = offlineFetch;
  window.localStorage.clear();
});

after(async () => {
  globalThis.fetch = nodeFetch;
  await closeDom();
});
