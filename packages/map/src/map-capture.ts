import type { MapEngine, MapRenderSurface } from "./map-engine";

/** Full viewport render surfaces, excluding small legends and plugin previews. */
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
