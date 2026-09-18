import type { Channel, invoke as nativeInvoke } from "@tauri-apps/api/core";

interface ArcGISResponse {
  status: number;
  body: string;
}

type ArcGISRequest = (
  url: string,
  signal?: AbortSignal | null,
  body?: string,
) => Promise<ArcGISResponse>;

/** Adapt the guarded Rust command to ArcGIS's fetch transport. */
export function createNativeArcGISFetch(request: ArcGISRequest): typeof globalThis.fetch {
  return async (input, init) => {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const body = init?.body ?? (input instanceof Request ? input.body : null);
    const post =
      method.toUpperCase() === "POST" &&
      typeof body === "string" &&
      headers.get("Content-Type") === "application/x-www-form-urlencoded" &&
      [...headers].length === 1;
    if (!post && (method.toUpperCase() !== "GET" || body != null || [...headers].length > 0)) {
      throw new Error(
        "Native ArcGIS fetch only supports GET without headers or a body, or form-encoded POST.",
      );
    }
    const url = input instanceof Request ? input.url : input.toString();
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    let onAbort: (() => void) | undefined;
    try {
      // Reject promptly while the native cancellation acknowledgement is in flight.
      const pending = request(url, signal, post ? (body as string) : undefined);
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

/** Coordinate native cancellation, including aborts before Rust registers the request. */
export function createArcGISRequest(
  invoke: typeof nativeInvoke,
  createReady: () => Pick<Channel<void>, "onmessage">,
): ArcGISRequest {
  return async (url, signal, body) => {
    signal?.throwIfAborted();
    const requestId = crypto.randomUUID();
    const ready = createReady();
    let registered = false;
    const onAbort = () => {
      if (registered) {
        void invoke("cancel_arcgis_request", { requestId }).catch((error: unknown) => {
          console.error("[GeoLibre] Failed to cancel native ArcGIS request", error);
        });
      }
    };
    ready.onmessage = () => {
      registered = true;
      if (signal?.aborted) onAbort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await invoke<ArcGISResponse>("fetch_arcgis_response", {
        url,
        requestId,
        ready,
        ...(body === undefined ? {} : { body }),
      });
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

/** Install before project restoration so every ArcGIS REST request uses Rust. */
export async function installNativeArcGISFetch(): Promise<void> {
  const { setArcGISFetch } = await import("@geolibre/plugins");
  const { invoke, Channel } = await import("@tauri-apps/api/core");
  setArcGISFetch(createNativeArcGISFetch(createArcGISRequest(invoke, () => new Channel<void>())));
}
