import type {
  GeoLibreExternalPluginManifest,
  GeoLibrePlugin,
  PluginManager,
} from "@geolibre/plugins";
import { isTauri } from "./tauri-io";

interface ExternalPluginBundle {
  archiveName: string;
  manifest: GeoLibreExternalPluginManifest;
  entrySource: string;
  styleSource?: string | null;
}

interface ExternalPluginBundleError {
  archiveName: string;
  message: string;
}

interface ExternalPluginBundleLoadResult {
  pluginsDirectory: string;
  bundles: ExternalPluginBundle[];
  errors: ExternalPluginBundleError[];
}

export interface ExternalPluginLoadIssue {
  archiveName: string;
  message: string;
}

export interface ExternalPluginLoadResult {
  pluginsDirectory?: string;
  loadedPluginIds: string[];
  issues: ExternalPluginLoadIssue[];
}

export async function loadExternalPlugins(
  manager: PluginManager,
): Promise<ExternalPluginLoadResult> {
  if (!isTauri()) {
    return {
      loadedPluginIds: [],
      issues: [],
    };
  }

  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<ExternalPluginBundleLoadResult>(
    "load_external_plugin_bundles",
  );
  const issues: ExternalPluginLoadIssue[] = result.errors.map((error) => ({
    archiveName: error.archiveName,
    message: error.message,
  }));
  const loadedPluginIds: string[] = [];
  const registeredPluginIds = new Set(
    manager.list().map((plugin) => plugin.id),
  );

  for (const bundle of result.bundles) {
    try {
      if (registeredPluginIds.has(bundle.manifest.id)) {
        issues.push({
          archiveName: bundle.archiveName,
          message: `Plugin id '${bundle.manifest.id}' is already registered.`,
        });
        continue;
      }

      const plugin = await importExternalPlugin(bundle);
      if (registeredPluginIds.has(plugin.id)) {
        issues.push({
          archiveName: bundle.archiveName,
          message: `Plugin id '${plugin.id}' is already registered.`,
        });
        continue;
      }

      if (bundle.styleSource) {
        injectExternalPluginStyle(bundle.manifest.id, bundle.styleSource);
      }
      manager.register(plugin);
      registeredPluginIds.add(plugin.id);
      loadedPluginIds.push(plugin.id);
    } catch (error) {
      issues.push({
        archiveName: bundle.archiveName,
        message:
          error instanceof Error
            ? error.message
            : "Could not load external plugin.",
      });
    }
  }

  return {
    pluginsDirectory: result.pluginsDirectory,
    loadedPluginIds,
    issues,
  };
}

async function importExternalPlugin(
  bundle: ExternalPluginBundle,
): Promise<GeoLibrePlugin> {
  const moduleUrl = URL.createObjectURL(
    new Blob([bundle.entrySource], { type: "text/javascript" }),
  );

  try {
    const module = (await import(/* @vite-ignore */ moduleUrl)) as {
      default?: unknown;
      plugin?: unknown;
    };
    const candidate = module.default ?? module.plugin;
    if (!isGeoLibrePlugin(candidate)) {
      throw new Error(
        "Entry must export a GeoLibrePlugin as default or plugin.",
      );
    }
    validateManifestMatchesPlugin(bundle.manifest, candidate);
    if (candidate.activeByDefault) {
      throw new Error("External plugins cannot use activeByDefault.");
    }
    return candidate;
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
}

function isGeoLibrePlugin(value: unknown): value is GeoLibrePlugin {
  if (!value || typeof value !== "object") return false;
  const plugin = value as Partial<GeoLibrePlugin>;
  return (
    typeof plugin.id === "string" &&
    typeof plugin.name === "string" &&
    typeof plugin.version === "string" &&
    typeof plugin.activate === "function" &&
    typeof plugin.deactivate === "function"
  );
}

function validateManifestMatchesPlugin(
  manifest: GeoLibreExternalPluginManifest,
  plugin: GeoLibrePlugin,
): void {
  if (plugin.id !== manifest.id) {
    throw new Error("Exported plugin id does not match plugin.json.");
  }
  if (plugin.name !== manifest.name) {
    throw new Error("Exported plugin name does not match plugin.json.");
  }
  if (plugin.version !== manifest.version) {
    throw new Error("Exported plugin version does not match plugin.json.");
  }
}

function injectExternalPluginStyle(
  pluginId: string,
  styleSource: string,
): void {
  const styleId = `geolibre-external-plugin-style:${pluginId}`;
  if (document.getElementById(styleId)) return;

  const style = document.createElement("style");
  style.id = styleId;
  style.dataset.geolibreExternalPlugin = pluginId;
  style.textContent = styleSource;
  document.head.append(style);
}
