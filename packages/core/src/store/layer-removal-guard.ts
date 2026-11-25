import type { StateCreator, StoreMutatorIdentifier } from "zustand";
import type { GeoLibreLayer } from "../types";

type Reservation = { references: (layer: GeoLibreLayer) => boolean; message: string };
const reservations = new Set<Reservation>();

/** Hold a source's no-overlay-reference invariant across asynchronous deletion.
 * Conflicting project loads, imports and undo operations fail before publishing
 * their state. Always release the reservation in a finally block. */
export function reserveLayerRemoval(
  layers: GeoLibreLayer[],
  references: Reservation["references"],
  message: string,
): () => void {
  if (layers.some(references)) throw new Error(message);
  const reservation = { references, message };
  reservations.add(reservation);
  return () => {
    reservations.delete(reservation);
  };
}

/** Reject a state that would use a source reserved for deletion. */
export function assertLayerRemovalSafe(layers: GeoLibreLayer[]): void {
  for (const reservation of reservations) {
    if (layers.some(reservation.references)) throw new Error(reservation.message);
  }
}

/** Guard both slice actions and direct writes, including temporal restores. */
export function guardLayerRemovals<
  T extends { layers: GeoLibreLayer[] },
  M extends [StoreMutatorIdentifier, unknown][],
>(initializer: StateCreator<T, [], M>): StateCreator<T, [], M> {
  return (set, get, api) => {
    const guardedSet: typeof set = (partial, replace) => {
      const next = typeof partial === "function" ? partial(get()) : partial;
      if (next.layers && next.layers !== get().layers) {
        assertLayerRemovalSafe(next.layers);
      }
      if (replace) set(next as T, true);
      else set(next);
    };
    api.setState = guardedSet;
    return initializer(guardedSet, get, api);
  };
}
