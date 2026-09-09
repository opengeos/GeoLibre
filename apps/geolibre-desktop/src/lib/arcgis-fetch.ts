interface ArcGISResponse {
  status: number;
  body: string;
}

type ArcGISRequest = (url: string) => Promise<ArcGISResponse>;

/** Adapt the guarded GET-only Rust command to ArcGIS's fetch transport. */
export function createNativeArcGISFetch(request: ArcGISRequest): typeof globalThis.fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    let onAbort: (() => void) | undefined;
    try {
      // The blocking Rust request has a 120-second deadline. Cancellation ends
      // the caller's wait immediately; late native results are discarded.
      const pending = request(url);
      const result = signal
        ? await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
              onAbort = () => reject(signal.reason);
              signal.addEventListener("abort", onAbort, { once: true });
              if (signal.aborted) onAbort();
            }),
          ])
        : await pending;
      return new Response([204, 205, 304].includes(result.status) ? null : result.body, {
        status: result.status,
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  };
}

/** Install before project restoration so every ArcGIS REST request uses Rust. */
export async function installNativeArcGISFetch(): Promise<void> {
  const { setArcGISFetch } = await import("@geolibre/plugins");
  const { invoke } = await import("@tauri-apps/api/core");
  setArcGISFetch(
    createNativeArcGISFetch((url) => invoke<ArcGISResponse>("fetch_arcgis_response", { url })),
  );
}
