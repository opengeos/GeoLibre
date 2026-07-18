import { isTauri } from "./tauri-io";
import { invoke } from "@tauri-apps/api/core";
import { addProtocol, type RequestParameters } from "maplibre-gl";

const MBTILES_PROTOCOL = "geolibre-mbtiles";

let protocolRegistered = false;

export interface MbtilesMetadata {
  name: string;
  format: string;
  tileType: "raster" | "vector";
  sourceLayers: string[];
  minZoom?: number | null;
  maxZoom?: number | null;
  bounds?: [number, number, number, number] | null;
  center?: [number, number, number] | null;
  scheme: string;
}

export function mbtilesTileUrl(path: string): string {
  return `${MBTILES_PROTOCOL}://tile/{z}/{x}/{y}?path=${encodeURIComponent(path)}`;
}

export async function readMbtilesMetadata(path: string): Promise<MbtilesMetadata> {
  if (!isTauri()) {
    throw new Error("MBTiles files require GeoLibre Desktop.");
  }

  return invoke<MbtilesMetadata>("read_mbtiles_metadata", { path });
}

export function registerMbtilesProtocol(): void {
  if (protocolRegistered) return;

  addProtocol(MBTILES_PROTOCOL, async (request) => {
    const params = parseMbtilesTileRequest(request);
    const bytes = await invoke<number[] | Uint8Array>("read_mbtiles_tile", params);
    const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return {
      data: array.buffer.slice(array.byteOffset, array.byteOffset + array.byteLength),
    };
  });
  protocolRegistered = true;
}

function parseMbtilesTileRequest(request: RequestParameters): {
  path: string;
  z: number;
  x: number;
  y: number;
} {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 3) {
    throw new Error("Invalid MBTiles tile URL.");
  }
  const path = url.searchParams.get("path");
  if (!path) {
    throw new Error("Invalid MBTiles tile path.");
  }

  return {
    path,
    z: parseTileCoordinate(parts[0], "z"),
    x: parseTileCoordinate(parts[1], "x"),
    y: parseTileCoordinate(parts[2], "y"),
  };
}

function parseTileCoordinate(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid MBTiles ${label} coordinate.`);
  }
  return parsed;
}
