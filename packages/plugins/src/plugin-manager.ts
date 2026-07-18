import type { ProjectPluginState } from "@geolibre/core";
import type { IControl } from "maplibre-gl";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
  GeoLibreToolbarMenu,
} from "./types";

export class PluginManager {
  private plugins = new Map<string, GeoLibrePlugin>();
  private active = new Set<string>();
  private defaultActive = new Set<string>();
  private defaultMapControlPositions = new Map<string, GeoLibreMapControlPosition>();
  private handledUrlParametersByContext = new Map<string, Set<string>>();
  private inFlightUrlContexts = new Map<string, number>();
  private urlParameterNamesById = new Map<string, string[]>();
  private listeners = new Set<() => void>();
  private activationGenerations = new Map<string, number>();
  private version = 0;

  register(plugin: GeoLibrePlugin): void {
    const previous = this.plugins.get(plugin.id);
    if (previous && previous !== plugin) {
      // Evict the plugin's dedup entries from every retained context so a
      // re-registered (e.g. hot-reloaded) plugin can handle the current URL
      // context again. This intentionally also lets it re-handle older
      // retained contexts if one of those is ever re-dispatched: the new
      // plugin instance has fresh state and never saw them.
      for (const handled of this.handledUrlParametersByContext.values()) {
        handled.delete(plugin.id);
      }
    }
    this.plugins.set(plugin.id, plugin);
    this.urlParameterNamesById.set(plugin.id, normalizeUrlParameterNames(plugin.urlParameterNames));
    const defaultPosition = plugin.getMapControlPosition?.();
    if (defaultPosition) {
      this.defaultMapControlPositions.set(plugin.id, defaultPosition);
    }
    // activeByDefault only marks the plugin active; activate() is not called
    // here because no app API is available at registration time. Such plugins
    // must apply their initial side effects idempotently elsewhere (e.g. the
    // layer control is added by MapController.init regardless of plugin state).
    if (plugin.activeByDefault) {
      this.defaultActive.add(plugin.id);
      this.active.add(plugin.id);
    } else {
      this.defaultActive.delete(plugin.id);
    }
    if (previous !== plugin) this.notify();
  }

  registerAll(plugins: GeoLibrePlugin[]): void {
    for (const p of plugins) this.register(p);
  }

  // Mark an already-registered plugin as active-by-default WITHOUT marking it
  // active now. Unlike `plugin.activeByDefault` handled in register() (built-ins
  // whose startup side effects are applied idempotently elsewhere), a plugin
  // marked here still needs its activate(app) called; leaving it out of `active`
  // lets restoreProjectState's activation loop do that with a real app API.
  // Used for bundled drop-in plugins whose manifest sets activeByDefault.
  markDefaultActive(id: string): void {
    if (!this.plugins.has(id)) return;
    this.defaultActive.add(id);
  }

  // Remove a plugin at runtime: deactivate it first (so an active plugin tears
  // down its map control) and drop all of its tracking state, then notify so
  // the Plugins menu updates without a reload. Used when an external plugin's
  // source is removed.
  unregister(id: string, app: GeoLibreAppAPI): void {
    const plugin = this.plugins.get(id);
    if (!plugin) return;
    if (this.active.has(id)) {
      try {
        plugin.deactivate(scopeAppToPlugin(app, id));
      } catch (error) {
        console.warn(`Plugin '${id}' threw while deactivating during unregister.`, error);
      }
      this.active.delete(id);
    }
    this.plugins.delete(id);
    this.defaultActive.delete(id);
    this.defaultMapControlPositions.delete(id);
    this.urlParameterNamesById.delete(id);
    this.activationGenerations.delete(id);
    for (const handled of this.handledUrlParametersByContext.values()) {
      handled.delete(id);
    }
    this.notify();
  }

  list(): GeoLibrePlugin[] {
    return Array.from(this.plugins.values());
  }

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  getProjectState(): ProjectPluginState {
    const mapControlPositions: ProjectPluginState["mapControlPositions"] = {};
    const settings: ProjectPluginState["settings"] = {};
    for (const plugin of this.plugins.values()) {
      const position = plugin.getMapControlPosition?.();
      if (position) mapControlPositions[plugin.id] = position;
      const pluginState = plugin.getProjectState?.();
      if (pluginState !== undefined) settings[plugin.id] = pluginState;
    }

    return {
      // The manager does not track external plugin sources; callers that
      // persist project state must overwrite manifestUrls with the real list
      // (see TopToolbar.handleSave and persistProjectPluginState).
      manifestUrls: [],
      activePluginIds: Array.from(this.plugins.keys()).filter((id) => this.active.has(id)),
      mapControlPositions,
      settings,
    };
  }

