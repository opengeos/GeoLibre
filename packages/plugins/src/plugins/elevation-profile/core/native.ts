import type { LngLat } from "../elevation/geometry";

/** Renderer operations used by the profile panel, independent of MapLibre sources. */
export interface NativeProfileMap {
  setLine(coords: LngLat[]): void;
  setHover(coord: LngLat | null): void;
  clear(): void;
  sample(coords: LngLat[]): Promise<number[]>;
  fit(coords: LngLat[]): void;
}
