/**
 * Hands a granule's bytes from a plugin (the Earthaccess search panel) to the
 * Add Data → ICESat-2 / GEDI dialog, which the top toolbar owns. The toolbar
 * listens to open the dialog; the dialog takes the pending granule when it
 * mounts, or straight away if it is already open.
 */

/** A downloaded granule waiting for the dialog. */
export interface PendingSpaceborneLidarGranule {
  data: ArrayBuffer;
  fileName: string;
}

let pending: PendingSpaceborneLidarGranule | null = null;
const listeners = new Set<() => void>();

/**
 * Queue a granule for the dialog and notify listeners. A newer request
 * replaces one that was never taken.
 *
 * @param granule The granule bytes and file name.
 */
export function requestSpaceborneLidarGranule(granule: PendingSpaceborneLidarGranule): void {
  pending = granule;
  for (const listener of [...listeners]) listener();
}

/**
 * Take the queued granule, if any; it is handed out once.
 *
 * @returns The granule, or null.
 */
export function takePendingSpaceborneLidarGranule(): PendingSpaceborneLidarGranule | null {
  const granule = pending;
  pending = null;
  return granule;
}

/**
 * Subscribe to granule requests.
 *
 * @param listener Called after each request.
 * @returns Unsubscribe.
 */
export function onSpaceborneLidarGranuleRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
