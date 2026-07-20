/** Decide whether a canvas is a full-viewport renderer surface worth capturing. */
export function isFullViewportMapCanvas(
  canvas: { readonly width: number; readonly height: number },
  base: { readonly width: number; readonly height: number },
): boolean {
  if (canvas === base) return true;
  if (base.width === 0 || base.height === 0) return false;
  return canvas.width >= base.width * 0.9 && canvas.height >= base.height * 0.9;
}
