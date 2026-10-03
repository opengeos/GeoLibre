import type { MapEngine } from "@geolibre/map";
import { VIEWER_BLOCKED_PLUGIN_IDS } from "@geolibre/plugins";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import {
  matchRegistryDeepLinkNames,
  pluginDeepLinkFromSearch,
  pluginDeepLinkNames,
} from "../../lib/plugin-deep-link";
import { fetchPluginRegistry, type PluginRegistryEntry } from "../../lib/plugin-registry";
import { mergeStringLists } from "../../lib/string-lists";
import {
  activateDeepLinkedPlugin,
  DEEP_LINKABLE_PLUGIN_IDS,
  getExternalPluginLoadIssues,
  getPluginManager,
  subscribeToExternalPluginLoads,
} from "../usePlugins";
import { useDesktopSettingsStore } from "../useDesktopSettings";

interface PluginDeepLinkOptions {
  mapControllerRef: RefObject<MapEngine | null>;
  enforceViewerPlugins: () => void;
  /** Whether the app runs in the read-only `layout=viewer` preset. */
  viewer: boolean;
  externalPluginsReady: boolean;
  mapReadyGeneration: number;
  /**
   * Whether a `?url=` project the page opened with has finished loading (or
   * failed). `true` when there is none. Only its first `true` matters: the
   * loader's "loaded" state later decays back to idle.
   */
  projectUrlSettled: boolean;
}

/** Registry plugins a `?plugin=` link names that await the user's trust decision. */
export interface RegistryPluginDeepLinkState {
  /** Registry entries not yet installed, shown in the trust prompt. */
  pending: PluginRegistryEntry[];
  /** Install the pending plugins (their manifest URLs) and activate them. */
  trust: () => void;
  /** Dismiss the prompt for this page load without installing anything. */
  dismiss: () => void;
}

/** A manifest URL in the spelling the registry uses, so stored URLs compare equal. */
function canonicalUrl(url: string): string {
  try {
    return new URL(url.trim()).href;
  } catch {
    return url.trim();
  }
}

const subscribeToPluginManager = (listener: () => void) => getPluginManager().subscribe(listener);
const getPluginManagerVersion = () => getPluginManager().getVersion();

/**
 * Activates the built-in plugins a `?plugin=<id>` deep link names, once per
 * page load, e.g. `…/?plugin=swipe` or `…/?plugin=maplibre-gl-time-slider`.
 *
 * It waits for the map and for any `?url=` project: restoring a loaded
 * project's plugin state deactivates every plugin the project does not list,
 * so activating earlier would be undone. Call it after `usePluginStateRestore`
 * so, in the commit a project loads in, the restore runs first. Consent-gated
 * plugins are never activated (see `DEEP_LINKABLE_PLUGIN_IDS`), nor are the
 * editing plugins `layout=viewer` blocks; the viewer guard is still re-asserted
 * afterwards.
 *
 * A name that is no built-in plugin is looked up in the official plugin registry
 * by id. A registry plugin that is already installed is activated like a
 * built-in one; one that is not is never loaded silently: it is returned in
 * `pending` for a trust prompt, and only "Trust and load" installs and
 * activates it. Registry plugins are skipped in the read-only viewer, which
 * has no place to prompt.
 *
 * @param options - The map engine, the viewer guard, and the readiness signals.
 * @returns The registry plugins awaiting the user's decision.
 */
