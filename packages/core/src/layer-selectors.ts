/**
 * Narrow subscriptions to the store's `layers` array.
 *
 * `updateLayer` (and every other layer action) replaces `layers` with a new
 * array on each change, so a component that subscribes with
 * `useAppStore((s) => s.layers)` re-renders on every opacity tweak, rename or
 * style edit of *any* layer. The hooks here select only what a component reads
 * and compare it so unrelated layer changes do not re-render it:
 *
 * - {@link useLayer} — one layer record, by id. Layer actions copy only the
 *   layer they change and keep every other record's identity, so this is
 *   stable while other layers change.
 * - {@link useLayerIds} — the ordered id list, shallow-compared.
 * - {@link useLayerSummaries} — `{ id, name, type, visible, groupId }` per
 *   layer, for components that only list layers.
 * - {@link useLayersWhen} — the full array, but only while `active` (a dialog
 *   is open, a search has a query); a constant empty array otherwise.
 *
 * The plain `select*` functions are exported so the selection semantics can be
 * tested without React.
 */
import { useShallow } from "zustand/react/shallow";
import { type AppState, useAppStore } from "./store";
import type { GeoLibreLayer, LayerType } from "./types";

/**
 * The fields a layer list needs: enough to draw a row, a `<select>` option or
 * a visibility checkbox. It deliberately leaves out opacity, style, source,
 * metadata and feature data, which change far more often.
 */
export interface LayerSummary {
  /** The layer id. */
  readonly id: string;
  /** The display name. */
  readonly name: string;
  /** The layer kind. */
  readonly type: LayerType;
  /** Whether the layer is shown on the primary map. */
  readonly visible: boolean;
  /** The layer panel group the layer belongs to, if any. */
  readonly groupId: string | undefined;
}

/**
 * The array {@link useLayersWhen} returns while inactive. Frozen, and shared so
 * the inactive selection never changes identity.
 */
export const NO_LAYERS: GeoLibreLayer[] = Object.freeze([]) as unknown as GeoLibreLayer[];

/**
 * Select one layer record by id.
 *
 * @param state - The app state.
 * @param id - The layer id; `null`/`undefined` selects nothing.
 * @returns The layer record, or `undefined` when there is no such layer.
 */
export function selectLayerById(
  state: Pick<AppState, "layers">,
  id: string | null | undefined,
): GeoLibreLayer | undefined {
  if (!id) return undefined;
  return state.layers.find((layer) => layer.id === id);
}

/**
 * Select the layer ids in store order (bottom to top).
 *
 * Returns a new array on every call; pair it with a shallow comparison (as
 * {@link useLayerIds} does) so an unchanged id list keeps its identity.
 *
 * @param state - The app state.
 * @returns The layer ids.
 */
export function selectLayerIds(state: Pick<AppState, "layers">): string[] {
  return state.layers.map((layer) => layer.id);
}

// Summaries from the previous call, by layer id. Reusing an entry whose fields
// are unchanged keeps each summary's identity across unrelated edits (an
// opacity change replaces the layer object but not its summary), which is what
// lets a shallow comparison of the summary array succeed. Rebuilt on every call
// so removed layers drop out. Summaries are immutable values, so sharing them
// between subscribers is safe.
//
// The cache is module-level on purpose: every caller reads the one app store,
// and an entry is reused only after `sameSummary` re-checks it against the
// current layer. Another subscriber, or a React render that is discarded,
// can therefore only cause a cache miss (a new summary object), never a stale
// summary. Tests that care about identity should not rely on a clean cache.
let summaryCache = new Map<string, LayerSummary>();

function sameSummary(summary: LayerSummary, layer: GeoLibreLayer): boolean {
  return (
    summary.name === layer.name &&
    summary.type === layer.type &&
    summary.visible === layer.visible &&
    summary.groupId === layer.groupId
  );
}

/**
 * Select a {@link LayerSummary} per layer, in store order (bottom to top).
 *
 * Each summary keeps its identity while its own fields are unchanged, so the
 * returned array is shallow-equal to the previous one after an edit that
 * touches none of those fields (opacity, style, data, metadata).
 *
 * @param state - The app state.
 * @returns One summary per layer.
 */
export function selectLayerSummaries(state: Pick<AppState, "layers">): LayerSummary[] {
  const next = new Map<string, LayerSummary>();
  const summaries = state.layers.map((layer) => {
    const previous = summaryCache.get(layer.id);
    const summary =
      previous && sameSummary(previous, layer)
        ? previous
        : Object.freeze({
            id: layer.id,
            name: layer.name,
            type: layer.type,
            visible: layer.visible,
            groupId: layer.groupId,
          });
    next.set(layer.id, summary);
    return summary;
  });
  summaryCache = next;
  return summaries;
}

/**
 * Build a selector for the full `layers` array that is live only while
 * `active`.
 *
 * @param active - Whether the caller currently needs the layers.
 * @returns A selector returning `state.layers` while active, and the constant
 *   {@link NO_LAYERS} otherwise.
 */
export function selectLayersWhen(
  active: boolean,
): (state: Pick<AppState, "layers">) => GeoLibreLayer[] {
  return active ? (state) => state.layers : () => NO_LAYERS;
}

/**
 * Subscribe to one layer record.
 *
 * Re-renders only when that layer changes (or appears/disappears), not when
 * another layer is edited.
 *
 * @param id - The layer id; `null`/`undefined` subscribes to nothing.
 * @returns The layer record, or `undefined` when there is no such layer.
 */
export function useLayer(id: string | null | undefined): GeoLibreLayer | undefined {
  return useAppStore((state) => selectLayerById(state, id));
}

/**
 * Subscribe to the ordered list of layer ids.
 *
 * Re-renders only when a layer is added, removed or reordered.
 *
 * @returns The layer ids in store order (bottom to top).
 */
export function useLayerIds(): string[] {
  return useAppStore(useShallow(selectLayerIds));
}

/**
 * Subscribe to a {@link LayerSummary} per layer.
 *
 * Re-renders only when a layer is added, removed, reordered, renamed, shown or
 * hidden, retyped or regrouped; opacity, style, data and metadata edits do not
 * re-render the caller.
 *
 * @returns One summary per layer, in store order (bottom to top).
 */
export function useLayerSummaries(): LayerSummary[] {
  return useAppStore(useShallow(selectLayerSummaries));
}

/**
 * Subscribe to the full `layers` array only while `active`.
 *
 * For always-mounted surfaces (dialogs, floating panels) that need every layer
 * record while open but keep local state across closes and so cannot simply be
 * unmounted. While inactive the caller gets the constant {@link NO_LAYERS} and
 * layer edits do not re-render it.
 *
 * @param active - Whether the caller currently needs the layers (for example,
 *   whether its dialog is open).
 * @returns `layers` while active, otherwise an empty, frozen array.
 */
export function useLayersWhen(active: boolean): GeoLibreLayer[] {
  return useAppStore(selectLayersWhen(active));
}
