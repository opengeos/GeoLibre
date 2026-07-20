import type { GeoLibreMapControlPosition, GeoLibrePlugin } from "./types";

export interface HostedMapPluginDefinition {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly activeByDefault?: boolean;
  readonly initialPosition?: GeoLibreMapControlPosition;
  readonly restoresPanelCollapseState?: boolean;
  /** Validates state persisted under this plugin's stable project-settings key. */
  readonly acceptsProjectState?: (state: unknown) => boolean;
  /** Forward the host text-export service to the adapter runtime on activation. */
  readonly forwardsTextFileExports?: boolean;
}

/**
 * A renderer-neutral first-party descriptor. Concrete code is looked up inside
 * the active map adapter through the typed hosted-plugin extension commands.
 */
export function createHostedMapPlugin(definition: HostedMapPluginDefinition): GeoLibrePlugin {
  let position = definition.initialPosition ?? "top-right";
  let projectState: unknown;
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
        ...(definition.acceptsProjectState
          ? {
              state: projectState,
              onStateChange: (nextState: unknown) => {
                projectState = nextState;
              },
            }
          : {}),
        ...(definition.forwardsTextFileExports && app.exportTextFile
          ? {
              exportTextFile: (filename: string, content: string) => {
                app.exportTextFile?.(filename, content);
              },
            }
          : {}),
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
    ...(definition.acceptsProjectState
      ? {
          getProjectState: () => projectState,
          applyProjectState: (app, nextState: unknown) => {
            if (!definition.acceptsProjectState?.(nextState)) return false;
            projectState = nextState;
            const applied = app.map.invoke("hosted-plugin.apply-state", {
              pluginId: definition.id,
              state: nextState,
            });
            // A runtime is intentionally unloaded while a plugin is inactive;
            // caching valid state is still a successful restore for the next
            // activation. A loaded runtime applies it immediately.
            return applied === false ? undefined : applied;
          },
        }
      : {}),
  };
}
