import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { addProtocol, type StyleSpecification } from "maplibre-gl";
import type { Protocol, TilePackage, TilePackageHeader } from "maplibre-tilepackage-protocol";
import {
  TILEPACKAGE_PROTOCOL,
  createLocalTilePackageKeyGenerator,
  prepareVtpkStyle,
  tilePackageBaseName,
  tilePackageBounds,
  tilePackageTileUrl,
} from "./tilepackage-style";

export { isTilePackageFileName, tilePackageBaseName, tilePackageBounds } from "./tilepackage-style";

/** `metadata.sourceKind` of a layer read from a package at a URL. */
export const TILEPACKAGE_URL_SOURCE_KIND = "tilepackage-url";
/** `metadata.sourceKind` of a layer read from a package file picked in this session. */
export const TILEPACKAGE_FILE_SOURCE_KIND = "tilepackage-file";

interface TilePackageRuntime {
  lib: typeof import("maplibre-tilepackage-protocol");
  protocol: Protocol;
}

let runtime: Promise<TilePackageRuntime> | null = null;
const nextLocalKey = createLocalTilePackageKeyGenerator();

/**
 * Load the tile-package reader and register its `tilepackage://` protocol with
 * MapLibre, once. The reader is a dynamic import, so it ships as its own chunk
 * instead of growing the entry bundle; the app requests it at startup (see
 * `useTileProtocols`) so a reopened project's packages resolve straight away.
 */
export function registerTilePackageProtocol(): Promise<TilePackageRuntime> {
  runtime ??= import("maplibre-tilepackage-protocol")
    .then((lib) => {
      const protocol = new lib.Protocol();
      addProtocol(TILEPACKAGE_PROTOCOL, protocol.package);
      return { lib, protocol };
    })
    .catch((error: unknown) => {
      // Do not cache a failed import: the next attempt (a retry after a
      // network blip) must be able to succeed.
      runtime = null;
      throw error;
    });
  return runtime;
}

/** An opened package: what the protocol serves and what its style says. */
export interface OpenedTilePackage {
  /** What the protocol knows the package by: its URL, or a unique local key. */
  key: string;
  header: TilePackageHeader;
  /** The package's own MapLibre style (a raster stand-in for a TPKX). */
  style: StyleSpecification;
  /** A layer name from the file name or the package's own title. */
  name: string;
  /** True for a file picked on this machine, which a saved project cannot reopen. */
  local: boolean;
  /** The URL or file name the package was opened from. */
  sourcePath: string;
}

/**
 * Open a VTPK or TPKX and register it with the protocol.
 *
 * Only the zip directory and the pieces asked for are read, by HTTP range
 * requests for a URL and `File.slice` for a local file, so a multi-gigabyte
 * package is never loaded whole.
 *
 * @param input - An http(s) URL, or a `File` from a picker.
 * @returns The registered package with its header and style.
 */
export async function openTilePackage(input: string | File): Promise<OpenedTilePackage> {
  const { lib, protocol } = await registerTilePackageProtocol();

  let key: string;
  let pkg: TilePackage;
  let sourcePath: string;
  if (typeof input === "string") {
    key = input;
    sourcePath = input;
    pkg = new lib.TilePackage(input);
  } else {
    key = nextLocalKey(input.name);
    sourcePath = input.name;
    const source = new lib.FileSource(input);
    // The library keys a file by its bare name; scope it so files that share a
    // name (or a name reused by a later session) never share a reader.
    source.getKey = () => key;
    pkg = new lib.TilePackage(source);
  }
  protocol.add(pkg);

  const header = await pkg.getHeader();
  const style = await pkg.getStyle();
  return {
    key,
    header,
    style,
    name: header.name?.trim() || tilePackageBaseName(sourcePath),
    local: typeof input !== "string",
    sourcePath,
  };
}

/**
 * Build the store layer for an opened package.
 *
 * A VTPK is drawn from its own Esri style, as an `arcgis` layer carrying the
 * resolved sources and style layers (the same record an ArcGIS vector tile
 * service uses, which every renderer already knows how to draw). A TPKX is
 * raster, so it becomes an ordinary `xyz` tile layer.
 *
 * @param opened - The result of {@link openTilePackage}.
 * @param layerId - The id for the new layer.
 * @returns The layer, or throws when a vector package has nothing drawable.
 */
export function createTilePackageLayer(opened: OpenedTilePackage, layerId: string): GeoLibreLayer {
  const { key, header, style, name, local } = opened;
  // A picked file has no path a project could reopen, only a name.
  const sourcePath = local ? undefined : opened.sourcePath;
  const bounds = tilePackageBounds(header) ?? undefined;
  const sourceKind = local ? TILEPACKAGE_FILE_SOURCE_KIND : TILEPACKAGE_URL_SOURCE_KIND;
  const tileUrl = tilePackageTileUrl(key);
  const minzoom = Number.isFinite(header.minZoom) ? header.minZoom : undefined;
  const maxzoom = Number.isFinite(header.maxZoom) ? header.maxZoom : undefined;
  const packageMetadata = {
    sourceKind,
    packageType: header.packageType,
    packageKey: key,
    spatialReference: header.spatialReference,
    bounds,
    minzoom,
    maxzoom,
  };

  if (header.packageType !== "vtpk") {
    return {
      id: layerId,
      name,
      type: "xyz",
      source: {
        tiles: [tileUrl],
        tileSize: header.tileSize ?? 256,
        bounds,
        minzoom,
        maxzoom,
        attribution: header.attribution,
      },
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: packageMetadata,
      sourcePath,
    };
  }

  const prepared = prepareVtpkStyle(style, layerId, { tileUrl });
  if (prepared.layers.length === 0) {
    throw new Error("The VTPK style has no vector layers that can be drawn.");
  }
  if (header.attribution) {
    for (const source of Object.values(prepared.sources)) {
      if (!("attribution" in source) || !source.attribution) {
        (source as { attribution?: string }).attribution = header.attribution;
      }
    }
  }

  return {
    id: layerId,
    name,
    type: "arcgis",
    source: {
      bounds,
      sourceId: prepared.sourceIds[0],
      sourceIds: prepared.sourceIds,
      type: "vector",
      // The resolved style travels with the layer, so a saved project redraws it
      // without the package's own reader being involved (arcgisVectorStyle).
      arcgisSources: prepared.sources,
      arcgisLayers: prepared.layers,
    },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      ...packageMetadata,
      externalNativeLayer: true,
      nativeLayerIds: prepared.nativeLayerIds,
      sourceId: prepared.sourceIds[0],
      sourceIds: prepared.sourceIds,
    },
    sourcePath,
  };
}
