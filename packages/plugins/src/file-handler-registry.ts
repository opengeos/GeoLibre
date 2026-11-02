import type { GeoLibreFileHandler } from "./types";

/**
 * Imperative registry for plugin file-format handlers (GeoLibre#3283).
 *
 * A plugin that adds a data format can already add its own reader and an Add
 * Data entry; a handler lets it also receive that format when a user drops the
 * file on the map. The shell's drop paths consult this registry before sorting
 * the drop into the built-in groups. Unlike the menu registries there is no
 * reactive snapshot: nothing renders from it, the drop handlers read it per drop.
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
        `File handler "${handler.id}": ignoring invalid data type ${JSON.stringify(name)}; ` +
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
 * Register a file handler. Returns an unregister function (call it from the
 * plugin's `deactivate` hook). Re-registering the same id replaces the handler
 * and keeps its place in the order.
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
  // The first handler to declare a hint keeps it; a later one is warned, not obeyed.
  for (const name of entry.dataTypes) {
    const owner = findEntryByDataType(name);
    if (owner && owner.handler.id !== handler.id) {
      console.warn(
        `File handler "${handler.id}" declares the "${name}" data type, which ` +
          `"${owner.handler.id}" already declares; "${owner.handler.id}" keeps it.`,
      );
    }
  }
  // Ids are global, like menu contribution ids. Replacing another plugin's
  // handler is almost certainly an accidental collision, so say so.
  const previous = registry.get(handler.id);
  if (previous && previous.ownerPluginId !== ownerPluginId) {
    console.warn(
      `File handler "${handler.id}" from "${ownerPluginId ?? "the host"}" replaces one ` +
        `registered by "${previous.ownerPluginId ?? "the host"}"; prefix handler ids with your plugin id.`,
    );
  }
  registry.set(handler.id, entry);
  // Only while this exact registration is current, so a stale disposer cannot
  // evict a newer handler that reused the id.
  return () => {
    if (registry.get(handler.id) === entry) registry.delete(handler.id);
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
  registry.delete(id);
}

/**
 * Remove every handler a plugin registered. The PluginManager calls this when
 * the plugin is deactivated or its activation fails, so a plugin that forgets
 * to dispose of its handler cannot keep receiving drops.
 */
export function unregisterFileHandlersByOwner(ownerPluginId: string): void {
  for (const [id, entry] of registry) {
    if (entry.ownerPluginId === ownerPluginId) registry.delete(id);
  }
}

function findEntryByDataType(name: string): FileHandlerEntry | undefined {
  for (const entry of registry.values()) {
    if (entry.dataTypes.includes(name)) return entry;
  }
  return undefined;
}

/**
 * The handler that declares a `dataType` hint (the first registered one when
 * several do), or undefined when none does. The built-in `lidar` hint never
 * resolves to a handler.
 */
export function findFileHandlerByDataType(name: string): GeoLibreFileHandler | undefined {
  return findEntryByDataType(name)?.handler;
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
}
