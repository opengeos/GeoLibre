import {
  ObiaError,
  polygonizeLabels,
  type ObiaImage,
  type ObiaRunOptions,
  type ObiaSegmentation,
} from "./obia";
import {
  OBIA_FELZENSZWALB_MAX_PIXELS,
  felzenszwalbLabels,
  type ObiaFelzenszwalbParams,
} from "./obia-felzenszwalb";
import type {
  FelzenszwalbWorkerRequest,
  FelzenszwalbWorkerResponse,
} from "./obia-felzenszwalb.worker";
import { encodeLabelGrid } from "./obia-hierarchy";
import { readRasterData } from "./raster-client";

/** The provenance tool id of a browser Felzenszwalb run. */
export const OBIA_FELZENSZWALB_TOOL = "obia/felzenszwalb";

const aborted = () => new DOMException("The segmentation was cancelled.", "AbortError");

/** Run the segmentation in a worker (inline where there is none), cancellable. */
function runLabels(request: FelzenszwalbWorkerRequest, run: ObiaRunOptions): Promise<Int32Array> {
  const { bands, width, height, valid, params } = request;
  if (run.signal?.aborted) return Promise.reject(aborted());
  if (typeof Worker === "undefined") {
    return Promise.resolve(felzenszwalbLabels(bands, width, height, valid, params));
  }
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./obia-felzenszwalb.worker.ts", import.meta.url), {
        type: "module",
      });
    } catch {
      resolve(felzenszwalbLabels(bands, width, height, valid, params));
      return;
    }
    const onAbort = () => settle(() => reject(aborted()));
    const settle = (fn: () => void) => {
      worker.terminate();
      run.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    run.signal?.addEventListener("abort", onAbort, { once: true });
    worker.addEventListener("message", (event: MessageEvent<FelzenszwalbWorkerResponse>) => {
      const data = event.data;
      settle(() => (data.ok ? resolve(data.labels) : reject(new Error(data.error))));
    });
    worker.addEventListener("error", (event) =>
      settle(() => reject(new Error(event.message || "The segmentation worker failed."))),
    );
    worker.addEventListener("messageerror", () =>
      settle(() => reject(new Error("The segmentation worker posted an unreadable message."))),
    );
    // The bands are transferred: they were decoded for this run only.
    worker.postMessage(request, [...bands.map((band) => band.buffer as ArrayBuffer)]);
  });
}

/**
 * Segment an image with Felzenszwalb's method in the browser, returning the
 * label raster. Deterministic: the same image and parameters give the same
 * labels, which is how a reloaded project rebuilds them.
 *
 * @param image Bands from `splitImageBands`.
 * @param params Scale, smoothing and minimum object size.
 * @param run Cancellation and progress.
 */
export async function felzenszwalbSegmentLabels(
  image: ObiaImage,
  params: ObiaFelzenszwalbParams,
  run: ObiaRunOptions = {},
): Promise<{ labels: Uint8Array; tool: string; args: string[] }> {
  if (!image.bands.length) {
    throw new ObiaError("no-bands", "Choose at least one band to segment.");
  }
  // Refuse an oversized image before decoding any band.
  const tooLarge = (width: number, height: number) =>
    new ObiaError(
      "image-too-large",
      `This image has ${width} x ${height} pixels, over the limit of ${OBIA_FELZENSZWALB_MAX_PIXELS.toLocaleString("en-US")} pixels for Felzenszwalb in the browser.`,
      { width, height, max: OBIA_FELZENSZWALB_MAX_PIXELS },
    );
  if (image.width * image.height > OBIA_FELZENSZWALB_MAX_PIXELS) {
    throw tooLarge(image.width, image.height);
  }
  run.onStep?.(OBIA_FELZENSZWALB_TOOL);
  const rasters = await Promise.all(
    image.bands.map((band) => readRasterData(band.bytes.slice().buffer as ArrayBuffer)),
  );
  const first = rasters[0];
  const { width, height } = first;
  // Pixels are compared by index, so every band must be on one grid (size,
  // origin, resolution and axis directions).
  const sameGrid = (raster: (typeof rasters)[number]) =>
    raster.width === width &&
    raster.height === height &&
    raster.originX === first.originX &&
    raster.originY === first.originY &&
    raster.resX === first.resX &&
    raster.resY === first.resY &&
    Boolean(raster.flipX) === Boolean(first.flipX) &&
    Boolean(raster.flipY) === Boolean(first.flipY);
  if (!rasters.every(sameGrid)) {
    throw new Error("The bands to segment are not on the same grid.");
  }
  const n = width * height;
  if (n > OBIA_FELZENSZWALB_MAX_PIXELS) throw tooLarge(width, height);

  // A pixel is valid when every band has a finite, non-NoData value.
  const valid = new Uint8Array(n).fill(1);
  const bands = rasters.map((raster) => {
    const values = Float32Array.from(raster.bands[0]);
    for (let i = 0; i < n; i += 1) {
      if (!Number.isFinite(values[i]) || values[i] === raster.nodata) valid[i] = 0;
    }
    return values;
  });
  const ids = await runLabels({ bands, width, height, valid, params }, run);
  const labels = encodeLabelGrid({ width, height, ids, raster: { ...rasters[0], bands: [] } }, ids);
  return {
    labels,
    tool: OBIA_FELZENSZWALB_TOOL,
    args: [JSON.stringify({ scale: params.scale, sigma: params.sigma, minSize: params.minSize })],
  };
}

/**
 * Segment an image with Felzenszwalb's method in the browser and polygonize
 * the labels, as `segmentImage` does for region growing.
 *
 * @param image Bands from `splitImageBands`.
 * @param params Scale, smoothing and minimum object size.
 * @param run Cancellation and progress.
 */
export async function segmentImageFelzenszwalb(
  image: ObiaImage,
  params: ObiaFelzenszwalbParams,
  run: ObiaRunOptions = {},
): Promise<ObiaSegmentation> {
  const { labels, tool, args } = await felzenszwalbSegmentLabels(image, params, run);
  const objects = await polygonizeLabels(labels, run);
  const objectCount = objects.features.length;
  return {
    labels,
    objects,
    objectCount,
    meanObjectArea: objectCount ? (image.width * image.height) / objectCount : 0,
    tool,
    args,
  };
}
