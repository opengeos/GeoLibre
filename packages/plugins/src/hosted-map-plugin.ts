import type { GeoLibreMapControlPosition, GeoLibrePlugin } from "./types";

export interface HostedMapPluginDefinition {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly activeByDefault?: boolean;
  readonly initialPosition?: GeoLibreMapControlPosition;
  readonly restoresPanelCollapseState?: boolean;
}

/**
 * A renderer-neutral first-party descriptor. Concrete code is looked up inside
 * the active map adapter through the typed hosted-plugin extension commands.
 */
export function createHostedMapPlugin(definition: HostedMapPluginDefinition): GeoLibrePlugin {
  let position = definition.initialPosition ?? "top-right";
  return {
    id: definition.id,
    name: definition.name,
    version: definition.version,
    ...(definition.activeByDefault ? { activeByDefault: true } : {}),
    ...(definition.restoresPanelCollapseState ? { restoresPanelCollapseState: true } : {}),
    activate: (app, context) =>
      app.map.invoke("hosted-plugin.activate", {
        pluginId: definition.id,
        position,
        collapsed: context?.collapsed,
      }),
    deactivate: (app) => {
      app.map.invoke("hosted-plugin.deactivate", { pluginId: definition.id });
    },
    getMapControlPosition: () => position,
    setMapControlPosition: (app, nextPosition) => {
      position = nextPosition;
      const applied = app.map.invoke("hosted-plugin.set-position", {
        pluginId: definition.id,
        position: nextPosition,
      });
      // Repositioning follows an already activated runtime, so this is
      // synchronous. Keep the descriptor safe if an engine later returns an
      // asynchronous recovery result by allowing PluginManager to persist the
      // requested position and report its normal activation failure separately.
      return typeof applied === "boolean" ? applied : undefined;
    },
  };
}
