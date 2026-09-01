import type { WhiteboxTool } from "@geolibre/processing";

export const DOWNLOAD_GLOBAL_DEM_TOOL_ID = "download_global_dem";

/** Built-in network tool shown alongside the GeoLibre-authored raster tools. */
export const DOWNLOAD_GLOBAL_DEM_TOOL: WhiteboxTool = {
  id: DOWNLOAD_GLOBAL_DEM_TOOL_ID,
  display_name: "Download Global DEM",
  summary:
    "Download a clipped global elevation model from OpenTopography for the current map view or a bounding box drawn on the map. A free OpenTopography API key is required.",
  category: "Raster",
  taxonomy_category: "Raster",
  source: "geolibre",
  params: [
    {
      name: "dataset",
      description:
        "Global elevation dataset: COP30/COP90 (Copernicus), NASADEM, SRTMGL1 (SRTM 30 m), AW3D30 (ALOS 30 m), or SRTM15Plus (global topography and bathymetry). COP30 is recommended.",
      kind: "enum",
      required: true,
      default: "COP30",
      options: ["COP30", "NASADEM", "SRTMGL1", "COP90", "AW3D30", "SRTM15Plus"],
    },
    {
      name: "bbox",
      description: "WGS84 extent as west,south,east,north.",
      kind: "string",
      required: true,
    },
    {
      name: "bbox_crs",
      description: "Coordinate reference system of the bounding box.",
      kind: "int",
      required: true,
      default: 4326,
    },
    {
      name: "api_key",
      description:
        "Free OpenTopography API key. It is used for this request only and is not saved in processing history or share links.",
      kind: "string",
      required: true,
    },
  ],
  return_type: "raster",
};

/** Add the built-in downloader without duplicating a future runtime implementation. */
export function withGlobalDemTool(tools: WhiteboxTool[]): WhiteboxTool[] {
  return tools.some((tool) => tool.id === DOWNLOAD_GLOBAL_DEM_TOOL_ID)
    ? tools
    : [...tools, DOWNLOAD_GLOBAL_DEM_TOOL];
}

export interface GlobalDemRequest {
  dataset: string;
  bbox: string;
  bboxCrs: number;
  apiKey: string;
  signal?: AbortSignal;
}

/** Domain error whose internal detail must not be rendered without translation. */
export class GlobalDemError extends Error {}

const DATASETS = new Set(
  DOWNLOAD_GLOBAL_DEM_TOOL.params?.find((param) => param.name === "dataset")?.options ?? [],
);

/** Download a clipped GeoTIFF through OpenTopography's Global DEM API. */
export async function downloadGlobalDem(request: GlobalDemRequest): Promise<Uint8Array> {
  if (!DATASETS.has(request.dataset))
    throw new GlobalDemError("Select a supported global DEM dataset.");
  if (request.bboxCrs !== 4326)
    throw new GlobalDemError("The OpenTopography extent must use EPSG:4326.");
  const bounds = request.bbox.split(",").map((value) => Number(value.trim()));
  if (
    bounds.length !== 4 ||
    bounds.some((value) => !Number.isFinite(value)) ||
    bounds[0] < -180 ||
    bounds[2] > 180 ||
    bounds[1] < -90 ||
    bounds[3] > 90 ||
    bounds[0] >= bounds[2] ||
    bounds[1] >= bounds[3]
  ) {
    throw new GlobalDemError("Enter a valid WGS84 extent as west,south,east,north.");
  }
  if (!request.apiKey.trim()) throw new GlobalDemError("Enter your OpenTopography API key.");

  const [west, south, east, north] = bounds;
  const query = new URLSearchParams({
    demtype: request.dataset,
    west: String(west),
    south: String(south),
    east: String(east),
    north: String(north),
    outputFormat: "GTiff",
    API_Key: request.apiKey.trim(),
  });
  const response = await fetch(`https://portal.opentopography.org/API/globaldem?${query}`, {
    signal: request.signal,
  });
  if (!response.ok) {
    // OpenTopography commonly returns a short plain-text explanation. Do not
    // include the request URL because it contains the API key, and redact both
    // forms of the key in case the upstream service or a proxy echoes it.
    const secret = request.apiKey.trim();
    const encodedSecret = encodeURIComponent(secret);
    let detail = (await response.text()).trim().replace(/\s+/g, " ");
    for (const value of new Set([secret, encodedSecret])) {
      detail = detail.replaceAll(value, "[redacted]");
    }
    detail = detail.slice(0, 300);
    throw new GlobalDemError(
      `OpenTopography download failed (HTTP ${response.status})${detail ? `: ${detail}` : "."}`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const littleEndian =
    bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00;
  const bigEndian =
    bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a;
  if (bytes.length < 4 || (!littleEndian && !bigEndian)) {
    throw new GlobalDemError(
      "OpenTopography returned an unexpected response instead of a GeoTIFF.",
    );
  }
  return bytes;
}
