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
  private listeners = new Set<() => void>();
  private version = 0;

  register(plugin: GeoLibrePlugin): void {
    const previous = this.plugins.get(plugin.id);
    this.plugins.set(plugin.id, plugin);
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
      activePluginIds: Array.from(this.plugins.keys()).filter((id) =>
        this.active.has(id),
      ),
      mapControlPositions,
      settings,
    };
  }

  getMapControlPosition(
    id: string,
  ): GeoLibreMapControlPosition | undefined {
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

      // Only apply settings the loaded project actually carries for this
      // plugin. A missing entry means "no change" rather than "reset", which
      // avoids clobbering in-memory state for plugins absent from the project.
      if (plugin.applyProjectState && state?.settings && id in state.settings) {
        const updated = plugin.applyProjectState(app, state.settings[id]);
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
