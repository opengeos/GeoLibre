import { addProtocol, type RequestParameters } from "maplibre-gl";
import { ungzip } from "pako";

const COMTILES_PROTOCOL = "comt";
const INITIAL_CHUNK_SIZE = 2 ** 19;
const METADATA_OFFSET_INDEX = 17;
const DEFAULT_TILE_OFFSET_BYTES = 5;
const TILE_SIZE_BYTES = 4;
const SUPPORTED_TILE_MATRIX_CRS = "WebMercatorQuad";
const SUPPORTED_ORDERING = "RowMajor";

let protocolRegistered = false;
const archiveCaches = new Map<string, ComtilesArchive>();

interface TileMatrixLimits {
  maxTileCol: number;
  maxTileRow: number;
  minTileCol: number;
  minTileRow: number;
}

interface TileMatrix {
  aggregationCoefficient: number;
  tileMatrixLimits: TileMatrixLimits;
  zoom: number;
}

interface ComtilesMetadata {
  tileFormat: string;
  tileOffsetBytes?: number;
  tileMatrixSet: {
    fragmentOrdering?: string;
    tileMatrix: TileMatrix[];
    tileMatrixCRS?: string;
    tileOrdering?: string;
  };
}

interface Header {
  dataOffset: number;
  indexOffset: number;
  metadata: ComtilesMetadata;
  partialIndex: ArrayBuffer;
}

interface IndexEntry {
  offset: number;
  size: number;
}

interface FragmentRange {
  endOffset: number;
  index: number;
  startOffset: number;
}

interface TileIndex {
  x: number;
  y: number;
  z: number;
}

export function comtilesTileUrl(url: string): string {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) return "";
  if (trimmedUrl.startsWith(`${COMTILES_PROTOCOL}://`)) return trimmedUrl;
  return `${COMTILES_PROTOCOL}://tile/{z}/{x}/{y}?url=${encodeURIComponent(
    trimmedUrl,
  )}`;
}

export function registerComtilesProtocol(): void {
  if (protocolRegistered) return;

  addProtocol(COMTILES_PROTOCOL, async (request, abortController) => {
    const { archiveUrl, x, y, z } = parseComtilesTileRequest(request);
    let archive = archiveCaches.get(archiveUrl);
    if (!archive) {
      archive = new ComtilesArchive(archiveUrl);
      archiveCaches.set(archiveUrl, archive);
    }

    return {
      data: await archive.getTile({ x, y, z }, abortController.signal),
    };
  });

  protocolRegistered = true;
}

