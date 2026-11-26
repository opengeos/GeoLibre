import { useAppStore } from "@geolibre/core";
import { useEffect } from "react";
import { fetchPluginRegistry } from "../../lib/plugin-registry";

/**
 * Fetch the plugin registry once at startup when this deployment allows
 * plugin installation.
 *
 * Fetching the registry also tells the credential redaction which external
 * plugins declared their project state publishable, so a save made before the
 * Manage Plugins dialog is ever opened still keeps that state. A failed fetch
 * only leaves the conservative default of dropping external plugin state. A
 * deployment that disables plugin installation has no registry plugins, so
 * nothing is fetched there. The request is aborted on unmount.
 */
export function usePluginRegistryPrefetch(): void {
  const canInstallPlugins = useAppStore((state) =>
    state.deploymentCapabilities.has("plugins:install"),
  );
  useEffect(() => {
    if (!canInstallPlugins) return;
    const controller = new AbortController();
    fetchPluginRegistry(undefined, controller.signal).catch(() => {});
    return () => controller.abort();
  }, [canInstallPlugins]);
}
