/**
 * How a `pmtiles` store layer is shaped, kept apart from `layer-sync` so the plugins package can
 * import it (`@geolibre/map/pmtiles-layer`) without pulling in MapLibre and its stylesheet.
 */
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, type LayerStyle } from "@geolibre/core";
import {
  FetchSource,
  FileSource,
  PMTiles,
  type RangeResponse,
  type Source,
  TileType,
} from "pmtiles";
import { encodeVectorTileLayerPart } from "./vector-tile-layer-ids";

export const PMTILES_PROTOCOL = "pmtiles";

export function normalizePMTilesUrl(url: string): string {
  return url.startsWith(`${PMTILES_PROTOCOL}://`) ? url : `${PMTILES_PROTOCOL}://${url}`;
}

/**
 * Collisions already reported, keyed by archive URL — an id is not unique over a session. Never
 * cleared, so a test asserting one of these warnings needs a URL no other test has warned for.
 */
const reportedCollisions = new Set<string>();

/** The MapLibre layers one source layer is drawn with. */
export const pmtilesLayerKinds = ["fill", "line", "circle"] as const;

/** The id one of an archive's style layers draws under. See {@link pmtilesControlLayerId}. */
export function pmtilesVectorLayerId(sourceId: string, sourceLayer: string, kind: string): string {
  return `${sourceId}-${encodeVectorTileLayerPart(sourceLayer)}-${kind}`;
}

/**
 * The id `maplibre-gl-components`' PMTiles control draws one of an archive's style layers under:
 * the same shape as {@link pmtilesVectorLayerId}, but spelling the source layer's name **raw**
 * where that encodes it. The two agree except for a name holding `/`, a space or non-ASCII, and
 * anything recognising the control's layers must match both or it draws a second set over them.
 *
 * A mirror of an unexported template, so a bump that renames it is one line here.
 * `tests/pmtiles-control-contract.test.ts` drives the real control and fails if they diverge.
 */
export function pmtilesControlLayerId(sourceId: string, sourceLayer: string, kind: string): string {
  return `${sourceId}-${sourceLayer}-${kind}`;
}

/**
 * The MapLibre layer ids `syncLayers` creates for a `pmtiles` store layer, in
 * the exact naming scheme `ensurePMTilesExternalLayer` uses. A layer built
 * outside the PMTiles control (e.g. the offline basemap extract dialog) must
 * put these in `metadata.nativeLayerIds` — a non-empty list is what marks the
 * layer renderable rather than a placeholder.
 */
export function pmtilesNativeLayerIds(
  sourceId: string,
  tileType: "vector" | "raster",
  sourceLayers: readonly string[],
): string[] {
  if (tileType === "raster") {
    return [`${sourceId}-raster`];
  }
  return sourceLayers.flatMap((sourceLayer) =>
    pmtilesLayerKinds.map((kind) => pmtilesVectorLayerId(sourceId, sourceLayer, kind)),
  );
}

/** Which of `nativeLayerIds` are ids these source layers draw under, in either scheme. */
export function pmtilesIdsForSourceLayers(
  nativeLayerIds: readonly string[],
  sourceId: string,
  sourceLayers: readonly string[],
): string[] {
  const drawn = new Set(
    sourceLayers.flatMap((sourceLayer) =>
      pmtilesLayerKinds.flatMap((kind) => [
        pmtilesVectorLayerId(sourceId, sourceLayer, kind),
        pmtilesControlLayerId(sourceId, sourceLayer, kind),
      ]),
    ),
  );
  return nativeLayerIds.filter((nativeLayerId) => drawn.has(nativeLayerId));
}

/** Whether one of `nativeLayerIds` is an id this source layer draws under. */
export function pmtilesIdNamesSourceLayer(
  nativeLayerIds: readonly string[],
  sourceId: string,
  sourceLayer: string,
): boolean {
  return pmtilesIdsForSourceLayers(nativeLayerIds, sourceId, [sourceLayer]).length > 0;
}

/** Everything {@link createPMTilesStoreLayer} needs beyond the archive's own facts. */
export interface PMTilesStoreLayerOptions {
  id: string;
  name: string;
  /** The archive, with or without the `pmtiles://` prefix. */
  url: string;
  tileType: "vector" | "raster";
  /** Passed to MapLibre for a vector source that is not plain MVT. */
  encoding?: "mvt" | "mlt";
  sourceLayers: readonly string[];
  visible?: boolean;
  opacity?: number;
  /** Merged over the defaults, for callers that paint their PMTiles layers their own way. */
  style?: Partial<LayerStyle>;
  pickable?: boolean;
  sourceLayerColors?: Record<string, string>;
  /** The MapLibre ids a control created itself; derived from the naming scheme otherwise. */
  nativeLayerIds?: readonly string[];
  /** The MapLibre source to draw from, when it is not this layer's own — a shared archive. */
  sourceId?: string;
}

