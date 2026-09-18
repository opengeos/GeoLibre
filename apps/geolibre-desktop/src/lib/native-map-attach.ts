import type { MapEngine } from "@geolibre/map";

/**
 * Whether a poll for the native MapLibre map is still worth another frame.
 *
 * Three hooks — `useCommandBridge`, `useNotebookBridge`, `useEmbedApi` — wait
 * for `MapCanvas` to publish its controller by re-scheduling a
 * `requestAnimationFrame` until `getMap()` answers. That loop was written when a
 * null ref could only mean "not mounted yet". It can now mean "this engine has
 * no MapLibre map and never will" (the globe), and a loop that cannot tell the
 * two apart schedules a frame every frame for the life of the session.
 *
 * The check lives here rather than inline in each hook because it was inline in
 * each hook: the guard was added to two of the three and the third was missed
 * until review caught it (#2268). One definition means the next hook to poll for
 * a map either uses it or is visibly not using it.
 *
 * @param engine - The live engine, or `null` when none has published yet.
 * @returns `true` while a map may still arrive, `false` once it cannot.
 */
export function shouldAwaitNativeMap(engine: MapEngine | null | undefined): boolean {
  // No engine yet: still mounting, so keep waiting.
  if (!engine) return true;
  return engine.capabilities.nativeMapInstance;
}
