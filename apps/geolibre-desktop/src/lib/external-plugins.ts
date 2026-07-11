import type {
  GeoLibreAppAPI,
  GeoLibreExternalPluginManifest,
  GeoLibrePlugin,
  PluginManager,
} from "@geolibre/plugins";
import { invoke } from "@tauri-apps/api/core";
import {
  deletePluginArchive,
  getAllPluginArchives,
  putPluginArchive,
  type StoredPluginArchive,
} from "./plugin-archive-store";
import {
  bundleFromZipBytes,
  type ExternalPluginBundle,
  isExternalPluginManifest,
  MAX_PLUGIN_ASSET_BYTES,
} from "./plugin-archive-unpack";
import {
  isManagedUrlSource,
  pluginAssetUrlFromSource,
  resolvePluginAssetUrl,
} from "./plugin-asset-url";
import {
  computePluginBundleHash,
  pinPluginBundle,
  removePluginBundlePin,
  verifyPluginBundleIntegrity,
} from "./plugin-integrity";
import { isTauri } from "./tauri-io";

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
  sourceUrl?: string;
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

// In-flight upgrade promises keyed by manifest URL. reloadExternalUrlPlugin is
// otherwise not re-entrant-safe: concurrent calls for the same URL capture the
// same existingId/wasActive snapshot and would double-register. Coalescing them
// onto one promise makes the function safe even if the UI's busyId guard is
// bypassed (e.g. the dialog is closed and reopened mid-upgrade).
const inFlightUrlUpgrades = new Map<string, Promise<GeoLibrePlugin>>();

