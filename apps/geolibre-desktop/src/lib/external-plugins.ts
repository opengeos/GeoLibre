import type {
  GeoLibreAppAPI,
  GeoLibreExternalPluginManifest,
  GeoLibrePlugin,
  PluginManager,
} from "@geolibre/plugins";
import { invoke } from "@tauri-apps/api/core";
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
  pluginsDirectories: string[];
  bundles: ExternalPluginBundle[];
  errors: ExternalPluginBundleError[];
}

export interface ExternalPluginLoadIssue {
  archiveName: string;
  message: string;
}

export interface ExternalPluginLoadResult {
  pluginsDirectories: string[];
  pluginSources: string[];
  loadedPluginIds: string[];
  issues: ExternalPluginLoadIssue[];
}

// Plugin IDs registered by previous loadExternalPlugins calls, mapped to the
// source that loaded them. A settings change triggers a re-scan; plugins
// already loaded from the same source are skipped silently, while the same ID
// arriving from a different source is reported so the user knows a restart is
// needed to pick it up. Removing a plugin source does not unregister its
// plugins until the app restarts.
const externallyLoadedPluginSources = new Map<string, string>();

export async function loadExternalPlugins(
  manager: PluginManager,
  additionalPluginDirectories: string[] = [],
  pluginManifestUrls: string[] = [],
): Promise<ExternalPluginLoadResult> {
  const issues: ExternalPluginLoadIssue[] = [];
  // The filesystem scan (Tauri IPC + disk) and the manifest URL fetches
  // (network) are independent, so overlap them.
  const [filesystemResult, urlBundles] = await Promise.all([
    isTauri()
      ? loadFilesystemPluginBundles(additionalPluginDirectories)
      : Promise.resolve<ExternalPluginBundleLoadResult>({
          pluginsDirectories: [],
          bundles: [],
          errors: [],
        }),
    loadPluginUrlBundles(pluginManifestUrls, issues),
  ]);
  for (const error of filesystemResult.errors) {
    issues.push({
      archiveName: error.archiveName,
      message: error.message,
    });
  }
  const loadedPluginIds: string[] = [];
  const registeredPluginIds = new Set(
    manager.list().map((plugin) => plugin.id),
  );

  for (const bundle of [...filesystemResult.bundles, ...urlBundles]) {
    try {
      const loadedFrom = externallyLoadedPluginSources.get(bundle.manifest.id);
      if (loadedFrom !== undefined) {
        // Already loaded by a previous scan; a settings change re-runs the
        // scan and should not warn about plugins it loaded itself. A copy
        // from a different source needs a restart to replace the loaded one.
        if (loadedFrom !== bundle.archiveName) {
          issues.push({
            archiveName: bundle.archiveName,
            message: `Plugin id '${bundle.manifest.id}' is already loaded from '${loadedFrom}'. Restart GeoLibre to load this copy.`,
          });
        }
        continue;
      }
      if (registeredPluginIds.has(bundle.manifest.id)) {
        issues.push({
          archiveName: bundle.archiveName,
          message: `Plugin id '${bundle.manifest.id}' is already registered.`,
        });
        continue;
      }

      const plugin = await importExternalPlugin(bundle);
      manager.register(plugin);
      registeredPluginIds.add(plugin.id);
      externallyLoadedPluginSources.set(plugin.id, bundle.archiveName);
      // Inject the style only after registration succeeds; an orphaned
      // <style> element would block re-injection on a later scan because
      // injectExternalPluginStyle skips existing style ids.
      if (bundle.styleSource) {
        injectExternalPluginStyle(bundle.manifest.id, bundle.styleSource);
      }
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
    pluginsDirectories: filesystemResult.pluginsDirectories,
    pluginSources: [
      ...pluginManifestUrls,
      ...filesystemResult.pluginsDirectories,
    ],
    loadedPluginIds,
    issues,
  };
}

async function loadFilesystemPluginBundles(
  additionalPluginDirectories: string[],
): Promise<ExternalPluginBundleLoadResult> {
  return invoke<ExternalPluginBundleLoadResult>(
    "load_external_plugin_bundles",
    {
      additionalPluginDirectories,
    },
  );
}

async function loadPluginUrlBundles(
  manifestUrls: string[],
  issues: ExternalPluginLoadIssue[],
): Promise<ExternalPluginBundle[]> {
  const bundles: ExternalPluginBundle[] = [];
  const results = await Promise.allSettled(
    manifestUrls.map((manifestUrl) => loadPluginUrlBundle(manifestUrl)),
  );
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") {
      bundles.push(result.value);
    } else {
      issues.push({
        archiveName: manifestUrls[index],
        message:
          result.reason instanceof Error
            ? result.reason.message
            : "Could not load plugin manifest URL.",
      });
    }
  }
  return bundles;
}

