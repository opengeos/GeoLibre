import type { GeoLibreExternalPlugin, GeoLibreExternalPluginManifest } from "@geolibre/plugins";
import { GEOLIBRE_PLUGIN_API_VERSION } from "@geolibre/plugins/api-version";
import {
  assertExternalPluginManifest,
  type ExternalPluginBundle,
  MAX_PLUGIN_ASSET_BYTES,
} from "./plugin-archive-unpack";
import { resolvePluginAssetUrl } from "./plugin-asset-url";

/** Fetch and validate a remote plugin bundle before any entry code executes. */
export async function loadPluginUrlBundle(
  manifestUrl: string,
  signal?: AbortSignal,
): Promise<ExternalPluginBundle> {
  const manifestResponse = await fetch(manifestUrl, { cache: "no-cache", signal });
  if (!manifestResponse.ok) {
    throw new Error(`Could not fetch plugin manifest: HTTP ${manifestResponse.status}`);
  }

  const manifest = (await manifestResponse.json()) as unknown;
  assertExternalPluginManifest(manifest);

  const entryUrl = resolvePluginAssetUrl(manifestUrl, manifest.entry);
  const styleUrl = manifest.style ? resolvePluginAssetUrl(manifestUrl, manifest.style) : null;
  const [entrySource, styleSource] = await Promise.all([
    fetchPluginText(entryUrl, "plugin entry", signal),
    styleUrl ? fetchPluginText(styleUrl, "plugin style", signal) : Promise.resolve(null),
  ]);

  return {
    archiveName: manifestUrl,
    sourceUrl: manifestUrl,
    manifest,
    entrySource,
    styleSource,
  };
}

async function fetchPluginText(url: string, label: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, { cache: "no-cache", signal });
  if (!response.ok) throw new Error(`Could not fetch ${label}: HTTP ${response.status}`);

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PLUGIN_ASSET_BYTES) {
    throw new Error(`Could not fetch ${label}: exceeds the 50 MB size limit.`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_PLUGIN_ASSET_BYTES) {
      throw new Error(`Could not fetch ${label}: exceeds the 50 MB size limit.`);
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
      throw new Error(`Could not fetch ${label}: exceeds the 50 MB size limit.`);
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

export function assertExternalPlugin(value: unknown): asserts value is GeoLibreExternalPlugin {
  if (!value || typeof value !== "object") {
    throw new Error("Entry must export a GeoLibrePlugin as default or plugin.");
  }
  const plugin = value as Partial<GeoLibreExternalPlugin>;
  if (plugin.apiVersion !== GEOLIBRE_PLUGIN_API_VERSION) {
    throw new Error(`Plugin requires Plugin API ${GEOLIBRE_PLUGIN_API_VERSION}.`);
  }
  const valid =
    typeof plugin.id === "string" &&
    typeof plugin.name === "string" &&
    typeof plugin.version === "string" &&
    typeof plugin.activate === "function" &&
    typeof plugin.deactivate === "function";
  if (!valid) throw new Error("Entry must export a GeoLibrePlugin as default or plugin.");
}

export function validateManifestMatchesPlugin(
  manifest: GeoLibreExternalPluginManifest,
  plugin: GeoLibreExternalPlugin,
): void {
  if (plugin.apiVersion !== manifest.apiVersion) {
    throw new Error("Exported plugin API version does not match plugin.json.");
  }
  if (plugin.id !== manifest.id) throw new Error("Exported plugin id does not match plugin.json.");
  if (plugin.name !== manifest.name)
    throw new Error("Exported plugin name does not match plugin.json.");
  if (plugin.version !== manifest.version) {
    throw new Error("Exported plugin version does not match plugin.json.");
  }
}
