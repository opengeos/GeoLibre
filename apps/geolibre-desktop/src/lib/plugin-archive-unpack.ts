// Pure, browser/Node-safe helpers for turning a plugin `.zip` into a validated
// bundle. Kept free of Tauri and DOM imports so it stays unit-testable and can
// be shared by the URL loader (manifest validation) and the web "install from
// file" flow (in-browser unzip). The heavier external-plugin loader re-exports
// what it needs from here.

import type { GeoLibreExternalPluginManifest } from "@geolibre/plugins";
import { unzip } from "fflate";

export interface ExternalPluginBundle {
  archiveName: string;
  manifest: GeoLibreExternalPluginManifest;
  entrySource: string;
  styleSource?: string | null;
}

// Mirrors MAX_PLUGIN_ENTRY_BYTES in the Rust filesystem loader so plugin assets
// (whether fetched, read from disk, or unzipped in the browser) cannot buffer an
// unbounded amount of data into memory.
export const MAX_PLUGIN_ASSET_BYTES = 50 * 1024 * 1024;

// Matches the Rust validate_required_manifest_string: non-empty with no leading
// or trailing whitespace.
function isRequiredManifestString(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.trim() === value
  );
}

export function isExternalPluginManifest(
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

function unzipToRecord(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(bytes, (error, files) => {
      if (error) reject(error);
      else resolve(files);
    });
  });
}

// Decode a zip entry to text, enforcing the 50 MB cap so a malicious archive
// cannot exhaust memory.
function decodePluginText(bytes: Uint8Array, label: string): string {
  if (bytes.byteLength > MAX_PLUGIN_ASSET_BYTES) {
    throw new Error(`Could not read ${label}: exceeds the 50 MB size limit.`);
  }
  return new TextDecoder().decode(bytes);
}

// Mirror the Rust validate_external_plugin_path rules so a manifest entry/style
// path cannot reference anything outside the archive's own files.
function assertSafeArchivePath(field: string, value: string): void {
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes(":") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Plugin manifest ${field} must be a relative safe path.`);
  }
}

/**
 * Unzip an uploaded plugin archive in the browser and validate it into an
 * ExternalPluginBundle: reads the root plugin.json, enforces the manifest rules
 * and safe relative paths, and pulls the entry (and optional style) out of the
 * archive. Does NOT execute the entry; the caller imports and registers it.
 */
export async function bundleFromZipBytes(
  archiveName: string,
  bytes: Uint8Array,
): Promise<ExternalPluginBundle> {
  const files = await unzipToRecord(bytes);
  const manifestBytes = files["plugin.json"];
  if (!manifestBytes) {
    throw new Error("Plugin archive is missing a root plugin.json.");
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(decodePluginText(manifestBytes, "plugin manifest"));
  } catch {
    throw new Error("Could not parse plugin.json.");
  }
  if (!isExternalPluginManifest(manifest)) {
    throw new Error("Plugin manifest is invalid.");
  }

  assertSafeArchivePath("entry", manifest.entry);
  const entryBytes = files[manifest.entry];
  if (!entryBytes) {
    throw new Error(
      `Plugin entry '${manifest.entry}' is missing from the archive.`,
    );
  }
  const entrySource = decodePluginText(entryBytes, "plugin entry");

  let styleSource: string | null = null;
  if (manifest.style) {
    assertSafeArchivePath("style", manifest.style);
    const styleBytes = files[manifest.style];
    if (!styleBytes) {
      throw new Error(
        `Plugin style '${manifest.style}' is missing from the archive.`,
      );
    }
    styleSource = decodePluginText(styleBytes, "plugin style");
  }

  return { archiveName, manifest, entrySource, styleSource };
}