function parseComtilesTileRequest(request: RequestParameters): {
  archiveUrl: string;
  x: number;
  y: number;
  z: number;
} {
  const url = new URL(request.url);
  const encodedArchiveUrl = url.searchParams.get("url");
  if (encodedArchiveUrl) {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 3) {
      throw new Error("Invalid COMTiles tile URL.");
    }
    return {
      archiveUrl: encodedArchiveUrl,
      z: parseTileCoordinate(parts[0], "z"),
      x: parseTileCoordinate(parts[1], "x"),
      y: parseTileCoordinate(parts[2], "y"),
    };
  }

  const match = request.url.match(
    /^comt:\/\/(.+)\/(\d+)\/(\d+)\/(\d+)(?:[?#].*)?$/,
  );
  if (!match) {
    throw new Error("Invalid COMTiles tile URL.");
  }

  return {
    archiveUrl: match[1],
    z: parseTileCoordinate(match[2], "z"),
    x: parseTileCoordinate(match[3], "x"),
    y: parseTileCoordinate(match[4], "y"),
  };
}

function parseTileCoordinate(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid COMTiles ${label} coordinate.`);
  }
  return parsed;
}

class ComtilesArchive {
  private header: Header | null = null;
  private headerLoad: Promise<Header> | null = null;
  private indexCache: ComtilesIndexCache | null = null;
  private index: ComtilesIndex | null = null;
  private readonly requestCache = new Map<number, Promise<ArrayBuffer>>();

  constructor(private readonly url: string) {}

  async getTile(tile: TileIndex, signal?: AbortSignal): Promise<ArrayBuffer> {
    const entry = await this.getIndexEntry(tile, signal);
    if (!entry || entry.indexEntry.size === 0) {
      return new Uint8Array(0).buffer;
    }

    const compressedTile = await fetchBinaryRange(
      this.url,
      entry.absoluteTileOffset,
      entry.absoluteTileOffset + entry.indexEntry.size - 1,
      signal,
    );
    return uint8ArrayToArrayBuffer(ungzip(new Uint8Array(compressedTile)));
  }

  private async getIndexEntry(
    tile: TileIndex,
    signal?: AbortSignal,
  ): Promise<
    | {
        absoluteTileOffset: number;
        indexEntry: IndexEntry;
      }
    | undefined
  > {
    const header = await this.ensureHeader(signal);
    const matrix = header.metadata.tileMatrixSet.tileMatrix.find(
      (item) => item.zoom === tile.z,
    );
    if (!matrix) return undefined;

    const tmsY = (1 << tile.z) - tile.y - 1;
    const limit = matrix.tileMatrixLimits;
    if (
      tile.x < limit.minTileCol ||
      tile.x > limit.maxTileCol ||
      tmsY < limit.minTileRow ||
      tmsY > limit.maxTileRow
    ) {
      return undefined;
    }

    const tmsTile = { x: tile.x, y: tmsY, z: tile.z };
    const indexEntry =
      this.indexCache?.get(tmsTile) ?? (await this.fetchIndexEntry(tmsTile, signal));
    return {
      absoluteTileOffset: header.dataOffset + indexEntry.offset,
      indexEntry,
    };
  }

  private async fetchIndexEntry(
    tile: TileIndex,
    signal?: AbortSignal,
  ): Promise<IndexEntry> {
    if (!this.header || !this.index || !this.indexCache) {
      throw new Error("COMTiles archive header is not loaded.");
    }

    const fragmentRange = this.index.getFragmentRangeForTile(tile.z, tile.x, tile.y);
    let indexFragment = this.requestCache.get(fragmentRange.startOffset);
    if (!indexFragment) {
      indexFragment = fetchBinaryRange(
        this.url,
        this.header.indexOffset + fragmentRange.startOffset,
        this.header.indexOffset + fragmentRange.endOffset,
        signal,
      );
      this.requestCache.set(fragmentRange.startOffset, indexFragment);
      indexFragment.finally(() => {
        this.requestCache.delete(fragmentRange.startOffset);
      });
    }

    this.indexCache.setIndexFragment(
      fragmentRange,
      new Uint8Array(await indexFragment),
    );
    const entry = this.indexCache.get(tile);
    if (!entry) {
      throw new Error("COMTiles index entry could not be read.");
    }
    return entry;
  }

  private async ensureHeader(signal?: AbortSignal): Promise<Header> {
    if (this.header) return this.header;
    this.headerLoad ??= loadHeader(this.url, signal);
    this.header = await this.headerLoad;
    this.indexCache = new ComtilesIndexCache(
      this.header.metadata,
      new Uint8Array(this.header.partialIndex),
    );
    this.index = new ComtilesIndex(this.header.metadata);
    return this.header;
  }
}

class ComtilesIndexCache {
  private readonly fragmentedIndex = new LruCache<
    number,
    { fragmentRange: FragmentRange; indexEntries: Uint8Array }
  >(28);
  private readonly index: ComtilesIndex;
  private readonly indexEntryByteLength: number;

  constructor(
    private readonly metadata: ComtilesMetadata,
    private readonly partialIndex = new Uint8Array(0),
  ) {
    this.index = new ComtilesIndex(metadata);
    this.indexEntryByteLength = getIndexEntryByteLength(metadata);
  }

  get(tile: TileIndex): IndexEntry | undefined {
    const { index } = this.index.calculateIndexOffsetForTile(
      tile.z,
      tile.x,
      tile.y,
    );
    const { startOffset } = this.index.getFragmentRangeForTile(
      tile.z,
      tile.x,
      tile.y,
    );
    const indexOffset = index * this.indexEntryByteLength;
    if (indexOffset <= this.partialIndex.byteLength - this.indexEntryByteLength) {
      return this.createIndexEntry(indexOffset, this.partialIndex);
    }

    const indexFragment = this.fragmentedIndex.get(startOffset);
    if (!indexFragment) return undefined;

    const relativeFragmentOffset =
      (index - indexFragment.fragmentRange.index) * this.indexEntryByteLength;
    return this.createIndexEntry(relativeFragmentOffset, indexFragment.indexEntries);
  }

  setIndexFragment(fragmentRange: FragmentRange, indexEntries: Uint8Array): void {
    this.fragmentedIndex.put(fragmentRange.startOffset, {
      fragmentRange,
      indexEntries,
    });
  }

  private createIndexEntry(
    indexOffset: number,
    indexEntries: Uint8Array,
  ): IndexEntry {
    const offsetBytes = this.metadata.tileOffsetBytes ?? DEFAULT_TILE_OFFSET_BYTES;
    return {
      offset: readUnsignedLittleEndian(indexEntries.buffer, indexOffset, offsetBytes),
      size: new DataView(indexEntries.buffer).getUint32(
        indexOffset + offsetBytes,
        true,
      ),
    };
  }
}

class ComtilesIndex {
  private readonly indexEntryByteLength: number;
  private readonly tileMatrixSet: ComtilesMetadata["tileMatrixSet"];

  constructor(private readonly metadata: ComtilesMetadata) {
    this.tileMatrixSet = metadata.tileMatrixSet;
    this.indexEntryByteLength = getIndexEntryByteLength(metadata);
  }

  getFragmentRangeForTile(zoom: number, x: number, y: number): FragmentRange {
    const tileMatrices = this.tileMatrixSet.tileMatrix.filter(
      (tileMatrix) => tileMatrix.zoom <= zoom,
    );

    let startIndex = 0;
    let endIndex = 0;
    for (const tileMatrix of tileMatrices) {
      const limit = tileMatrix.tileMatrixLimits;
      if (tileMatrix.zoom === zoom && !isInRange(x, y, limit)) {
        throw new Error("Specified tile index is not part of the COMTiles archive.");
      }

      if (tileMatrix.zoom < zoom) {
        startIndex += countTiles(limit);
        continue;
      }

      const fragmentBounds = calculateFragmentBounds(
        x,
        y,
        tileMatrix.aggregationCoefficient,
        limit,
      );
      startIndex += countIndexEntriesBeforeFragment(fragmentBounds, limit);
      endIndex = startIndex + countTiles(fragmentBounds) - 1;
    }

    return {
      endOffset: (endIndex + 1) * this.indexEntryByteLength,
      index: startIndex,
      startOffset: startIndex * this.indexEntryByteLength,
    };
  }

  calculateIndexOffsetForTile(
    zoom: number,
    x: number,
    y: number,
  ): { index: number; offset: number } {
    const offset = this.tileMatrixSet.tileMatrix
      .filter((tileMatrix) => tileMatrix.zoom <= zoom)
      .reduce((currentOffset, tileMatrix) => {
        const limit = tileMatrix.tileMatrixLimits;
        if (tileMatrix.zoom === zoom && !isInRange(x, y, limit)) {
          throw new Error("Specified tile index is not part of the COMTiles archive.");
        }

        if (tileMatrix.zoom < zoom) {
          return currentOffset + countTiles(limit) * this.indexEntryByteLength;
        }

        if (tileMatrix.aggregationCoefficient === -1) {
          const rowCount = y - limit.minTileRow;
          const columnCount = limit.maxTileCol - limit.minTileCol + 1;
          const columnDelta = x - limit.minTileCol;
          return (
            currentOffset +
            (rowCount > 0 ? rowCount * columnCount + columnDelta : columnDelta) *
              this.indexEntryByteLength
          );
        }

        const fragmentBounds = calculateFragmentBounds(
          x,
          y,
          tileMatrix.aggregationCoefficient,
          limit,
        );
        const entriesBeforeFragment = countIndexEntriesBeforeFragment(
          fragmentBounds,
          limit,
        );
        const fullRows =
          (y - fragmentBounds.minTileRow) *
          (fragmentBounds.maxTileCol - fragmentBounds.minTileCol + 1);
        const partialRow = x - fragmentBounds.minTileCol;
        return (
          currentOffset +
          (entriesBeforeFragment + fullRows + partialRow) *
            this.indexEntryByteLength
        );
      }, 0);

    return {
      index: offset / this.indexEntryByteLength,
      offset,
    };
  }
}

class LruCache<K, V> {
  private readonly values = new Map<K, V>();

  constructor(private readonly maxEntries: number) {}

  get(key: K): V | undefined {
    if (!this.values.has(key)) return undefined;
    const value = this.values.get(key);
    this.values.delete(key);
    if (value !== undefined) this.values.set(key, value);
    return value;
  }

  put(key: K, value: V): void {
    if (this.values.size >= this.maxEntries) {
      const keyToDelete = this.values.keys().next().value;
      if (keyToDelete !== undefined) this.values.delete(keyToDelete);
    }
    this.values.set(key, value);
  }
}

async function loadHeader(url: string, signal?: AbortSignal): Promise<Header> {
  const buffer = await fetchBinaryRange(url, 0, INITIAL_CHUNK_SIZE - 1, signal);
  const view = new DataView(buffer);
  const version = view.getUint32(4, true);
  if (version !== 1) {
    throw new Error("The specified COMTiles archive version is not supported.");
  }

  const metadataSize = view.getUint32(8, true);
  const indexSize = readUnsignedLittleEndian(buffer, 12, DEFAULT_TILE_OFFSET_BYTES);
  const indexOffset = METADATA_OFFSET_INDEX + metadataSize;
  const metadataDocument = new TextDecoder().decode(
    buffer.slice(METADATA_OFFSET_INDEX, indexOffset),
  );
  const metadata = JSON.parse(metadataDocument) as ComtilesMetadata;
  const indexEntryByteLength = getIndexEntryByteLength(metadata);
  const completeIndexEntries = Math.floor(
    (INITIAL_CHUNK_SIZE - indexOffset) / indexEntryByteLength,
  );
  validateMetadata(metadata, completeIndexEntries);

  const partialIndexEnd = Math.min(
    buffer.byteLength,
    indexOffset + completeIndexEntries * indexEntryByteLength,
  );
  return {
    dataOffset: indexOffset + indexSize,
    indexOffset,
    metadata,
    partialIndex: buffer.slice(indexOffset, partialIndexEnd),
  };
}

function validateMetadata(
  metadata: ComtilesMetadata,
  downloadedUnfragmentedIndexEntries: number,
): void {
  if (metadata.tileFormat !== "pbf") {
    throw new Error("Only COMTiles archives with pbf vector tiles are supported.");
  }

  const tileMatrixSet = metadata.tileMatrixSet;
  for (const ordering of [
    tileMatrixSet.fragmentOrdering,
    tileMatrixSet.tileOrdering,
  ]) {
    if (ordering !== undefined && ordering !== SUPPORTED_ORDERING) {
      throw new Error(`Only ${SUPPORTED_ORDERING} COMTiles ordering is supported.`);
    }
  }

  if (
    tileMatrixSet.tileMatrixCRS !== undefined &&
    tileMatrixSet.tileMatrixCRS.trim().toLowerCase() !==
      SUPPORTED_TILE_MATRIX_CRS.toLowerCase()
  ) {
    throw new Error(`Only ${SUPPORTED_TILE_MATRIX_CRS} COMTiles are supported.`);
  }

  const unfragmentedIndexEntries = tileMatrixSet.tileMatrix
    .filter((tileMatrix) => tileMatrix.aggregationCoefficient === -1)
    .reduce(
      (total, tileMatrix) => total + countTiles(tileMatrix.tileMatrixLimits),
      0,
    );
  if (unfragmentedIndexEntries > downloadedUnfragmentedIndexEntries) {
    throw new Error(
      "The COMTiles unfragmented index is larger than the initial chunk.",
    );
  }
}

async function fetchBinaryRange(
  url: string,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetch(url, {
    headers: { range: `bytes=${start}-${end}` },
    signal,
  });
  if (!response.ok) {
    throw new Error(`COMTiles request failed with status ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  if (response.status === 200 && buffer.byteLength > end - start + 1) {
    return buffer.slice(start, end + 1);
  }
  return buffer;
}

function calculateFragmentBounds(
  x: number,
  y: number,
  aggregationCoefficient: number,
  limit: TileMatrixLimits,
): TileMatrixLimits {
  if (aggregationCoefficient === -1) return limit;

  const tilesPerSide = 2 ** aggregationCoefficient;
  const minTileCol = Math.floor(x / tilesPerSide) * tilesPerSide;
  const minTileRow = Math.floor(y / tilesPerSide) * tilesPerSide;
  return {
    maxTileCol: Math.min(limit.maxTileCol, minTileCol + tilesPerSide - 1),
    maxTileRow: Math.min(limit.maxTileRow, minTileRow + tilesPerSide - 1),
    minTileCol: Math.max(limit.minTileCol, minTileCol),
    minTileRow: Math.max(limit.minTileRow, minTileRow),
  };
}

function countIndexEntriesBeforeFragment(
  fragmentBounds: TileMatrixLimits,
  limit: TileMatrixLimits,
): number {
  const left =
    (fragmentBounds.minTileCol - limit.minTileCol) *
    (fragmentBounds.maxTileRow - limit.minTileRow + 1);
  const lower =
    (limit.maxTileCol - fragmentBounds.minTileCol + 1) *
    (fragmentBounds.minTileRow - limit.minTileRow);
  return left + lower;
}

function countTiles(limit: TileMatrixLimits): number {
  return (
    (limit.maxTileCol - limit.minTileCol + 1) *
    (limit.maxTileRow - limit.minTileRow + 1)
  );
}

function getIndexEntryByteLength(metadata: ComtilesMetadata): number {
  return (metadata.tileOffsetBytes ?? DEFAULT_TILE_OFFSET_BYTES) + TILE_SIZE_BYTES;
}

function isInRange(x: number, y: number, limit: TileMatrixLimits): boolean {
  return (
    x >= limit.minTileCol &&
    x <= limit.maxTileCol &&
    y >= limit.minTileRow &&
    y <= limit.maxTileRow
  );
}

function readUnsignedLittleEndian(
  buffer: ArrayBufferLike,
  offset: number,
  byteLength: number,
): number {
  const bytes = new Uint8Array(buffer, offset, byteLength);
  return bytes.reduceRight((value, byte) => value * 256 + byte, 0);
}

function uint8ArrayToArrayBuffer(array: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(array.byteLength);
  copy.set(array);
  return copy.buffer;
}
