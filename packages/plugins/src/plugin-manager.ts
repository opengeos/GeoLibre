import type { GeoLibreAppAPI, GeoLibrePlugin } from "./types";

export class PluginManager {
  private plugins = new Map<string, GeoLibrePlugin>();
  private active = new Set<string>();

  register(plugin: GeoLibrePlugin): void {
    this.plugins.set(plugin.id, plugin);
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

  activate(id: string, app: GeoLibreAppAPI): void {
    const plugin = this.plugins.get(id);
    if (!plugin || this.active.has(id)) return;
    plugin.activate(app);
    this.active.add(id);
  }

  deactivate(id: string, app: GeoLibreAppAPI): void {
    const plugin = this.plugins.get(id);
    if (!plugin || !this.active.has(id)) return;
    plugin.deactivate(app);
    this.active.delete(id);
  }

  toggle(id: string, app: GeoLibreAppAPI): void {
    if (this.active.has(id)) this.deactivate(id, app);
    else this.activate(id, app);
  }
}