/**
 * The one place a `pmtiles` store layer is shaped. `syncLayers` renders an archive only when the
 * layer carries `sourceKind`, `externalNativeLayer`, and a non-empty `nativeLayerIds`; miss one and
 * it is drawn as a placeholder with nothing to say why.
 */
export function createPMTilesStoreLayer(options: PMTilesStoreLayerOptions): GeoLibreLayer {
  const { id, name, tileType } = options;
  const sourceId = options.sourceId ?? id;
  const sourceLayers = [...options.sourceLayers];
  const url = normalizePMTilesUrl(options.url);
  const fillColor =
    (sourceLayers[0] ? options.sourceLayerColors?.[sourceLayers[0]] : undefined) ??
    DEFAULT_LAYER_STYLE.fillColor;

  return {
    id,
    name,
    type: "pmtiles",
    source: {
      sourceId,
      sourceLayers,
      tileType,
      type: tileType === "raster" ? "raster" : "vector",
      ...(options.encoding ? { encoding: options.encoding } : {}),
      url,
    },
    sourcePath: url,
    visible: options.visible ?? true,
    opacity: options.opacity ?? 1,
    // The outline follows the fill unless the caller set its own.
    style: {
      ...DEFAULT_LAYER_STYLE,
      fillColor,
      strokeColor: fillColor,
      ...options.style,
      ...(options.style?.fillColor && !options.style.strokeColor
        ? { strokeColor: options.style.fillColor }
        : {}),
    },
    metadata: {
      externalNativeLayer: true,
      nativeLayerIds: [
        ...(options.nativeLayerIds ?? pmtilesNativeLayerIds(sourceId, tileType, sourceLayers)),
      ],
      pickable: options.pickable ?? true,
      sourceId,
      sourceKind: "pmtiles-url",
      sourceLayers,
      tileType,
    },
  };
}

/**
 * One layer per source layer in a vector archive, so the Layers panel can show, reorder, style and
 * hide them with the machinery it already has. Raster, or a single source layer, stays one layer.
 *
 * All of them name the archive's one MapLibre source, so removing one must not remove it —
 * `removeLayerFromMap` refcounts it against the survivors. That id doubles as the refcount key;
 * anything needing the two to differ needs its own field rather than a third reader of this one.
 */
export function createPMTilesArchiveLayers(options: PMTilesStoreLayerOptions): GeoLibreLayer[] {
  // Keyed by the id each source layer would take, not by its name: `encodeVectorTileLayerPart` is
  // not injective (`a/b` and `a_2Fb` both encode to `a_2Fb`), and an archive's metadata can repeat
  // a name outright. Either way a second layer would carry the first one's id.
  if (options.tileType === "raster") {
    // Raster tiles never split, so the id math below means nothing for them.
    return [createPMTilesStoreLayer(options)];
  }
  // The source every part draws from, and so the prefix of every id naming one. A caller that
  // points an archive at someone else's source says so here; nothing does today, and forcing
  // `options.id` would have quietly ignored it.
  const archiveSourceId = options.sourceId ?? options.id;

  const parts = new Map<string, string>();
  for (const sourceLayer of options.sourceLayers) {
    const id = `${options.id}-${encodeVectorTileLayerPart(sourceLayer)}`;
    const taken = parts.get(id);
    if (taken === undefined) {
      parts.set(id, sourceLayer);
      continue;
    }
    if (taken === sourceLayer) continue;
    // Two names, one id (`a/b` and `a_2Fb` both encode to `a_2Fb`): the id goes to whichever owns
    // it outright, or the wrong source layer is drawn under it. Re-`set` keeps the key's position,
    // so the folder is not reordered.
    const dropped = encodeVectorTileLayerPart(sourceLayer) === sourceLayer ? taken : sourceLayer;
    if (dropped === taken) parts.set(id, sourceLayer);
    // Said once per archive and name, rather than on every re-read. Serialised rather than joined:
    // both halves can hold a space.
    const seen = JSON.stringify([options.url, dropped]);
    if (!reportedCollisions.has(seen)) {
      reportedCollisions.add(seen);
      console.warn(
        `PMTiles archive "${options.id}": source layer "${dropped}" collides with "${dropped === taken ? sourceLayer : taken}" and is not the project's.`,
      );
    }
  }
  if (parts.size < 2) {
    // Built from `parts` like the split path, so both arms agree on what is drawn and which ids go
    // with it — a dropped collider's would be styled, hidden and removed on this layer's behalf.
    const drawn = [...parts.values()];
    const own = pmtilesIdsForSourceLayers(options.nativeLayerIds ?? [], archiveSourceId, drawn);
    return [
      createPMTilesStoreLayer({
        ...options,
        sourceLayers: drawn,
        // No source layers means nothing to match against and nothing to derive from, so the
        // caller's ids stand or the layer becomes a placeholder.
        nativeLayerIds:
          drawn.length === 0 ? options.nativeLayerIds : own.length > 0 ? own : undefined,
      }),
    ];
  }
  return [...parts].map(([id, sourceLayer]) => {
    // Whichever of the archive's ids draw this source layer: deriving a fresh set would put a
    // second trio over the control's. Empty means nobody has drawn it, so ids are derived below.
    const own = pmtilesIdsForSourceLayers(options.nativeLayerIds ?? [], archiveSourceId, [
      sourceLayer,
    ]);
    return createPMTilesStoreLayer({
      ...options,
      id,
      name: sourceLayer,
      sourceLayers: [sourceLayer],
      // The archive's source, and so the archive's ids: a layer deriving its own would name ids
      // nothing on the map answers to.
      sourceId: archiveSourceId,
      nativeLayerIds: own.length > 0 ? own : undefined,
    });
  });
}

