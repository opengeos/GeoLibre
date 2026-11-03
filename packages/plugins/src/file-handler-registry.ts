import type { GeoLibreFileHandler } from "./types";

/**
 * Imperative registry for plugin file-format handlers (GeoLibre#3283).
 *
 * A plugin that adds a data format can already add its own reader and an Add
 * Data entry; a handler lets it also receive that format when a user drops the
 * file on the map, or when GeoLibre downloads it for `?data=` or the embed
 * `addData` command. The shell's drop paths and its URL loader consult this
 * registry before the built-in loaders. Unlike the menu registries there is no
 * reactive snapshot: nothing renders from it, the loaders read it per load.
 */

/** A registered handler plus the plugin that registered it (host-injected). */
export interface FileHandlerEntry {
  handler: GeoLibreFileHandler;
  ownerPluginId?: string;
  /** The handler's valid, non-reserved `dataTypes`; the rest were ignored. */
  dataTypes: string[];
}

/** Hint names the host handles itself; a handler cannot declare them. */
const RESERVED_DATA_TYPES = new Set(["lidar"]);

/** Whether `name` is a usable `dataType` hint: lower-case `[a-z0-9-]`, at most 32 characters. */
export function isFileHandlerDataType(name: unknown): name is string {
  return typeof name === "string" && /^[a-z0-9-]{1,32}$/.test(name);
}

/** The valid names of `handler.dataTypes`, warning about each one that is ignored. */
function declaredDataTypes(handler: GeoLibreFileHandler): string[] {
  if (handler.dataTypes === undefined) return [];
  if (!Array.isArray(handler.dataTypes)) {
    console.warn(`File handler "${handler.id}": dataTypes must be an array; ignoring it.`);
    return [];
  }
  const names: string[] = [];
  for (const name of handler.dataTypes) {
    if (!isFileHandlerDataType(name)) {
      console.warn(
        `File handler "${handler.id}": ignoring invalid data type ` +
          `${typeof name === "string" ? JSON.stringify(name) : `of type ${typeof name}`}; ` +
          "use lower-case letters, digits and hyphens, at most 32 characters.",
      );
    } else if (RESERVED_DATA_TYPES.has(name)) {
      console.warn(
        `File handler "${handler.id}": the "${name}" data type is built in; ignoring it.`,
      );
    } else if (!names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

const registry = new Map<string, FileHandlerEntry>();

/**
 * Who owns each `dataType` hint: the first handler to declare it. Kept apart
 * from the registration order so that replacing a handler (which keeps its
 * slot) can neither take a hint another live handler owns nor lose one it owned.
 */
const hintOwners = new Map<string, string>();

/** Hand `name` to the first live handler, other than `exceptId`, that declares it. */
function reassignHint(name: string, exceptId: string): void {
  hintOwners.delete(name);
  for (const [id, entry] of registry) {
    if (id !== exceptId && entry.dataTypes.includes(name)) {
      hintOwners.set(name, id);
      return;
    }
  }
}

/** Remove a handler and release the hints it owned. */
function removeHandler(id: string): void {
  registry.delete(id);
  for (const [name, owner] of [...hintOwners]) {
    if (owner === id) reassignHint(name, id);
  }
}

/**
 * Register a file handler. Returns an unregister function (call it from the
 * plugin's `deactivate` hook). Re-registering the same id replaces the handler
 * and keeps its place in the order. A replacement keeps the hints its
 * predecessor owned and never takes one another live handler owns.
 *
 * `ownerPluginId` is injected by the host; plugins call this with one argument.
 */
export function registerFileHandler(
  handler: GeoLibreFileHandler,
  ownerPluginId?: string,
): () => void {
  if (!handler || typeof handler.id !== "string" || handler.id.length === 0) {
    throw new Error("registerFileHandler requires a handler with a non-empty id.");
  }
  if (typeof handler.name !== "string" || handler.name.length === 0) {
    throw new Error(`File handler "${handler.id}" must have a non-empty name.`);
  }
  if (
    !Array.isArray(handler.extensions) ||
    handler.extensions.length === 0 ||
    handler.extensions.some((extension) => typeof extension !== "string" || extension.length === 0)
  ) {
    throw new Error(
      `File handler "${handler.id}" must list at least one extension, all non-empty.`,
    );
  }
  if (typeof handler.claim !== "function" || typeof handler.open !== "function") {
    throw new Error(`File handler "${handler.id}" must have claim and open functions.`);
  }
  const entry: FileHandlerEntry = { handler, ownerPluginId, dataTypes: declaredDataTypes(handler) };
  // Ids are global, like menu contribution ids. Replacing another plugin's
  // handler is almost certainly an accidental collision, so say so.
  const previous = registry.get(handler.id);
  if (previous && previous.ownerPluginId !== ownerPluginId) {
    console.warn(
      `File handler "${handler.id}" from "${ownerPluginId ?? "the host"}" replaces one ` +
        `registered by "${previous.ownerPluginId ?? "the host"}"; prefix handler ids with your plugin id.`,
    );
  }
  // Hints the predecessor owned but the replacement no longer declares go to
  // the next handler that declares them.
  for (const [name, owner] of [...hintOwners]) {
    if (owner === handler.id && !entry.dataTypes.includes(name)) reassignHint(name, handler.id);
  }
  // The first handler to declare a hint keeps it; a later one is warned, not obeyed.
  for (const name of entry.dataTypes) {
    const owner = hintOwners.get(name);
    if (owner === undefined) {
      hintOwners.set(name, handler.id);
    } else if (owner !== handler.id) {
      console.warn(
        `File handler "${handler.id}" declares the "${name}" data type, which ` +
          `"${owner}" already declares; "${owner}" keeps it.`,
      );
    }
  }
  registry.set(handler.id, entry);
  // Only while this exact registration is current, so a stale disposer cannot
  // evict a newer handler that reused the id.
  return () => {
    if (registry.get(handler.id) === entry) removeHandler(handler.id);
  };
}

/**
 * Remove a previously registered file handler.
 *
 * `ownerPluginId` is injected by the host when a plugin calls this through its
 * scoped app API: the handler is then removed only if that plugin owns it.
 */
export function unregisterFileHandler(id: string, ownerPluginId?: string): void {
  const entry = registry.get(id);
  if (!entry) return;
  if (ownerPluginId !== undefined && entry.ownerPluginId !== ownerPluginId) return;
  removeHandler(id);
}

/**
 * Remove every handler a plugin registered. The PluginManager calls this when
 * the plugin is deactivated or its activation fails, so a plugin that forgets
 * to dispose of its handler cannot keep receiving drops.
 */
export function unregisterFileHandlersByOwner(ownerPluginId: string): void {
  for (const [id, entry] of registry) {
    if (entry.ownerPluginId === ownerPluginId) removeHandler(id);
  }
}

/**
 * The handler that declares a `dataType` hint (the first registered one when
 * several do), or undefined when none does. The built-in `lidar` hint never
 * resolves to a handler.
 */
export function findFileHandlerByDataType(name: string): GeoLibreFileHandler | undefined {
  const owner = hintOwners.get(name);
  return owner === undefined ? undefined : registry.get(owner)?.handler;
}

/** All registered handlers, in registration order. */
export function listFileHandlers(): GeoLibreFileHandler[] {
  return [...registry.values()].map((entry) => entry.handler);
}

/**
 * Test-only: reset the registry to its initial empty state. Not part of the
 * public plugin API.
 */
export function __resetFileHandlerRegistryForTests(): void {
  registry.clear();
  hintOwners.clear();
}
