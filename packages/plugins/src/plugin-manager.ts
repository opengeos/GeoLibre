import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "./types";

export class PluginManager {
  private plugins = new Map<string, GeoLibrePlugin>();
  private active = new Set<string>();
  private listeners = new Set<() => void>();
  private version = 0;

  register(plugin: GeoLibrePlugin): void {
    const previous = this.plugins.get(plugin.id);
    this.plugins.set(plugin.id, plugin);
    // activeByDefault only marks the plugin active; activate() is not called
    // here because no app API is available at registration time. Such plugins
    // must apply their initial side effects idempotently elsewhere (e.g. the
    // layer control is added by MapController.init regardless of plugin state).
    if (plugin.activeByDefault) this.active.add(plugin.id);
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

  private notify(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}
