/**
 * Which footprint layer the along-track profile window charts (null when it is
 * closed). Opened from a layer's actions menu; the window reads the layer from
 * the app store, so it follows edits and closes itself if the layer goes away.
 */

let layerId: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * Open the profile for a layer (replacing any open one).
 *
 * @param id The footprint layer's id.
 */
export function openAlongTrackProfile(id: string): void {
  layerId = id;
  emit();
}

/** Close the profile window. */
export function closeAlongTrackProfile(): void {
  if (layerId === null) return;
  layerId = null;
  emit();
}

/**
 * The charted layer's id, or null when the window is closed.
 *
 * @returns The layer id.
 */
export function getAlongTrackProfileLayerId(): string | null {
  return layerId;
}

/**
 * Subscribe to open / close changes (for `useSyncExternalStore`).
 *
 * @param listener Called after each change.
 * @returns Unsubscribe.
 */
export function subscribeAlongTrackProfile(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
