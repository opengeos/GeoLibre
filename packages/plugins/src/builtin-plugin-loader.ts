/**
 * Keep imports and host setup lazy, shared by UI activation and data helpers.
 * A failed import/setup can be retried; a successful module is reused.
 */
export function createBuiltInPluginModules<
  Definitions extends Record<string, () => Promise<object>>,
>(definitions: Definitions) {
  type Id = keyof Definitions & string;
  type Module<Key extends Id> = Awaited<ReturnType<Definitions[Key]>>;
  const loaded = new Map<Id, object>();
  const pending = new Map<Id, Promise<object>>();
  const setup = new Map<Id, Map<string, (module: unknown) => void>>();

  const load = <Key extends Id>(id: Key): Promise<Module<Key>> => {
    const cached = loaded.get(id);
    if (cached) return Promise.resolve(cached as Module<Key>);
    const inFlight = pending.get(id);
    if (inFlight) return inFlight as Promise<Module<Key>>;
    const task = Promise.resolve()
      .then(() => {
        const loader = definitions[id];
        if (typeof loader !== "function") throw new Error(`Unknown built-in module '${id}'.`);
        return loader();
      })
      .then((module) => {
        for (const initialize of setup.get(id)?.values() ?? []) initialize(module);
        loaded.set(id, module);
        pending.delete(id);
        return module;
      })
      .catch((error: unknown) => {
        pending.delete(id);
        throw error;
      });
    pending.set(id, task);
    // The keyed definitions establish this association; the shared cache
    // erases module-specific types without exposing that erasure to callers.
    return task as Promise<Module<Key>>;
  };

  return {
    loadModule: load,
    peekModule: <Key extends Id>(id: Key): Module<Key> | undefined =>
      loaded.get(id) as Module<Key> | undefined,
    // A failed initializer remains required until its host replaces it: never
    // expose a partially configured module. Live errors propagate so hosts
    // can report programmer errors; UI effects must catch them at the boundary.
    configure: <Key extends Id>(
      id: Key,
      initializers: Record<string, (module: Module<Key>) => void>,
    ): void => {
      // Host I/O and translated labels have independent owners. Updating one
      // named initializer replaces only that owner's configuration.
      let channels = setup.get(id);
      if (!channels) {
        channels = new Map();
        setup.set(id, channels);
      }
      const updates = Object.entries(initializers).map(([name, initialize]) => {
        const apply = (module: unknown): void => initialize(module as Module<Key>);
        channels.set(name, apply);
        return apply;
      });
      const implementation = loaded.get(id);
      if (implementation) {
        try {
          for (const apply of updates) apply(implementation);
        } catch (error) {
          loaded.delete(id);
          throw error;
        }
      }
    },
  };
}
