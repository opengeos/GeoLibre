type Indexable = Record<PropertyKey, unknown>;

function isIndexable(value: unknown): value is Indexable {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function resolvePath(root: unknown, path: readonly PropertyKey[]): unknown {
  let value = root;
  for (const key of path) {
    if (!isIndexable(value)) return undefined;
    value = value[key];
  }
  return value;
}

function proxyAt(getLatest: () => unknown, path: readonly PropertyKey[]): Indexable {
  return new Proxy({} as Indexable, {
    get(_target, key) {
      const parent = resolvePath(getLatest(), path);
      if (!isIndexable(parent)) return undefined;
      const value = parent[key];
      if (typeof value === "function") {
        // Re-resolve on every call so a handler captured once (say, a command's
        // `run`) always reaches the newest function at that path, invoked on its
        // own parent so methods keep their `this`.
        return (...args: unknown[]) => {
          const latestParent = resolvePath(getLatest(), path);
          if (!isIndexable(latestParent)) return undefined;
          const latest = latestParent[key];
          return typeof latest === "function"
            ? (latest as (...a: unknown[]) => unknown).apply(latestParent, args)
            : undefined;
        };
      }
      if (typeof value === "object" && value !== null) return proxyAt(getLatest, [...path, key]);
      return value;
    },
  });
}

/**
 * A read-through view of an object that always resolves against its newest
 * version.
 *
 * Primitives are read from `getLatest()` when accessed. Functions come back as
 * wrappers that look the function up again when called, and nested objects as
 * further views, so something captured from the view once — a handler stored in
 * a memoized list, `obj.nested.method`, `ref.current?.method()` — still calls
 * the version current at call time rather than the one current when captured.
 *
 * Use it to memoize work that captures many unstable callbacks but only
 * depends on a few values: memoize on those values and hand the builder this
 * view instead of the raw object.
 *
 * Args:
 *   getLatest: Returns the current version of the object.
 *
 * Returns:
 *   A view typed as the object itself. Only property reads and calls are
 *   supported; enumeration, `in`, and writes see an empty object.
 */
export function createLatestProxy<T extends object>(getLatest: () => T): T {
  return proxyAt(getLatest, []) as T;
}
