// Trust gating for plugin manifest URLs carried inside a project file.
//
// A `.geolibre.json` project is opened as data and can come from anyone (a
// shared file, a URL, a gallery card). It can carry `plugins.manifestUrls`,
// each of which the app would otherwise fetch and dynamically `import()` as a
// JavaScript module in the privileged renderer context (with access to the
// Tauri APIs on desktop). Executing that code on open, with no user decision,
// lets a shared project silently extend the app's trusted codebase (#1062).
//
// So project-supplied URLs never auto-load. Only URLs the user has already
// explicitly installed (their desktop settings) or that ship baked into the
// build (bundled drop-ins) are trusted to load automatically; every other
// project URL is held back until the user approves it in a trust prompt.

import { isAllowedPluginManifestUrl } from "@geolibre/core";
import { normalizeStringList } from "./string-lists";

export interface PartitionedProjectPluginUrls {
  /** Project URLs already trusted (installed in settings or bundled). */
  trusted: string[];
  /** Project URLs that must not load until the user approves them. */
  untrusted: string[];
}

/**
 * Split the plugin manifest URLs carried by a project into the already-trusted
 * subset and the untrusted subset.
 *
 * A URL is trusted only when the user has previously installed it (it is in
 * `trustedManifestUrls`, i.e. the desktop settings list) or it ships with the
 * build (`bundledManifestUrls`). Everything else is untrusted and must not be
 * fetched or imported until the user makes an explicit trust decision.
 *
 * URLs that fail the scheme allow-list (`isAllowedPluginManifestUrl`) can never
 * load, so they are dropped from both lists — matching the filter applied when
 * the project file is parsed (`normalizeProjectPlugins`).
 *
 * @param projectManifestUrls - `plugins.manifestUrls` from the opened project.
 * @param trustedManifestUrls - The user's installed plugin URLs (desktop settings).
 * @param bundledManifestUrls - URLs for plugins baked into the build.
 * @returns The trusted and untrusted partitions, de-duplicated and trimmed.
 */
export function partitionProjectPluginManifestUrls(
  projectManifestUrls: readonly string[],
  trustedManifestUrls: readonly string[],
  bundledManifestUrls: readonly string[],
): PartitionedProjectPluginUrls {
  const trustedSet = new Set(normalizeStringList([...trustedManifestUrls, ...bundledManifestUrls]));
  const trusted: string[] = [];
  const untrusted: string[] = [];
  for (const url of normalizeStringList(projectManifestUrls)) {
    // A disallowed scheme (non-HTTPS, non-loopback) can never load; drop it
    // rather than surfacing it in a trust prompt the user could never satisfy.
    if (!isAllowedPluginManifestUrl(url)) continue;
    if (trustedSet.has(url)) {
      trusted.push(url);
    } else {
      untrusted.push(url);
    }
  }
  return { trusted, untrusted };
}
