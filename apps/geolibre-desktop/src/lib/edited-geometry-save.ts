import { redactUrlCredentials } from "@geolibre/core";
import type { GeoLibreLayer } from "@geolibre/core";
import { isAbsoluteLocalPath } from "./file-io/paths";

/**
 * Layers with committed feature edits that need an explicit embedding choice.
 * `metadata.geometryEdited` marks any divergence from the source's features:
 * geometry edits from the Geo Editor and attribute edits from the attribute
 * table (see {@link markAttributeEdit}).
 */
export function hasEditedGeometry(layer: GeoLibreLayer): boolean {
  return layer.metadata.geometryEdited === true && layer.geojson !== undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Whether a saved project rebuilds the layer from its source (a URL, a desktop
 * file path, or the Add Vector Layer control) instead of from its in-memory
 * features. Edits to such a layer's features are lost on reopen unless the save
 * embeds them.
 *
 * @param layer - A store layer.
 * @returns True when the layer's features reload from their source.
 */
export function reloadsFeaturesFromSource(layer: GeoLibreLayer): boolean {
  return (
    isNonEmptyString(layer.source.url) ||
    isNonEmptyString(layer.metadata.originalUrl) ||
    layer.metadata.sourceKind === "maplibre-gl-vector" ||
    layer.metadata.localFileReloadable === true ||
    (typeof layer.sourcePath === "string" && isAbsoluteLocalPath(layer.sourcePath))
  );
}

/**
 * Flags an attribute-table patch that rewrites a source-backed layer's features
 * (edited cells, added/renamed/deleted fields, Field Calculator results) as an
 * edit, so the next save offers to embed the edited features rather than saving
 * only the source reference and silently dropping the change on reopen.
 *
 * @param layer - The layer the patch applies to.
 * @param patch - The patch the attribute table is about to apply.
 * @returns The patch, with `metadata.geometryEdited` set when it edits features.
 */
export function markAttributeEdit(
  layer: GeoLibreLayer,
  patch: Partial<GeoLibreLayer>,
): Partial<GeoLibreLayer> {
  if (patch.geojson === undefined || !layer.geojson || !reloadsFeaturesFromSource(layer)) {
    return patch;
  }
  // `updateLayer` replaces metadata wholesale, so build on the patch's own
  // metadata (column settings) when it carries one.
  const metadata = patch.metadata ?? layer.metadata;
  if (metadata.geometryEdited === true) return patch;
  return { ...patch, metadata: { ...metadata, geometryEdited: true } };
}

/** Make the edited features authoritative in a saved project snapshot. */
export function embedEditedGeometry(layer: GeoLibreLayer): GeoLibreLayer {
  if (!hasEditedGeometry(layer)) return layer;
  const { url: _url, ...source } = layer.source;
  const {
    originalUrl: _originalUrl,
    localFileReloadable: _reload,
    geometryEdited: _edited,
    ...metadata
  } = layer.metadata;
  return {
    ...layer,
    source,
    metadata:
      layer.metadata.sourceKind === "maplibre-gl-vector"
        ? { ...metadata, embeddedGeoJSON: layer.geojson }
        : metadata,
  };
}
function hasRestorableWfsUrl(layer: GeoLibreLayer): boolean {
  // Only the layer's own request URL counts: WFS hydration needs an HTTP(S)
  // `source.url`, so a stray `metadata.originalUrl` (a tile-layer field) must
  // not let a no-embed save drop features nothing can re-fetch.
  const value = layer.source.url;
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      redactUrlCredentials(value) === value
    );
  } catch {
    return false;
  }
}

/** Honor an explicit no-embed choice for edited WFS layers with a reload URL. */
export function discardEditedWfsGeometry(layer: GeoLibreLayer): GeoLibreLayer {
  if (
    !hasEditedGeometry(layer) ||
    layer.metadata.sourceKind !== "wfs-getfeature" ||
    !hasRestorableWfsUrl(layer)
  ) {
    return layer;
  }
  const { geojson: _geojson, ...rest } = layer;
  const { geometryEdited: _edited, ...metadata } = layer.metadata;
  return { ...rest, metadata };
}
