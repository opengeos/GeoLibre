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
 * Wrap a live map so a model-authored snippet cannot call the methods in
 * {@link BLOCKED_MAP_SCRIPT_METHODS}. Every other property reads through to the
 * real map. Methods run against the real instance, so MapLibre's internals
 * (including private fields) see it, but a chaining method's `this` return
 * comes back as the proxy, so `map.setPaintProperty(...).setStyle(...)` is
 * still guarded. Wrappers are cached per function so `map.on === map.on` holds
 * inside the snippet.
 *
 * This is a guardrail against a snippet quietly desynchronizing the store, not
 * a sandbox: the code already runs only after the user approves it, and it can
 * still reach the prototype if it tries.
 *
 * @param map The live map instance handed to the snippet.
 * @returns A proxy of `map` whose blocked methods throw with guidance.
 */
export function guardMapForScript<T extends object>(map: T): T {
  const wrappers = new WeakMap<(...args: unknown[]) => unknown, unknown>();
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
      const method = value as (...args: unknown[]) => unknown;
      let wrapper = wrappers.get(method);
      if (!wrapper) {
        wrapper = (...args: unknown[]) => {
          const result = method.apply(target, args);
          return result === target ? guarded : result;
        };
        wrappers.set(method, wrapper);
      }
      return wrapper;
    },
  });
  return guarded;
}
