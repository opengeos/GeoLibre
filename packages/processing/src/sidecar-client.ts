const DEFAULT_SIDECAR_URL = "http://127.0.0.1:8765";

export interface SidecarHealth {
  status: string;
}

export interface SidecarAlgorithm {
  id: string;
  name: string;
  description: string;
}

/** Optional Python processing sidecar client — UI works without it. */
export async function checkSidecarHealth(
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<SidecarHealth | null> {
  try {
    const res = await fetch(`${baseUrl}/health`);
    if (!res.ok) return null;
    return (await res.json()) as SidecarHealth;
  } catch {
    return null;
  }
}

export async function fetchSidecarAlgorithms(
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<SidecarAlgorithm[]> {
  try {
    const res = await fetch(`${baseUrl}/algorithms`);
    if (!res.ok) return [];
    const data = (await res.json()) as { algorithms: SidecarAlgorithm[] };
    return data.algorithms ?? [];
  } catch {
    return [];
  }
}

// TODO(v0.5): POST /run with algorithm id and parameters