/** Facts about a PMTiles archive needed to build a GeoLibre layer for it. */
export interface PMTilesArchiveInfo {
  tileType: "vector" | "raster";
  /** How the vector tiles are encoded, when the archive is not plain MVT. */
  encoding?: "mvt" | "mlt";
  /** Vector-tile layer ids from the archive metadata (empty for raster). */
  sourceLayers: string[];
  /** `[minLon, minLat, maxLon, maxLat]` from the archive header. */
  bounds: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
}

/** Add the native renderer's explicit extent and zoom limits to each archive part. */
export function createArcgisPMTilesArchiveLayers(
  options: PMTilesStoreLayerOptions & Pick<PMTilesArchiveInfo, "bounds" | "minZoom" | "maxZoom">,
): GeoLibreLayer[] {
  return createPMTilesArchiveLayers(options).map((layer) => ({
    ...layer,
    source: {
      ...layer.source,
      bounds: options.bounds,
      minzoom: options.minZoom,
      maxzoom: options.maxZoom,
    },
    metadata: { ...layer.metadata, bounds: options.bounds },
  }));
}

/**
 * Reads the header (and, for vector archives, the metadata's `vector_layers`) of an in-memory
 * PMTiles archive, so callers can construct a properly-shaped `pmtiles` store layer for it.
 */
export function readPMTilesArchiveInfo(bytes: Uint8Array): Promise<PMTilesArchiveInfo> {
  const file = new File([bytes as BlobPart], "archive.pmtiles", {
    type: "application/octet-stream",
  });
  return readArchive(new PMTiles(new FileSource(file)));
}

/**
 * The same facts for an archive that stays where it is. The header and metadata are range
 * requests, so this costs a few kilobytes rather than the whole file.
 */
export function readRemotePMTilesInfo(
  url: string,
  signal?: AbortSignal,
): Promise<PMTilesArchiveInfo> {
  return readArchive(new PMTiles(signal ? new AbortableSource(url, signal) : url));
}

/**
 * A source's `getBytes` takes a signal, but the header and metadata reads above it never pass one,
 * so a caller's signal has no way in. Wrapping the library's own source carries it down without
 * reimplementing its ETag, 416 and content-length handling.
 */
class AbortableSource implements Source {
  private readonly inner: FetchSource;

  constructor(
    url: string,
    private readonly signal: AbortSignal,
  ) {
    this.inner = new FetchSource(url);
  }

  getKey(): string {
    return this.inner.getKey();
  }

  getBytes(
    offset: number,
    length: number,
    signal?: AbortSignal,
    etag?: string,
  ): Promise<RangeResponse> {
    return this.inner.getBytes(offset, length, signal ?? this.signal, etag);
  }
}

async function readArchive(archive: PMTiles): Promise<PMTilesArchiveInfo> {
  const header = await archive.getHeader();
  // Mvt and Mlt are vector; every other tile type is an image format.
  const encoding = header.tileType === TileType.Mlt ? "mlt" : "mvt";
  const tileType =
    header.tileType === TileType.Mvt || header.tileType === TileType.Mlt ? "vector" : "raster";
  let sourceLayers: string[] = [];
  if (tileType === "vector") {
    try {
      const metadata = (await archive.getMetadata()) as {
        vector_layers?: Array<{ id?: unknown }>;
      };
      sourceLayers = (metadata.vector_layers ?? [])
        .map((layer) => layer.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
    } catch {
      // Metadata is optional; a vector archive without it still renders once the user knows its
      // layer names.
    }
  }
  return {
    tileType,
    ...(encoding === "mlt" ? { encoding } : {}),
    sourceLayers,
    bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
    minZoom: header.minZoom,
    maxZoom: header.maxZoom,
  };
}
