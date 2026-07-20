import type { MapEngineClient } from "@geolibre/map";

export const VIEWPORT_HISTORY_RESTORE_TAG = "viewport-history.restore";
export const STORY_CAMERA_TAG = "story-camera";

export interface CameraUpdate {
  readonly center?: readonly [number, number];
  readonly zoom?: number;
  readonly bearing?: number;
  readonly pitch?: number;
  readonly durationMs?: number;
  readonly tag?: string;
}

/** Apply a partial camera update without exposing an engine-native camera API. */
export function flyToCamera(client: MapEngineClient | null, update: CameraUpdate): void {
  if (!client) return;
  const current = client.camera.readView();
  client.camera.applyView(
    {
      center: update.center ? [...update.center] : current.center,
      zoom: update.zoom ?? current.zoom,
      bearing: update.bearing ?? current.bearing,
      pitch: update.pitch ?? current.pitch,
    },
    {
      mode: "fly",
      ...(update.durationMs === undefined ? {} : { durationMs: update.durationMs }),
      ...(update.tag === undefined ? {} : { tag: update.tag }),
    },
  );
}
