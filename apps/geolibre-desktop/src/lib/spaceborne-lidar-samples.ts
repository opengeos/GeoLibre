import type { SpaceborneLidarField } from "@geolibre/plugins";

/** Sample granules on Source Cooperative (CORS-enabled), one per product. */
export const SAMPLE_BASE_URL = "https://data.source.coop/opengeos/geolibre/spaceborne-lidar";
export const SAMPLES = [
  { labelKey: "sampleAtl06", file: "ATL06_20230629230240_01492006_007_01.h5" },
  { labelKey: "sampleAtl08", file: "ATL08_20230629230240_01492006_007_01.h5" },
  { labelKey: "sampleGediL2a", file: "GEDI02_A_2022158224411_O19743_03_T10532_02_004_02_V003.h5" },
  { labelKey: "sampleGediL2b", file: "GEDI02_B_2022158224411_O19743_03_T10532_02_003_01_V002.h5" },
  { labelKey: "sampleGediL4a", file: "GEDI04_A_2022158224411_O19743_03_T10532_02_003_01_V002.h5" },
] as const;

/**
 * Download a file into memory, reporting progress as a 0-100 percentage when
 * the server sends a length.
 *
 * @param url The file URL.
 * @param signal Aborts the download.
 * @param onProgress Called with the percentage received so far.
 * @returns The file's bytes.
 * @throws If the request fails or is aborted.
 */
export async function downloadWithProgress(
  url: string,
  signal: AbortSignal,
  onProgress: (percent: number) => void,
): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
  const total = Number(response.headers.get("content-length")) || 0;
  // A compressed response announces the encoded length but streams decoded
  // bytes, so the preallocated buffer would be too small.
  const encoding = response.headers.get("content-encoding");
  if (!response.body || total === 0 || (encoding && encoding !== "identity")) {
    return response.arrayBuffer();
  }
  // Preallocate so a multi-gigabyte granule is not held twice while chunks
  // are concatenated.
  const bytes = new Uint8Array(total);
  const reader = response.body.getReader();
  let received = 0;
  let lastPercent = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.length > total) throw new Error("Received more bytes than announced.");
    bytes.set(value, received);
    received += value.length;
    const percent = Math.floor((received / total) * 100);
    if (percent !== lastPercent) {
      lastPercent = percent;
      onProgress(percent);
    }
  }
  return received === total ? bytes.buffer : bytes.slice(0, received).buffer;
}

/** Distinct key for a field, since GEDI `rh` yields several columns of one path. */
export function fieldKey(field: Pick<SpaceborneLidarField, "path" | "column">): string {
  return field.column === undefined ? field.path : `${field.path}[${field.column}]`;
}

/** The base file name without its directory or extension. */
export function baseName(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return name.replace(/\.(h5|hdf5|he5)$/i, "");
}
