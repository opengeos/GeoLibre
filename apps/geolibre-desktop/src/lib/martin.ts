import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./tauri-io";

export interface MartinBinaryInfo {
  path: string;
  downloaded: boolean;
}

export interface MartinServerInfo {
  baseUrl: string;
  binaryPath: string;
  port: number;
}

export interface MartinCatalogTile {
  name?: string;
  content_type?: string;
  contentType?: string;
}

export interface MartinCatalog {
  tiles?: Record<string, MartinCatalogTile>;
}

export interface MartinVectorLayer {
  id: string;
  fields?: Record<string, string>;
  description?: string;
  minzoom?: number;
  maxzoom?: number;
}

export interface MartinTileJson {
  name?: string;
  description?: string;
  bounds?: [number, number, number, number];
  center?: [number, number, number];
  minzoom?: number;
  maxzoom?: number;
  vector_layers?: MartinVectorLayer[];
  vectorLayers?: MartinVectorLayer[];
}

export interface MartinSourceSummary {
  id: string;
  name: string;
  contentType: string;
}

export async function ensureMartinBinary(): Promise<MartinBinaryInfo> {
  assertTauri();
  return invoke<MartinBinaryInfo>("ensure_martin_binary");
}

export async function startMartinServer(options: {
  connectionString: string;
  defaultSrid?: string;
}): Promise<MartinServerInfo> {
  assertTauri();
  return invoke<MartinServerInfo>("start_martin_server", {
    connectionString: options.connectionString,
    defaultSrid: options.defaultSrid?.trim() || null,
  });
}

export async function stopMartinServer(): Promise<void> {
  assertTauri();
  await invoke("stop_martin_server");
}

export async function fetchMartinCatalog(server: MartinServerInfo): Promise<MartinSourceSummary[]> {
  const response = await fetch(`${server.baseUrl}/catalog`);
  if (!response.ok) {
    throw new Error(`Martin catalog request failed with status ${response.status}.`);
  }

  const catalog = (await response.json()) as MartinCatalog;
  return Object.entries(catalog.tiles ?? {})
    .map(([id, tile]) => ({
      id,
      name: tile.name?.trim() || id,
      contentType: tile.contentType ?? tile.content_type ?? "",
    }))
    .filter((source) => isVectorTileContentType(source.contentType))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchMartinTileJson(
  server: MartinServerInfo,
  sourceId: string,
): Promise<MartinTileJson> {
  const response = await fetch(martinTileJsonUrl(server, sourceId));
  if (!response.ok) {
    throw new Error(`Martin TileJSON request failed with status ${response.status}.`);
  }
  return (await response.json()) as MartinTileJson;
}

export function martinTileJsonUrl(server: MartinServerInfo, sourceId: string): string {
  return `${server.baseUrl}/${encodeURIComponent(sourceId)}`;
}

function assertTauri(): void {
  if (!isTauri()) {
    throw new Error("PostgreSQL layers require GeoLibre Desktop.");
  }
}

function isVectorTileContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return normalized.includes("protobuf") || normalized.includes("mapbox-vector-tile");
}
