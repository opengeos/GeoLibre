// Public COG conversion API. Pixel decoding, overview generation and encoding
// run in a disposable Worker in browser/WebView hosts. The inline engine is
// also used by the worker itself and by headless hosts without Web Workers.
import {
  convertGeoTiffToCog as convertInline,
  type ConvertGeoTiffToCogOptions as EncodingOptions,
} from "./cog-convert-engine";
import type { CogConvertRequest, CogConvertResponse } from "./cog-convert.worker";

export {
  initCogWasm,
  readGeoTiffInfo,
  isTiledGeoTiff,
  convertRasterDataToCog,
  COG_WASM_COMPRESSIONS,
  exceedsBrowserCogConversionLimit,
  geoTiffSampleCount,
  LARGE_BROWSER_COG_CONVERSION_SAMPLES,
  MAX_BROWSER_COG_CONVERSION_SAMPLES,
  type CogWasmCompression,
  type ConvertRasterDataToCogOptions,
  type GeoTiffInfo,
} from "./cog-convert-engine";

export interface ConvertGeoTiffToCogOptions extends EncodingOptions {
  /** Terminate the conversion worker immediately on cancellation. */
  signal?: AbortSignal;
  /**
   * Transfer ownership of a whole ArrayBuffer input to the worker, detaching
   * every view of it in this thread. Defaults to false so retained layer bytes
   * and reusable inputs remain valid. Subarrays/shared buffers are always copied.
   */
  transferInput?: boolean;
}

/**
 * Convert a GeoTIFF off the UI thread, preserving the engine's metadata and
 * sample-limit checks. A worker failure rejects rather than retrying expensive
 * synchronous work on the UI thread. Headless hosts without Worker use the
 * inline engine; cancellation there can only be checked before/after encoding.
 */
export async function convertGeoTiffToCog(
  bytes: Uint8Array,
  options: ConvertGeoTiffToCogOptions = {},
): Promise<Uint8Array> {
  const { signal, transferInput, compression, overviews, float64 } = options;
  signal?.throwIfAborted();
  if (typeof Worker === "undefined") {
    const result = await convertInline(bytes, {
      compression,
      overviews,
      float64,
    });
    signal?.throwIfAborted();
    return result;
  }

  const worker = new Worker(new URL("./cog-convert.worker.ts", import.meta.url), {
    type: "module",
  });
  return new Promise<Uint8Array>((resolve, reject) => {
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const abort = () =>
      fail(signal?.reason ?? new DOMException("Conversion cancelled.", "AbortError"));
    worker.onmessage = (event: MessageEvent<CogConvertResponse>) => {
      cleanup();
      if (event.data.ok) resolve(event.data.bytes);
      else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fail(new Error(event.message || "COG conversion worker failed."));
    };
    worker.onmessageerror = () => fail(new Error("Could not read COG conversion worker response."));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    try {
      // Preserve the exact view range and never detach unrelated data sharing
      // the buffer. Every payload crossing threads owns its own ArrayBuffer.
      const input =
        transferInput &&
        bytes.buffer instanceof ArrayBuffer &&
        bytes.byteOffset === 0 &&
        bytes.byteLength === bytes.buffer.byteLength
          ? bytes
          : new Uint8Array(bytes);
      worker.postMessage(
        {
          bytes: input,
          options: {
            compression,
            overviews,
            ...(float64 === undefined ? {} : { float64 }),
          },
        } satisfies CogConvertRequest,
        [input.buffer as ArrayBuffer],
      );
    } catch (error) {
      fail(error);
    }
  });
}