  getMapControlPosition(id: string): GeoLibreMapControlPosition | undefined {
    return this.plugins.get(id)?.getMapControlPosition?.();
  }

  getVersion(): number {
    return this.version;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  activate(id: string, app: GeoLibreAppAPI): void {
    const plugin = this.plugins.get(id);
    if (!plugin || this.active.has(id)) return;
    const scopedApp = scopeAppToPlugin(app, id);
    const activated = plugin.activate(scopedApp);
    if (activated === false) return;
    const generation = this.nextActivationGeneration(id);
    this.active.add(id);
    this.notify();
    this.watchAsyncActivation(id, activated, scopedApp, generation);
  }

  /**
   * Watch an async activation result so the optimistic active state can be
   * rolled back if the mount ultimately fails (resolves false or rejects). A
   * synchronous result is a no-op. Shared by {@link activate} and
   * {@link restoreProjectState}, which both add to `active` before the mount
   * has finished.
   *
   * `generation` ties the rollback to this specific activation attempt so a
   * stale promise from an earlier activate/deactivate cycle cannot revert a
   * newer activation of the same plugin.
   */
  private watchAsyncActivation(
    id: string,
    activated: boolean | void | PromiseLike<boolean | void>,
    app: GeoLibreAppAPI,
    generation: number,
  ): void {
    // An async plugin (e.g. one mounted behind a dynamic import) reports
    // failure after the fact by resolving false or rejecting. Roll back so the
    // Plugins menu does not show a plugin that never mounted (e.g. when its
    // chunk fails to load after a web redeploy).
    if (!isThenable(activated)) return;
    void Promise.resolve(activated).then(
      (result) => {
        if (result === false) {
          this.rollbackFailedActivation(id, app, generation);
        }
      },
      (error) => this.rollbackFailedActivation(id, app, generation, error),
    );
  }

  /**
   * Undo an activation whose async mount ultimately failed. No-op when the
   * plugin is no longer active, or when a newer activation has superseded this
   * one (the user deactivated and reactivated while the mount was pending).
   */
  private rollbackFailedActivation(
    id: string,
    app: GeoLibreAppAPI,
    generation: number,
    error?: unknown,
  ): void {
    if (!this.active.has(id) || this.activationGenerations.get(id) !== generation) {
      return;
    }
    if (error !== undefined) {
      console.warn(`Plugin '${id}' failed to activate; reverting.`, error);
    } else {
      console.warn(`Plugin '${id}' activation resolved false; reverting.`);
    }
    const plugin = this.plugins.get(id);
    this.active.delete(id);
    if (plugin) {
      try {
        // Tear down any partial mount. Plugin teardown is written to be safe to
        // run even when nothing was mounted.
        plugin.deactivate(app);
      } catch (deactivateError) {
        console.warn(`Plugin '${id}' threw while reverting a failed activation.`, deactivateError);
      }
    }
    this.notify();
  }

  deactivate(id: string, app: GeoLibreAppAPI): void {
    const plugin = this.plugins.get(id);
    if (!plugin || !this.active.has(id)) return;
    plugin.deactivate(scopeAppToPlugin(app, id));
    this.active.delete(id);
    this.notify();
  }

  toggle(id: string, app: GeoLibreAppAPI): void {
    if (this.active.has(id)) this.deactivate(id, app);
    else this.activate(id, app);
  }

  async handleUrlParameters(
    params: URLSearchParams,
    app: GeoLibreAppAPI,
    contextKey?: string,
  ): Promise<void> {
    // An empty serialization means no parameters. params.size would be more
    // direct but is unavailable in older webviews (pre-Safari 17 WKWebView).
    const serialized = params.toString();
    if (!serialized) return;
    contextKey ??= serialized;

    // Dedup state is kept per context so overlapping async calls with
    // different context keys cannot clear each other's in-flight entries.
    // Only the most recent contexts matter, so older ones are evicted to keep
    // the map bounded for the lifetime of the page. In-flight contexts are
    // never evicted, so a suspended dispatch cannot lose its dedup entries
    // and re-run plugins for the same context; the map can temporarily exceed
    // MAX_HANDLED_URL_CONTEXTS while that many dispatches overlap.
    this.inFlightUrlContexts.set(contextKey, (this.inFlightUrlContexts.get(contextKey) ?? 0) + 1);

    let handledPluginIds = this.handledUrlParametersByContext.get(contextKey);
    if (!handledPluginIds) {
      handledPluginIds = new Set();
      this.handledUrlParametersByContext.set(contextKey, handledPluginIds);
      for (const key of this.handledUrlParametersByContext.keys()) {
        if (this.handledUrlParametersByContext.size <= MAX_HANDLED_URL_CONTEXTS) {
          break;
        }
        if (this.inFlightUrlContexts.has(key)) continue;
        this.handledUrlParametersByContext.delete(key);
      }
    }

    try {
      for (const [id, plugin] of this.plugins) {
        if (!plugin.handleUrlParameters) continue;

        const parameterNames = this.urlParameterNamesById.get(id) ?? [];
        if (parameterNames.length === 0 || !parameterNames.some((name) => params.has(name))) {
          continue;
        }

        // Skip before activating: a context already handled this plugin, so
        // re-running activation side-effects (e.g. after a manual deactivate)
        // would reactivate it without ever dispatching the handler again.
        if (handledPluginIds.has(id)) continue;
        // Reserve dedup before activating: activate() notifies listeners
        // synchronously, and a re-entrant URL dispatch for the same context
        // must not double-run this plugin. Rolled back on every path that
        // ends without dispatching the handler.
        handledPluginIds.add(id);

        // A deep link to a parameter a plugin owns implies the user wants that
        // plugin: activate it if it is installed (registered) but inactive, so
        // a parameter a plugin declares brings up that plugin. Only
        // already-registered (trusted) plugins are activated here; nothing is
        // loaded from the URL.
        // If activation is refused or throws, skip dispatch and isolate the
        // failure to this plugin instead of aborting the whole loop.
        if (!this.active.has(id)) {
          try {
            this.activate(id, app);
          } catch (error) {
            handledPluginIds.delete(id);
            console.warn(
              `Plugin '${id}' could not be activated from GeoLibre URL parameters.`,
              error,
            );
            continue;
          }
          if (!this.active.has(id)) {
            handledPluginIds.delete(id);
            continue;
          }
        }

        try {
          await plugin.handleUrlParameters(scopeAppToPlugin(app, id), new URLSearchParams(params));
        } catch (error) {
          // Unmark so a later dispatch for the same context retries the
          // plugin instead of silently skipping it after a failure.
          handledPluginIds.delete(id);
          console.warn(`Plugin '${id}' could not handle GeoLibre URL parameters.`, error);
        }
      }
    } finally {
      const inFlight = this.inFlightUrlContexts.get(contextKey) ?? 0;
      if (inFlight <= 1) this.inFlightUrlContexts.delete(contextKey);
      else this.inFlightUrlContexts.set(contextKey, inFlight - 1);
    }
  }

  setMapControlPosition(
    id: string,
    app: GeoLibreAppAPI,
    position: GeoLibreMapControlPosition,
  ): void {
    const plugin = this.plugins.get(id);
    if (!plugin?.setMapControlPosition) return;
    const updated = plugin.setMapControlPosition(scopeAppToPlugin(app, id), position);
    if (updated === false) return;
    this.notify();
  }

  restoreProjectState(
    state: ProjectPluginState | null,
    app: GeoLibreAppAPI,
    options: { resetMissingSettings?: boolean } = {},
  ): void {
    const targetActive = new Set(state?.activePluginIds ?? Array.from(this.defaultActive));
    let changed = false;

    // Plugins pop their control panel open when activated so a user who just
    // enabled one lands in it. On a project restore that is unwanted: a loaded
    // project (e.g. a gallery `?url=` link) would bury the map under every
    // expanded panel it carries (#952). Collapse each control added while
    // restoring so panels stay closed. This also closes a panel re-added by
    // setMapControlPosition for an already-active plugin whose saved position
    // differs, which matches the project-load intent.
    const collapseRestoredPanel = (control: IControl): void => {
      const collapsible = control as { collapse?: () => void };
      if (typeof collapsible.collapse !== "function") return;
      // Collapse now so the first paint is collapsed, then again after the
      // plugin's own auto-expand. Plugins open their panel with a setTimeout(0)
      // expand from activate(), queued after this control was added, so a single
      // deferred collapse here would run before that expand and lose; defer twice
      // so the re-collapse lands after it. Doing this per control (instead of
      // once after the activate loop) also covers controls a plugin adds
      // asynchronously while restoring, e.g. behind a dynamic-import mount.
      collapsible.collapse();
      setTimeout(() => {
        setTimeout(() => collapsible.collapse?.(), 0);
      }, 0);
    };
    const scopeForRestore = (id: string): GeoLibreAppAPI =>
      scopeAppToPlugin(app, id, { onControlAdded: collapseRestoredPanel });

    // Deactivate first so plugins that should be inactive tear down their live
    // controls before we touch positions or settings. This keeps the order of
    // operations from rebuilding a control only to remove it on the next pass.
    for (const id of Array.from(this.active)) {
      if (targetActive.has(id)) continue;
      const plugin = this.plugins.get(id);
      if (!plugin) continue;
      plugin.deactivate(scopeAppToPlugin(app, id));
      this.active.delete(id);
      changed = true;
    }

    // Restore positions and settings. Plugins that will be (re)activated below
    // are inactive at this point, so applyProjectState only caches their state
    // for the upcoming activate() call rather than doing live DOM work.
    for (const [id, plugin] of this.plugins) {
      // One scoped app per plugin so any menu it (re)registers from
      // setMapControlPosition/applyProjectState is owner-tagged correctly.
      const scopedApp = scopeForRestore(id);
      const defaultPosition = this.defaultMapControlPositions.get(id);
      const targetPosition = state?.mapControlPositions[id] ?? defaultPosition;
      if (targetPosition && plugin.setMapControlPosition) {
        const currentPosition = plugin.getMapControlPosition?.();
        if (currentPosition !== targetPosition) {
          const updated = plugin.setMapControlPosition(scopedApp, targetPosition);
          if (updated !== false) changed = true;
        }
      }

      // Regular project loads apply only the settings present in the file. New
      // project resets can opt into clearing cached state for every plugin.
      const hasSetting = state?.settings && id in state.settings;
      if (plugin.applyProjectState && (hasSetting || options.resetMissingSettings)) {
        const updated = plugin.applyProjectState(
          scopedApp,
          hasSetting ? state.settings[id] : undefined,
        );
        if (updated !== false) changed = true;
      }
    }

    for (const id of targetActive) {
      if (this.active.has(id)) continue;
      const plugin = this.plugins.get(id);
      if (!plugin) continue;
      const scopedApp = scopeForRestore(id);
      const activated = plugin.activate(scopedApp);
      if (activated === false) continue;
      const generation = this.nextActivationGeneration(id);
      this.active.add(id);
      changed = true;
      // Restoring a saved project re-activates plugins the same way the user
      // would, so an async mount that later fails (e.g. a stale chunk after a
      // redeploy) must roll back here too, not just from activate().
      this.watchAsyncActivation(id, activated, scopedApp, generation);
    }

    if (changed) this.notify();
  }

  private notify(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /**
   * Allocate the next activation generation for a plugin. Each activate (or
   * restore) attempt gets a unique, increasing id so a late async failure can
   * be matched to the attempt that started it and ignored if superseded.
   */
  private nextActivationGeneration(id: string): number {
    const next = (this.activationGenerations.get(id) ?? 0) + 1;
    this.activationGenerations.set(id, next);
    return next;
  }
}

/**
 * Return an app API scoped to `pluginId`: a shallow copy whose
 * `registerToolbarMenu` tags each menu with the registering plugin's id so the
 * toolbar can place it by owner (e.g. external plugin menus after Help). Every
 * lifecycle callback that hands a plugin the app (activate, deactivate,
 * handleUrlParameters, setMapControlPosition, applyProjectState) passes a scoped
 * app, so a menu the plugin (re)registers from any of them is tagged correctly,
 * including one registered asynchronously after the callback returns. With
 * `onControlAdded` it also intercepts `addMapControl` (used by project restore
 * to collapse newly added panels, #952). Returns the app unchanged when neither
 * applies.
 */
interface ScopeAppOptions {
  /**
   * Called with every control a plugin adds through `addMapControl` while the
   * scope is active. Used during project restore to keep newly added panels
   * collapsed (#952).
   */
  onControlAdded?: (control: IControl) => void;
}

function scopeAppToPlugin(
  app: GeoLibreAppAPI,
  pluginId: string,
  options: ScopeAppOptions = {},
): GeoLibreAppAPI {
  const { onControlAdded } = options;
  const register = app.registerToolbarMenu;
  if (!register && !onControlAdded) return app;

  const scoped: GeoLibreAppAPI = { ...app };

  if (register) {
    // The public `registerToolbarMenu` is single-arg; the host's concrete impl
    // accepts an owner id as a second argument (see toolbar-menu-registry). Cast
    // here so the owner stays a host-side injection that plugins never see.
    const registerWithOwner = register as (
      menu: GeoLibreToolbarMenu,
      ownerPluginId: string,
    ) => () => void;
    scoped.registerToolbarMenu = (menu) => registerWithOwner(menu, pluginId);
  }

  if (onControlAdded) {
    const addMapControl = app.addMapControl;
    scoped.addMapControl = (control, position) => {
      const added = addMapControl(control, position);
      if (added !== false) onControlAdded(control);
      return added;
    };
  }

  return scoped;
}

// Retaining several recent contexts (rather than only the latest) keeps dedup
// intact when fire-and-forget calls with different context keys overlap.
const MAX_HANDLED_URL_CONTEXTS = 8;

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function normalizeUrlParameterNames(names: string[] | undefined): string[] {
  if (!names) return [];
  return Array.from(new Set(names.map((name) => name.trim()).filter((name) => name.length > 0)));
}
