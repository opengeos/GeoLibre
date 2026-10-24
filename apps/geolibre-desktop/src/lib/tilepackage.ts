import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, useAppStore } from "@geolibre/core";
import { addProtocol, type StyleSpecification } from "maplibre-gl";
import type { Protocol, TilePackage, TilePackageHeader } from "maplibre-tilepackage-protocol";
import {
  TILEPACKAGE_PROTOCOL,
  createLocalTilePackageKeyGenerator,
  isLocalTilePackageKey,
  localTilePackageKeyFromUrl,
  localTilePackageKeysInLayers,
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
// The live protocol, for the synchronous release paths below.
let activeProtocol: Protocol | null = null;
const nextLocalKey = createLocalTilePackageKeyGenerator();

// Local keys that a layer has referenced at least once. Only these are pruned:
// a package that is open but not yet on a layer is released by whoever opened it.
const claimedLocalKeys = new Set<string>();
let pruneSubscriptionInstalled = false;
let pruneScheduled = false;

const LOCAL_PACKAGE_GONE_MESSAGE =
  "This tile package file is no longer loaded. Add it again to view its tiles.";

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
      activeProtocol = protocol;
      // The protocol opens an unknown key as if it were a URL. A local file has
      // no URL, so a reopened project (or a released file) would fail with a
      // confusing network error; say what happened instead.
      addProtocol(TILEPACKAGE_PROTOCOL, (request, abortController) => {
        const localKey = localTilePackageKeyFromUrl(request.url);
        if (localKey !== null && !protocol.tiles.has(localKey)) {
          return Promise.reject(new Error(LOCAL_PACKAGE_GONE_MESSAGE));
        }
        return protocol.package(request, abortController);
      });
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

  // Read before registering: a package that cannot be opened (not a package,
  // unreachable, no range support) must not stay registered, and for a local
  // file registering is what keeps the `File` alive.
  const header = await pkg.getHeader();
  const style = await pkg.getStyle();
  protocol.add(pkg);
  if (typeof input !== "string") ensurePruneSubscription();
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
 * Forget a package that was opened but will not be used (the open was
 * cancelled, or no layer could be built from it), so its reader and cached
 * directory, and for a local file the `File` itself, can be freed.
 *
 * A package at a URL is keyed by the URL, which another layer may share, so it
 * is kept while any layer on the map uses it. The protocol simply opens it
 * again if it is asked for later.
 */
export function releaseTilePackage(key: string): void {
  claimedLocalKeys.delete(key);
  if (!activeProtocol) return;
  if (!isLocalTilePackageKey(key)) {
    const inUse = useAppStore.getState().layers.some((layer) => layer.metadata?.packageKey === key);
    if (inUse) return;
  }
  activeProtocol.tiles.delete(key);
}

/**
 * Release every local package that a layer used to reference but no layer
 * references any more. "Referenced" includes the undo/redo snapshots, so undoing
 * a layer removal still finds its tiles; a package is released only once the
 * history has let go of the layer as well.
 */
export function pruneTilePackages(): void {
  if (!activeProtocol) return;
  const { pastStates, futureStates } = useAppStore.temporal.getState();
  const live = localTilePackageKeysInLayers([
    useAppStore.getState().layers,
    ...pastStates.map((state) => state.layers ?? []),
    ...futureStates.map((state) => state.layers ?? []),
  ]);
  for (const key of live) {
    if (activeProtocol.tiles.has(key)) claimedLocalKeys.add(key);
  }
  for (const key of [...claimedLocalKeys]) {
    if (!live.has(key)) releaseTilePackage(key);
  }
}

// A layer can vanish through paths that never touch the layer panel (the
// scripting API, plugin teardown, New Project), and undo history can later drop
// the snapshots that kept it alive, so watch the store and its history. The
// prune is deferred to a microtask because zundo records the previous state
// *after* subscribers are notified: pruning synchronously would free a package
// whose removal is about to become an undo entry.
function schedulePrune(): void {
  if (pruneScheduled) return;
  pruneScheduled = true;
  queueMicrotask(() => {
    pruneScheduled = false;
    pruneTilePackages();
  });
}

function ensurePruneSubscription(): void {
  if (pruneSubscriptionInstalled) return;
  pruneSubscriptionInstalled = true;
  useAppStore.subscribe((state, previous) => {
    if (state.layers !== previous.layers) schedulePrune();
  });
  useAppStore.temporal.subscribe((state, previous) => {
    if (state.pastStates !== previous.pastStates || state.futureStates !== previous.futureStates) {
      schedulePrune();
    }
  });
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
