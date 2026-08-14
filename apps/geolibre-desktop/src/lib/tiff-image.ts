/**
 * Decoding for TIFF/GeoTIFF images that have to be *painted* rather than
 * analysed: KML `<GroundOverlay>` icons, which authoring tools (Global Mapper,
 * gdal2tiles) routinely write as `.tif` instead of PNG/JPEG.
 *
 * Browsers cannot decode TIFF into an `<img>`, a canvas, or
 * `createImageBitmap`, which is what a MapLibre image source and the KML
 * Super-Overlay tile protocol paint from. So the bytes go through geotiff.js
 * first and come back out as RGBA, then as a PNG the rest of the app can treat
 * like any other overlay image.
 *
 * `geotiff` is a large dependency that only a TIFF overlay needs, so it is
 * pulled in with a dynamic `import()` and stays out of the initial bundle.
 */

/**
 * The most pixels a TIFF may decode to, ~8192x8192.
 *
 * A TIFF's dimensions come from its IFD tags, which are just numbers in a file
 * a user imported: a "decompression bomb" that is a few KB on disk can declare
 * 50000x50000 and make the decode below allocate gigabytes on the main thread.
 * The compressed-size caps around the callers (`MAX_OVERLAY_IMAGE_BYTES` in
 * `tauri-io.ts`) bound the *file*, not what it expands to, so the ceiling has to
 * be checked here, before any pixel buffer is allocated. 64 megapixels leaves
 * room for the large aerials a ground overlay legitimately carries — at 4 bytes
 * per pixel it still bounds the RGBA buffer at 256 MB.
 */
const MAX_DECODED_TIFF_PIXELS = 64 * 1024 * 1024;

/** A decoded raster image: RGBA bytes plus the dimensions they describe. */
export interface DecodedImage {
  width: number;
  height: number;
  /** Row-major RGBA, four bytes per pixel. */
  data: Uint8ClampedArray<ArrayBuffer>;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // A view over a larger pooled buffer (or a SharedArrayBuffer) would hand
  // geotiff bytes that are not the image, so copy unless the view is exactly
  // its own ArrayBuffer.
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    const { buffer } = bytes;
    if (buffer instanceof ArrayBuffer) return buffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

/**
 * Decode TIFF bytes into RGBA pixels.
 *
 * geotiff's `readRGB` resolves the photometric interpretation (grayscale,
 * palette, YCbCr, CMYK) to 8-bit RGB, and with `enableAlpha` keeps an
 * `ExtraSamples` alpha band. It returns three channels for an opaque image and
 * four for one carrying alpha, so the missing alpha is filled in here to give
 * callers a single RGBA shape.
 *
 * @param bytes - The raw TIFF file bytes.
 * @returns The decoded image as RGBA.
 * @throws If the bytes are not a TIFF, hold no readable image, or declare more
 *   than `MAX_DECODED_TIFF_PIXELS` pixels.
 */
export async function decodeTiffToRgba(bytes: Uint8Array): Promise<DecodedImage> {
  const { fromArrayBuffer } = await import("geotiff");
  const tiff = await fromArrayBuffer(toArrayBuffer(bytes));
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  if (!width || !height) throw new Error("The TIFF image has no pixels.");
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 0 || height < 0) {
    throw new Error("The TIFF image declares invalid dimensions.");
  }
  if (width * height > MAX_DECODED_TIFF_PIXELS) {
    throw new Error(
      `The TIFF image is ${width}x${height}, over the ${Math.round(
        MAX_DECODED_TIFF_PIXELS / (1024 * 1024),
      )} megapixel decode limit.`,
    );
  }

  const pixels = await image.readRGB({ interleave: true, enableAlpha: true });
  const channels = pixels.length / (width * height);
  if (channels !== 3 && channels !== 4) {
    throw new Error(`Unexpected TIFF channel count: ${channels}.`);
  }

  const data = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const from = pixel * channels;
    const to = pixel * 4;
    data[to] = pixels[from];
    data[to + 1] = pixels[from + 1];
    data[to + 2] = pixels[from + 2];
    data[to + 3] = channels === 4 ? pixels[from + 3] : 255;
  }
  return { width, height, data };
}

/**
 * Re-encode TIFF bytes as PNG bytes.
 *
 * PNG (rather than JPEG) because a ground overlay's alpha channel is what keeps
 * the area outside the imagery transparent instead of a black or white box.
 *
 * @param bytes - The raw TIFF file bytes.
 * @returns The equivalent PNG file bytes.
 * @throws If the TIFF cannot be decoded or the canvas cannot be encoded.
 */
export async function tiffBytesToPngBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const image = await decodeTiffToRgba(bytes);
  const imageData = new ImageData(image.data, image.width, image.height);

  // OffscreenCanvas where available so nothing is attached to the document.
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(image.width, image.height);
    drawingContext(canvas).putImageData(imageData, 0, 0);
    return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
  }

  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  drawingContext(canvas).putImageData(imageData, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not encode the TIFF image as PNG.");
  return new Uint8Array(await blob.arrayBuffer());
}

function drawingContext<T extends OffscreenCanvas | HTMLCanvasElement>(
  canvas: T,
): T extends OffscreenCanvas ? OffscreenCanvasRenderingContext2D : CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not get a 2D canvas context to draw the TIFF image.");
  return context as T extends OffscreenCanvas
    ? OffscreenCanvasRenderingContext2D
    : CanvasRenderingContext2D;
}

/**
 * Decode TIFF bytes straight to an `ImageBitmap`, skipping the PNG round trip.
 * Used by the Super-Overlay tile protocol, which composites bitmaps rather than
 * handing URLs to MapLibre.
 *
 * @param bytes - The raw TIFF file bytes.
 * @returns The decoded image as an `ImageBitmap`.
 */
export async function tiffBytesToImageBitmap(bytes: Uint8Array): Promise<ImageBitmap> {
  const { width, height, data } = await decodeTiffToRgba(bytes);
  return createImageBitmap(new ImageData(data, width, height));
}
