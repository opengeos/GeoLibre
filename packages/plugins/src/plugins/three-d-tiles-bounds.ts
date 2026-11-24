import { createBoundingVolume } from "@loaders.gl/tiles";
import { Matrix4 } from "@math.gl/core";
import { Ellipsoid } from "@math.gl/geospatial";

import { createPluginTranslator, type PluginTranslate } from "../plugin-i18n";

type Bounds = [number, number, number, number];

/** A camera extent from a 3D Tiles root volume, including its root transform. */
export function threeDTilesRootBounds(value: unknown): Bounds | null {
  if (!value || typeof value !== "object") return null;
  const root = (value as { root?: Record<string, unknown> }).root;
  if (!root || !root.boundingVolume || typeof root.boundingVolume !== "object") return null;
  const header = root.boundingVolume as Record<string, unknown>;
  const numbers = (input: unknown, length: number): input is number[] =>
    Array.isArray(input) && input.length === length && input.every(Number.isFinite);
  // Regions are geographic and excluded from the root transform by the spec.
  if (numbers(header.region, 6)) {
    const [w, s, e, n] = header.region.map((radians) => (radians * 180) / Math.PI);
    return [w, s, e < w ? e + 360 : e, n];
  }
  if (!numbers(header.box, 12) && !numbers(header.sphere, 4)) return null;
  if (root.transform !== undefined && !numbers(root.transform, 16)) return null;
  const volume = createBoundingVolume(header, new Matrix4(root.transform as number[] | undefined));
  const sphere: { center: number[]; radius: number } =
    typeof volume.getBoundingSphere === "function" ? volume.getBoundingSphere() : volume;
  if (numbers(header.box, 12)) {
    // Under nonuniform scale/shear, u+v+w may be the shortest corner rather
    // than the farthest one. Enclose all eight transformed corner offsets.
    const axes: ArrayLike<number> = volume.halfAxes;
    let radius = 0;
    for (const x of [-1, 1])
      for (const y of [-1, 1])
        for (const z of [-1, 1]) {
          radius = Math.max(
            radius,
            Math.hypot(
              x * axes[0] + y * axes[3] + z * axes[6],
              x * axes[1] + y * axes[4] + z * axes[7],
              x * axes[2] + y * axes[5] + z * axes[8],
            ),
          );
        }
    sphere.radius = radius;
  }
  if (!Number.isFinite(sphere.radius) || sphere.radius < 0) return null;
  const center = Ellipsoid.WGS84.cartesianToCartographic(sphere.center);
  if (!center || !center.every(Number.isFinite)) return [-180, -90, 180, 90];
  const [lng, lat, altitude] = center;
  // WGS84's minimum curvature radius, reduced by below-surface extent,
  // provides an enclosing camera box instead of cropping the root sphere.
  const radius = Math.max(1, 6_335_439 + Math.min(0, altitude) - sphere.radius);
  const angle = Math.min(Math.PI, sphere.radius / radius);
  const degrees = (angle * 180) / Math.PI;
  const south = Math.max(-90, lat - degrees);
  const north = Math.min(90, lat + degrees);
  if (south <= -90 || north >= 90) return [-180, south, 180, north];
  const delta =
    (Math.asin(Math.min(1, Math.sin(angle) / Math.cos((lat * Math.PI) / 180))) * 180) / Math.PI;
  return [lng - delta, south, lng + delta, north];
}

/** Read the root manifest so asynchronous 3D layers can join batch fitting. */
export async function loadThreeDTilesBounds(
  url: string,
  signal?: AbortSignal,
  t: PluginTranslate = createPluginTranslator(null, "3d-tiles"),
): Promise<Bounds | null> {
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetch(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok)
    throw new Error(
      t("extentHttp", "Could not read the 3D Tiles extent (HTTP {{status}}).", {
        status: response.status,
      }),
    );
  // Root manifests can contain many children. Bound this metadata-only read
  // independently of the renderer's later, on-demand tileset loading.
  const limit = 4 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error(
      t("extentTooLarge", "The 3D Tiles extent manifest exceeds the 4 MiB preview limit."),
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(t("extentEmpty", "The 3D Tiles extent manifest is empty."));
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit)
        throw new Error(
          t("extentTooLarge", "The 3D Tiles extent manifest exceeds the 4 MiB preview limit."),
        );
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const bounds = threeDTilesRootBounds(JSON.parse(new TextDecoder().decode(bytes)));
  if (!bounds)
    throw new Error(
      t("extentNoVolume", "The 3D Tiles manifest has no usable root bounding volume."),
    );
  return bounds;
}
