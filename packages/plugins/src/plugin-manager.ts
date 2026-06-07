import type { ProjectPluginState } from "@geolibre/core";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "./types";

export class PluginManager {
  private plugins = new Map<string, GeoLibrePlugin>();
  private active = new Set<string>();
  private defaultActive = new Set<string>();
  private defaultMapControlPositions = new Map<
    string,
    GeoLibreMapControlPosition
  >();
  private handledUrlParametersByContext = new Map<string, Set<string>>();
  private inFlightUrlContexts = new Map<string, number>();
  private urlParameterNamesById = new Map<string, string[]>();
  private listeners = new Set<() => void>();
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
    this.urlParameterNamesById.set(
      plugin.id,
      normalizeUrlParameterNames(plugin.urlParameterNames),
    );
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
      activePluginIds: Array.from(this.plugins.keys()).filter((id) =>
        this.active.has(id),
      ),
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
    const activated = plugin.activate(app);
    if (activated === false) return;
    this.active.add(id);
    this.notify();
  }

  deactivate(id: string, app: GeoLibreAppAPI): void {
    const plugin = this.plugins.get(id);
    if (!plugin || !this.active.has(id)) return;
    plugin.deactivate(app);
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
    this.inFlightUrlContexts.set(
      contextKey,
      (this.inFlightUrlContexts.get(contextKey) ?? 0) + 1,
    );

    let handledPluginIds = this.handledUrlParametersByContext.get(contextKey);
    if (!handledPluginIds) {
      handledPluginIds = new Set();
      this.handledUrlParametersByContext.set(contextKey, handledPluginIds);
      for (const key of this.handledUrlParametersByContext.keys()) {
        if (
          this.handledUrlParametersByContext.size <= MAX_HANDLED_URL_CONTEXTS
        ) {
          break;
        }
        if (this.inFlightUrlContexts.has(key)) continue;
        this.handledUrlParametersByContext.delete(key);
      }
    }

    try {
      for (const [id, plugin] of this.plugins) {
        if (!this.active.has(id) || !plugin.handleUrlParameters) continue;

        const parameterNames = this.urlParameterNamesById.get(id) ?? [];
        if (
          parameterNames.length === 0 ||
          !parameterNames.some((name) => params.has(name))
        ) {
          continue;
        }

        if (handledPluginIds.has(id)) continue;
        // Mark before awaiting so a concurrent dispatch for the same context
        // cannot double-fire the handler.
        handledPluginIds.add(id);

        try {
          await plugin.handleUrlParameters(app, new URLSearchParams(params));
        } catch (error) {
          // Unmark so a later dispatch for the same context retries the
          // plugin instead of silently skipping it after a failure.
          handledPluginIds.delete(id);
          console.warn(
            `Plugin '${id}' could not handle GeoLibre URL parameters.`,
            error,
          );
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
    const updated = plugin.setMapControlPosition(app, position);
    if (updated === false) return;
    this.notify();
  }

  restoreProjectState(
    state: ProjectPluginState | null,
    app: GeoLibreAppAPI,
    options: { resetMissingSettings?: boolean } = {},
  ): void {
    const targetActive = new Set(
      state?.activePluginIds ?? Array.from(this.defaultActive),
    );
    let changed = false;

    // Deactivate first so plugins that should be inactive tear down their live
    // controls before we touch positions or settings. This keeps the order of
    // operations from rebuilding a control only to remove it on the next pass.
    for (const id of Array.from(this.active)) {
      if (targetActive.has(id)) continue;
      const plugin = this.plugins.get(id);
      if (!plugin) continue;
      plugin.deactivate(app);
      this.active.delete(id);
      changed = true;
    }

    // Restore positions and settings. Plugins that will be (re)activated below
    // are inactive at this point, so applyProjectState only caches their state
    // for the upcoming activate() call rather than doing live DOM work.
    for (const [id, plugin] of this.plugins) {
      const defaultPosition = this.defaultMapControlPositions.get(id);
      const targetPosition = state?.mapControlPositions[id] ?? defaultPosition;
      if (targetPosition && plugin.setMapControlPosition) {
        const currentPosition = plugin.getMapControlPosition?.();
        if (currentPosition !== targetPosition) {
          const updated = plugin.setMapControlPosition(app, targetPosition);
          if (updated !== false) changed = true;
        }
      }

      // Regular project loads apply only the settings present in the file. New
      // project resets can opt into clearing cached state for every plugin.
      const hasSetting = state?.settings && id in state.settings;
      if (
        plugin.applyProjectState &&
        (hasSetting || options.resetMissingSettings)
      ) {
        const updated = plugin.applyProjectState(
          app,
          hasSetting ? state.settings[id] : undefined,
        );
        if (updated !== false) changed = true;
      }
    }

    for (const id of targetActive) {
      if (this.active.has(id)) continue;
      const plugin = this.plugins.get(id);
      if (!plugin) continue;
      const activated = plugin.activate(app);
      if (activated === false) continue;
      this.active.add(id);
      changed = true;
    }

    if (changed) this.notify();
  }

  private notify(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

// Retaining several recent contexts (rather than only the latest) keeps dedup
// intact when fire-and-forget calls with different context keys overlap.
const MAX_HANDLED_URL_CONTEXTS = 8;

function normalizeUrlParameterNames(names: string[] | undefined): string[] {
  if (!names) return [];
  return Array.from(
    new Set(names.map((name) => name.trim()).filter((name) => name.length > 0)),
  );
}
