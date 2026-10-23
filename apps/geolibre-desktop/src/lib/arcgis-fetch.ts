import type { Channel, invoke as nativeInvoke } from "@tauri-apps/api/core";

interface ArcGISResponse {
  status: number;
  body: string;
  /** An attachment download's bytes, base64-encoded; `body` is then empty. */
  bodyBase64?: string;
  contentType?: string;
}

/** A form-encoded edit, or a multipart attachment upload with its boundary type. */
type ArcGISRequestBody = string | { base64: string; contentType: string };

type ArcGISRequest = (
  url: string,
  signal?: AbortSignal | null,
  body?: ArcGISRequestBody,
) => Promise<ArcGISResponse>;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked so a large file does not overflow the argument limit of apply().
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Serialize a multipart upload the way the browser would send it. */
async function encodeFormData(body: FormData): Promise<{ base64: string; contentType: string }> {
  const encoded = new Response(body);
  const contentType = encoded.headers.get("Content-Type");
  if (!contentType?.startsWith("multipart/form-data")) {
    throw new Error("Could not encode the ArcGIS upload.");
  }
  return { base64: bytesToBase64(new Uint8Array(await encoded.arrayBuffer())), contentType };
}

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
    // A FormData body sets its own multipart type, boundary included.
    const multipart =
      method.toUpperCase() === "POST" && body instanceof FormData && [...headers].length === 0;
    if (
      !post &&
      !multipart &&
      (method.toUpperCase() !== "GET" || body != null || [...headers].length > 0)
    ) {
      throw new Error(
        "Native ArcGIS fetch only supports GET without headers or a body, form-encoded POST, or a FormData upload.",
      );
    }
    const url = input instanceof Request ? input.url : input.toString();
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    let onAbort: (() => void) | undefined;
    try {
      const payload = multipart
        ? await encodeFormData(body as FormData)
        : post
          ? (body as string)
          : undefined;
      signal?.throwIfAborted();
      // Reject promptly while the native cancellation acknowledgement is in flight.
      const pending = request(url, signal, payload);
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
      const content =
        result.bodyBase64 === undefined ? result.body : base64ToBytes(result.bodyBase64);
      return new Response([204, 205, 304].includes(result.status) ? null : content, {
        status: result.status,
        headers: result.contentType ? { "Content-Type": result.contentType } : undefined,
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
        ...(body === undefined
          ? {}
          : typeof body === "string"
            ? { body }
            : { bodyBase64: body.base64, contentType: body.contentType }),
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