export async function loadExternalPlugins(
  manager: PluginManager,
  additionalPluginDirectories: string[] = [],
  pluginManifestUrls: string[] = [],
): Promise<ExternalPluginLoadResult> {
  const issues: ExternalPluginLoadIssue[] = [];
  // The filesystem scan (Tauri IPC + disk), the manifest URL fetches (network),
  // and the IndexedDB read (web-installed archives) are independent, so overlap
  // them. Web-installed archives are the browser counterpart of the desktop
  // filesystem scan: the desktop build copies an installed zip onto disk and
  // re-scans it, while the web build replays the unpacked bundle stored here.
  const [filesystemResult, urlBundles, webBundles] = await Promise.all([
    isTauri()
      ? loadFilesystemPluginBundles(additionalPluginDirectories)
      : Promise.resolve<ExternalPluginBundleLoadResult>({
          pluginsDirectories: [],
          bundles: [],
          errors: [],
        }),
    loadPluginUrlBundles(pluginManifestUrls, issues),
    loadWebInstalledPluginBundles(),
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

  for (const bundle of [
    ...filesystemResult.bundles,
    ...urlBundles,
    ...webBundles,
  ]) {
    try {
      const loadedFrom = externallyLoadedPluginSources.get(bundle.manifest.id);
      if (loadedFrom !== undefined) {
        // Already loaded by a previous scan; a settings change re-runs the
        // scan and should not warn about plugins it loaded itself. A copy
        // from a different source needs a restart to replace the loaded one.
        if (loadedFrom !== bundle.archiveName) {
          issues.push({
            archiveName: bundle.archiveName,
            sourceUrl: bundle.sourceUrl,
            message: `Plugin id '${bundle.manifest.id}' is already loaded from '${loadedFrom}'. Restart GeoLibre to load this copy.`,
          });
        }
        continue;
      }
      if (registeredPluginIds.has(bundle.manifest.id)) {
        issues.push({
          archiveName: bundle.archiveName,
          sourceUrl: bundle.sourceUrl,
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
        sourceUrl: bundle.sourceUrl,
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

/**
 * Whether a plugin id was loaded from an external source (a zip archive, a
 * manifest URL, a bundled drop-in, or a web "install from file"). Built-in
 * plugins registered at module load are not tracked here and return false. The
 * toolbar uses this to render external plugin menus after the Help menu.
 */
export function isExternalPluginId(pluginId: string): boolean {
  return externallyLoadedPluginSources.has(pluginId);
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
      const bundle = result.value;
      // Refuse to auto-execute a URL bundle whose code changed since it was
      // last trusted (a silent-update / compromised-host vector). First sight
      // pins it; a changed hash is held back until the user reloads it
      // explicitly (which re-pins). Isolate a verification failure (e.g.
      // crypto.subtle unavailable) to this one URL — letting it throw here would
      // reject the whole loadExternalPlugins Promise.all and drop every plugin.
      try {
        const integrity = await verifyPluginBundleIntegrity(
          manifestUrls[index],
          bundle,
        );
        if (integrity.status === "changed") {
          issues.push({
            archiveName: bundle.archiveName,
            sourceUrl: bundle.sourceUrl,
            message:
              `Plugin at '${bundle.sourceUrl}' changed since you last trusted it and was not loaded. ` +
              "Open Settings → Plugins and reload it to review and accept the update.",
          });
          continue;
        }
      } catch (error) {
        issues.push({
          archiveName: bundle.archiveName,
          sourceUrl: bundle.sourceUrl,
          message:
            error instanceof Error
              ? `Could not verify plugin integrity: ${error.message}`
              : "Could not verify plugin bundle integrity.",
        });
        continue;
      }
      bundles.push(bundle);
    } else {
      issues.push({
        archiveName: manifestUrls[index],
        sourceUrl: manifestUrls[index],
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
  signal?: AbortSignal,
): Promise<ExternalPluginBundle> {
  // Revalidate every request (manifest, entry, style) instead of serving from
  // the HTTP cache. A static host can hand the manifest and the entry very
  // different cache lifetimes (e.g. GitHub Pages / Fastly cache JSON for ~10
  // minutes but JS for hours), so after a version bump the loader can otherwise
  // read a fresh plugin.json against a stale, still-cached entry and reject the
  // pair with "Exported plugin version does not match plugin.json." Forcing
  // revalidation keeps the manifest and entry version-consistent. `no-cache`
  // still allows a cheap 304 when nothing changed, so this is not a full
  // re-download on every load.
  const manifestResponse = await fetch(manifestUrl, {
    cache: "no-cache",
    signal,
  });
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
    fetchPluginText(entryUrl, "plugin entry", signal),
    styleUrl
      ? fetchPluginText(styleUrl, "plugin style", signal)
      : Promise.resolve(null),
  ]);

  return {
    archiveName: manifestUrl,
    sourceUrl: manifestUrl,
    manifest,
    entrySource,
    styleSource,
  };
}

async function fetchPluginText(
  url: string,
  label: string,
  signal?: AbortSignal,
): Promise<string> {
  // `no-cache` revalidates so the entry/style stay in sync with the manifest
  // version even when a static host caches them for much longer than the
  // manifest (see loadPluginUrlBundle).
  const response = await fetch(url, { cache: "no-cache", signal });
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

// ---------------------------------------------------------------------------
// Web "install from file": unpack an uploaded .zip in the browser, register the
// plugin, and persist the unpacked bundle in IndexedDB so it reloads on the next
// visit. This is the web counterpart of the desktop Tauri install command, which
// copies the zip onto disk for the startup filesystem scan instead.
// ---------------------------------------------------------------------------

export interface InstalledWebPlugin {
  id: string;
  name: string;
  version: string;
  archiveName: string;
}

// Synthetic source recorded in externallyLoadedPluginSources for an
// IndexedDB-installed plugin. It is intentionally not an http(s)/tauri URL so
// unloadRemovedUrlPlugins (which only touches managed URL sources) leaves it
// alone, and it is stable per id so a re-scan dedupes the same plugin.
function webPluginSource(pluginId: string): string {
  return `indexeddb:${pluginId}`;
}

async function loadWebInstalledPluginBundles(): Promise<ExternalPluginBundle[]> {
  let records: StoredPluginArchive[];
  try {
    records = await getAllPluginArchives();
  } catch {
    // IndexedDB unavailable (private mode, blocked storage); the scan continues
    // with the other sources rather than failing entirely.
    return [];
  }
  return records.map((record) => ({
    archiveName: webPluginSource(record.id),
    manifest: record.manifest,
    entrySource: record.entrySource,
    styleSource: record.styleSource,
  }));
}

/**
 * Install a plugin from an uploaded `.zip` in the browser: validate it, persist
 * the unpacked bundle in IndexedDB, and register it immediately (no re-scan).
 * Reinstalling the same id overwrites the stored copy and reloads the plugin,
 * preserving its active state. A collision with a built-in or otherwise already
 * registered plugin id is rejected. Returns the installed plugin id.
 */
export async function installWebPluginArchive(
  manager: PluginManager,
  fileName: string,
  bytes: Uint8Array,
  app: GeoLibreAppAPI,
): Promise<string> {
  const bundle = await bundleFromZipBytes(fileName, bytes);
  // importExternalPlugin validates the exported plugin, that it matches the
  // manifest id/name/version, and rejects activeByDefault.
  const plugin = await importExternalPlugin(bundle);

  const existingSource = externallyLoadedPluginSources.get(plugin.id);
  if (existingSource === undefined) {
    // No record of loading this id from any external source; a clash with a
    // built-in (or a not-yet-tracked plugin) must not be silently overwritten.
    if (manager.list().some((registered) => registered.id === plugin.id)) {
      throw new Error(`Plugin id '${plugin.id}' is already registered.`);
    }
  }

  await putPluginArchive({
    id: plugin.id,
    archiveName: fileName,
    manifest: bundle.manifest,
    entrySource: bundle.entrySource,
    styleSource: bundle.styleSource ?? null,
    installedAt: pluginInstallTimestamp(),
  });

  const wasActive =
    existingSource !== undefined && manager.isActive(plugin.id);
  if (existingSource !== undefined) {
    manager.unregister(plugin.id, app);
    removeExternalPluginStyle(plugin.id);
    externallyLoadedPluginSources.delete(plugin.id);
  }

  manager.register(plugin);
  externallyLoadedPluginSources.set(plugin.id, webPluginSource(plugin.id));
  if (bundle.styleSource) {
    injectExternalPluginStyle(plugin.id, bundle.styleSource);
  }
  if (wasActive) manager.activate(plugin.id, app);

  return plugin.id;
}

/**
 * Uninstall a web-installed plugin: remove it from IndexedDB, unregister it
 * (tearing down any map control), and drop its injected style. A no-op for ids
 * that were not installed from a file.
 */
export async function uninstallWebPlugin(
  manager: PluginManager,
  pluginId: string,
  app: GeoLibreAppAPI,
): Promise<void> {
  await deletePluginArchive(pluginId);
  const source = externallyLoadedPluginSources.get(pluginId);
  if (source === webPluginSource(pluginId)) {
    manager.unregister(pluginId, app);
    removeExternalPluginStyle(pluginId);
    externallyLoadedPluginSources.delete(pluginId);
  }
}

/** List plugins installed from a file (for the Manage Plugins UI). */
export async function listInstalledWebPlugins(): Promise<InstalledWebPlugin[]> {
  let records: StoredPluginArchive[];
  try {
    records = await getAllPluginArchives();
  } catch {
    return [];
  }
  return records.map((record) => ({
    id: record.id,
    name: record.manifest.name,
    version: record.manifest.version,
    archiveName: record.archiveName,
  }));
}

// new Date()/Date.now() are awkward to stub in tests; isolate the one timestamp
// read so the install flow stays deterministic if a test needs to override it.
function pluginInstallTimestamp(): number {
  return Date.now();
}

/**
 * Resolve a fetchable URL for an asset shipped alongside a loaded plugin's
 * manifest (e.g. sample data bundled in the plugin folder). The plugin's
 * recorded source is its manifest URL, so `relativePath` resolves against the
 * plugin's own directory. Returns null when the plugin is unknown, was loaded
 * from the desktop filesystem (no URL base), or when `relativePath` would
 * escape the plugin directory. This is exposed to plugins via the app API so a
 * plugin can locate its own bundled assets without GeoLibre knowing anything
 * about that specific plugin.
 */
export function resolvePluginAssetUrlForLoadedPlugin(
  pluginId: string,
  relativePath: string,
): string | null {
  return pluginAssetUrlFromSource(
    externallyLoadedPluginSources.get(pluginId),
    relativePath,
  );
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
  // Collect first, then mutate: manager.unregister notifies subscribers
  // synchronously, so removing entries in a separate pass avoids mutating the
  // map while iterating it.
  const toRemove: string[] = [];
  const removedUrls = new Set<string>();
  for (const [pluginId, source] of externallyLoadedPluginSources) {
    if (isManagedUrlSource(source) && !keep.has(source)) {
      toRemove.push(pluginId);
      removedUrls.add(source);
    }
  }
  for (const pluginId of toRemove) {
    manager.unregister(pluginId, app);
    removeExternalPluginStyle(pluginId);
    externallyLoadedPluginSources.delete(pluginId);
  }
  // Drop integrity pins for URLs no longer installed, so re-adding one later
  // re-pins from a fresh review rather than silently matching a stale hash.
  for (const url of removedUrls) {
    removePluginBundlePin(url);
  }
  return toRemove;
}

/**
 * Forget a plugin previously loaded from the desktop filesystem so the next scan
 * re-registers it from its (possibly updated) archive. Used when a plugin is
 * reinstalled from a zip: the archive is overwritten in place under the same id,
 * so without dropping the loaded-source record the re-scan would treat the id as
 * already loaded and skip it. Managed URL and bundled plugins are left untouched
 * (their lifecycle runs through unloadRemovedUrlPlugins / reloadExternalUrlPlugin).
 * Deactivates the plugin (removing any map control) and drops its injected style.
 * Returns true when a filesystem plugin was unloaded.
 */
export function unloadFilesystemPlugin(
  manager: PluginManager,
  pluginId: string,
  app: GeoLibreAppAPI,
): boolean {
  const source = externallyLoadedPluginSources.get(pluginId);
  if (source === undefined || isManagedUrlSource(source)) return false;
  manager.unregister(pluginId, app);
  removeExternalPluginStyle(pluginId);
  externallyLoadedPluginSources.delete(pluginId);
  return true;
}

/**
 * Re-fetch and re-register the plugin loaded from `manifestUrl` to upgrade it to
 * the version currently published at that URL. The new version is fetched
 * before the old one is torn down, so a failed upgrade leaves the installed
 * plugin intact. Active state is preserved: an active plugin is reactivated
 * after the new version registers. Returns the new plugin.
 *
 * Concurrent calls for the same manifest URL are coalesced onto a single
 * in-flight promise, so the function is re-entrant-safe even if a caller's own
 * guard (e.g. the dialog's `busyId`) is bypassed by closing and reopening the
 * dialog mid-upgrade. If the plugin is uninstalled mid-fetch the returned
 * plugin is fetched and validated but NOT registered in the manager.
 */
export function reloadExternalUrlPlugin(
  manager: PluginManager,
  manifestUrl: string,
  app: GeoLibreAppAPI,
): Promise<GeoLibrePlugin> {
  const inFlight = inFlightUrlUpgrades.get(manifestUrl);
  if (inFlight) return inFlight;
  const promise = reloadExternalUrlPluginUncoalesced(
    manager,
    manifestUrl,
    app,
  ).finally(() => {
    inFlightUrlUpgrades.delete(manifestUrl);
  });
  inFlightUrlUpgrades.set(manifestUrl, promise);
  return promise;
}

async function reloadExternalUrlPluginUncoalesced(
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
  // untouched. Bound the fetch so a stalled endpoint can't leave the Update
  // button spinning forever (the manifest + entry/style requests are aborted).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let bundle: ExternalPluginBundle;
  let plugin: GeoLibrePlugin;
  try {
    bundle = await loadPluginUrlBundle(manifestUrl, controller.signal);
    // The timeout only bounds the fetch/stream above; a dynamic import() of a
    // local blob URL can't be aborted, but it evaluates near-instantly so it is
    // not a practical hang risk.
    plugin = await importExternalPlugin(bundle);
  } finally {
    clearTimeout(timeout);
  }

  // Nothing was loaded for this URL (existingId null — e.g. the manifest is in
  // settings but its initial load failed). Throw rather than registering the
  // fetched plugin as a side effect, so the caller surfaces the inconsistency
  // instead of the UI reporting a silent, invisible "success".
  if (existingId === null) {
    throw new Error(
      `Cannot update plugin: no loaded version was found for '${manifestUrl}'. Try reloading the app.`,
    );
  }

  // If the plugin was uninstalled while we were fetching (its source was
  // removed from the loaded map by unloadRemovedUrlPlugins), don't resurrect it.
  if (!externallyLoadedPluginSources.has(existingId)) return plugin;

  // A version that changes its plugin id (e.g. the author renamed it) would
  // leave the marketplace's installed/version state pointing at the old id.
  // Refuse rather than silently register a mismatched plugin.
  if (existingId !== plugin.id) {
    throw new Error(
      `Cannot update plugin: the published version exports id '${plugin.id}' but the installed version has id '${existingId}'. Reinstall it manually.`,
    );
  }

  manager.unregister(existingId, app);
  removeExternalPluginStyle(existingId);
  externallyLoadedPluginSources.delete(existingId);
  manager.register(plugin);
  externallyLoadedPluginSources.set(plugin.id, manifestUrl);
  // Explicit user reload: accept this version as the new trusted baseline so the
  // next auto-scan doesn't flag it as changed.
  pinPluginBundle(manifestUrl, await computePluginBundleHash(bundle));
  if (bundle.styleSource) {
    injectExternalPluginStyle(plugin.id, bundle.styleSource);
  }
  if (wasActive) manager.activate(plugin.id, app);
  return plugin;
}
