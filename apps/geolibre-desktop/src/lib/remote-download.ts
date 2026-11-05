/**
 * Plugin-facing large-file downloads through the desktop app's native
 * `download_remote_file` command (`src-tauri/src/remote_download.rs`): no
 * CORS, no size cap, streamed to disk. A "save" download goes where the user
 * picks in a native dialog; a "memory" download is parked in the app cache and
 * read back once with `take_cached_download`, which deletes it.
 */

import type { Channel, invoke as nativeInvoke } from "@tauri-apps/api/core";
import type {
  GeoLibreRemoteDownloadOptions,
  GeoLibreRemoteDownloadResult,
  GeoLibreWriteFileResult,
} from "@geolibre/plugins";

/** Progress the native command reports while it streams. */
export interface RemoteDownloadProgress {
  received: number;
  total: number | null;
}

interface NativeRemoteDownloadResult {
  path: string | null;
  size: number;
}

/**
 * Build the app API's `downloadRemoteFile`.
 *
 * @param invoke - Tauri's `invoke`.
 * @param createChannel - Creates the progress channel.
 * @returns The download function.
 */
export function createRemoteDownload(
  invoke: typeof nativeInvoke,
  createChannel: () => Pick<Channel<RemoteDownloadProgress>, "onmessage">,
): (
  url: string,
  options: GeoLibreRemoteDownloadOptions,
) => Promise<GeoLibreRemoteDownloadResult | null> {
  return async (url, options) => {
    const { signal } = options;
    signal?.throwIfAborted();
    // Plugins may be plain JavaScript, so check what the type promises.
    if (options.target === "folder" && !options.folderId) {
      throw new TypeError("A folder download needs the folderId from pickDownloadFolder.");
    }
    const requestId = crypto.randomUUID();
    const progress = createChannel();
    // Rust registers the download (and so can cancel it) just before its first
    // progress message; an abort that lands earlier is replayed then.
    let registered = false;
    const cancel = () => {
      void invoke("cancel_remote_download", { requestId }).catch((error: unknown) => {
        console.error("[GeoLibre] Failed to cancel a native download", error);
      });
    };
    let rejectOnAbort: ((reason: unknown) => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectOnAbort = reject;
    });
    // Rejected without a handler when the download finishes first; keep that quiet.
    aborted.catch(() => undefined);
    const onAbort = () => {
      if (registered) cancel();
      // Settle now even while the save dialog is still open (Rust cannot be
      // reached until it registers); the cancel is replayed on registration.
      rejectOnAbort?.(signal?.reason);
    };
    progress.onmessage = (message) => {
      if (!registered) {
        registered = true;
        if (signal?.aborted) cancel();
      }
      options.onProgress?.(message.received, message.total ?? null);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let result: NativeRemoteDownloadResult | null;
    try {
      result = await Promise.race([
        invoke<NativeRemoteDownloadResult | null>("download_remote_file", {
          request: {
            url,
            headers: Object.entries(options.headers ?? {}),
            fileName: options.fileName,
            save: options.target === "save",
            ...(options.target === "folder" ? { folderId: options.folderId } : {}),
          },
          requestId,
          progress,
        }),
        aborted,
      ]);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    if (!result) return null;
    if (options.target !== "memory") return { path: result.path, size: result.size, data: null };
    const data = await invoke<ArrayBuffer>("take_cached_download", { requestId });
    return { path: null, size: result.size, data };
  };
}

/** Maximum payload size supported by writeFileToFolder (50 MiB). */
export const MAX_WRITE_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Normalize arbitrary file data (string, Blob, ArrayBuffer, ArrayBufferView) into
 * the bytes sent to the native command. They go as a raw request body: as a JSON
 * number array they cost the main thread ~80 ms per MB, and the text is 3.6x larger.
 */
export async function normalizeBinaryData(
  data: string | Uint8Array | ArrayBuffer | Blob,
): Promise<Uint8Array> {
  let bytes: Uint8Array;
  if (typeof data === "string") {
    bytes = new TextEncoder().encode(data);
  } else if (data instanceof Blob) {
    if (data.size > MAX_WRITE_FILE_BYTES) {
      throw new RangeError(
        `writeFileToFolder data exceeds the 50 MiB limit (received ${data.size} bytes).`,
      );
    }
    bytes = new Uint8Array(await data.arrayBuffer());
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data.slice(0)); // a copy: the caller may reuse its buffer
  } else if (ArrayBuffer.isView(data)) {
    bytes = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  } else {
    throw new TypeError(
      "Unsupported data type for writeFileToFolder; expected string, Blob, ArrayBuffer, or ArrayBufferView.",
    );
  }
  if (bytes.byteLength > MAX_WRITE_FILE_BYTES) {
    throw new RangeError(
      `writeFileToFolder data exceeds the 50 MiB limit (received ${bytes.byteLength} bytes).`,
    );
  }
  return bytes;
}

/**
 * Build the app API's `writeFileToFolder`.
 *
 * @param invoke - Tauri's `invoke`.
 * @returns The write function.
 */
export function createWriteFileToFolder(
  invoke: typeof nativeInvoke,
): (
  folderId: string,
  fileName: string,
  data: string | Uint8Array | ArrayBuffer | Blob,
  options?: { subfolder?: string },
) => Promise<GeoLibreWriteFileResult> {
  return async (folderId, fileName, data, options) => {
    if (!folderId || typeof folderId !== "string") {
      throw new TypeError("writeFileToFolder requires a valid folderId from pickDownloadFolder.");
    }
    if (!fileName || typeof fileName !== "string") {
      throw new TypeError("writeFileToFolder requires a non-empty fileName.");
    }
    const bytes = await normalizeBinaryData(data);
    // Raw body, so the names travel as headers; percent-encoded, as headers carry only ASCII.
    return invoke<GeoLibreWriteFileResult>("write_file_to_folder", bytes, {
      headers: {
        "x-folder-id": encodeURIComponent(folderId),
        "x-file-name": encodeURIComponent(fileName),
        ...(typeof options?.subfolder === "string"
          ? { "x-subfolder": encodeURIComponent(options.subfolder) }
          : {}),
      },
    });
  };
}
