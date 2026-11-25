/** Rebase retained iOS data references before a layer reaches any reader. */
import type { GeoLibreLayer } from "./types";
import { hasPathTraversal, isAbsoluteFilesystemPath } from "./paths";

const COPY_PATH =
  /^\/.*\/Library\/Application Support\/org\.geolibre\.app\/picked-documents\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/data\/([^/]+)$/i;

/** Keep the selection identity and file name, replacing only the container root. */
export function rebaseImportedDocumentPath(path: string, root: string): string {
  if (
    !root.startsWith("/") ||
    !isAbsoluteFilesystemPath(root) ||
    hasPathTraversal(root) ||
    !root.endsWith("/picked-documents") ||
    !isAbsoluteFilesystemPath(path) ||
    hasPathTraversal(path)
  )
    return path;
  const match = COPY_PATH.exec(path);
  if (!match) return path;
  const [, selection, name] = match;
  if (
    name === "." ||
    name === ".." ||
    /[\\\x00-\x1f\x7f]/.test(name) ||
    name.length > 255 ||
    new TextEncoder().encode(name).length > 255
  )
    return path;
  return `${root}/${selection}/data/${name}`;
}

/** Only rewrite native local-media URLs, preserving tile coordinate templates. */
function rebaseMediaUrl(value: string, root: string): string {
  const prefix = value.startsWith("pmtiles://") ? "pmtiles://" : "";
  const raw = prefix ? value.slice(prefix.length) : value;
  if (
    !/^(?:(?:geolibre-mbtiles|mbtiles|local-cog|local-pmtiles|asset):\/\/|http:\/\/(?:mbtiles|local-cog|local-pmtiles|asset)\.localhost\/)/i.test(
      raw,
    )
  )
    return value;
  try {
    const url = new URL(raw);
    const queryMedia =
      (["geolibre-mbtiles:", "mbtiles:", "local-cog:", "local-pmtiles:"].includes(url.protocol) &&
        ["localhost", "tile"].includes(url.host)) ||
      (url.protocol === "http:" &&
        ["mbtiles.localhost", "local-cog.localhost", "local-pmtiles.localhost"].includes(url.host));
    if (queryMedia) {
      const path = url.searchParams.get("path");
      if (!path) return value;
      const current = rebaseImportedDocumentPath(path, root);
      return current === path
        ? value
        : prefix +
            raw.replace(/([?&]path=)[^&#]*/, (_, key: string) => key + encodeURIComponent(current));
    }
    if (
      (url.protocol === "asset:" && url.host === "localhost") ||
      (url.protocol === "http:" && url.host === "asset.localhost")
    ) {
      const path = decodeURIComponent(
        /^\/%2f/i.test(url.pathname) ? url.pathname.slice(1) : url.pathname,
      );
      const current = rebaseImportedDocumentPath(path, root);
      return current === path
        ? value
        : `${url.protocol}//${url.host}/${encodeURIComponent(current)}${url.search}${url.hash}`;
    }
  } catch {
    // Malformed/unsupported URLs remain for their normal validation path.
  }
  return value;
}

/** The root is native runtime state, never a field supplied by a saved project. */
export function rebaseImportedDocumentLayer(
  layer: GeoLibreLayer,
  root: string | null,
): GeoLibreLayer {
  if (!root) return layer;
  let result = layer;
  if (typeof layer.sourcePath === "string") {
    const path = rebaseImportedDocumentPath(layer.sourcePath, root);
    if (path !== layer.sourcePath) result = { ...result, sourcePath: path };
  }
  for (const key of ["localFilePath", "localBytesUrl"]) {
    const value = layer.metadata[key];
    if (typeof value !== "string") continue;
    const next =
      key === "localFilePath"
        ? rebaseImportedDocumentPath(value, root)
        : rebaseMediaUrl(value, root);
    if (next !== value) result = { ...result, metadata: { ...result.metadata, [key]: next } };
  }
  if (typeof layer.source.url === "string") {
    const url = rebaseMediaUrl(layer.source.url, root);
    if (url !== layer.source.url) result = { ...result, source: { ...result.source, url } };
  }
  if (Array.isArray(layer.source.tiles)) {
    const original = layer.source.tiles;
    const tiles = original.map((value) =>
      typeof value === "string" ? rebaseMediaUrl(value, root) : value,
    );
    if (tiles.some((value, index) => value !== original[index])) {
      result = { ...result, source: { ...result.source, tiles } };
    }
  }
  return result;
}
