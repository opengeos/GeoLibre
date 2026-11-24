import { createBoundingVolume } from "@loaders.gl/tiles";
import { Matrix4 } from "@math.gl/core";
import { Ellipsoid } from "@math.gl/geospatial";

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
): Promise<Bounds | null> {
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetch(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok)
    throw new Error(`Could not read the 3D Tiles extent (HTTP ${response.status}).`);
  const bounds = threeDTilesRootBounds(await response.json());
  if (!bounds) throw new Error("The 3D Tiles manifest has no usable root bounding volume.");
  return bounds;
}