async function loadPluginUrlBundle(
  manifestUrl: string,
): Promise<ExternalPluginBundle> {
  const manifestResponse = await fetch(manifestUrl);
  if (!manifestResponse.ok) {
    throw new Error(
      `Could not fetch plugin manifest: HTTP ${manifestResponse.status}`,
    );
  }

  const manifest = (await manifestResponse.json()) as unknown;
  if (!isExternalPluginManifest(manifest)) {
    throw new Error("Plugin manifest is invalid.");
  }

  const entryUrl = resolvePluginAssetUrl(manifestUrl, manifest.entry);
  const styleUrl = manifest.style
    ? resolvePluginAssetUrl(manifestUrl, manifest.style)
    : null;
  const [entrySource, styleSource] = await Promise.all([
    fetchPluginText(entryUrl, "plugin entry"),
    styleUrl
      ? fetchPluginText(styleUrl, "plugin style")
      : Promise.resolve(null),
  ]);

  return {
    archiveName: manifestUrl,
    manifest,
    entrySource,
    styleSource,
  };
}

// Mirrors MAX_PLUGIN_ENTRY_BYTES in the Rust filesystem loader so URL-loaded
// plugin assets cannot buffer an unbounded response into memory.
const MAX_PLUGIN_ASSET_BYTES = 50 * 1024 * 1024;