export function usePluginDeepLink({
  mapControllerRef,
  enforceViewerPlugins,
  viewer,
  externalPluginsReady,
  mapReadyGeneration,
  projectUrlSettled,
}: PluginDeepLinkOptions): RegistryPluginDeepLinkState {
  const targets = useMemo(
    () =>
      typeof window === "undefined"
        ? null
        : pluginDeepLinkFromSearch(window.location.search, DEEP_LINKABLE_PLUGIN_IDS),
    [],
  );
  const handled = useRef(false);
  const projectSettled = useRef(false);
  const [pending, setPending] = useState<PluginRegistryEntry[]>([]);
  // Registry plugins the user trusted, activated as each one loads.
  const [awaiting, setAwaiting] = useState<PluginRegistryEntry[]>([]);
  const loadIssues = useSyncExternalStore(
    subscribeToExternalPluginLoads,
    getExternalPluginLoadIssues,
    getExternalPluginLoadIssues,
  );
  const managerVersion = useSyncExternalStore(
    subscribeToPluginManager,
    getPluginManagerVersion,
    getPluginManagerVersion,
  );

  useEffect(() => {
    if (projectUrlSettled) projectSettled.current = true;
    if (!targets || handled.current) return;
    if (!externalPluginsReady || !mapReadyGeneration || !projectSettled.current) return;
    if (!mapControllerRef.current) return;
    handled.current = true;

    void (async () => {
      // One at a time so plugins sharing an exclusive group resolve in link
      // order (the last one wins), as they would clicked from the menu.
      for (const id of targets.pluginIds) {
        // Skipped rather than left to the guard: activating would mount the
        // editing control for a moment and record it in the project's plugin
        // state, so every later restore would bring it back.
        if (viewer && VIEWER_BLOCKED_PLUGIN_IDS.includes(id)) continue;
        try {
          if (!(await activateDeepLinkedPlugin(id, mapControllerRef))) {
            console.warn(`[GeoLibre] The plugin "${id}" from the ?plugin= link did not activate.`);
          }
        } catch (error) {
          console.error(`[GeoLibre] Could not activate the plugin "${id}"`, error);
        }
      }
      await resolveRegistryNames(targets.unknown);
    })().finally(enforceViewerPlugins);

    /**
     * Resolves the names no built-in plugin claimed against the registry:
     * activates the installed ones, queues the rest for the trust prompt, and
     * warns about names that match nothing.
     */
    async function resolveRegistryNames(names: string[]): Promise<void> {
      if (names.length === 0) return;
      let unknown = names;
      if (!viewer) {
        try {
          const registry = await fetchPluginRegistry();
          const matches = matchRegistryDeepLinkNames(names, registry.entries);
          unknown = matches.unknown;
          const installedUrls = new Set(
            useDesktopSettingsStore.getState().desktopSettings.pluginManifestUrls.map(canonicalUrl),
          );
          const toPrompt: PluginRegistryEntry[] = [];
          for (const entry of matches.entries) {
            const loaded = getPluginManager()
              .list()
              .some((plugin) => plugin.id === entry.id);
            if (installedUrls.has(entry.manifestUrl)) {
              // Contained per entry so one throwing plugin neither hides the
              // others nor drops the ones still waiting for the trust prompt.
              try {
                if (loaded && (await activateDeepLinkedPlugin(entry.id, mapControllerRef)))
                  continue;
                console.warn(
                  `[GeoLibre] The plugin "${entry.id}" from the ?plugin= link did not activate.`,
                );
              } catch (error) {
                console.error(`[GeoLibre] Could not activate the plugin "${entry.id}"`, error);
              }
            } else if (loaded) {
              // The id belongs to a plugin this entry would not replace.
              console.warn(
                `[GeoLibre] Ignoring "${entry.id}" in the ?plugin= link: a plugin with that id is already loaded.`,
              );
            } else {
              toPrompt.push(entry);
            }
          }
          setPending(toPrompt);
        } catch (error) {
          console.warn(
            "[GeoLibre] Could not look up the ?plugin= link in the plugin registry",
            error,
          );
        }
      }
      if (unknown.length > 0) {
        // The valid names go last, after a fixed label: the docs check in
        // e2e/plugin-deep-link.spec.ts reads them from this message.
        console.warn(
          `[GeoLibre] Ignoring unknown plugin(s) in the ?plugin= link: ${unknown.join(", ")}. ` +
            `Valid names: ${pluginDeepLinkNames(DEEP_LINKABLE_PLUGIN_IDS).join(", ")}`,
        );
      }
    }
  }, [
    targets,
    enforceViewerPlugins,
    viewer,
    externalPluginsReady,
    mapReadyGeneration,
    projectUrlSettled,
    mapControllerRef,
  ]);

  // Once a trusted plugin's manifest has loaded (installing re-runs the external
  // plugin scan), open it as a built-in link target would be. One whose manifest
  // failed to load is dropped with a warning, since the dialog is already closed.
  useEffect(() => {
    if (awaiting.length === 0) return;
    const loadedIds = new Set(
      getPluginManager()
        .list()
        .map((plugin) => plugin.id),
    );
    const ready = awaiting.filter((entry) => loadedIds.has(entry.id));
    const failed = awaiting.filter(
      (entry) => !loadedIds.has(entry.id) && loadIssues.has(entry.manifestUrl),
    );
    if (ready.length === 0 && failed.length === 0) return;
    setAwaiting((entries) =>
      entries.filter((entry) => !ready.includes(entry) && !failed.includes(entry)),
    );
    for (const entry of failed) {
      console.warn(
        `[GeoLibre] The plugin "${entry.id}" from the ?plugin= link did not load: ${loadIssues.get(entry.manifestUrl)}`,
      );
    }
    void (async () => {
      for (const { id } of ready) {
        try {
          if (!(await activateDeepLinkedPlugin(id, mapControllerRef))) {
            console.warn(`[GeoLibre] The plugin "${id}" from the ?plugin= link did not activate.`);
          }
        } catch (error) {
          console.error(`[GeoLibre] Could not activate the plugin "${id}"`, error);
        }
      }
    })();
  }, [awaiting, managerVersion, loadIssues, mapControllerRef]);

  const trust = useCallback(() => {
    if (pending.length === 0) return;
    const current = useDesktopSettingsStore.getState().desktopSettings;
    useDesktopSettingsStore.getState().setDesktopSettings({
      ...current,
      pluginManifestUrls: mergeStringLists(
        current.pluginManifestUrls,
        pending.map((entry) => entry.manifestUrl),
      ),
    });
    setAwaiting((entries) => [...entries, ...pending]);
    setPending([]);
  }, [pending]);

  const dismiss = useCallback(() => setPending([]), []);

  return { pending, trust, dismiss };
}
