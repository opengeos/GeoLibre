/**
 * Reading a user-picked image file into a custom point marker (`markerSvg`).
 *
 * SVG goes in as markup, so recoloring and QGIS color parameters keep working.
 * A raster image (PNG, JPEG, GIF) is downscaled on the client and stored as a
 * data URL, so a large photo does not bloat the project on every save.
 */

/**
 * The longest side, in pixels, a raster marker is stored at. The largest marker
 * (96 px) is baked at a 2x pixel ratio, so 128 px stays sharp at the common
 * sizes without carrying a full-resolution photo in the project.
 */
export const MARKER_IMAGE_MAX_SIDE = 128;

/**
 * The largest SVG file stored as markup. SVG is kept verbatim (so it can be
 * recolored) rather than downscaled, so cap it to keep projects small; a
 * marker icon is a few kilobytes.
 */
export const MARKER_SVG_MAX_BYTES = 512 * 1024;

/** The `accept` list of the marker image file picker. */
export const MARKER_IMAGE_ACCEPT =
  ".svg,.png,.jpg,.jpeg,.gif,image/svg+xml,image/png,image/jpeg,image/gif";

/** The kind of image a picked file holds, or `null` when it is not supported. */
export type MarkerImageKind = "svg" | "png" | "jpeg" | "gif";

/**
 * Classify a picked file by its MIME type, falling back to its extension
 * (some platforms report an empty type, notably for SVG).
 *
 * @param name - The file name.
 * @param type - The file's MIME type, possibly empty.
 * @returns The image kind, or `null` for an unsupported file.
 */
export function markerImageKind(name: string, type: string): MarkerImageKind | null {
  const mime = type.toLowerCase();
  if (mime === "image/svg+xml") return "svg";
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpeg";
  if (mime === "image/gif") return "gif";
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (extension === "svg") return "svg";
  if (extension === "png") return "png";
  if (extension === "jpg" || extension === "jpeg") return "jpeg";
  if (extension === "gif") return "gif";
  return null;
}

/**
 * The size to store a raster marker at: scaled down so its longest side is at
 * most `maxSide`, keeping the aspect ratio. Never scales up.
 *
 * @param width - The image's natural width.
 * @param height - The image's natural height.
 * @param maxSide - The longest side allowed.
 * @returns The target width and height, each at least 1.
 */
export function markerImageTargetSize(
  width: number,
  height: number,
  maxSide: number = MARKER_IMAGE_MAX_SIDE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  const scale = longest > maxSide ? maxSide / longest : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * The data URL format a raster marker is stored in: JPEG for a JPEG photo
 * (which has no transparency to keep, and compresses far smaller), PNG for
 * everything else so transparent icons stay transparent.
 *
 * @param kind - The picked file's kind.
 * @returns The output MIME type.
 */
export function markerImageOutputType(kind: MarkerImageKind): "image/jpeg" | "image/png" {
  return kind === "jpeg" ? "image/jpeg" : "image/png";
}

/**
 * Whether markup parses as XML with an SVG-namespaced `<svg>` root, so a truncated or
 * non-SVG file is rejected at upload instead of silently drawing nothing.
 *
 * @param markup - The file's text.
 * @returns `true` for a well-formed SVG document.
 */
function isWellFormedSvg(markup: string): boolean {
  const document = new DOMParser().parseFromString(markup, "image/svg+xml");
  if (document.getElementsByTagName("parsererror").length > 0) return false;
  // An <svg> without the SVG namespace parses but does not render as an image.
  const root = document.documentElement;
  return root?.localName === "svg" && root.namespaceURI === "http://www.w3.org/2000/svg";
}

function decodeImage(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The image could not be decoded."));
    image.src = url;
  }).finally(() => URL.revokeObjectURL(url));
}

/**
 * Read a picked file as a `markerSvg` value: SVG markup for an SVG, or a
 * downscaled PNG/JPEG data URL for a raster image. An animated GIF keeps only
 * its first frame.
 *
 * @param file - The picked file.
 * @returns The value to store in `markerSvg`.
 * @throws When the file is not a supported image or cannot be decoded.
 */
export async function readMarkerImageFile(file: File): Promise<string> {
  const kind = markerImageKind(file.name, file.type);
  if (!kind) throw new Error("Unsupported image type.");
  if (kind === "svg") {
    if (file.size > MARKER_SVG_MAX_BYTES) throw new Error("The SVG file is too large.");
    const markup = (await file.text()).trim();
    if (!isWellFormedSvg(markup)) throw new Error("The file is not an SVG image.");
    return markup;
  }
  const image = await decodeImage(file);
  const { width, height } = markerImageTargetSize(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("A canvas is not available.");
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, height);
  const type = markerImageOutputType(kind);
  return type === "image/jpeg" ? canvas.toDataURL(type, 0.9) : canvas.toDataURL(type);
}