async function fetchPluginText(url: string, label: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not fetch ${label}: HTTP ${response.status}`);
  }

  // Fast-fail when the server declares the size; the streaming reader below
  // is the real enforcement for responses without a content-length header.
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PLUGIN_ASSET_BYTES) {
    throw new Error(`Could not fetch ${label}: exceeds the 50 MB size limit.`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_PLUGIN_ASSET_BYTES) {
      throw new Error(
        `Could not fetch ${label}: exceeds the 50 MB size limit.`,
      );
    }
    return text;
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_PLUGIN_ASSET_BYTES) {
      await reader.cancel();
      throw new Error(
        `Could not fetch ${label}: exceeds the 50 MB size limit.`,
      );
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function resolvePluginAssetUrl(manifestUrl: string, path: string): string {
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    /^[a-z][a-z\d+.-]*:/i.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Plugin manifest paths must be relative safe paths.");
  }
  // Percent-encoded dot segments ("%2e%2e") pass the textual check above but
  // the URL parser still normalizes them, so confirm the resolved URL stays
  // under the manifest directory.
  const resolved = new URL(path, manifestUrl);
  const manifestDirectory = new URL(".", manifestUrl);
  if (!resolved.href.startsWith(manifestDirectory.href)) {
    throw new Error("Plugin manifest paths must be relative safe paths.");
  }
  return resolved.toString();
}

// Matches the Rust validate_required_manifest_string: non-empty with no
// leading or trailing whitespace.
function isRequiredManifestString(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.trim() === value
  );
}

function isExternalPluginManifest(
  value: unknown,
): value is GeoLibreExternalPluginManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<GeoLibreExternalPluginManifest>;
  return (
    isRequiredManifestString(manifest.id) &&
    isRequiredManifestString(manifest.name) &&
    isRequiredManifestString(manifest.version) &&
    isRequiredManifestString(manifest.entry) &&
    (manifest.entry.endsWith(".js") || manifest.entry.endsWith(".mjs")) &&
    (manifest.description === undefined ||
      typeof manifest.description === "string") &&
    (manifest.style === undefined ||
      (typeof manifest.style === "string" && manifest.style.endsWith(".css")))
  );
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

function removeExternalPluginStyle(pluginId: string): void {
  document
    .getElementById(`geolibre-external-plugin-style:${pluginId}`)
    ?.remove();
}

// A loaded plugin came from a manifest URL (web/desktop) rather than the
// desktop filesystem scan, whose source is an absolute path with no scheme.
function isManagedUrlSource(source: string): boolean {
  return /^(https?|tauri):\/\//.test(source);
}

/**
 * Unregister URL-loaded plugins whose manifest URL is no longer present in
 * `currentManifestUrls` (e.g. a marketplace or manual removal). Filesystem and
 * bundled plugins are untouched: filesystem sources are not URLs, and bundled
 * URLs are always re-injected into the current list. Deactivates each plugin
 * (removing its map control) and drops its injected style, then the manager
 * notifies so the Plugins menu updates without a reload.
 */
export function unloadRemovedUrlPlugins(
  manager: PluginManager,
  currentManifestUrls: string[],
  app: GeoLibreAppAPI,
): string[] {
  const keep = new Set(currentManifestUrls);
  const removed: string[] = [];
  for (const [pluginId, source] of externallyLoadedPluginSources) {
    if (!isManagedUrlSource(source) || keep.has(source)) continue;
    manager.unregister(pluginId, app);
    removeExternalPluginStyle(pluginId);
    externallyLoadedPluginSources.delete(pluginId);
    removed.push(pluginId);
  }
  return removed;
}

/**
 * Re-fetch and re-register the plugin loaded from `manifestUrl` to upgrade it to
 * the version currently published at that URL. The new version is fetched
 * before the old one is torn down, so a failed upgrade leaves the installed
 * plugin intact. Active state is preserved: an active plugin is reactivated
 * after the new version registers. Returns the new plugin.
 */
export async function reloadExternalUrlPlugin(
  manager: PluginManager,
  manifestUrl: string,
  app: GeoLibreAppAPI,
): Promise<GeoLibrePlugin> {
  let existingId: string | null = null;
  for (const [id, source] of externallyLoadedPluginSources) {
    if (source === manifestUrl) {
      existingId = id;
      break;
    }
  }
  const wasActive = existingId ? manager.isActive(existingId) : false;

  // Fetch and validate the new version first; if this throws the old plugin is
  // untouched.
  const bundle = await loadPluginUrlBundle(manifestUrl);
  const plugin = await importExternalPlugin(bundle);

  // If the plugin was uninstalled while we were fetching (its source was
  // removed from the loaded map by unloadRemovedUrlPlugins), don't resurrect it.
  if (existingId !== null && !externallyLoadedPluginSources.has(existingId)) {
    return plugin;
  }

  // A version that changes its plugin id (e.g. the author renamed it) would
  // leave the marketplace's installed/version state pointing at the old id.
  // Refuse rather than silently register a mismatched plugin.
  if (existingId && existingId !== plugin.id) {
    throw new Error(
      `Cannot update plugin: the published version exports id '${plugin.id}' but the installed version has id '${existingId}'. Reinstall it manually.`,
    );
  }

  if (existingId) {
    manager.unregister(existingId, app);
    removeExternalPluginStyle(existingId);
    externallyLoadedPluginSources.delete(existingId);
  }
  manager.register(plugin);
  externallyLoadedPluginSources.set(plugin.id, manifestUrl);
  if (bundle.styleSource) {
    injectExternalPluginStyle(bundle.manifest.id, bundle.styleSource);
  }
  if (wasActive) manager.activate(plugin.id, app);
  return plugin;
}
