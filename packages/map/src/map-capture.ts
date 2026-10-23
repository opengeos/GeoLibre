import type { MapEngine, MapRenderSurface } from "./map-engine";

/**
 * Decide whether a `<canvas>` found inside the map container is a full-viewport
 * map render surface that should be composited into the snapshot.
 *
 * The map container holds the MapLibre base canvas and, on desktop, a deck.gl
 * overlay canvas (both sized to the full viewport). It can also hold small UI
 * canvases that map controls render: the raster control's colorbar/colormap
 * previews and the lidar profile chart. Those must be skipped, otherwise the
 * capture loop stretches them to fill the whole page and clobbers the map with,
 * for example, a horizontal colormap ramp.
 *
 * This is a size heuristic, not an allow-list: it assumes the only
 * full-viewport canvases in the container are map render surfaces, and that
 * control/preview canvases are comfortably smaller than 90% of the base in at
 * least one dimension (today's previews are ~280x24, so they are). Two edges to
 * keep in mind if that assumption ever changes: a deck.gl overlay rendered at
 * under 90% of the base (e.g. a different device-pixel-ratio) would be dropped
 * from the snapshot, and a future near-full-screen widget canvas (e.g. a 95%
 * minimap) would be composited over the map. Prefer an explicit allow-list keyed
 * on the overlay canvas if either case becomes real.
 *
 * @param canvas - A candidate canvas, kept if it is the base by identity or
 *   matches the base size.
 * @param base - The engine's base canvas, used as the reference size.
 * @returns True for the base canvas and any other canvas at least 90% of the
 *   base's width and height; false for the smaller control/preview canvases.
 */
export function isFullViewportMapCanvas(
  canvas: { width: number; height: number },
  base: { width: number; height: number },
): boolean {
  return (
    canvas === base ||
    (base.width > 0 &&
      base.height > 0 &&
      canvas.width >= base.width * 0.9 &&
      canvas.height >= base.height * 0.9)
  );
}

export function compositeMapCanvas(
  surface: Pick<MapRenderSurface, "getCanvas" | "getContainer" | "redraw">,
): HTMLCanvasElement {
  surface.redraw();
  const base = surface.getCanvas();
  if (!base.width || !base.height) throw new Error("The map canvas is empty");
  const out = document.createElement("canvas");
  out.width = base.width;
  out.height = base.height;
  const context = out.getContext("2d");
  if (!context) throw new Error("Could not create a map capture canvas");
  for (const canvas of surface.getContainer().querySelectorAll("canvas")) {
    if (
      canvas.classList.contains("geolibre-effects-canvas") ||
      !isFullViewportMapCanvas(canvas, base)
    )
      continue;
    context.drawImage(canvas, 0, 0, out.width, out.height);
  }
  return out;
}

/** Wait across painted frames so async providers have time to register tile work. */
export async function captureEngineImage(engine: MapEngine): Promise<Blob> {
  const started = performance.now();
  let settledSince = 0;
  while (true) {
    const status = engine.getRenderStatus();
    if (status.errors.length) throw new Error(status.errors.join("; "));
    if (status.pending.length) settledSince = 0;
    else settledSince ||= performance.now();
    if (settledSince && performance.now() - settledSince >= 500) break;
    if (performance.now() - started > 30_000)
      throw new Error("Timed out waiting for the map to finish rendering");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const surface = engine.getRenderSurface();
  if (!surface) throw new Error("The map was destroyed during capture");
  const canvas = compositeMapCanvas(surface);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error("Could not encode the map image"))),
      "image/png",
    ),
  );
  if (engine.getRenderSurface() !== surface)
    throw new Error("The map was destroyed during capture");
  return blob;
}

export function imageBlobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the map image"));
    reader.readAsDataURL(blob);
  });
}
