import { useAppStore } from "@geolibre/core";
import { selectionFitKey } from "./map-selection";

/** Selection ownership recorded while an Identify popup is open. */
export interface IdentifyPopupState {
  identifiedLayerId: string;
  identifiedFeatureId: string | null;
  previousSelectedLayerId: string | null;
  previousSelectedFeatureId: string | null;
  previousSelectedFeatureIds: string[];
  onClose: () => void;
}

/** The engine-neutral popup surface needed by the Identify lifecycle. */
export interface PopupLike {
  remove(): unknown;
  off(type: "close", listener: () => void): unknown;
}

// Fit key of the selection a restore is writing back, read once by whichever
// engine observes it. A synchronous flag can't serve both engines: MapboxCanvas
// reads it in a store subscription inside the restore's call stack, but
// MapCanvas reads it in a React effect that runs after the restore returned.
// Module-level is fine because only the primary canvas of the active 2D
// engine opens Identify popups.
let pendingIdentifyRestoreKey: string | null = null;

/**
 * Report, exactly once, whether a selection is the one an Identify restore wrote back.
 *
 * Call with the fit key of the selection being applied. Any call clears the
 * marker; only a key matching the restored selection reports true. A
 * different key means a newer selection (e.g. a miss clearing the restored
 * features) superseded the restore before this reader saw it.
 *
 * Args:
 *   key: The selection's fit key, as computed by `selectionFitKey`.
 *
 * Returns:
 *   True when the camera fit for this selection should be suppressed.
 */
export function consumePendingIdentifyRestore(key: string | null): boolean {
  if (pendingIdentifyRestoreKey === null) return false;
  const matches = key === pendingIdentifyRestoreKey;
  pendingIdentifyRestoreKey = null;
  return matches;
}

/** Snapshot the current selection before an Identify result takes ownership of it. */
export function createIdentifyPopupState(snapshot: {
  layerId: string;
  featureId: string | null;
  onClose: () => void;
}): IdentifyPopupState {
  const current = useAppStore.getState();
  return {
    identifiedLayerId: snapshot.layerId,
    identifiedFeatureId: snapshot.featureId,
    previousSelectedLayerId: current.selectedLayerId,
    previousSelectedFeatureId: current.selectedFeatureId,
    previousSelectedFeatureIds: current.selectedFeatureIds,
    onClose: snapshot.onClose,
  };
}

/** Restore the selection owned before an Identify popup opened. */
export function restoreIdentifySelection(
  selection: IdentifyPopupState,
  options: { force?: boolean } = {},
): void {
  const next = useAppStore.getState();
  // Only undo the popup's own selection; a layer or feature the user picked
  // while the popup was open is theirs to keep.
  if (
    !options.force &&
    (next.selectedLayerId !== selection.identifiedLayerId ||
      next.selectedFeatureId !== selection.identifiedFeatureId ||
      next.selectedFeatureIds.length !== (selection.identifiedFeatureId !== null ? 1 : 0) ||
      (selection.identifiedFeatureId !== null &&
        next.selectedFeatureIds[0] !== selection.identifiedFeatureId))
  ) {
    return;
  }
  const previousLayerExists =
    selection.previousSelectedLayerId !== null &&
    next.layers.some((layer) => layer.id === selection.previousSelectedLayerId);
  // selectLayer also clears the feature selection.
  next.selectLayer(previousLayerExists ? selection.previousSelectedLayerId : null);
  if (previousLayerExists && selection.previousSelectedFeatureIds.length > 0) {
    // Only a restored feature selection can trigger a fit. Record its key
    // after selectLayer so that intermediate write can't consume it; Mapbox
    // consumes it inside selectFeatures, MapCanvas in its later effect.
    pendingIdentifyRestoreKey = selectionFitKey({
      selectedLayerId: selection.previousSelectedLayerId,
      selectedFeatureIds: selection.previousSelectedFeatureIds,
      selectedFeatureId: selection.previousSelectedFeatureId,
    });
    next.selectFeatures(selection.previousSelectedFeatureIds, selection.previousSelectedFeatureId);
  }
}

/** Remove an Identify popup and optionally restore the selection it owns. */
export function removeIdentifyPopup(
  popup: PopupLike | null | undefined,
  state: IdentifyPopupState | null | undefined,
  options: { restore?: boolean; forceRestore?: boolean } = {},
): void {
  if (popup && state) popup.off("close", state.onClose);
  popup?.remove();
  if (state && options.restore !== false) {
    restoreIdentifySelection(state, { force: options.forceRestore });
  }
}
