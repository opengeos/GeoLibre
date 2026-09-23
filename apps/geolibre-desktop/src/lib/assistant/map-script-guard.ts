/**
 * Map methods a `run_maplibre_js` snippet may not call, each with the message
 * the snippet gets instead. These replace or tear down the whole map outside
 * the app store, so the Layers panel and undo history stop matching what the
 * map shows (issue #2584). Everything else stays reachable: the tool exists for
 * the paint, terrain, projection and control tweaks no dedicated tool covers.
 */
export const BLOCKED_MAP_SCRIPT_METHODS: Readonly<Record<string, string>> = Object.freeze({
  setStyle:
    "map.setStyle() replaces the whole style outside the app store, so the Layers panel and undo would no longer match the map. Use the set_basemap tool to change the basemap.",
  remove:
    "map.remove() destroys the map the app is rendering into. Use remove_layer to remove a layer.",
});

/**
 * One guard per map, reused across `run_maplibre_js` calls, so a listener one
 * snippet registers with `map.on(type, fn)` can be removed by a later snippet's
 * `map.off(type, fn)`: both calls see the same listener wrapper.
 */
const guardedMaps = new WeakMap<object, object>();

/**
 * Wrap a live map so a model-authored snippet cannot call the methods in
 * {@link BLOCKED_MAP_SCRIPT_METHODS}. Every other property reads through to the
 * real map. Methods run against the real instance, so MapLibre's internals
 * (including private fields) see it, but a chaining method's `this` return
 * comes back as the proxy, so `map.setPaintProperty(...).setStyle(...)` is
 * still guarded. Listeners registered through `on`/`once`/`off` (and the promise
 * `once(type)` returns) see the proxy as `this` and `event.target`, since
 * MapLibre would otherwise hand them the real map. Wrappers are cached per
 * function so `map.on === map.on` holds inside the snippet.
 *
 * This is a guardrail against a snippet quietly desynchronizing the store, not
 * a sandbox: the code already runs only after the user approves it, and it can
 * still reach the real map if it tries (the prototype, or the map MapLibre
 * passes to a custom control's `onAdd`).
 *
 * @param map The live map instance handed to the snippet.
 * @returns A proxy of `map` whose blocked methods throw with guidance; the
 *   same proxy for every call with the same map.
 */
export function guardMapForScript<T extends object>(map: T): T {
  const existing = guardedMaps.get(map);
  if (existing) return existing as T;
  type Fn = (...args: unknown[]) => unknown;
  const wrappers = new WeakMap<Fn, unknown>();
  // One wrapper per snippet listener, so `map.off(type, fn)` finds the wrapper
  // `map.on(type, fn)` registered.
  const listeners = new WeakMap<Fn, Fn>();

  /**
   * MapLibre fires events with `event.target` set to the real map, which would
   * hand a snippet's listener an unguarded map. Present the guarded map there.
   */
  const guardEvent = (event: unknown): unknown => {
    if (event === null || typeof event !== "object") return event;
    if ((event as { target?: unknown }).target !== map) return event;
    return new Proxy(event, {
      get(eventTarget, property) {
        if (property === "target") return guarded;
        const value: unknown = Reflect.get(eventTarget, property, eventTarget);
        return typeof value === "function" ? (value as Fn).bind(eventTarget) : value;
      },
    });
  };

  /** Run a snippet listener with `this` and `event.target` as the guarded map. */
  const guardListener = (listener: Fn): Fn => {
    let wrapped = listeners.get(listener);
    if (!wrapped) {
      wrapped = (event?: unknown) => listener.call(guarded, guardEvent(event));
      listeners.set(listener, wrapped);
    }
    return wrapped;
  };

  const guarded: T = new Proxy(map, {
    get(target, property) {
      if (typeof property === "string" && Object.hasOwn(BLOCKED_MAP_SCRIPT_METHODS, property)) {
        const message = BLOCKED_MAP_SCRIPT_METHODS[property];
        return () => {
          throw new Error(message);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      // `constructor` stays the real class so `new map.constructor(...)` and
      // `map instanceof maplibregl.Map` behave as they do on the bare map.
      if (typeof value !== "function" || property === "constructor") return value;
      const method = value as Fn;
      let wrapper = wrappers.get(method);
      if (!wrapper) {
        const isEventMethod = property === "on" || property === "once" || property === "off";
        wrapper = (...args: unknown[]) => {
          const callArgs = isEventMethod
            ? args.map((arg) => (typeof arg === "function" ? guardListener(arg as Fn) : arg))
            : args;
          const result = method.apply(target, callArgs);
          if (result === target) return guarded;
          // `once(type)` without a listener resolves with the event instead.
          if (property === "once" && result instanceof Promise) return result.then(guardEvent);
          return result;
        };
        wrappers.set(method, wrapper);
      }
      return wrapper;
    },
  });
  guardedMaps.set(map, guarded);
  return guarded;
}
