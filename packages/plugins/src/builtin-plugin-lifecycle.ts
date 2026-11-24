import type { BuiltInPluginMetadata } from "./builtin-plugin-metadata";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition, GeoLibrePlugin } from "./types";

export interface LazyPluginRegistration {
  metadata: BuiltInPluginMetadata;
  load: () => Promise<GeoLibrePlugin>;
  peek: () => GeoLibrePlugin | undefined;
  deactivatePendingState?: (state: unknown) => unknown;
}

export interface LazyPluginContext {
  restoreGeneration: () => number;
  isRegistered: () => boolean;
  changed: () => void;
  reportError: (error: unknown) => void;
}

/** Retain serializable settings while the implementation is unavailable. */
export function createLazyPlugin(registration: LazyPluginRegistration, context: LazyPluginContext) {
  const { metadata } = registration;
  const hooks = new Set(metadata.hooks);
  if (hooks.has("getMapControlPosition") && !metadata.defaultMapControlPosition)
    throw new Error(`Plugin '${metadata.id}' has no default control position.`);
  let activationGeneration = 0;
  let restoreTicket = 0;
  let lastRestoreGeneration = -1;
  let statePending = false;
  let state: unknown;
  let position: GeoLibreMapControlPosition | undefined;
  let activationTask: Promise<boolean | void> | undefined;

  const applyPending = (implementation: GeoLibrePlugin, app: GeoLibreAppAPI): boolean | void => {
    if (position) {
      const target = position;
      if (!implementation.setMapControlPosition)
        throw new Error(`Plugin '${metadata.id}' cannot restore its control position.`);
      const updated = implementation.setMapControlPosition(app, target);
      if (updated !== false && position === target) position = undefined;
    }
    if (!statePending) return;
    if (!implementation.applyProjectState)
      throw new Error(`Plugin '${metadata.id}' cannot restore its saved settings.`);
    const ticket = restoreTicket;
    const updated = implementation.applyProjectState(app, state);
    if (ticket === restoreTicket) statePending = false;
    return updated;
  };

  const queueRestore = (app: GeoLibreAppAPI): void => {
    const ticket = ++restoreTicket;
    const generation = context.restoreGeneration();
    lastRestoreGeneration = generation;
    // An untouched/reset plugin needs no implementation until it is used.
    if (!statePending || state === undefined) return;
    void registration.load().then(
      (implementation) => {
        if (
          !context.isRegistered() ||
          ticket !== restoreTicket ||
          generation !== context.restoreGeneration()
        )
          return;
        try {
          applyPending(implementation, app);
          context.changed();
        } catch (error) {
          context.reportError(error);
        }
      },
      (error: unknown) => {
        if (
          context.isRegistered() &&
          ticket === restoreTicket &&
          generation === context.restoreGeneration()
        )
          context.reportError(error);
      },
    );
  };

  const prepare = async (
    app: GeoLibreAppAPI,
    isCurrent: () => boolean = () => true,
  ): Promise<GeoLibrePlugin> => {
    const generation = context.restoreGeneration();
    const implementation = await registration.load();
    if (!context.isRegistered() || !isCurrent() || generation !== context.restoreGeneration())
      throw new Error(`Plugin '${metadata.id}' preparation was superseded.`);
    applyPending(implementation, app);
    return implementation;
  };

  const plugin: GeoLibrePlugin = {
    id: metadata.id,
    name: metadata.name,
    version: metadata.version,
    activeByDefault: metadata.activeByDefault,
    engines: metadata.engines ? [...metadata.engines] : undefined,
    exclusiveGroup: metadata.exclusiveGroup,
    assistant: metadata.assistant ? { ...metadata.assistant } : undefined,
    urlParameterNames: metadata.urlParameterNames ? [...metadata.urlParameterNames] : undefined,
    restoresPanelCollapseState: metadata.restoresPanelCollapseState,
    clearsStateOnProjectLoad: metadata.clearsStateOnProjectLoad,
    sessionScoped: metadata.sessionScoped,
    activate: async (app) => {
      const generation = ++activationGeneration;
      const task = (async () => {
        const implementation = await registration.load();
        if (!context.isRegistered() || generation !== activationGeneration) return false;
        applyPending(implementation, app);
        const result = await implementation.activate(app);
        return generation === activationGeneration && context.isRegistered() ? result : false;
      })();
      activationTask = task;
      try {
        return await task;
      } finally {
        if (activationTask === task) activationTask = undefined;
      }
    },
    deactivate: (app) => {
      activationGeneration++;
      restoreTicket++;
      if (statePending && registration.deactivatePendingState)
        state = registration.deactivatePendingState(state);
      registration.peek()?.deactivate(app);
    },
  };

  if (hooks.has("getMapControlPosition"))
    plugin.getMapControlPosition = () =>
      position ??
      registration.peek()?.getMapControlPosition?.() ??
      metadata.defaultMapControlPosition ??
      "top-right";
  if (hooks.has("setMapControlPosition"))
    plugin.setMapControlPosition = (app, target) => {
      const implementation = registration.peek();
      if (implementation) {
        if (!implementation.setMapControlPosition)
          throw new Error(`Plugin '${metadata.id}' cannot restore its control position.`);
        return implementation.setMapControlPosition(app, target);
      }
      position = target;
      return true;
    };
  if (hooks.has("getProjectState"))
    plugin.getProjectState = () =>
      statePending ? state : registration.peek()?.getProjectState?.();
  if (hooks.has("applyProjectState"))
    plugin.applyProjectState = (app, value) => {
      state = value;
      statePending = true;
      const implementation = registration.peek();
      if (implementation) {
        restoreTicket++;
        return applyPending(implementation, app);
      }
      queueRestore(app);
      return true;
    };
  if (hooks.has("handleUrlParameters"))
    plugin.handleUrlParameters = async (app, parameters) => {
      const generation = activationGeneration;
      if (activationTask && (await activationTask) === false)
        throw new Error(`Plugin '${metadata.id}' did not activate.`);
      const implementation = await prepare(app, () => generation === activationGeneration);
      if (!implementation.handleUrlParameters)
        throw new Error(`Plugin '${metadata.id}' cannot handle its URL parameters.`);
      await implementation.handleUrlParameters(app, parameters);
    };

  return {
    plugin,
    prepare: (app: GeoLibreAppAPI) => prepare(app),
    retargetRestore: (app: GeoLibreAppAPI): void => {
      if (statePending && lastRestoreGeneration !== context.restoreGeneration()) queueRestore(app);
    },
  };
}
